/**
 * Integration tests for McpClient — connects to a real MCP server subprocess.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "../client.ts";

describe("McpClient — shell server integration", () => {
	let client: McpClient;

	beforeEach(async () => {
		client = new McpClient("shell");
		await client.connect({ name: "shell", builtin: "shell" });
	});

	afterEach(async () => {
		await client.disconnect();
	});

	it("connects without throwing", async () => {
		// connect() already succeeded in beforeEach
		expect(client.serverName).toBe("shell");
	});

	it("listTools returns at least one tool", async () => {
		const tools = await client.listTools();
		expect(tools.length).toBeGreaterThan(0);
	});

	it("each tool has name and inputSchema", async () => {
		const tools = await client.listTools();
		for (const tool of tools) {
			expect(typeof tool.name).toBe("string");
			expect(tool.inputSchema).toBeDefined();
		}
	});

	it("callTool returns a ToolResult with content array", async () => {
		const result = await client.callTool("bash", { command: "echo ping" });
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content.length).toBeGreaterThan(0);
		expect(result.content[0].text?.trim()).toBe("ping");
	});

	it("disconnect does not throw", async () => {
		await expect(client.disconnect()).resolves.not.toThrow();
	});
});

describe("McpClient — filesystem server integration", () => {
	let client: McpClient;

	beforeEach(async () => {
		client = new McpClient("filesystem");
		await client.connect({ name: "filesystem", builtin: "filesystem" });
	});

	afterEach(async () => {
		await client.disconnect();
	});

	it("lists filesystem tools", async () => {
		const tools = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("write_file");
	});

	it("callTool error result has isError true", async () => {
		const result = await client.callTool("read_file", { path: "/nonexistent/file/xyz.txt" });
		expect(result.isError).toBe(true);
	});
});
