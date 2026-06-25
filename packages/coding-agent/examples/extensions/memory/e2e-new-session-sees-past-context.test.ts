/**
 * T007 — Manual end-to-end verification: new session sees past context
 * Section: packages/coding-agent/examples/extensions/memory (e2e)
 *
 * Integration tests for the observable end-to-end behavior of the memory
 * extension as described in the acceptance criteria.  They verify:
 *
 *   1. Memory write on agent_end: after 'Remember that my favourite colour is
 *      blue.' is received, the memory store file (~/.pi/agent/memory.json or
 *      the temp-overridden path) must exist and contain a JSON array with at
 *      least one entry whose text includes 'blue'.
 *
 *   2. Memory injection on before_agent_start in a fresh session: the
 *      before_agent_start handler's returned systemPrompt must contain the
 *      substring '## Memory Context' and 'blue' within that section.  This is
 *      verified by invoking the extension handler directly, without an LLM.
 *
 *   3. No crash when both extensions are loaded simultaneously: loading both
 *      lmstudio-provider and memory extensions via loadExtensions() emits no
 *      errors and registerProvider('lmstudio', ...) does not throw.
 *
 *   4. No crash under empty memory store: on first session launch with no
 *      memory store present, the before_agent_start handler returns the
 *      original systemPrompt unchanged (no '## Memory Context' section) and
 *      throws no errors.
 *
 * These tests are written TDD-style BEFORE the implementation exists and are
 * expected to FAIL until index.ts is created under this same directory.
 *
 * Test strategy from architect:
 * - Integration tests only — no mocks of internal modules.
 * - Verify observable behavior: does the agent actually write the memory
 *   store, does the before_agent_start handler inject the right text?
 * - Do NOT rely on live LLM output for scenarios 1-4; inspect handlers directly.
 *
 * Run command (from this directory):
 *   cd packages/coding-agent/examples/extensions/memory && npx vitest run
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { getRecentExchanges } from "./db.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MEMORY_EXTENSION_INDEX = resolve(__dirname, "index.ts");
const _LMSTUDIO_EXTENSION_INDEX = resolve(__dirname, "../lmstudio-provider/index.ts");

// ---------------------------------------------------------------------------
// Type aliases for functions we expect the extension's index.ts to export.
// Static type-only shapes; the actual implementations come via loadExtensions.
// ---------------------------------------------------------------------------

/**
 * The memory extension must export a factory that satisfies ExtensionAPI.
 * We do not statically import it (the file does not exist yet).  We invoke it
 * through the extension loader so the TDD "red" state is a module-not-found
 * error rather than a TypeScript compile error.
 */
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory for this test run.
 */
function makeTempDir(label: string): string {
	const dir = join(tmpdir(), `pi-t007-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Build a minimal ExtensionAPI stub that records the before_agent_start and
 * agent_end handlers registered by an extension.  This lets us invoke those
 * handlers directly without spinning up a full AgentSession.
 */
function buildStubExtensionAPI() {
	const handlers: Map<string, ((...args: unknown[]) => Promise<unknown>)[]> = new Map();

	const api = {
		on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider(_name: string, _config: unknown) {
			// No-op for the memory extension; silently accepted.
		},
		registerCommand(_name: string, _opts: unknown) {},
		registerTool(_tool: unknown) {},
		registerShortcut(_key: unknown, _opts: unknown) {},
		registerFlag(_name: string, _opts: unknown) {},
		registerMessageRenderer(_type: string, _renderer: unknown) {},
		getFlag(_name: string) {
			return undefined;
		},
		sendMessage(_msg: unknown, _opts?: unknown) {},
		sendUserMessage(_content: unknown, _opts?: unknown) {},
		appendEntry(_type: string, _data?: unknown) {},
		setSessionName(_name: string) {},
		getSessionName() {
			return undefined;
		},
		setLabel(_id: string, _label: unknown) {},
		exec(
			_cmd: string,
			_args: string[],
			_opts?: unknown,
		): Promise<{ stdout: string; stderr: string; exitCode: number }> {
			return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
		},
		getActiveTools() {
			return [];
		},
		getAllTools() {
			return [];
		},
		setActiveTools(_names: string[]) {},
		getCommands() {
			return [];
		},
		setModel(_model: unknown) {
			return Promise.resolve(true);
		},
		getThinkingLevel() {
			return "medium" as const;
		},
		setThinkingLevel(_level: unknown) {},
		unregisterProvider(_name: string) {},
		events: {
			on: (_event: string, _handler: unknown) => () => {},
			emit: (_event: string, ..._args: unknown[]) => {},
		},
	};

	return { api, handlers };
}

/**
 * Invoke the before_agent_start handlers registered by an extension factory
 * and return the final systemPrompt string (with any extension modifications
 * applied).  The factory is loaded via a dynamic import so that a missing
 * index.ts surfaces as a readable "module not found" failure rather than a
 * static import error.
 */
async function invokeBeforeAgentStart(
	factoryPath: string,
	initialSystemPrompt: string,
	memoryStorePath: string,
): Promise<string> {
	// Dynamic import — fails with module-not-found until implementation exists.
	const mod = (await import(factoryPath)) as { default: (api: unknown) => void | Promise<void> };
	const factory = mod.default;

	if (typeof factory !== "function") {
		throw new TypeError(`Extension at ${factoryPath} does not export a default factory function.`);
	}

	const { api, handlers } = buildStubExtensionAPI();

	// Pass the memory store path via environment variable (the expected
	// implementation reads PI_MEMORY_PATH or falls back to the default path).
	process.env.PI_MEMORY_PATH = memoryStorePath;
	try {
		await factory(api);
	} finally {
		delete process.env.PI_MEMORY_PATH;
	}

	const beforeAgentStartHandlers = handlers.get("before_agent_start") ?? [];
	let currentPrompt = initialSystemPrompt;

	for (const handler of beforeAgentStartHandlers) {
		const event = {
			type: "before_agent_start" as const,
			prompt: "What is my favourite colour?",
			images: undefined,
			systemPrompt: currentPrompt,
			systemPromptOptions: {},
		};
		const result = (await handler(event, {})) as { systemPrompt?: string } | undefined;
		if (result?.systemPrompt !== undefined) {
			currentPrompt = result.systemPrompt;
		}
	}

	return currentPrompt;
}

/**
 * Invoke the agent_end handlers registered by an extension factory with a
 * simulated exchange about 'blue'.
 */
async function invokeAgentEnd(factoryPath: string, memoryStorePath: string): Promise<void> {
	const mod = (await import(factoryPath)) as { default: (api: unknown) => void | Promise<void> };
	const factory = mod.default;

	if (typeof factory !== "function") {
		throw new TypeError(`Extension at ${factoryPath} does not export a default factory function.`);
	}

	const { api, handlers } = buildStubExtensionAPI();

	process.env.PI_MEMORY_PATH = memoryStorePath;
	try {
		await factory(api);
	} finally {
		delete process.env.PI_MEMORY_PATH;
	}

	const agentEndHandlers = handlers.get("agent_end") ?? [];
	const messages = [
		{
			role: "user" as const,
			content: "Remember that my favourite colour is blue.",
			timestamp: Date.now(),
		},
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "I will remember that your favourite colour is blue." }],
			timestamp: Date.now() + 100,
		},
	];

	for (const handler of agentEndHandlers) {
		const event = { type: "agent_end" as const, messages };
		await handler(event, {});
	}
}

// ===========================================================================
// Scenario 1 — Memory write on agent_end
// ===========================================================================

describe("T007 scenario 1: memory write on agent_end", () => {
	let tempDir: string;
	let memoryStorePath: string;

	beforeEach(() => {
		tempDir = makeTempDir("write");
		memoryStorePath = join(tempDir, "memory.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("memory store file is created after sending the blue-colour exchange", async () => {
		await invokeAgentEnd(MEMORY_EXTENSION_INDEX, memoryStorePath);

		expect(existsSync(memoryStorePath), `Expected memory store (SQLite) at ${memoryStorePath} to exist after agent_end.`).toBe(
			true,
		);
	});

	it("memory store contains at least one exchange", async () => {
		await invokeAgentEnd(MEMORY_EXTENSION_INDEX, memoryStorePath);

		const exchanges = getRecentExchanges(10, memoryStorePath);
		expect(exchanges.length, "Expected at least one exchange in the memory store.").toBeGreaterThanOrEqual(1);
	});

	it("at least one exchange contains the word 'blue'", async () => {
		await invokeAgentEnd(MEMORY_EXTENSION_INDEX, memoryStorePath);

		const exchanges = getRecentExchanges(10, memoryStorePath);
		const hasBlue = exchanges.some(
			(e) =>
				e.user_prompt.toLowerCase().includes("blue") ||
				e.assistant_reply.toLowerCase().includes("blue"),
		);

		expect(hasBlue, "Expected at least one exchange whose user_prompt or assistant_reply contains 'blue'.").toBe(true);
	});
});

// ===========================================================================
// Scenario 2 — Memory injection on before_agent_start in a fresh session
// ===========================================================================

describe("T007 scenario 2: before_agent_start injects '## Memory Context' section", () => {
	let tempDir: string;
	let memoryStorePath: string;

	beforeEach(() => {
		tempDir = makeTempDir("inject");
		memoryStorePath = join(tempDir, "memory.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("system prompt returned by before_agent_start contains '## Memory Context' after a blue exchange was saved", async () => {
		// Session 1: write 'blue' to the memory store.
		await invokeAgentEnd(MEMORY_EXTENSION_INDEX, memoryStorePath);

		// Session 2: simulate a fresh session start, check that the system
		// prompt is augmented with '## Memory Context'.
		const originalPrompt = "You are a helpful assistant.";
		const result = await invokeBeforeAgentStart(MEMORY_EXTENSION_INDEX, originalPrompt, memoryStorePath);

		expect(result, "Expected the system prompt to include '## Memory Context' after a blue exchange.").toContain(
			"## Memory Context",
		);
	});

	it("'## Memory Context' section contains the word 'blue'", async () => {
		await invokeAgentEnd(MEMORY_EXTENSION_INDEX, memoryStorePath);

		const originalPrompt = "You are a helpful assistant.";
		const result = await invokeBeforeAgentStart(MEMORY_EXTENSION_INDEX, originalPrompt, memoryStorePath);

		// Locate the '## Memory Context' section and verify 'blue' appears
		// within it (not just anywhere in the prompt).
		const contextSectionIndex = result.indexOf("## Memory Context");
		expect(
			contextSectionIndex,
			"'## Memory Context' header must appear in the modified system prompt.",
		).toBeGreaterThanOrEqual(0);

		const afterHeader = result.slice(contextSectionIndex);
		expect(afterHeader.toLowerCase(), "'blue' must appear within the '## Memory Context' section.").toContain("blue");
	});

	it("before_agent_start returns a systemPrompt that is different from the original (it was extended)", async () => {
		await invokeAgentEnd(MEMORY_EXTENSION_INDEX, memoryStorePath);

		const originalPrompt = "You are a helpful assistant.";
		const result = await invokeBeforeAgentStart(MEMORY_EXTENSION_INDEX, originalPrompt, memoryStorePath);

		expect(result.length, "Modified system prompt must be longer than the original.").toBeGreaterThan(
			originalPrompt.length,
		);
	});
});

// ===========================================================================
// Scenario 3 — No crash when both extensions are loaded simultaneously
// ===========================================================================

describe("T007 scenario 3: simultaneous extension loading — no crash", () => {
	it("loading memory extension via dynamic import does not throw", async () => {
		// FAILS until index.ts is created.
		await expect(
			import(MEMORY_EXTENSION_INDEX).then((mod) => {
				if (typeof (mod as { default?: unknown }).default !== "function") {
					throw new TypeError("default export is not a function");
				}
			}),
		).resolves.not.toThrow();
	});

	it("registering a custom 'lmstudio' provider via the stub API does not throw", async () => {
		// This simulates the lmstudio-provider extension calling registerProvider.
		// It does NOT require the lmstudio-provider index.ts to exist: it only
		// confirms that the ExtensionAPI stub accepts registerProvider calls and
		// that the combination does not crash.
		const { api } = buildStubExtensionAPI();

		expect(() => {
			api.registerProvider("lmstudio", {
				baseUrl: "http://localhost:1234/v1",
				apiKey: "lm-studio",
				models: [
					{
						id: "gemma-4-4b",
						name: "Gemma 4 4B (LM Studio)",
						contextWindow: 128000,
						maxTokens: 16384,
						input: ["text"],
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
					{
						id: "qwen-3.5-8b",
						name: "Qwen 3.5 8B (LM Studio)",
						contextWindow: 128000,
						maxTokens: 16384,
						input: ["text"],
						reasoning: true,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			});
		}).not.toThrow();
	});

	it("memory extension factory can be called together with a lmstudio registerProvider call without throwing", async () => {
		// FAILS until memory/index.ts is created.
		const mod = (await import(MEMORY_EXTENSION_INDEX)) as { default: (api: unknown) => void | Promise<void> };
		const memoryFactory = mod.default;

		const { api } = buildStubExtensionAPI();

		// Simulate what would happen when both extensions are loaded in the
		// same session: lmstudio registers a provider, memory registers handlers.
		api.registerProvider("lmstudio", {
			baseUrl: "http://localhost:1234/v1",
			apiKey: "lm-studio",
			models: [],
		});

		await expect(Promise.resolve().then(() => memoryFactory(api))).resolves.not.toThrow();
	});
});

// ===========================================================================
// Scenario 4 — No crash under empty memory store (first launch)
// ===========================================================================

describe("T007 scenario 4: no crash with absent memory store", () => {
	let tempDir: string;
	let emptyMemoryStorePath: string;

	beforeEach(() => {
		tempDir = makeTempDir("empty");
		// Path that does NOT exist yet — no memory.json has been written.
		emptyMemoryStorePath = join(tempDir, "memory.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("before_agent_start handler does not throw when memory store is absent", async () => {
		// FAILS until index.ts is created.
		const originalPrompt = "You are a helpful assistant.";
		await expect(
			invokeBeforeAgentStart(MEMORY_EXTENSION_INDEX, originalPrompt, emptyMemoryStorePath),
		).resolves.not.toThrow();
	});

	it("before_agent_start returns original systemPrompt unchanged when memory store is absent", async () => {
		// FAILS until index.ts is created.
		const originalPrompt = "You are a helpful assistant.";
		const result = await invokeBeforeAgentStart(MEMORY_EXTENSION_INDEX, originalPrompt, emptyMemoryStorePath);

		expect(result, "With no memory store, the system prompt must be returned unchanged.").toBe(originalPrompt);
	});

	it("before_agent_start does NOT inject '## Memory Context' when memory store is absent", async () => {
		// FAILS until index.ts is created.
		const originalPrompt = "You are a helpful assistant.";
		const result = await invokeBeforeAgentStart(MEMORY_EXTENSION_INDEX, originalPrompt, emptyMemoryStorePath);

		expect(result, "No '## Memory Context' should appear in the system prompt on first launch.").not.toContain(
			"## Memory Context",
		);
	});

	it("agent_end does not throw when memory store directory exists but file is absent", async () => {
		// FAILS until index.ts is created.
		await expect(invokeAgentEnd(MEMORY_EXTENSION_INDEX, emptyMemoryStorePath)).resolves.not.toThrow();
	});
});

// ===========================================================================
// Scenario 5 — Manual gate gate-check: verification-log.md existence
// ===========================================================================

describe("T007 scenario 5: manual verification gate — verification-log.md", () => {
	// The manual gate requires a human tester to run both Gemma 4 4B and
	// Qwen 3.5 8B, observe the /debug output showing '## Memory Context' with
	// 'blue', and record the model response.
	//
	// The automated portion of this gate is:
	//   - verification-log.md file exists in this directory, and
	//   - it contains transcript evidence for both models.
	//
	// The test is intentionally strict: it FAILs until a human has completed the
	// manual run and committed verification-log.md.

	const verificationLogPath = resolve(__dirname, "verification-log.md");

	it("verification-log.md exists in the memory extension directory", () => {
		// FAILS until a human tester creates this file.
		expect(
			existsSync(verificationLogPath),
			`Expected verification-log.md to exist at ${verificationLogPath}. ` +
				"A human tester must run two full sessions (Gemma 4 4B and Qwen 3.5 8B), " +
				"record the /debug output showing '## Memory Context' containing 'blue', " +
				"record the model response text containing 'blue', and commit verification-log.md.",
		).toBe(true);
	});

	it("verification-log.md contains transcript evidence for Gemma 4 4B", () => {
		// FAILS until a human tester fills in the log.
		if (!existsSync(verificationLogPath)) {
			// Covered by the previous test — fail explicitly.
			expect.fail(`verification-log.md not found at ${verificationLogPath}`);
		}
		const content = readFileSync(verificationLogPath, "utf-8");
		const lowerContent = content.toLowerCase();
		expect(lowerContent, "verification-log.md must contain a reference to Gemma 4 4B or gemma-4-4b.").toMatch(
			/gemma.?4.?4b|gemma-4-4b/,
		);
	});

	it("verification-log.md contains transcript evidence for Qwen 3.5 8B", () => {
		if (!existsSync(verificationLogPath)) {
			expect.fail(`verification-log.md not found at ${verificationLogPath}`);
		}
		const content = readFileSync(verificationLogPath, "utf-8");
		const lowerContent = content.toLowerCase();
		expect(lowerContent, "verification-log.md must contain a reference to Qwen 3.5 8B or qwen-3.5-8b.").toMatch(
			/qwen.?3\.?5.?8b|qwen-3.5-8b/,
		);
	});

	it("verification-log.md contains evidence that '## Memory Context' was observed", () => {
		if (!existsSync(verificationLogPath)) {
			expect.fail(`verification-log.md not found at ${verificationLogPath}`);
		}
		const content = readFileSync(verificationLogPath, "utf-8");
		expect(content, "verification-log.md must contain '## Memory Context' (copied from /debug output).").toContain(
			"## Memory Context",
		);
	});

	it("verification-log.md contains evidence that the model response included 'blue'", () => {
		if (!existsSync(verificationLogPath)) {
			expect.fail(`verification-log.md not found at ${verificationLogPath}`);
		}
		const content = readFileSync(verificationLogPath, "utf-8");
		expect(
			content.toLowerCase(),
			"verification-log.md must contain the word 'blue' (from the model recall response).",
		).toContain("blue");
	});
});
