/**
 * Phase 3 — T004/T005: index.ts richer injection + new commands
 *
 * The new injection keeps "## Memory Context" as the top-level block header
 * (backward compatibility with memory-extension.test.ts) and adds sub-sections
 * ### About You, ### Known Facts, ### Relevant Past Context, ### Recent History.
 *
 * TDD: written before implementation. Expected to fail until index.ts is upgraded.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, insertExchange, insertFact, setProfile } from "../examples/extensions/memory/db.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MEMORY_INDEX = resolve(__dirname, "../examples/extensions/memory/index.ts");

// ─── Stub API builder ─────────────────────────────────────────────────────────

function buildStubApi() {
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notifications: Array<{ msg: string; level: string }> = [];

	const ctx = {
		ui: {
			notify: (msg: string, level: string) => notifications.push({ msg, level }),
		},
	};

	const api = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: () => {},
		registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, opts);
		},
		registerTool: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => undefined,
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: () => Promise.resolve(true),
		getThinkingLevel: () => "medium" as const,
		setThinkingLevel: () => {},
		unregisterProvider: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};

	async function invokeBeforeAgentStart(systemPrompt: string, userPrompt: string, dbPath: string): Promise<string> {
		process.env.PI_MEMORY_PATH = dbPath;
		try {
			const mod = (await import(MEMORY_INDEX)) as { default: (api: unknown) => void };
			await mod.default(api);
		} finally {
			delete process.env.PI_MEMORY_PATH;
		}

		const list = handlers.get("before_agent_start") ?? [];
		let current = systemPrompt;
		for (const h of list) {
			const result = (await h({ systemPrompt: current, prompt: userPrompt })) as
				| { systemPrompt?: string }
				| undefined;
			if (result?.systemPrompt !== undefined) current = result.systemPrompt;
		}
		return current;
	}

	async function invokeCommand(name: string, args: string, dbPath: string): Promise<typeof notifications> {
		notifications.length = 0;
		process.env.PI_MEMORY_PATH = dbPath;
		try {
			const mod = (await import(MEMORY_INDEX)) as { default: (api: unknown) => void };
			await mod.default(api);
		} finally {
			delete process.env.PI_MEMORY_PATH;
		}
		const cmd = commands.get(name);
		if (!cmd) throw new Error(`Command ${name} not registered`);
		await cmd.handler(args, ctx);
		return [...notifications];
	}

	return { invokeBeforeAgentStart, invokeCommand };
}

// ─── ### About You section ────────────────────────────────────────────────────

describe("before_agent_start — ### About You section", () => {
	let dbPath: string;
	let tempDir: string;
	let stub: ReturnType<typeof buildStubApi>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-inj-about-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
		stub = buildStubApi();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("injects ### About You when user_profile_synthesis exists", async () => {
		setProfile("user_profile_synthesis", "The user is a TypeScript developer on Mac Mini M4.", dbPath);
		insertExchange("s1", "dummy", "dummy", dbPath); // ensure db exists so before_agent_start runs
		const result = await stub.invokeBeforeAgentStart("You are helpful.", "hello", dbPath);
		expect(result).toContain("### About You");
		expect(result).toContain("TypeScript developer");
	});

	it("does not inject ### About You when no synthesis exists", async () => {
		insertExchange("s1", "dummy", "dummy", dbPath);
		const result = await stub.invokeBeforeAgentStart("You are helpful.", "hello", dbPath);
		expect(result).not.toContain("### About You");
	});
});

// ─── ### Relevant Past Context section ───────────────────────────────────────

describe("before_agent_start — ### Relevant Past Context section", () => {
	let dbPath: string;
	let tempDir: string;
	let stub: ReturnType<typeof buildStubApi>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-inj-rel-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
		stub = buildStubApi();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("injects ### Relevant Past Context when FTS5 finds matching exchanges", async () => {
		insertExchange("s1", "I prefer TypeScript for all projects", "Great choice", dbPath);
		const result = await stub.invokeBeforeAgentStart("You are helpful.", "Tell me about TypeScript", dbPath);
		expect(result).toContain("### Relevant Past Context");
	});

	it("does not inject ### Relevant Past Context when no exchanges match the query", async () => {
		// Insert exchange that won't match "xyz_no_match_12345"
		insertExchange("s1", "hello world", "hi", dbPath);
		const result = await stub.invokeBeforeAgentStart("You are helpful.", "xyz_no_match_12345", dbPath);
		expect(result).not.toContain("### Relevant Past Context");
	});
});

// ─── ### Known Facts section ──────────────────────────────────────────────────

describe("before_agent_start — ### Known Facts section", () => {
	let dbPath: string;
	let tempDir: string;
	let stub: ReturnType<typeof buildStubApi>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-inj-facts-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
		stub = buildStubApi();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("injects ### Known Facts when facts exist", async () => {
		insertFact({ subject: "user", predicate: "prefers", object: "TypeScript", confidence: 0.9 }, dbPath);
		insertExchange("s1", "dummy", "dummy", dbPath);
		const result = await stub.invokeBeforeAgentStart("You are helpful.", "hello", dbPath);
		expect(result).toContain("### Known Facts");
		expect(result).toContain("TypeScript");
	});

	it("does not inject ### Known Facts when no facts exist", async () => {
		insertExchange("s1", "dummy", "dummy", dbPath);
		const result = await stub.invokeBeforeAgentStart("You are helpful.", "hello", dbPath);
		expect(result).not.toContain("### Known Facts");
	});
});

// ─── ### Recent History section ───────────────────────────────────────────────

describe("before_agent_start — ### Recent History section", () => {
	let dbPath: string;
	let tempDir: string;
	let stub: ReturnType<typeof buildStubApi>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-inj-hist-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
		stub = buildStubApi();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("injects ### Recent History when exchanges exist", async () => {
		insertExchange("s1", "hello", "hi there", dbPath);
		const result = await stub.invokeBeforeAgentStart("You are helpful.", "hello again", dbPath);
		expect(result).toContain("### Recent History");
	});

	it("top-level ## Memory Context block is still present (backward compat)", async () => {
		insertExchange("s1", "hello", "hi there", dbPath);
		const result = await stub.invokeBeforeAgentStart("You are helpful.", "hello", dbPath);
		expect(result).toContain("## Memory Context");
	});
});

// ─── Empty db ─────────────────────────────────────────────────────────────────

describe("before_agent_start — empty db produces unchanged prompt", () => {
	let dbPath: string;
	let tempDir: string;
	let stub: ReturnType<typeof buildStubApi>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-inj-empty-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		stub = buildStubApi();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns original prompt unchanged when db does not exist", async () => {
		const original = "You are helpful.";
		const result = await stub.invokeBeforeAgentStart(original, "hello", dbPath);
		expect(result).toBe(original);
	});
});

// ─── New slash commands ────────────────────────────────────────────────────────

describe("new slash commands", () => {
	let dbPath: string;
	let tempDir: string;
	let stub: ReturnType<typeof buildStubApi>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p3-cmds-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbPath = join(tempDir, "memory.db");
		initDb(dbPath);
		stub = buildStubApi();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("/memory-facts shows all known facts", async () => {
		insertFact({ subject: "user", predicate: "prefers", object: "TypeScript", confidence: 0.9 }, dbPath);
		const notes = await stub.invokeCommand("memory-facts", "", dbPath);
		const msg = notes.map((n) => n.msg).join(" ");
		expect(msg).toContain("TypeScript");
	});

	it("/memory-facts reports when no facts exist", async () => {
		const notes = await stub.invokeCommand("memory-facts", "", dbPath);
		expect(notes.length).toBeGreaterThanOrEqual(1);
	});

	it("/memory-profile shows synthesis when it exists", async () => {
		setProfile("user_profile_synthesis", "TypeScript developer on Mac Mini.", dbPath);
		const notes = await stub.invokeCommand("memory-profile", "", dbPath);
		const msg = notes.map((n) => n.msg).join(" ");
		expect(msg).toContain("TypeScript");
	});

	it("/memory-profile reports no profile when none exists", async () => {
		const notes = await stub.invokeCommand("memory-profile", "", dbPath);
		expect(notes.length).toBeGreaterThanOrEqual(1);
	});

	it("/memory-search returns results for matching query", async () => {
		insertExchange("s1", "I love TypeScript", "Great", dbPath);
		const notes = await stub.invokeCommand("memory-search", "TypeScript", dbPath);
		const msg = notes.map((n) => n.msg).join(" ");
		expect(msg).toContain("TypeScript");
	});

	it("/memory-search reports no results for non-matching query", async () => {
		const notes = await stub.invokeCommand("memory-search", "golang_xyz_12345", dbPath);
		expect(notes.length).toBeGreaterThanOrEqual(1);
	});

	it("/memory-consolidate command is registered", async () => {
		// Just verify the command can be invoked without throwing
		await expect(stub.invokeCommand("memory-consolidate", "", dbPath)).resolves.not.toThrow();
	});
});
