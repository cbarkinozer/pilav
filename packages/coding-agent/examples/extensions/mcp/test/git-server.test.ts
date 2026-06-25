/**
 * Integration tests for the pilav-git MCP server.
 * Uses the actual pilav repo as the test repo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "../client.ts";

const REPO = "/Users/cbarkinozer/Documents/GitHub/pilav";

let client: McpClient;
let commitBlockedClient: McpClient;

beforeEach(async () => {
	client = new McpClient("git");
	await client.connect({ name: "git", builtin: "git", allowCommit: false });

	commitBlockedClient = new McpClient("git-no-commit");
	await commitBlockedClient.connect({ name: "git-no-commit", builtin: "git" });
});

afterEach(async () => {
	await client.disconnect();
	await commitBlockedClient.disconnect();
});

describe("git MCP server — git_status", () => {
	it("returns status output for a real git repo", async () => {
		const result = await client.callTool("git_status", { repo: REPO });
		expect(result.isError).not.toBe(true);
		// Output may be empty (clean repo) or list files — just check it's a string
		expect(typeof result.content[0].text).toBe("string");
	});
});

describe("git MCP server — git_log", () => {
	it("returns recent commits", async () => {
		const result = await client.callTool("git_log", { repo: REPO, count: 3 });
		expect(result.isError).not.toBe(true);
		const text = result.content[0].text ?? "";
		// Oneline log has commit hashes
		expect(text.split("\n").length).toBeGreaterThanOrEqual(1);
	});
});

describe("git MCP server — git_diff", () => {
	it("returns diff output without error (may be empty on clean repo)", async () => {
		const result = await client.callTool("git_diff", { repo: REPO });
		expect(result.isError).not.toBe(true);
	});
});

describe("git MCP server — git_commit safety gate", () => {
	it("blocks git_commit when allowCommit is false (default)", async () => {
		const result = await commitBlockedClient.callTool("git_commit", {
			repo: REPO,
			message: "test commit — should be blocked",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("disabled");
	});
});

describe("git MCP server — tool listing", () => {
	it("lists all expected tools", async () => {
		const tools = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("git_status");
		expect(names).toContain("git_diff");
		expect(names).toContain("git_log");
		expect(names).toContain("git_add");
		expect(names).toContain("git_commit");
	});
});
