/**
 * T003 — Memory staleness decay tests
 * Facts decay with exp(-days/90); filtered below 0.1 effective confidence.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFacts, initDb, insertFact } from "./db.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pilav-decay-test-"));
  dbPath = join(tmpDir, "test.db");
  initDb(dbPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Age a fact by directly updating created_at via a separate raw connection.
// SQLite WAL mode allows this safely (single-threaded JS, no concurrency).
function ageFactDays(path: string, daysAgo: number) {
  const raw = new DatabaseSync(path);
  raw.exec(`UPDATE facts SET created_at = datetime('now', '-${daysAgo} days')`);
  raw.close();
}

describe("T003: Memory staleness decay", () => {
  it("returns fresh facts at near-full confidence", () => {
    insertFact({ subject: "user", predicate: "uses", object: "TypeScript", confidence: 0.9 }, dbPath);
    const facts = getFacts(10, dbPath);
    expect(facts.length).toBe(1);
    // Fresh: effectiveConfidence ≈ 0.9 * exp(0) = 0.9
    expect(facts[0].confidence).toBeGreaterThan(0.85);
  });

  it("reduces effective confidence for 90-day-old facts", () => {
    insertFact({ subject: "user", predicate: "likes", object: "Python", confidence: 0.8 }, dbPath);
    ageFactDays(dbPath, 90);

    const facts = getFacts(10, dbPath);
    expect(facts.length).toBe(1);
    // decay = exp(-90/90) = exp(-1) ≈ 0.368 → effectiveConf ≈ 0.8 * 0.368 = 0.294
    expect(facts[0].confidence).toBeGreaterThan(0.1);
    expect(facts[0].confidence).toBeLessThan(0.5);
  });

  it("filters out ~200-day-old facts with low base confidence", () => {
    insertFact({ subject: "user", predicate: "tried", object: "Rust", confidence: 0.3 }, dbPath);
    ageFactDays(dbPath, 200);

    const facts = getFacts(10, dbPath);
    // effectiveConf = 0.3 * exp(-200/90) ≈ 0.3 * 0.109 ≈ 0.033 → filtered
    expect(facts.length).toBe(0);
  });

  it("retains high-confidence 180-day-old facts above the threshold", () => {
    insertFact({ subject: "user", predicate: "loves", object: "TypeScript", confidence: 1.0 }, dbPath);
    ageFactDays(dbPath, 180);

    const facts = getFacts(10, dbPath);
    // effectiveConf = 1.0 * exp(-180/90) = exp(-2) ≈ 0.135 → above 0.1, survives
    expect(facts.length).toBe(1);
  });

  it("sorts facts by effective confidence descending (fresh before stale)", () => {
    insertFact({ subject: "user", predicate: "uses", object: "A", confidence: 0.9 }, dbPath);
    insertFact({ subject: "user", predicate: "uses", object: "B", confidence: 0.9 }, dbPath);

    // Age B by 120 days so its effective confidence is lower
    const raw = new DatabaseSync(dbPath);
    const rows = raw.prepare("SELECT id FROM facts ORDER BY id DESC LIMIT 1").all() as { id: number }[];
    raw.prepare("UPDATE facts SET created_at = datetime('now', '-120 days') WHERE id = ?").run(rows[0].id);
    raw.close();

    const facts = getFacts(10, dbPath);
    expect(facts.length).toBe(2);
    // A is fresh (conf ≈ 0.9), B is 120d old (conf ≈ 0.9 * exp(-120/90) ≈ 0.26)
    expect(facts[0].object).toBe("A");
    expect(facts[0].confidence).toBeGreaterThan(facts[1].confidence);
  });
});
