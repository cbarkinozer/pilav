/**
 * Phase 5 — loop.ts integration tests (stub Pi API — no live LLM)
 * TDD: written before implementation. Expected to fail until loop.ts exists.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkCancelSignal, runTtsLoop } from "../loop.ts";
import { listCheckpoints, loadCheckpoint } from "../checkpoint.ts";
import { readStatus } from "../streaming.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-tts-loop-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// Minimal stub ExtensionAPI that auto-responds to sendMessage
function buildStubPi(responses: string[]) {
	let callCount = 0;
	const sentMessages: string[] = [];

	return {
		sendMessage: async (content: string) => {
			sentMessages.push(content);
			return responses[callCount++ % responses.length] ?? "Done.";
		},
		on: () => {},
		registerCommand: () => {},
		registerTool: () => {},
		registerProvider: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => undefined,
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: () => Promise.resolve(true),
		getThinkingLevel: () => "medium" as const,
		setThinkingLevel: () => {},
		unregisterProvider: () => {},
		events: { on: () => () => {}, emit: () => {} },
		_sentMessages: sentMessages,
	};
}

describe("checkCancelSignal", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns false when no sentinel file exists", () => {
		expect(checkCancelSignal("sess-abc", dir)).toBe(false);
	});

	it("returns true when sentinel file exists", () => {
		writeFileSync(join(dir, "cancel-sess-abc"), "");
		expect(checkCancelSignal("sess-abc", dir)).toBe(true);
	});
});

describe("runTtsLoop — basic completion", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns status done on successful completion", async () => {
		const pi = buildStubPi(["Subtask 1 complete", "Subtask 2 complete", "All done"]);
		const result = await runTtsLoop("Analyze the codebase", {
			sessionId: "sess-loop-1",
			maxSteps: 3,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
		}, pi as never);
		expect(result.status).toBe("done");
		expect(result.steps).toBeGreaterThan(0);
	});

	it("saves at least one checkpoint during the loop", async () => {
		const pi = buildStubPi(["Step done"]);
		await runTtsLoop("Simple task", {
			sessionId: "sess-loop-2",
			maxSteps: 2,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
		}, pi as never);
		const checkpoints = listCheckpoints(dir);
		expect(checkpoints.length).toBeGreaterThanOrEqual(1);
		expect(checkpoints[0].sessionId).toBe("sess-loop-2");
	});

	it("pushes status updates during execution", async () => {
		const pi = buildStubPi(["Step done"]);
		await runTtsLoop("Simple task", {
			sessionId: "sess-loop-3",
			maxSteps: 2,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
		}, pi as never);
		const status = readStatus(dir);
		expect(status).not.toBeNull();
		expect(["done", "working", "cancelled"]).toContain(status!.status);
	});
});

describe("runTtsLoop — cancel signal", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("stops early and returns status cancelled when sentinel exists", async () => {
		// Pre-write the cancel sentinel before the loop starts
		writeFileSync(join(dir, "cancel-sess-cancel-1"), "");
		const pi = buildStubPi(["Never reached"]);
		const result = await runTtsLoop("Long task", {
			sessionId: "sess-cancel-1",
			maxSteps: 10,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
		}, pi as never);
		expect(result.status).toBe("cancelled");
	});
});

describe("runTtsLoop — resume from checkpoint", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("resumes from a saved checkpoint and continues", async () => {
		// First run: save a checkpoint at step 2
		const pi1 = buildStubPi(["Step 1 done", "Step 2 done"]);
		await runTtsLoop("Long task", {
			sessionId: "sess-resume-1",
			maxSteps: 2,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
		}, pi1 as never);

		const checkpoint = loadCheckpoint("sess-resume-1", dir);
		expect(checkpoint).not.toBeNull();
		const resumeStep = checkpoint!.step;

		// Second run: resume — should start from where we left off
		const pi2 = buildStubPi(["Resumed step done"]);
		const result = await runTtsLoop("Long task", {
			sessionId: "sess-resume-1",
			maxSteps: resumeStep + 2,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
			resumeFrom: checkpoint!.checkpointId,
		}, pi2 as never);

		expect(result.status).toBe("done");
		// Resumed run should pick up from the prior step
		expect(result.steps).toBeGreaterThanOrEqual(1);
	});
});
