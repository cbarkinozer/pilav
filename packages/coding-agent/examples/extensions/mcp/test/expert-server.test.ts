/**
 * T003 — ask_expert MCP tool tests (TDD: written before implementation)
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { askExpert, type AskExpertOptions } from "../servers/expert.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pilav-expert-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("askExpert — happy path", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("writes request file and returns guidance from pre-written response file", async () => {
		const opts: AskExpertOptions = { pilav_dir: dir, poll_interval_ms: 10, timeout_ms: 2000 };

		// Pre-write a response so askExpert doesn't have to wait
		const responsePayload = { guidance: "Use a BFS traversal instead of DFS here." };
		writeFileSync(join(dir, "expert-response.json"), JSON.stringify(responsePayload), "utf-8");

		const result = await askExpert("The agent is stuck in an infinite DFS loop.", opts);

		expect(result).toContain("BFS");
		expect(existsSync(join(dir, "expert-request.json"))).toBe(true);
	});

	it("request file contains the question text", async () => {
		const opts: AskExpertOptions = { pilav_dir: dir, poll_interval_ms: 10, timeout_ms: 2000 };

		writeFileSync(join(dir, "expert-response.json"), JSON.stringify({ guidance: "ok" }), "utf-8");
		await askExpert("How should I handle the auth edge case?", opts);

		const req = JSON.parse(require("node:fs").readFileSync(join(dir, "expert-request.json"), "utf-8")) as { question: string; timestamp: string };
		expect(req.question).toBe("How should I handle the auth edge case?");
		expect(req.timestamp).toBeTruthy();
	});
});

describe("askExpert — timeout", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("resolves with a timeout message if no response arrives within timeout_ms", async () => {
		const opts: AskExpertOptions = { pilav_dir: dir, poll_interval_ms: 10, timeout_ms: 100 };

		// No response file written — should time out quickly
		const result = await askExpert("Will this ever be answered?", opts);

		expect(result).toMatch(/timeout|no response|timed out/i);
	});

	it("never throws even on timeout", async () => {
		const opts: AskExpertOptions = { pilav_dir: dir, poll_interval_ms: 10, timeout_ms: 50 };

		await expect(askExpert("Question with no answer", opts)).resolves.toBeDefined();
	});
});
