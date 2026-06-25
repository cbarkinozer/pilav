import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCache, DEFAULT_TTL_MS } from "../cache.ts";
import type { ToolResult } from "../cache.ts";

const makeResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

describe("ToolCache — key generation", () => {
	it("produces stable keys for same inputs", () => {
		const k1 = ToolCache.key("fs", "read_file", { path: "/foo" });
		const k2 = ToolCache.key("fs", "read_file", { path: "/foo" });
		expect(k1).toBe(k2);
	});

	it("produces different keys for different tool names", () => {
		const k1 = ToolCache.key("fs", "read_file", { path: "/foo" });
		const k2 = ToolCache.key("fs", "write_file", { path: "/foo" });
		expect(k1).not.toBe(k2);
	});

	it("produces different keys for different server names", () => {
		const k1 = ToolCache.key("fs", "read_file", { path: "/foo" });
		const k2 = ToolCache.key("git", "read_file", { path: "/foo" });
		expect(k1).not.toBe(k2);
	});

	it("key format is serverName:toolName:argsJson", () => {
		const k = ToolCache.key("web", "fetch_url", { url: "https://example.com" });
		expect(k).toBe('web:fetch_url:{"url":"https://example.com"}');
	});
});

describe("ToolCache — get/set/hit", () => {
	let cache: ToolCache;

	beforeEach(() => {
		cache = new ToolCache();
	});

	it("returns undefined for a key that was never set", () => {
		expect(cache.get("nonexistent")).toBeUndefined();
	});

	it("returns the stored result after set", () => {
		const key = ToolCache.key("fs", "read_file", { path: "/foo" });
		const result = makeResult("hello");
		cache.set(key, result);
		expect(cache.get(key)).toEqual(result);
	});

	it("tracks size correctly", () => {
		expect(cache.size).toBe(0);
		cache.set("k1", makeResult("a"));
		expect(cache.size).toBe(1);
		cache.set("k2", makeResult("b"));
		expect(cache.size).toBe(2);
	});

	it("overwriting same key keeps size at 1", () => {
		cache.set("k1", makeResult("a"));
		cache.set("k1", makeResult("b"));
		expect(cache.size).toBe(1);
		expect(cache.get("k1")?.content[0].text).toBe("b");
	});
});

describe("ToolCache — TTL expiry", () => {
	it("returns undefined after TTL expires", async () => {
		const cache = new ToolCache(50); // 50ms TTL
		cache.set("key", makeResult("fresh"));
		expect(cache.get("key")).toBeDefined();
		await new Promise((r) => setTimeout(r, 60));
		expect(cache.get("key")).toBeUndefined();
	});

	it("does not expire before TTL", async () => {
		const cache = new ToolCache(200);
		cache.set("key", makeResult("still here"));
		await new Promise((r) => setTimeout(r, 50));
		expect(cache.get("key")).toBeDefined();
	});
});

describe("ToolCache — LRU eviction", () => {
	it("evicts oldest entry when max size is reached", () => {
		const cache = new ToolCache(DEFAULT_TTL_MS, 3);
		cache.set("a", makeResult("a"));
		cache.set("b", makeResult("b"));
		cache.set("c", makeResult("c"));
		expect(cache.size).toBe(3);
		cache.set("d", makeResult("d")); // should evict "a"
		expect(cache.size).toBe(3);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("d")).toBeDefined();
	});

	it("accessing a key refreshes its LRU position", () => {
		const cache = new ToolCache(DEFAULT_TTL_MS, 3);
		cache.set("a", makeResult("a"));
		cache.set("b", makeResult("b"));
		cache.set("c", makeResult("c"));
		// Access "a" to refresh it
		cache.get("a");
		cache.set("d", makeResult("d")); // should evict "b" now
		expect(cache.get("a")).toBeDefined();
		expect(cache.get("b")).toBeUndefined();
	});
});

describe("ToolCache — invalidation", () => {
	let cache: ToolCache;

	beforeEach(() => {
		cache = new ToolCache();
		cache.set("fs:read_file:a", makeResult("r1"));
		cache.set("fs:write_file:b", makeResult("r2"));
		cache.set("git:status:c", makeResult("r3"));
	});

	it("invalidate() with no pattern clears everything", () => {
		cache.invalidate();
		expect(cache.size).toBe(0);
	});

	it("invalidate(prefix) removes only matching keys", () => {
		cache.invalidate("fs:");
		expect(cache.size).toBe(1);
		expect(cache.get("git:status:c")).toBeDefined();
	});

	it("invalidate(prefix) does not remove non-matching keys", () => {
		cache.invalidate("git:");
		expect(cache.get("fs:read_file:a")).toBeDefined();
		expect(cache.get("fs:write_file:b")).toBeDefined();
	});
});
