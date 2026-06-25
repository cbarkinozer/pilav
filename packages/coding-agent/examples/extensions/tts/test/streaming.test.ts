/**
 * Phase 5 — streaming.ts integration tests
 * TDD: written before implementation. Expected to fail until streaming.ts exists.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type TtsStatus, pushStatus, readStatus } from "../streaming.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-tts-stream-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const BASE_STATUS: TtsStatus = {
	sessionId: "sess-123",
	step: 3,
	totalSteps: 10,
	currentTask: "Analyzing codebase",
	elapsedMs: 5000,
	status: "working",
};

describe("pushStatus", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("creates tts-status.json in the given directory", () => {
		pushStatus(BASE_STATUS, dir);
		expect(existsSync(join(dir, "tts-status.json"))).toBe(true);
	});

	it("overwrites previous status", () => {
		pushStatus(BASE_STATUS, dir);
		pushStatus({ ...BASE_STATUS, step: 5 }, dir);
		const status = readStatus(dir);
		expect(status?.step).toBe(5);
	});
});

describe("readStatus", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns null when no status file exists", () => {
		expect(readStatus(dir)).toBeNull();
	});

	it("returns the status written by pushStatus", () => {
		pushStatus(BASE_STATUS, dir);
		const status = readStatus(dir);
		expect(status).not.toBeNull();
		expect(status!.sessionId).toBe("sess-123");
		expect(status!.currentTask).toBe("Analyzing codebase");
		expect(status!.status).toBe("working");
	});

	it("round-trip preserves all fields", () => {
		const withResult: TtsStatus = { ...BASE_STATUS, status: "done", result: "Task complete: found 3 issues" };
		pushStatus(withResult, dir);
		const back = readStatus(dir);
		expect(back!.result).toBe("Task complete: found 3 issues");
		expect(back!.status).toBe("done");
	});
});
