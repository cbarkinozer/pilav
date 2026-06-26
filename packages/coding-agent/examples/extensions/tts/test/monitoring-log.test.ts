/**
 * T005 — Per-step monitoring log tests (TDD)
 */

import { createReadStream, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTtsLoop } from "../loop.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pilav-mon-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function readJsonl(filePath: string): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const lines: unknown[] = [];
		const rl = createInterface({ input: createReadStream(filePath) });
		rl.on("line", (l) => { if (l.trim()) lines.push(JSON.parse(l)); });
		rl.on("close", () => resolve(lines));
		rl.on("error", reject);
	});
}

describe("monitoring log", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); mkdirSync(join(dir, "logs"), { recursive: true }); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("writes at least one JSONL entry per step", async () => {
		const pi = {
			sendMessage: async (msg: string) => {
				if (msg.includes("Break it into")) return "1. Step one\n2. Step two";
				return "Here is the complete detailed response covering all aspects of the requested subtask.";
			},
		};

		await runTtsLoop("Test task", {
			sessionId: "sess-mon-1",
			maxSteps: 3,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
			logDir: join(dir, "logs"),
		}, pi);

		const entries = await readJsonl(join(dir, "logs", "sessions.jsonl")) as Array<Record<string, unknown>>;
		expect(entries.length).toBeGreaterThanOrEqual(1);
	});

	it("each entry has required fields: timestamp, sessionId, step, model, responseLength, latencyMs, status", async () => {
		const pi = {
			sendMessage: async (msg: string) => {
				if (msg.includes("Break it into")) return "1. Only step";
				return "A sufficiently long response that covers the full scope of the requested task execution.";
			},
		};

		await runTtsLoop("Single step task", {
			sessionId: "sess-mon-2",
			maxSteps: 2,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
			logDir: join(dir, "logs"),
		}, pi);

		const entries = await readJsonl(join(dir, "logs", "sessions.jsonl")) as Array<Record<string, unknown>>;
		expect(entries.length).toBeGreaterThanOrEqual(1);
		const entry = entries[0] as Record<string, unknown>;
		expect(entry).toHaveProperty("timestamp");
		expect(entry).toHaveProperty("sessionId", "sess-mon-2");
		expect(entry).toHaveProperty("step");
		expect(entry).toHaveProperty("model");
		expect(entry).toHaveProperty("responseLength");
		expect(entry).toHaveProperty("latencyMs");
		expect(entry).toHaveProperty("status");
	});

	it("records retries and escalated flag when stuck", async () => {
		let callCount = 0;
		const pi = {
			sendMessage: async (msg: string) => {
				callCount++;
				if (callCount === 1) return "1. The only subtask to execute"; // plan
				if (callCount <= 3) return "ok"; // stuck
				return "A fully detailed response covering all necessary aspects of the task.";
			},
		};

		const expertFn = async () => "Try a different approach with more detail.";

		await runTtsLoop("Stuck task", {
			sessionId: "sess-mon-3",
			maxSteps: 2,
			checkpointDir: dir,
			statusDir: dir,
			cancelDir: dir,
			logDir: join(dir, "logs"),
			expertFn,
		}, pi);

		const entries = await readJsonl(join(dir, "logs", "sessions.jsonl")) as Array<Record<string, unknown>>;
		const stepEntry = entries.find((e) => (e as Record<string, unknown>).step === 1) as Record<string, unknown> | undefined;
		expect(stepEntry).toBeDefined();
		expect(stepEntry!.retries).toBeGreaterThanOrEqual(1);
	});
});
