/**
 * Integration tests for the memory extension:
 *   packages/coding-agent/examples/extensions/memory/index.ts
 *
 * Written TDD-style BEFORE the implementation exists.
 * All tests are expected to FAIL until the extension is created.
 *
 * Acceptance criteria verified here:
 * 1. Loading the extension does not throw.
 * 2. A subsequent before_agent_start event after one exchange contains
 *    '## Memory Context' in the system prompt injected by the handler.
 * 3. The injected system prompt block contains at least the prior user prompt text.
 * 4. agent_end handler calls insertExchange without throwing
 *    (verified by checking DB row count increases from 0 → 1).
 * 5. TypeScript compilation passes for index.ts (no type errors).
 *
 * Test strategy (integration only — no mocks of internal modules):
 * - Load the extension using the real loadExtensions() from the extension loader.
 * - Dispatch events via the real ExtensionRunner.
 * - Verify observable state changes (systemPrompt content, SQLite row counts).
 * - Run tsc --noEmit for the TS compile check.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_EXT_DIR = path.resolve(__dirname, "../examples/extensions/memory");
const MEMORY_EXT_INDEX = path.join(MEMORY_EXT_DIR, "index.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Shared test infrastructure
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-ext-test-"));
});

afterEach(() => {
	if (tempDir && fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
	// Ensure the DB_PATH env var is cleaned up between tests.
	delete process.env.DB_PATH;
});

/** Minimal no-op ExtensionActions stub required by ExtensionRunner.bindCore() */
const noOpActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

/** Minimal no-op ExtensionContextActions stub */
const noOpContextActions: ExtensionContextActions = {
	getModel: () => undefined,
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

/** Build an ExtensionRunner loaded with the memory extension for a given DB path. */
async function buildRunner(dbPath: string) {
	process.env.DB_PATH = dbPath;

	const result = await loadExtensions([MEMORY_EXT_INDEX], tempDir);
	// The loader must not produce errors; the test will surface the real failure
	// if the implementation file is missing.

	const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage);
	const sessionManager = SessionManager.inMemory();

	const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

	runner.bindCore(noOpActions, noOpContextActions);

	return { runner, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Loading the extension does not throw
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — loading", () => {
	it("loadExtensions() with the memory index path returns no errors and one extension", async () => {
		const dbPath = path.join(tempDir, "test.db");
		process.env.DB_PATH = dbPath;

		const result = await loadExtensions([MEMORY_EXT_INDEX], tempDir);

		// The critical assertion: loading must not produce any error string.
		expect(result.errors).toHaveLength(0);

		// Exactly one extension was loaded (the memory index.ts).
		expect(result.extensions).toHaveLength(1);

		// The loaded extension path must point at the memory directory.
		const extPath = result.extensions[0]?.path ?? "";
		expect(extPath).toContain("memory");
	});

	it("building ExtensionRunner with the memory extension does not throw", async () => {
		const dbPath = path.join(tempDir, "test.db");
		await expect(buildRunner(dbPath)).resolves.not.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 3. System prompt injection after one exchange
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — before_agent_start system prompt injection", () => {
	it("injects '## Memory Context' into the system prompt on the second call", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const userPromptText = "hello world";

		// --- First agent_end: persist the exchange to the DB ---
		// The agent_end event carries the full conversation messages array.
		// We pass a minimal user + assistant message pair.
		const userMsg = {
			role: "user" as const,
			content: userPromptText,
			timestamp: Date.now(),
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "I can help with that." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};

		// Emit agent_end so the handler can persist the exchange.
		await runner.emit({
			type: "agent_end",
			messages: [userMsg, assistantMsg],
		});

		// --- Second turn: before_agent_start should now inject memory context ---
		const result = await runner.emitBeforeAgentStart("follow-up question", undefined, "base system prompt", {
			cwd: tempDir,
		});

		// The handler must have returned a modified systemPrompt.
		expect(result).toBeDefined();
		expect(result?.systemPrompt).toBeDefined();

		const injected = result?.systemPrompt ?? "";

		// Core assertion: the memory block header must be present.
		expect(injected).toContain("## Memory Context");
	});

	it("injected system prompt block contains the prior user prompt text", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const priorUserPrompt = "tell me about TypeScript generics";

		const userMsg = {
			role: "user" as const,
			content: priorUserPrompt,
			timestamp: Date.now(),
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "TypeScript generics allow…" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};

		// Emit agent_end to persist the exchange.
		await runner.emit({
			type: "agent_end",
			messages: [userMsg, assistantMsg],
		});

		// Now check the system prompt injection.
		const result = await runner.emitBeforeAgentStart("next question", undefined, "base system prompt", {
			cwd: tempDir,
		});

		expect(result?.systemPrompt).toBeDefined();
		const injected = result?.systemPrompt ?? "";

		// The block must reference the prior user prompt text.
		expect(injected).toContain(priorUserPrompt);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. agent_end persists an exchange row in SQLite
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — agent_end persistence", () => {
	it("DB row count increases from 0 to 1 after emitting agent_end with a user+assistant message pair", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		// Import the db helpers from the (not-yet-existing) implementation to
		// query row counts directly.  Dynamic import with a cache-busting query
		// string matches the pattern used in memory-db.test.ts.
		const dbUrl = new URL(`../examples/extensions/memory/db.ts?t=${Date.now()}`, import.meta.url);
		const dbMod = (await import(dbUrl.href)) as {
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

		// Initialise so we can read from it.
		dbMod.initDb(dbPath);

		// Before: no rows.
		const before = dbMod.searchExchanges("hello", 100, dbPath);
		expect(before).toHaveLength(0);

		// Emit agent_end with one user + one assistant message.
		const userMsg = {
			role: "user" as const,
			content: "hello from the user",
			timestamp: Date.now(),
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "hello back" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};

		await runner.emit({
			type: "agent_end",
			messages: [userMsg, assistantMsg],
		});

		// After: at least one row containing the user prompt.
		const after = dbMod.searchExchanges("hello", 100, dbPath);
		expect(after.length).toBeGreaterThanOrEqual(1);

		const hit = after.find((r) => r.user_prompt.includes("hello from the user"));
		expect(hit).toBeDefined();
	});

	it("agent_end handler does not throw when called with a valid message pair", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const userMsg = {
			role: "user" as const,
			content: "does this throw?",
			timestamp: Date.now(),
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "no" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};

		await expect(runner.emit({ type: "agent_end", messages: [userMsg, assistantMsg] })).resolves.not.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. TypeScript compilation check
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — TypeScript compilation", () => {
	it("tsc --noEmit on tsconfig.examples.json produces no errors for memory extension files", () => {
		const { spawnSync } = childProcess;

		const tsconfigPath = path.resolve(__dirname, "../tsconfig.examples.json");
		const codingAgentDir = path.resolve(__dirname, "..");

		// Resolve the tsc binary: try the coding-agent local devDep first,
		// then fall back to the monorepo root node_modules.
		const localTsc = path.resolve(codingAgentDir, "node_modules/.bin/tsc");
		const rootTsc = path.resolve(__dirname, "../../../node_modules/.bin/tsc");
		const tsc = fs.existsSync(localTsc) ? localTsc : rootTsc;

		const result = spawnSync(tsc, ["--project", tsconfigPath, "--noEmit"], {
			cwd: codingAgentDir,
			encoding: "utf-8",
		});

		// The full compiler output (stdout + stderr) may contain errors from other
		// example extensions that are unrelated to memory.  We only care that no
		// lines mention a path inside examples/extensions/memory/.
		const allOutput = [result.stdout ?? "", result.stderr ?? ""].join("\n");
		const memoryErrorLines = allOutput
			.split("\n")
			.filter(
				(line) =>
					line.includes("examples/extensions/memory") && (line.includes("error TS") || line.includes(": error")),
			);

		expect(
			memoryErrorLines,
			`Found TypeScript errors in the memory extension:\n${memoryErrorLines.join("\n")}`,
		).toHaveLength(0);
	});
});
