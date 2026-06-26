/**
 * T004 — Expert escalation integration tests (TDD)
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTtsLoop } from "../loop.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pilav-esc-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("runTtsLoop — expert escalation", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("calls expertFn when stuck after first retry", async () => {
		const expertFn = vi.fn().mockResolvedValue("Use iterative approach instead.");
		let callCount = 0;

		// First call = plan (returns subtasks), next calls = stuck short responses, then normal
		const pi = {
			sendMessage: vi.fn().mockImplementation(async (msg: string) => {
				callCount++;
				if (callCount === 1) return "1. Analyze the code\n2. Report findings"; // plan
				if (callCount <= 3) return "ok"; // stuck: too short
				return "Here is a detailed analysis of the code that covers all the important aspects and findings.";
			}),
		};

		const result = await runTtsLoop("Analyze codebase", {
			sessionId: "sess-esc-1",
			maxSteps: 3,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
			expertFn,
		}, pi);

		expect(expertFn).toHaveBeenCalled();
		expect(result.status).toBe("done");
	});

	it("prepends expert guidance to retry prompt after escalation", async () => {
		const guidance = "Focus on the authentication module specifically.";
		const expertFn = vi.fn().mockResolvedValue(guidance);
		const promptsSeen: string[] = [];

		let callCount = 0;
		const pi = {
			sendMessage: vi.fn().mockImplementation(async (msg: string) => {
				promptsSeen.push(msg);
				callCount++;
				if (callCount === 1) return "1. Check auth module"; // plan
				if (callCount === 2) return "ok"; // stuck — retry 1
				if (callCount === 3) return "ok"; // stuck — triggers escalation
				return "Here is a thorough analysis of the authentication module with all relevant details.";
			}),
		};

		await runTtsLoop("Check auth", {
			sessionId: "sess-esc-2",
			maxSteps: 2,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
			expertFn,
		}, pi);

		// One of the later prompts should contain the guidance text
		const escalatedPrompt = promptsSeen.find((p) => p.includes(guidance));
		expect(escalatedPrompt).toBeDefined();
	});

	it("runs normally without expertFn (no escalation)", async () => {
		const pi = {
			sendMessage: vi.fn().mockImplementation(async (msg: string) => {
				if (msg.includes("Break it into")) return "1. Do the thing";
				return "Here is the complete and detailed result of executing the subtask as requested.";
			}),
		};

		const result = await runTtsLoop("Simple task", {
			sessionId: "sess-esc-3",
			maxSteps: 2,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
			// no expertFn
		}, pi);

		expect(result.status).toBe("done");
	});
});
