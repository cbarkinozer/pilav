import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkCancelSignal, runTtsLoop, writeCancelSentinel } from "./loop.ts";
import { loadCheckpoint, listCheckpoints } from "./checkpoint.ts";
import { readStatus } from "./streaming.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CANCEL_DIR = join(homedir(), ".pilav");
const DEFAULT_CHECKPOINT_DIR = join(homedir(), ".pilav", "checkpoints");
const DEFAULT_STATUS_DIR = join(homedir(), ".pilav");

let currentSessionId: string | undefined;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tts-run", {
		description: "Start an extended reasoning session. Usage: /tts-run <task description>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /tts-run <task description>", "error");
				return;
			}
			const sessionId = `tts-${Date.now()}`;
			currentSessionId = sessionId;
			ctx.ui.notify(`Starting TTS session ${sessionId} for: ${task.slice(0, 80)}`, "info");

			// Run in background (fire-and-forget) so the command returns immediately
			void runTtsLoop(task, {
				sessionId,
				maxSteps: 20,
				checkpointDir: DEFAULT_CHECKPOINT_DIR,
				statusDir: DEFAULT_STATUS_DIR,
				cancelDir: DEFAULT_CANCEL_DIR,
			}, pi as never).then((result) => {
				ctx.ui.notify(`TTS ${sessionId} finished: ${result.status} after ${result.steps} steps`, "info");
			}).catch((err: unknown) => {
				ctx.ui.notify(`TTS ${sessionId} error: ${String(err)}`, "error");
			});
		},
	});

	pi.registerCommand("tts-status", {
		description: "Show current TTS session status.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const status = readStatus(DEFAULT_STATUS_DIR);
			if (!status) {
				ctx.ui.notify("No TTS session status found.", "info");
				return;
			}
			ctx.ui.notify(
				`Session ${status.sessionId}: ${status.status} — step ${status.step}/${status.totalSteps} — ${status.currentTask} (${Math.round(status.elapsedMs / 1000)}s elapsed)`,
				"info",
			);
			if (status.result) ctx.ui.notify(`Result: ${status.result.slice(0, 200)}`, "info");
		},
	});

	pi.registerCommand("tts-cancel", {
		description: "Cancel the current TTS session.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const sessionId = currentSessionId;
			if (!sessionId) {
				ctx.ui.notify("No active TTS session to cancel.", "info");
				return;
			}
			writeCancelSentinel(sessionId, DEFAULT_CANCEL_DIR);
			ctx.ui.notify(`Cancel signal sent for session ${sessionId}`, "info");
		},
	});

	pi.registerCommand("tts-resume", {
		description: "Resume an interrupted TTS session. Usage: /tts-resume <sessionId>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sessionId = args.trim();
			if (!sessionId) {
				// List available sessions
				const checkpoints = listCheckpoints(DEFAULT_CHECKPOINT_DIR);
				if (checkpoints.length === 0) {
					ctx.ui.notify("No checkpoints found.", "info");
					return;
				}
				const sessions = [...new Set(checkpoints.map((c) => c.sessionId))].slice(0, 5);
				ctx.ui.notify(`Available sessions: ${sessions.join(", ")}`, "info");
				return;
			}

			const checkpoint = loadCheckpoint(sessionId, DEFAULT_CHECKPOINT_DIR);
			if (!checkpoint) {
				ctx.ui.notify(`No checkpoint found for session ${sessionId}`, "error");
				return;
			}

			currentSessionId = sessionId;
			ctx.ui.notify(`Resuming ${sessionId} from step ${checkpoint.step}: ${checkpoint.currentTask}`, "info");

			void runTtsLoop(checkpoint.currentTask, {
				sessionId,
				maxSteps: checkpoint.totalSteps,
				checkpointDir: DEFAULT_CHECKPOINT_DIR,
				statusDir: DEFAULT_STATUS_DIR,
				cancelDir: DEFAULT_CANCEL_DIR,
				resumeFrom: checkpoint.checkpointId,
			}, pi as never).then((result) => {
				ctx.ui.notify(`TTS ${sessionId} resumed and finished: ${result.status} after ${result.steps} steps`, "info");
			}).catch((err: unknown) => {
				ctx.ui.notify(`TTS ${sessionId} resume error: ${String(err)}`, "error");
			});
		},
	});
}
