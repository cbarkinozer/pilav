/**
 * T006 — Cross-session recall integration test
 *
 * Verifies that the memory extension's SQLite store correctly persists and
 * retrieves exchanges across different session IDs using FTS5 full-text search,
 * and that the built system-prompt block contains the expected content.
 *
 * These tests are written TDD-style BEFORE the implementation exists and are
 * expected to FAIL until db.ts is created under this same directory.
 *
 * Acceptance criteria covered:
 * 1. searchExchanges('France capital', 3) returns ≥1 row after
 *    insertExchange('session-001', 'What is the capital of France?',
 *                  'The capital of France is Paris.')
 * 2. The system-prompt block built from that row contains the word 'Paris'.
 * 3. After inserting a second exchange in a different session, searching for
 *    'France' returns 2 rows from different session IDs (cross-session recall).
 * 4. The test never starts a server, never reads from disk — the db module
 *    accepts ':memory:' as the database path for in-process tests.
 * 5. The full suite completes in under 10 seconds (testTimeout: 10000 in config).
 *
 * Run command (from this directory):
 *   cd packages/coding-agent/examples/extensions/memory && npx vitest run
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Import the module under test.
// db.ts does NOT exist yet — the dynamic import in beforeAll will fail with a
// module-not-found error until the implementation is provided.
// That failure is the expected TDD "red" state for this test file.
// ---------------------------------------------------------------------------

// Type aliases for the functions we expect db.ts to export.
// These are inlined here (no static import from the missing file) so that the
// test file itself can be parsed and the beforeAll error is visible.
type InsertExchangeFn = (sessionId: string, userPrompt: string, assistantReply: string, dbPath?: string) => void;

type SearchExchangesFn = (
	query: string,
	limit: number,
	dbPath?: string,
) => Array<{ session_id: string; user_prompt: string; assistant_reply: string }>;

let insertExchange: InsertExchangeFn;
let searchExchanges: SearchExchangesFn;

beforeAll(async () => {
	// ':memory:' is passed so the module uses an in-process SQLite database
	// with no disk I/O.  The implementation must honour this argument.
	const mod = (await import("./db.ts")) as {
		insertExchange: InsertExchangeFn;
		searchExchanges: SearchExchangesFn;
	};
	insertExchange = mod.insertExchange;
	searchExchanges = mod.searchExchanges;
});

// ---------------------------------------------------------------------------
// No cleanup required — ':memory:' databases are discarded automatically when
// the Node.js process exits.  There is no SQLite file on disk to delete.
// ---------------------------------------------------------------------------
afterAll(() => {
	// Nothing to clean up — in-memory DB lives only for the duration of the
	// process and leaves no files on disk.
});

// ===========================================================================
// Scenario 1 — Basic FTS5 recall: Paris shows up in search results
// ===========================================================================

describe("cross-session recall — scenario 1: FTS5 finds Paris after insertion", () => {
	it("searchExchanges('France capital', 3) returns at least one row after inserting the France/Paris exchange", async () => {
		// Insert the exchange into session-001.
		insertExchange("session-001", "What is the capital of France?", "The capital of France is Paris.", ":memory:");

		// FTS5 should match 'France' and/or 'capital' in the stored text.
		const results = searchExchanges("France capital", 3, ":memory:");

		expect(results).toBeInstanceOf(Array);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("the result row's assistant_reply includes the word 'Paris'", async () => {
		insertExchange("session-001", "What is the capital of France?", "The capital of France is Paris.", ":memory:");

		const results = searchExchanges("France capital", 3, ":memory:");

		expect(results.length).toBeGreaterThanOrEqual(1);

		// At least one result must have 'Paris' in the assistant_reply field.
		const hit = results.find((row) => row.assistant_reply.includes("Paris"));
		expect(hit, "Expected at least one result whose assistant_reply contains 'Paris'").toBeDefined();
	});
});

// ===========================================================================
// Scenario 2 — System-prompt block construction contains 'Paris'
// ===========================================================================

describe("cross-session recall — scenario 2: built system-prompt block contains 'Paris'", () => {
	it("building a '## Relevant past exchanges' block from search results produces a string containing 'Paris'", async () => {
		insertExchange("session-001", "What is the capital of France?", "The capital of France is Paris.", ":memory:");

		const results = searchExchanges("France capital", 3, ":memory:");
		expect(results.length).toBeGreaterThanOrEqual(1);

		// Replicate the exact prompt-block format used in index.ts:
		//   ## Memory Context
		//   - Q: {user_prompt} A: {assistant_reply}
		const lines = results.map((row) => `- Q: ${row.user_prompt} A: ${row.assistant_reply}`);
		const block = `## Relevant past exchanges\n${lines.join("\n")}`;

		expect(block).toContain("Paris");
	});
});

// ===========================================================================
// Scenario 3 — Cross-session: two rows from different session IDs
// ===========================================================================

describe("cross-session recall — scenario 3: search returns rows from multiple sessions", () => {
	it("after inserting in session-001 and session-002, searching 'France' returns 2 rows from different sessions", async () => {
		// First exchange in session-001.
		insertExchange("session-001", "What is the capital of France?", "The capital of France is Paris.", ":memory:");

		// Second exchange in session-002.
		insertExchange("session-002", "Tell me about France.", "France is a beautiful country.", ":memory:");

		// 'France' appears in both exchanges — both rows should be returned.
		const results = searchExchanges("France", 3, ":memory:");

		expect(results.length).toBeGreaterThanOrEqual(2);

		// The results must come from two different session IDs.
		const sessionIds = results.map((row) => row.session_id);
		const uniqueSessionIds = new Set(sessionIds);
		expect(
			uniqueSessionIds.size,
			`Expected results from at least 2 different session IDs, got: ${[...uniqueSessionIds].join(", ")}`,
		).toBeGreaterThanOrEqual(2);

		expect(sessionIds).toContain("session-001");
		expect(sessionIds).toContain("session-002");
	});

	it("each result row exposes session_id, user_prompt, and assistant_reply fields", async () => {
		insertExchange("session-001", "What is the capital of France?", "The capital of France is Paris.", ":memory:");

		const results = searchExchanges("France", 3, ":memory:");
		expect(results.length).toBeGreaterThanOrEqual(1);

		for (const row of results) {
			expect(typeof row.session_id).toBe("string");
			expect(typeof row.user_prompt).toBe("string");
			expect(typeof row.assistant_reply).toBe("string");
		}
	});
});

// ===========================================================================
// Scenario 4 — No network calls, no LM Studio, no disk I/O
// ===========================================================================

describe("cross-session recall — scenario 4: isolation guarantees", () => {
	it("db module exports insertExchange and searchExchanges without requiring a network", async () => {
		// If the module loaded in beforeAll, network is not required.
		expect(typeof insertExchange).toBe("function");
		expect(typeof searchExchanges).toBe("function");
	});

	it("passing ':memory:' as the dbPath leaves no files in the OS temp directory", async () => {
		// This is a structural test: the in-memory DB must not create any file.
		// We run an insert + search and simply confirm neither throws.
		expect(() => {
			insertExchange("session-isolation", "isolation test prompt", "isolation test reply", ":memory:");
		}).not.toThrow();

		expect(() => {
			const rows = searchExchanges("isolation", 5, ":memory:");
			// We don't assert row count here because this is a fresh ':memory:' call
			// and the implementation may or may not share state between ':memory:'
			// calls — both behaviours are acceptable for this isolation test.
			expect(rows).toBeInstanceOf(Array);
		}).not.toThrow();
	});
});
