import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CheckpointData, deleteCheckpoints, loadCheckpoint, saveCheckpoint } from "./checkpoint.ts";
import { appendMonitoringEntry } from "./monitoring.ts";
import { pushStatus } from "./streaming.ts";
import { buildRetryPrompt, detectStuckReason, isStuck } from "./stuck.ts";

export interface TtsOptions {
	sessionId?: string;
	maxSteps?: number;
	checkpointDir?: string;
	statusDir?: string;
	cancelDir?: string;
	resumeFrom?: string;
	expertFn?: (question: string) => Promise<string>;
	logDir?: string;
}

export interface TtsResult {
	status: "done" | "cancelled" | "error";
	steps: number;
	result: string;
	checkpointPath?: string;
}

export interface PiLike {
	sendMessage: (content: string) => Promise<string>;
}

function cancelDir(opts: TtsOptions): string {
	return opts.cancelDir ?? join(homedir(), ".pilav");
}

export function checkCancelSignal(sessionId: string, dir?: string): boolean {
	const d = dir ?? join(homedir(), ".pilav");
	return existsSync(join(d, `cancel-${sessionId}`));
}

function makeCancelSentinelPath(sessionId: string, dir: string): string {
	return join(dir, `cancel-${sessionId}`);
}

export async function runTtsLoop(task: string, options: TtsOptions, pi: PiLike): Promise<TtsResult> {
	const sessionId = options.sessionId ?? `tts-${Date.now()}`;
	const maxSteps = options.maxSteps ?? 20;
	const ckptDir = options.checkpointDir;
	const statDir = options.statusDir;
	const cxlDir = cancelDir(options);
	const expertFn = options.expertFn;
	const logDir = options.logDir;
	const startTime = Date.now();

	// Check cancel signal before we even start
	if (checkCancelSignal(sessionId, cxlDir)) {
		pushStatus({ sessionId, step: 0, totalSteps: maxSteps, currentTask: "Cancelled before start", elapsedMs: 0, status: "cancelled" }, statDir);
		return { status: "cancelled", steps: 0, result: "Cancelled before start" };
	}

	// Determine starting step (resume support)
	let startStep = 0;
	if (options.resumeFrom) {
		const prior = loadCheckpoint(sessionId, ckptDir);
		if (prior) startStep = prior.step;
	}

	const results: string[] = [];
	let lastCheckpointPath: string | undefined;

	// Phase 1: plan — ask the model to break the task into subtasks
	const planPrompt = `You are performing extended reasoning on a complex task. Break it into ${maxSteps - startStep} sequential subtasks and list them numbered 1 to N. Task: ${task}`;
	let planResponse: string;
	try {
		planResponse = await pi.sendMessage(planPrompt);
	} catch {
		pushStatus({ sessionId, step: 0, totalSteps: maxSteps, currentTask: "Planning failed", elapsedMs: Date.now() - startTime, status: "error" }, statDir);
		return { status: "error", steps: 0, result: "Planning step failed" };
	}

	// Extract subtasks from plan (simple line parsing)
	const subtasks = planResponse
		.split("\n")
		.map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
		.filter((l) => l.length > 0)
		.slice(0, maxSteps - startStep);

	if (subtasks.length === 0) subtasks.push(task);

	// Phase 2: execute subtasks
	for (let i = 0; i < subtasks.length; i++) {
		const step = startStep + i + 1;
		const currentTask = subtasks[i];

		// Check cancel signal
		if (checkCancelSignal(sessionId, cxlDir)) {
			const ckptData: CheckpointData = {
				sessionId, checkpointId: `ckpt-${String(step).padStart(3, "0")}`,
				timestamp: new Date().toISOString(),
				elapsedMs: Date.now() - startTime,
				step, totalSteps: subtasks.length + startStep,
				currentTask, context: { messages: [], toolResults: [], scratchpad: results.join("\n") },
				status: "cancelled",
			};
			lastCheckpointPath = saveCheckpoint(ckptData, ckptDir);
			pushStatus({ sessionId, step, totalSteps: subtasks.length + startStep, currentTask: "Cancelled", elapsedMs: Date.now() - startTime, status: "cancelled" }, statDir);
			return { status: "cancelled", steps: step, result: results.join("\n"), checkpointPath: lastCheckpointPath };
		}

		// Execute subtask with stuck detection and retry
		pushStatus({ sessionId, step, totalSteps: subtasks.length + startStep, currentTask, elapsedMs: Date.now() - startTime, status: "working" }, statDir);

		const basePrompt = `Execute subtask ${step}/${subtasks.length + startStep}: ${currentTask}`;
		let stepResult: string;
		let retryCount = 0;
		let previousResponse: string | undefined;
		let stuckReason: string | undefined;
		let expertGuidance: string | undefined;

		while (true) {
			let prompt = retryCount === 0 ? basePrompt : buildRetryPrompt(basePrompt, stuckReason as Parameters<typeof buildRetryPrompt>[1], retryCount);
			if (expertGuidance) prompt = `[Expert guidance: ${expertGuidance}]\n\n${prompt}`;

			try {
				stepResult = await pi.sendMessage(prompt);
			} catch {
				stepResult = `[error on step ${step}]`;
				break;
			}

			const stuck = isStuck(stepResult, { retryCount, previousResponse });
			if (!stuck) break;

			stuckReason = detectStuckReason(stepResult, { retryCount, previousResponse }) ?? "short_response";
			retryCount++;

			// Escalate to expert on second failure (retryCount just became 2)
			if (retryCount === 2 && expertFn && !expertGuidance) {
				try {
					expertGuidance = await expertFn(`Stuck on: ${currentTask}. Reason: ${stuckReason}. Last response: ${String(stepResult).slice(0, 200)}`);
				} catch { /* ignore — proceed without guidance */ }
			}

			if (retryCount >= 3) {
				// Max retries reached — accept the last response
				break;
			}
			previousResponse = stepResult;
		}

		results.push(`Step ${step}: ${stepResult!}`);

		appendMonitoringEntry({
			timestamp: new Date().toISOString(),
			sessionId,
			step,
			model: process.env.LM_STUDIO_MODEL ?? "unknown",
			task: currentTask,
			responseLength: stepResult!.length,
			latencyMs: Date.now() - startTime,
			retries: retryCount,
			retryReason: stuckReason,
			escalated: expertGuidance !== undefined,
			status: "working",
		}, logDir);

		// Save checkpoint after each step
		const ckptData: CheckpointData = {
			sessionId, checkpointId: `ckpt-${String(step).padStart(3, "0")}`,
			timestamp: new Date().toISOString(),
			elapsedMs: Date.now() - startTime,
			step, totalSteps: subtasks.length + startStep,
			currentTask, context: { messages: [], toolResults: [], scratchpad: results.join("\n") },
			status: "working",
		};
		lastCheckpointPath = saveCheckpoint(ckptData, ckptDir);
	}

	const finalResult = results.join("\n");
	pushStatus({ sessionId, step: subtasks.length + startStep, totalSteps: subtasks.length + startStep, currentTask: "Complete", elapsedMs: Date.now() - startTime, status: "done", result: finalResult }, statDir);

	// Clean up cancel sentinel if it somehow appeared after loop
	const sentinelPath = makeCancelSentinelPath(sessionId, cxlDir);
	if (existsSync(sentinelPath)) {
		try { import("node:fs").then(fs => fs.rmSync(sentinelPath, { force: true })); } catch { /* ignore */ }
	}

	return { status: "done", steps: subtasks.length + startStep, result: finalResult, checkpointPath: lastCheckpointPath };
}

export function writeCancelSentinel(sessionId: string, dir?: string): void {
	const d = dir ?? join(homedir(), ".pilav");
	if (!existsSync(d)) mkdirSync(d, { recursive: true });
	writeFileSync(join(d, `cancel-${sessionId}`), "", "utf-8");
}
