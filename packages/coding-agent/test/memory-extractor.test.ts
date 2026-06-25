/**
 * Phase 3 — T002: extractor.ts
 * Tests for fact extraction from conversations via LM Studio HTTP.
 *
 * Uses a minimal in-process HTTP server to mock LM Studio responses so tests
 * pass without a live LM Studio instance.
 *
 * TDD: written before implementation. Expected to fail until extractor.ts exists.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getFacts, initDb } from "../examples/extensions/memory/db.ts";
// These will fail to import until extractor.ts is created
import { extractAndSaveFacts, extractFacts } from "../examples/extensions/memory/extractor.ts";

// ─── Mini HTTP server that mimics LM Studio /v1/chat/completions ──────────────

type MockServer = { url: string; setResponse: (json: object) => void; close: () => Promise<void> };

function startMockLmStudio(): Promise<MockServer> {
	let responseJson: object = {
		choices: [
			{
				message: {
					content: JSON.stringify([
						{ subject: "user", predicate: "prefers", object: "TypeScript", confidence: 0.9 },
					]),
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("extractFacts", () => {
	let mock: MockServer;
	let originalUrl: string | undefined;

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

	it("extractFacts returns an array of fact objects", async () => {
		const facts = await extractFacts("I prefer TypeScript", "TypeScript is a great choice");
		expect(Array.isArray(facts)).toBe(true);
	});

	it("extractFacts returns objects with subject, predicate, object, confidence", async () => {
		mock.setResponse({
			choices: [
				{
					message: {
						content: JSON.stringify([
							{ subject: "user", predicate: "prefers", object: "TypeScript", confidence: 0.9 },
						]),
					},
				},
			],
		});
		const facts = await extractFacts("I prefer TypeScript", "TypeScript is a great choice");
		expect(facts.length).toBeGreaterThanOrEqual(1);
		const f = facts[0];
		expect(typeof f.subject).toBe("string");
		expect(typeof f.predicate).toBe("string");
		expect(typeof f.object).toBe("string");
		expect(typeof f.confidence).toBe("number");
	});

	it("extractFacts returns empty array when LM Studio returns invalid JSON", async () => {
		mock.setResponse({ choices: [{ message: { content: "not valid json at all" } }] });
		const facts = await extractFacts("hello", "hi");
		expect(Array.isArray(facts)).toBe(true);
		expect(facts).toHaveLength(0);
	});

	it("extractFacts returns empty array when LM Studio is unreachable", async () => {
		const savedUrl = process.env.LM_STUDIO_URL;
		process.env.LM_STUDIO_URL = "http://127.0.0.1:19999/v1"; // nothing listening
		const facts = await extractFacts("hello", "hi");
		expect(Array.isArray(facts)).toBe(true);
		expect(facts).toHaveLength(0);
		process.env.LM_STUDIO_URL = savedUrl;
	});
});

describe("extractAndSaveFacts", () => {
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
		tempDir = join(tmpdir(), `pi-p3-ext-save-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("extractAndSaveFacts saves extracted facts to the db", async () => {
		mock.setResponse({
			choices: [
				{
					message: {
						content: JSON.stringify([
							{ subject: "user", predicate: "uses", object: "SQLite", confidence: 0.85 },
						]),
					},
				},
			],
		});
		await extractAndSaveFacts("I use SQLite for everything", "Good choice for embedded storage", dbPath);
		const facts = getFacts(10, dbPath);
		expect(facts.length).toBeGreaterThanOrEqual(1);
		const saved = facts.find((f) => f.object === "SQLite");
		expect(saved).toBeDefined();
	});

	it("extractAndSaveFacts does not throw when LM Studio is unreachable", async () => {
		const savedUrl = process.env.LM_STUDIO_URL;
		process.env.LM_STUDIO_URL = "http://127.0.0.1:19999/v1";
		await expect(extractAndSaveFacts("hello", "hi", dbPath)).resolves.not.toThrow();
		process.env.LM_STUDIO_URL = savedUrl;
	});
});
