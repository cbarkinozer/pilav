/**
 * Integration tests for the SQLite memory store with FTS5 full-text search.
 *
 * Target implementation: packages/coding-agent/examples/extensions/memory/db.ts
 *
 * These tests are written TDD-style BEFORE the implementation exists and are
 * expected to FAIL until db.ts is created.
 *
 * All tests use a per-test temp database path to avoid ~/.pi side effects
 * and to keep each test fully isolated.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Helper: create a fresh temp DB path for each test so tests never share state.
// ──────────────────────────────────────────────────────────────────────────────
let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-db-test-"));
});

afterEach(() => {
	if (tempDir && fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
	// Clear any cached DB singleton so the next test gets a fresh one.
	// The implementation must honour DB_PATH env var (or an initDb(path) override)
	// to make this work in CI without touching ~/.pi.
	delete process.env.DB_PATH;
});

// Dynamically import the module under test so each test can point it at a
// different file path via the DB_PATH environment variable.
async function loadDb(dbPath: string) {
	process.env.DB_PATH = dbPath;
	// Force a fresh module import for every test.  Vitest caches modules across
	// the test file by default, so we bust the cache with a timestamp query
	// parameter – the implementation should not care about the URL query string.
	const url = new URL(`../examples/extensions/memory/db.ts?t=${Date.now()}`, import.meta.url);
	const mod = await import(url.href);
	return mod as {
		initDb: (dbPath?: string) => void;
		insertExchange: (sessionId: string, userPrompt: string, assistantReply: string, dbPath?: string) => void;
		searchExchanges: (
			query: string,
			limit: number,
			dbPath?: string,
		) => Array<{ session_id: string; user_prompt: string; assistant_reply: string }>;
		setProfile: (key: string, value: string, dbPath?: string) => void;
		getProfile: (key: string, dbPath?: string) => string | undefined;
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("memory/db.ts — SQLite memory store with FTS5", () => {
	describe("FTS5 full-text search (stemming)", () => {
		it("insertExchange writes a row and searchExchanges finds it by exact word", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			db.insertExchange("session-1", "running tests", "all passed", dbPath);
			const results = db.searchExchanges("running", 10, dbPath);

			expect(results).toBeInstanceOf(Array);
			expect(results.length).toBeGreaterThanOrEqual(1);
			const hit = results.find((r) => r.user_prompt === "running tests");
			expect(hit).toBeDefined();
		});

		it("FTS5 porter tokenizer finds 'running tests' when querying stem 'run'", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			db.insertExchange("session-1", "running tests", "all passed", dbPath);
			const results = db.searchExchanges("run", 10, dbPath);

			// FTS5 with porter tokenizer must stem 'running' → 'run', so the query
			// 'run' should return the row inserted with user_prompt 'running tests'.
			expect(results).toBeInstanceOf(Array);
			expect(results.length).toBeGreaterThanOrEqual(1);
			const hit = results.find((r) => r.user_prompt === "running tests");
			expect(hit).toBeDefined();
			expect(hit?.session_id).toBe("session-1");
		});

		it("searchExchanges returns an empty array when nothing matches", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			db.insertExchange("session-1", "running tests", "all passed", dbPath);
			const results = db.searchExchanges("xyzzy42notaword", 10, dbPath);

			expect(results).toBeInstanceOf(Array);
			expect(results).toHaveLength(0);
		});

		it("insertExchange called twice with different sessions; search returns only the matching one", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			db.insertExchange("session-alpha", "running tests", "all passed", dbPath);
			db.insertExchange("session-beta", "cooking recipes", "here are some dishes", dbPath);

			const results = db.searchExchanges("run", 10, dbPath);

			expect(results).toBeInstanceOf(Array);
			expect(results).toHaveLength(1);
			expect(results[0]?.session_id).toBe("session-alpha");
			expect(results[0]?.user_prompt).toBe("running tests");
		});
	});

	describe("profile key/value store", () => {
		it("setProfile followed by getProfile returns the stored value", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			db.setProfile("name", "Alice", dbPath);
			const value = db.getProfile("name", dbPath);

			expect(value).toBe("Alice");
		});

		it("getProfile returns undefined for a key that has never been set", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			const value = db.getProfile("missing_key_that_was_never_set", dbPath);

			expect(value).toBeUndefined();
		});

		it("setProfile overwrites a previously stored value (upsert semantics)", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			db.setProfile("name", "Alice", dbPath);
			db.setProfile("name", "Bob", dbPath);
			const value = db.getProfile("name", dbPath);

			expect(value).toBe("Bob");
		});
	});

	describe("idempotent schema setup (IF NOT EXISTS)", () => {
		it("calling initDb twice on the same path does not throw", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			expect(() => db.initDb(dbPath)).not.toThrow();
			// Second call — schema tables and FTS5 virtual table already exist.
			expect(() => db.initDb(dbPath)).not.toThrow();
		});

		it("calling insertExchange and searchExchanges twice in the same process does not throw", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			expect(() => {
				db.insertExchange("s1", "first prompt", "first reply", dbPath);
			}).not.toThrow();
			expect(() => {
				db.insertExchange("s2", "second prompt", "second reply", dbPath);
			}).not.toThrow();

			let results: ReturnType<typeof db.searchExchanges>;
			expect(() => {
				results = db.searchExchanges("first", 10, dbPath);
			}).not.toThrow();
			expect(() => {
				db.searchExchanges("second", 10, dbPath);
			}).not.toThrow();

			expect(results!).toHaveLength(1);
			expect(results![0]?.session_id).toBe("s1");
		});
	});

	describe("module exports", () => {
		it("db.ts exports all four required functions", async () => {
			const dbPath = path.join(tempDir, "test.db");
			const db = await loadDb(dbPath);

			expect(typeof db.initDb).toBe("function");
			expect(typeof db.insertExchange).toBe("function");
			expect(typeof db.searchExchanges).toBe("function");
			expect(typeof db.setProfile).toBe("function");
			expect(typeof db.getProfile).toBe("function");
		});
	});
});
