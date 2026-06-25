/**
 * Phase 5 — checkpoint.ts integration tests
 * TDD: written before implementation. Expected to fail until checkpoint.ts exists.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type CheckpointData,
	deleteCheckpoints,
	listCheckpoints,
	loadCheckpoint,
	saveCheckpoint,
} from "../checkpoint.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-tts-ckpt-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const BASE: CheckpointData = {
	sessionId: "test-session-1",
	checkpointId: "ckpt-001",
	timestamp: new Date().toISOString(),
	elapsedMs: 1000,
	step: 1,
	totalSteps: 10,
	currentTask: "Analyze repository",
	context: { messages: [], toolResults: [], scratchpad: "initial thoughts" },
	status: "working",
};

describe("saveCheckpoint", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("writes a JSON file to the checkpoint directory", () => {
		const path = saveCheckpoint(BASE, dir);
		expect(existsSync(path)).toBe(true);
		expect(path).toContain(BASE.sessionId);
	});

	it("returns a path ending in .json", () => {
		const path = saveCheckpoint(BASE, dir);
		expect(path.endsWith(".json")).toBe(true);
	});

	it("written file parses back to the original data", async () => {
		const { readFileSync } = await import("node:fs");
		const path = saveCheckpoint(BASE, dir);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as CheckpointData;
		expect(parsed.sessionId).toBe(BASE.sessionId);
		expect(parsed.step).toBe(BASE.step);
		expect(parsed.currentTask).toBe(BASE.currentTask);
	});
});

describe("loadCheckpoint", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns null for unknown sessionId", () => {
		expect(loadCheckpoint("no-such-session", dir)).toBeNull();
	});

	it("returns the checkpoint with the highest step number", () => {
		saveCheckpoint({ ...BASE, step: 1, checkpointId: "ckpt-001" }, dir);
		saveCheckpoint({ ...BASE, step: 5, checkpointId: "ckpt-005" }, dir);
		saveCheckpoint({ ...BASE, step: 3, checkpointId: "ckpt-003" }, dir);
		const loaded = loadCheckpoint(BASE.sessionId, dir);
		expect(loaded).not.toBeNull();
		expect(loaded!.step).toBe(5);
	});

	it("round-trip: save then load returns identical data", () => {
		saveCheckpoint(BASE, dir);
		const loaded = loadCheckpoint(BASE.sessionId, dir);
		expect(loaded).not.toBeNull();
		expect(loaded!.sessionId).toBe(BASE.sessionId);
		expect(loaded!.context.scratchpad).toBe("initial thoughts");
	});
});

describe("listCheckpoints", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns empty array when directory is empty", () => {
		expect(listCheckpoints(dir)).toHaveLength(0);
	});

	it("returns all checkpoints sorted newest (highest step) first", () => {
		saveCheckpoint({ ...BASE, step: 2, checkpointId: "ckpt-002" }, dir);
		saveCheckpoint({ ...BASE, step: 5, checkpointId: "ckpt-005" }, dir);
		saveCheckpoint({ ...BASE, step: 1, checkpointId: "ckpt-001" }, dir);
		const list = listCheckpoints(dir);
		expect(list).toHaveLength(3);
		expect(list[0].step).toBe(5);
		expect(list[2].step).toBe(1);
	});
});

describe("deleteCheckpoints", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("removes all checkpoints for the given sessionId", () => {
		saveCheckpoint({ ...BASE, step: 1, checkpointId: "ckpt-001" }, dir);
		saveCheckpoint({ ...BASE, step: 2, checkpointId: "ckpt-002" }, dir);
		deleteCheckpoints(BASE.sessionId, dir);
		expect(listCheckpoints(dir)).toHaveLength(0);
	});

	it("does not delete checkpoints for other sessions", () => {
		saveCheckpoint({ ...BASE, step: 1, checkpointId: "ckpt-001" }, dir);
		saveCheckpoint({ ...BASE, sessionId: "other-session", step: 1, checkpointId: "ckpt-001" }, dir);
		deleteCheckpoints(BASE.sessionId, dir);
		const remaining = listCheckpoints(dir);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].sessionId).toBe("other-session");
	});
});
