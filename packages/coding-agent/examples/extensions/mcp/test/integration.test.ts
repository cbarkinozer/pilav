/**
 * Integration test for the MCP extension factory (index.ts).
 * Verifies that loading the extension discovers built-in servers and
 * registers their tools with the Pi stub.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface RegisteredTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: (args: Record<string, unknown>) => Promise<string>;
}

interface RegisteredProvider {
	name: string;
	config: unknown;
}

function buildStubExtensionAPI() {
	const tools: RegisteredTool[] = [];
	const providers: RegisteredProvider[] = [];
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();

	const api = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerProvider(name: string, config: unknown) {
			providers.push({ name, config });
		},
		registerCommand(_name: string, _opts: unknown) {},
		registerShortcut(_key: unknown, _opts: unknown) {},
		registerFlag(_name: string, _opts: unknown) {},
		registerMessageRenderer(_type: string, _renderer: unknown) {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getFlag(_name: string) { return undefined; },
		sendMessage(_msg: unknown, _opts?: unknown) {},
		sendUserMessage(_content: unknown, _opts?: unknown) {},
		appendEntry(_type: string, _data?: unknown) {},
		setSessionName(_name: string) {},
		getSessionName() { return undefined; },
		setLabel(_id: string, _label: unknown) {},
		exec(_cmd: string, _args: string[], _opts?: unknown) {
			return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
		},
		getActiveTools() { return []; },
		getAllTools() { return []; },
		setActiveTools(_names: string[]) {},
		getCommands() { return []; },
		setModel(_model: unknown) { return Promise.resolve(true); },
		getThinkingLevel() { return "medium" as const; },
		setThinkingLevel(_level: unknown) {},
		unregisterProvider(_name: string) {},
		events: {
			on: (_event: string, _handler: unknown) => () => {},
			emit: (_event: string, ..._args: unknown[]) => {},
		},
		_tools: tools,
		_providers: providers,
	};

	return api;
}

describe("MCP extension — factory loads and registers tools", () => {
	let api: ReturnType<typeof buildStubExtensionAPI>;
	let extensionLoaded = false;

	beforeEach(async () => {
		api = buildStubExtensionAPI();
		// Set MCP_CONFIG_PATH to nonexistent to trigger default config
		delete process.env.MCP_CONFIG_PATH;

		const mod = await import("../index.ts");
		await mod.default(api as unknown as Parameters<typeof mod.default>[0]);
		extensionLoaded = true;
	}, 20000);

	afterEach(() => {
		extensionLoaded = false;
	});

	it("extension loads without throwing", () => {
		expect(extensionLoaded).toBe(true);
	});

	it("registers tools from at least 2 built-in servers", () => {
		// Even if some servers fail (e.g. network for web), at least shell + filesystem should load
		expect(api._tools.length).toBeGreaterThanOrEqual(2);
	});

	it("all registered tools have namespaced names (server__tool)", () => {
		for (const tool of api._tools) {
			expect(tool.name).toMatch(/^[a-z_-]+__[a-z_]+$/);
		}
	});

	it("all registered tools have a handler function", () => {
		for (const tool of api._tools) {
			expect(typeof tool.handler).toBe("function");
		}
	});

	it("filesystem tools are registered", () => {
		const names = api._tools.map((t) => t.name);
		expect(names.some((n) => n.startsWith("filesystem__"))).toBe(true);
	});

	it("shell tools are registered", () => {
		const names = api._tools.map((t) => t.name);
		expect(names.some((n) => n.startsWith("shell__"))).toBe(true);
	});

	it("calling filesystem__read_file tool returns a string result", async () => {
		const tool = api._tools.find((t) => t.name === "filesystem__read_file");
		expect(tool).toBeDefined();
		// Call with a file we know exists
		const result = await tool!.handler({ path: "/Users/cbarkinozer/Documents/GitHub/pilav/README.md" });
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("calling shell__bash tool returns command output", async () => {
		const tool = api._tools.find((t) => t.name === "shell__bash");
		expect(tool).toBeDefined();
		const result = await tool!.handler({ command: "echo integration-test-ok" });
		expect(result).toContain("integration-test-ok");
	});
});
