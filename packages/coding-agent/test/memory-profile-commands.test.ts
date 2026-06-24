/**
 * Integration tests for the memory extension profile read/write slash commands.
 *
 * Target implementation:
 *   packages/coding-agent/examples/extensions/memory/index.ts
 *   (must register /memory-set and /memory-get commands)
 *
 * Written TDD-style BEFORE the implementation exists.
 * All tests are expected to FAIL until the slash commands are added to the
 * memory extension.
 *
 * Acceptance criteria verified here:
 * 1. '/memory-set name Alice' calls notify with a confirmation string and
 *    getProfile('name') subsequently returns 'Alice'.
 * 2. '/memory-get name' after a set calls notify with 'Alice'.
 * 3. '/memory-get nonexistent' calls notify with a message containing
 *    'not found' and does NOT throw.
 * 4. runner.getRegisteredCommands() includes both 'memory-set' and
 *    'memory-get', each with a non-empty description field (simulating
 *    /help visibility after the extension loads).
 * 5. TypeScript compilation produces zero errors for files under
 *    examples/extensions/memory/.
 *
 * Test strategy (integration only — no mocks of internal modules):
 * - Load the extension using the real loadExtensions() from the extension loader.
 * - Construct an ExtensionRunner exactly as done in extensions-runner.test.ts.
 * - Bind stub extensionActions and extensionContextActions.
 * - Capture notify calls via a Vitest spy on the mock ExtensionUIContext.notify.
 * - Invoke command handlers directly from runner.getCommand(name).handler().
 * - Verify observable side-effects: notify call arguments and getProfile() return values.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_EXT_INDEX = path.resolve(__dirname, "../examples/extensions/memory/index.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Shared stubs (mirroring extensions-runner.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const extensionActions: ExtensionActions = {
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

const extensionContextActions: ExtensionContextActions = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-test setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-profile-test-"));
});

afterEach(() => {
	if (tempDir && fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
	delete process.env.DB_PATH;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the memory extension and wire up a fully bound ExtensionRunner.
 * Returns the runner plus a spy-instrumented UI context whose notify calls
 * can be asserted on.
 */
async function buildRunner(dbPath: string): Promise<{
	runner: ExtensionRunner;
	notifySpy: ReturnType<typeof vi.fn>;
}> {
	process.env.DB_PATH = dbPath;

	const result = await loadExtensions([MEMORY_EXT_INDEX], tempDir);

	const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage);
	const sessionManager = SessionManager.inMemory();

	const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

	runner.bindCore(extensionActions, extensionContextActions);

	// Build a UI context with a spied-on notify method so we can assert on the
	// messages shown to the user by the command handlers.
	const notifySpy = vi.fn<Parameters<ExtensionUIContext["notify"]>, void>();

	const mockUIContext: ExtensionUIContext = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: notifySpy,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			// Return a minimal stub – command handlers only call notify, not theme.
			return {} as ExtensionUIContext["theme"];
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	// Wire the UI context so ctx.ui in command handlers resolves to our spy.
	runner.setUIContext(mockUIContext, "rpc");

	return { runner, notifySpy };
}

/**
 * Build a minimal ExtensionCommandContext from the runner so command handlers
 * receive a proper ctx argument (including ctx.ui.notify).
 */
function makeCommandContext(runner: ExtensionRunner): ExtensionCommandContext {
	return runner.createCommandContext();
}

/**
 * Dynamically import the db module pointed at the given dbPath, returning the
 * exported functions we need to verify side-effects.
 */
async function loadDb(dbPath: string) {
	const url = new URL(`../examples/extensions/memory/db.ts?t=${Date.now()}`, import.meta.url);
	const mod = (await import(url.href)) as {
		initDb: (dbPath?: string) => void;
		getProfile: (key: string, dbPath?: string) => string | undefined;
	};
	mod.initDb(dbPath);
	return mod;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. /memory-set produces a confirmation notify and persists to getProfile
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — /memory-set command", () => {
	it("calls notify with a confirmation string after setting a profile key", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner, notifySpy } = await buildRunner(dbPath);

		const cmd = runner.getCommand("memory-set");
		expect(cmd, "memory-set command must be registered").toBeDefined();

		const ctx = makeCommandContext(runner);
		await cmd!.handler("name Alice", ctx);

		// The handler must have called notify at least once with a confirmation.
		expect(notifySpy).toHaveBeenCalled();

		// The notification must be a non-empty string (confirmation message).
		const firstCall = notifySpy.mock.calls[0];
		expect(firstCall).toBeDefined();
		const message = firstCall![0];
		expect(typeof message).toBe("string");
		expect(message.length).toBeGreaterThan(0);
	});

	it("getProfile('name') returns 'Alice' after running memory-set name Alice", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const cmd = runner.getCommand("memory-set");
		expect(cmd, "memory-set command must be registered").toBeDefined();

		const ctx = makeCommandContext(runner);
		await cmd!.handler("name Alice", ctx);

		// Verify the profile was persisted to the DB.
		const db = await loadDb(dbPath);
		const value = db.getProfile("name", dbPath);
		expect(value).toBe("Alice");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. /memory-get returns 'Alice' via notify after a prior set
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — /memory-get command (existing key)", () => {
	it("calls notify with 'Alice' after memory-set name Alice", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner, notifySpy } = await buildRunner(dbPath);

		const setCmd = runner.getCommand("memory-set");
		const getCmd = runner.getCommand("memory-get");
		expect(setCmd, "memory-set command must be registered").toBeDefined();
		expect(getCmd, "memory-get command must be registered").toBeDefined();

		const ctx = makeCommandContext(runner);

		// First set the profile key.
		await setCmd!.handler("name Alice", ctx);

		// Reset the spy so we only capture the get notification.
		notifySpy.mockClear();

		// Now get the profile key.
		await getCmd!.handler("name", ctx);

		expect(notifySpy).toHaveBeenCalled();

		// The notification must contain the stored value.
		const calls = notifySpy.mock.calls;
		const allMessages = calls.map((c) => String(c[0])).join("\n");
		expect(allMessages).toContain("Alice");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. /memory-get with a nonexistent key shows 'not found' without throwing
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — /memory-get command (missing key)", () => {
	it("calls notify with a 'not found' message and does not throw", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner, notifySpy } = await buildRunner(dbPath);

		const getCmd = runner.getCommand("memory-get");
		expect(getCmd, "memory-get command must be registered").toBeDefined();

		const ctx = makeCommandContext(runner);

		// Must not throw even though the key does not exist.
		await expect(getCmd!.handler("nonexistent", ctx)).resolves.not.toThrow();

		// Must have notified the user with some kind of 'not found' message.
		expect(notifySpy).toHaveBeenCalled();

		const allMessages = notifySpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(allMessages.toLowerCase()).toContain("not found");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. /help visibility — commands appear in getRegisteredCommands()
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — /help visibility", () => {
	it("getRegisteredCommands() includes 'memory-set' with a non-empty description", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const commands = runner.getRegisteredCommands();
		const memorySetCmd = commands.find((c) => c.name === "memory-set");

		expect(memorySetCmd, "memory-set must appear in getRegisteredCommands()").toBeDefined();
		expect(typeof memorySetCmd!.description).toBe("string");
		expect(memorySetCmd!.description!.length).toBeGreaterThan(0);
	});

	it("getRegisteredCommands() includes 'memory-get' with a non-empty description", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const commands = runner.getRegisteredCommands();
		const memoryGetCmd = commands.find((c) => c.name === "memory-get");

		expect(memoryGetCmd, "memory-get must appear in getRegisteredCommands()").toBeDefined();
		expect(typeof memoryGetCmd!.description).toBe("string");
		expect(memoryGetCmd!.description!.length).toBeGreaterThan(0);
	});

	it("both memory-set and memory-get are present in getRegisteredCommands() simultaneously", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const commands = runner.getRegisteredCommands();
		const names = commands.map((c) => c.name);

		expect(names).toContain("memory-set");
		expect(names).toContain("memory-get");
	});

	it("runner.getCommand('memory-set') returns a non-undefined ResolvedCommand", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const cmd = runner.getCommand("memory-set");
		expect(cmd).toBeDefined();
		expect(cmd?.invocationName).toBe("memory-set");
	});

	it("runner.getCommand('memory-get') returns a non-undefined ResolvedCommand", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const { runner } = await buildRunner(dbPath);

		const cmd = runner.getCommand("memory-get");
		expect(cmd).toBeDefined();
		expect(cmd?.invocationName).toBe("memory-get");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. TypeScript compilation check
// ─────────────────────────────────────────────────────────────────────────────

describe("memory extension — TypeScript compilation", () => {
	it("tsc --noEmit on tsconfig.examples.json produces zero errors for memory extension files", () => {
		const { spawnSync } = childProcess;

		const codingAgentDir = path.resolve(__dirname, "..");
		const tsconfigPath = path.resolve(codingAgentDir, "tsconfig.examples.json");

		// Resolve the tsc binary: prefer the local devDependency, fall back to
		// the monorepo root.
		const localTsc = path.resolve(codingAgentDir, "node_modules/.bin/tsc");
		const rootTsc = path.resolve(__dirname, "../../../node_modules/.bin/tsc");
		const tsc = fs.existsSync(localTsc) ? localTsc : rootTsc;

		const result = spawnSync(tsc, ["--project", tsconfigPath, "--noEmit"], {
			cwd: codingAgentDir,
			encoding: "utf-8",
		});

		// We only fail if the memory extension itself has TS errors.
		// Other example extensions that may already have errors are ignored.
		const allOutput = [result.stdout ?? "", result.stderr ?? ""].join("\n");
		const memoryErrorLines = allOutput
			.split("\n")
			.filter(
				(line) =>
					line.includes("examples/extensions/memory") && (line.includes("error TS") || line.includes(": error")),
			);

		expect(
			memoryErrorLines,
			`TypeScript errors found in the memory extension:\n${memoryErrorLines.join("\n")}`,
		).toHaveLength(0);
	});
});
