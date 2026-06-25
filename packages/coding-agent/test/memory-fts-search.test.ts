/**
 * Phase 3 — T001: db.ts new exports
 * Tests for: insertFact, getFacts, searchFacts, countExchanges, searchExchangesByRelevance
 *
 * TDD: written before implementation. Expected to fail until db.ts is extended.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// These imports will fail until db.ts exports them
import {
	countExchanges,
	getFacts,
	initDb,
	insertExchange,
	insertFact,
	searchExchangesByRelevance,
	searchFacts,
} from "../examples/extensions/memory/db.ts";

function makeTempDb(label: string): string {
	const dir = join(tmpdir(), `pi-p3-fts-${label}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memory.db");
}

describe("insertFact / getFacts", () => {
	let dbPath: string;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-fts-facts-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("insertFact stores a fact and getFacts retrieves it", () => {
		insertFact({ subject: "user", predicate: "prefers", object: "TypeScript", confidence: 0.9 }, dbPath);
		const facts = getFacts(10, dbPath);
		expect(facts).toHaveLength(1);
		expect(facts[0].subject).toBe("user");
		expect(facts[0].predicate).toBe("prefers");
		expect(facts[0].object).toBe("TypeScript");
		expect(facts[0].confidence).toBeCloseTo(0.9);
	});

	it("getFacts returns facts in insertion order DESC", () => {
		insertFact({ subject: "user", predicate: "uses", object: "SQLite", confidence: 0.8 }, dbPath);
		insertFact({ subject: "project", predicate: "runs-on", object: "Mac Mini M4", confidence: 0.95 }, dbPath);
		const facts = getFacts(10, dbPath);
		expect(facts[0].object).toBe("Mac Mini M4");
		expect(facts[1].object).toBe("SQLite");
	});

	it("getFacts respects limit", () => {
		for (let i = 0; i < 5; i++) {
			insertFact({ subject: "user", predicate: "fact", object: `value-${i}`, confidence: 0.5 }, dbPath);
		}
		const facts = getFacts(3, dbPath);
		expect(facts).toHaveLength(3);
	});

	it("getFacts returns empty array when no facts exist", () => {
		const facts = getFacts(10, dbPath);
		expect(facts).toHaveLength(0);
	});
});

describe("searchFacts — FTS5", () => {
	let dbPath: string;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-fts-sfacts-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
		insertFact({ subject: "user", predicate: "prefers", object: "TypeScript over Python", confidence: 0.9 }, dbPath);
		insertFact({ subject: "user", predicate: "uses", object: "SQLite for persistence", confidence: 0.8 }, dbPath);
		insertFact({ subject: "project", predicate: "runs-on", object: "Mac Mini M4", confidence: 0.95 }, dbPath);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("searchFacts finds facts matching query", () => {
		const results = searchFacts("TypeScript", 10, dbPath);
		expect(results.length).toBeGreaterThanOrEqual(1);
		const found = results.some((r) => r.object.includes("TypeScript"));
		expect(found).toBe(true);
	});

	it("searchFacts returns empty array for no matches", () => {
		const results = searchFacts("golang", 10, dbPath);
		expect(results).toHaveLength(0);
	});

	it("searchFacts returns empty array for empty query", () => {
		const results = searchFacts("", 10, dbPath);
		expect(results).toHaveLength(0);
	});
});

describe("countExchanges", () => {
	let dbPath: string;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-fts-count-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("countExchanges returns 0 for empty db", () => {
		expect(countExchanges(dbPath)).toBe(0);
	});

	it("countExchanges increments after insertExchange", () => {
		insertExchange("s1", "hello", "hi there", dbPath);
		insertExchange("s2", "how are you", "fine", dbPath);
		expect(countExchanges(dbPath)).toBe(2);
	});
});

describe("searchExchangesByRelevance — BM25 ranking", () => {
	let dbPath: string;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-fts-rank-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
		insertExchange("s1", "I love TypeScript and use it daily", "Great choice!", dbPath);
		insertExchange("s2", "what is the weather today", "I don't know", dbPath);
		insertExchange(
			"s3",
			"TypeScript TypeScript TypeScript is my primary language",
			"Clearly you're a TypeScript fan",
			dbPath,
		);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("searchExchangesByRelevance returns results ranked by BM25", () => {
		const results = searchExchangesByRelevance("TypeScript", 10, dbPath);
		expect(results.length).toBeGreaterThanOrEqual(1);
		// s3 has more TypeScript mentions, should rank higher
		expect(results[0].user_prompt).toContain("TypeScript");
	});

	it("searchExchangesByRelevance respects limit", () => {
		const results = searchExchangesByRelevance("TypeScript", 1, dbPath);
		expect(results).toHaveLength(1);
	});

	it("searchExchangesByRelevance returns empty array for empty query", () => {
		const results = searchExchangesByRelevance("", 10, dbPath);
		expect(results).toHaveLength(0);
	});

	it("searchExchangesByRelevance does not return unrelated exchanges", () => {
		const results = searchExchangesByRelevance("TypeScript", 10, dbPath);
		const hasWeather = results.some((r) => r.user_prompt.includes("weather"));
		expect(hasWeather).toBe(false);
	});
});
