#!/usr/bin/env node
/**
 * Pilav MCP git server — exposes git_status, git_diff, git_log, git_add,
 * git_commit as MCP tools.
 *
 * Config (from environment):
 *   ALLOW_COMMIT — set to "true" to enable git_commit (default: blocked)
 *   GIT_REPO     — working repo path (default: process.cwd())
 */
import { execSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const allowCommit = process.env.ALLOW_COMMIT === "true";
const repoPath = process.env.GIT_REPO ?? process.cwd();

function git(args: string, cwd = repoPath): string {
	return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

const server = new Server({ name: "pilav-git", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "git_status",
			description: "Show working tree status (git status --short).",
			inputSchema: { type: "object", properties: { repo: { type: "string" } } },
		},
		{
			name: "git_diff",
			description: "Show diff of staged + unstaged changes.",
			inputSchema: {
				type: "object",
				properties: { repo: { type: "string" }, staged: { type: "boolean" } },
			},
		},
		{
			name: "git_log",
			description: "Show recent commit log.",
			inputSchema: {
				type: "object",
				properties: { repo: { type: "string" }, count: { type: "number" } },
			},
		},
		{
			name: "git_add",
			description: "Stage files for commit.",
			inputSchema: {
				type: "object",
				properties: {
					paths: { type: "array", items: { type: "string" } },
					repo: { type: "string" },
				},
				required: ["paths"],
			},
		},
		{
			name: "git_commit",
			description: "Commit staged changes. Requires allowCommit: true in server config.",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" }, repo: { type: "string" } },
				required: ["message"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const args = req.params.arguments as Record<string, unknown>;
	const cwd = (args.repo as string | undefined) ?? repoPath;
	try {
		switch (req.params.name) {
			case "git_status":
				return { content: [{ type: "text", text: git("status --short", cwd) }] };
			case "git_diff": {
				const flag = args.staged ? "--cached" : "";
				return { content: [{ type: "text", text: git(`diff ${flag}`.trim(), cwd) }] };
			}
			case "git_log": {
				const n = (args.count as number | undefined) ?? 10;
				return { content: [{ type: "text", text: git(`log --oneline -${n}`, cwd) }] };
			}
			case "git_add": {
				const paths = (args.paths as string[]).map((p) => JSON.stringify(p)).join(" ");
				git(`add ${paths}`, cwd);
				return { content: [{ type: "text", text: "Staged." }] };
			}
			case "git_commit": {
				if (!allowCommit) {
					return {
						content: [{ type: "text", text: "git_commit is disabled. Set allowCommit: true in MCP config." }],
						isError: true,
					};
				}
				const msg = JSON.stringify(args.message as string);
				const out = git(`commit -m ${msg}`, cwd);
				return { content: [{ type: "text", text: out }] };
			}
			default:
				return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
		}
	} catch (err: unknown) {
		const e = err as { stderr?: string; message?: string };
		return { content: [{ type: "text", text: e.stderr ?? String(e) }], isError: true };
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
