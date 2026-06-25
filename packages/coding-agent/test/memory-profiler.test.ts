/**
 * Phase 3 — T003: profiler.ts
 * Tests for dialectic user profile consolidation.
 *
 * TDD: written before implementation. Expected to fail until profiler.ts exists.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getProfile, initDb, insertExchange } from "../examples/extensions/memory/db.ts";
// Will fail until profiler.ts is created
import { consolidateProfile, shouldConsolidate } from "../examples/extensions/memory/profiler.ts";

type MockServer = { url: string; setResponse: (json: object) => void; close: () => Promise<void> };

function startMockLmStudio(): Promise<MockServer> {
	let responseJson: object = {
		choices: [
			{
				message: {
					content: JSON.stringify({
						synthesis: "The user is a TypeScript developer working on Mac Mini M4.",
						thesis: "User prefers TypeScript, SQLite, and local AI models.",
						antithesis: "No strong contradictions observed yet.",
					}),
				},
			},
		],
	};

	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(responseJson));
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${addr.port}/v1`,
				setResponse: (json: object) => {
					responseJson = json;
				},
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

describe("shouldConsolidate", () => {
	let dbPath: string;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-prof-should-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns false when exchange count is 0", () => {
		expect(shouldConsolidate(5, dbPath)).toBe(false);
	});

	it("returns false when count is not a multiple of threshold", () => {
		insertExchange("s1", "hello", "hi", dbPath);
		insertExchange("s2", "bye", "goodbye", dbPath);
		expect(shouldConsolidate(5, dbPath)).toBe(false);
	});

	it("returns true when count is exactly a multiple of threshold", () => {
		for (let i = 0; i < 5; i++) {
			insertExchange(`s${i}`, `msg ${i}`, `reply ${i}`, dbPath);
		}
		expect(shouldConsolidate(5, dbPath)).toBe(true);
	});

	it("returns true at 10 with threshold 5", () => {
		for (let i = 0; i < 10; i++) {
			insertExchange(`s${i}`, `msg ${i}`, `reply ${i}`, dbPath);
		}
		expect(shouldConsolidate(5, dbPath)).toBe(true);
	});
});

describe("consolidateProfile", () => {
	let mock: MockServer;
	let originalUrl: string | undefined;
	let dbPath: string;
	let tempDir: string;

	beforeAll(async () => {
		mock = await startMockLmStudio();
		originalUrl = process.env.LM_STUDIO_URL;
		process.env.LM_STUDIO_URL = mock.url;
	});

	afterAll(async () => {
		if (originalUrl !== undefined) process.env.LM_STUDIO_URL = originalUrl;
		else delete process.env.LM_STUDIO_URL;
		await mock.close();
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-prof-cons-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
		// Seed some exchanges
		insertExchange("s1", "I prefer TypeScript", "Great choice", dbPath);
		insertExchange("s2", "I work on Mac Mini M4", "Nice machine", dbPath);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("consolidateProfile saves user_profile_synthesis to profile table", async () => {
		await consolidateProfile(dbPath);
		const synthesis = getProfile("user_profile_synthesis", dbPath);
		expect(synthesis).toBeDefined();
		expect(typeof synthesis).toBe("string");
		expect(synthesis!.length).toBeGreaterThan(0);
	});

	it("consolidateProfile saves user_profile_thesis", async () => {
		await consolidateProfile(dbPath);
		const thesis = getProfile("user_profile_thesis", dbPath);
		expect(thesis).toBeDefined();
	});

	it("consolidateProfile saves user_profile_antithesis", async () => {
		await consolidateProfile(dbPath);
		const antithesis = getProfile("user_profile_antithesis", dbPath);
		expect(antithesis).toBeDefined();
	});

	it("consolidateProfile does not throw when LM Studio is unreachable", async () => {
		const savedUrl = process.env.LM_STUDIO_URL;
		process.env.LM_STUDIO_URL = "http://127.0.0.1:19999/v1";
		await expect(consolidateProfile(dbPath)).resolves.not.toThrow();
		process.env.LM_STUDIO_URL = savedUrl;
	});

	it("consolidateProfile handles malformed LM Studio response gracefully", async () => {
		mock.setResponse({ choices: [{ message: { content: "not json" } }] });
		await expect(consolidateProfile(dbPath)).resolves.not.toThrow();
		// synthesis may be undefined or a fallback string — either is acceptable
	});
});
