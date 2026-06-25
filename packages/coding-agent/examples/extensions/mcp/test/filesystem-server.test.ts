/**
 * Integration tests for the pilav-filesystem MCP server.
 * Spawns the real server as a subprocess via McpClient.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "../client.ts";

let client: McpClient;
let tmpDir: string;

beforeEach(async () => {
	tmpDir = join(tmpdir(), `pilav-fs-test-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	client = new McpClient("filesystem");
	await client.connect({ name: "filesystem", builtin: "filesystem" });
});

afterEach(async () => {
	await client.disconnect();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("filesystem MCP server — read_file", () => {
	it("reads an existing file", async () => {
		const path = join(tmpDir, "hello.txt");
		writeFileSync(path, "hello world");
		const result = await client.callTool("read_file", { path });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toBe("hello world");
	});

	it("returns error for non-existent file", async () => {
		const result = await client.callTool("read_file", { path: join(tmpDir, "nope.txt") });
		expect(result.isError).toBe(true);
	});
});

describe("filesystem MCP server — write_file", () => {
	it("creates a new file with given content", async () => {
		const path = join(tmpDir, "new.txt");
		const result = await client.callTool("write_file", { path, content: "written by mcp" });
		expect(result.isError).not.toBe(true);
		expect(readFileSync(path, "utf-8")).toBe("written by mcp");
	});

	it("creates parent directories if they do not exist", async () => {
		const path = join(tmpDir, "sub", "dir", "file.txt");
		await client.callTool("write_file", { path, content: "nested" });
		expect(readFileSync(path, "utf-8")).toBe("nested");
	});
});

describe("filesystem MCP server — edit_file", () => {
	it("replaces old_string with new_string", async () => {
		const path = join(tmpDir, "edit.txt");
		writeFileSync(path, "foo bar foo");
		await client.callTool("edit_file", { path, old_string: "foo", new_string: "baz" });
		expect(readFileSync(path, "utf-8")).toBe("baz bar baz");
	});

	it("returns error when old_string not found", async () => {
		const path = join(tmpDir, "edit.txt");
		writeFileSync(path, "hello");
		const result = await client.callTool("edit_file", { path, old_string: "nothere", new_string: "x" });
		expect(result.isError).toBe(true);
	});
});

describe("filesystem MCP server — list_directory", () => {
	it("lists files and directories", async () => {
		writeFileSync(join(tmpDir, "a.txt"), "");
		writeFileSync(join(tmpDir, "b.txt"), "");
		mkdirSync(join(tmpDir, "subdir"));
		const result = await client.callTool("list_directory", { path: tmpDir });
		const text = result.content[0].text ?? "";
		expect(text).toContain("a.txt");
		expect(text).toContain("b.txt");
		expect(text).toContain("subdir/");
	});
});

describe("filesystem MCP server — tool listing", () => {
	it("lists all expected tools", async () => {
		const tools = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("write_file");
		expect(names).toContain("edit_file");
		expect(names).toContain("list_directory");
		expect(names).toContain("glob");
		expect(names).toContain("grep_files");
	});
});
