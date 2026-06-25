/**
 * Integration tests for the pilav-shell MCP server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "../client.ts";

let client: McpClient;

beforeEach(async () => {
	client = new McpClient("shell");
	await client.connect({ name: "shell", builtin: "shell" });
});

afterEach(async () => {
	await client.disconnect();
});

describe("shell MCP server — bash", () => {
	it("runs a simple echo command", async () => {
		const result = await client.callTool("bash", { command: "echo hello" });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text?.trim()).toBe("hello");
	});

	it("runs commands in a temp directory by default (no cwd needed)", async () => {
		const result = await client.callTool("bash", { command: "pwd" });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toBeTruthy();
	});

	it("returns isError on non-zero exit", async () => {
		const result = await client.callTool("bash", { command: "exit 1" });
		expect(result.isError).toBe(true);
	});

	it("lists the bash tool", async () => {
		const tools = await client.listTools();
		expect(tools.map((t) => t.name)).toContain("bash");
	});
});

describe("shell MCP server — allowedCommands restriction", () => {
	let restrictedClient: McpClient;

	beforeEach(async () => {
		restrictedClient = new McpClient("shell-restricted");
		await restrictedClient.connect({
			name: "shell-restricted",
			builtin: "shell",
			allowedCommands: ["echo", "pwd"],
		});
	});

	afterEach(async () => {
		await restrictedClient.disconnect();
	});

	it("allows echo when it is in allowedCommands", async () => {
		const result = await restrictedClient.callTool("bash", { command: "echo allowed" });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text?.trim()).toBe("allowed");
	});

	it("blocks ls when it is not in allowedCommands", async () => {
		const result = await restrictedClient.callTool("bash", { command: "ls /" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not in allowed list");
	});
});
