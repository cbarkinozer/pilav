#!/usr/bin/env node
/**
 * Pilav MCP shell server — exposes bash as an MCP tool.
 * Commands run in a temp directory by default.
 *
 * Config (from environment):
 *   ALLOWED_COMMANDS — comma-separated allowlist (if set, only these base commands run)
 *   WORK_DIR         — working directory override (default: OS temp dir)
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const allowedCommands = process.env.ALLOWED_COMMANDS ? process.env.ALLOWED_COMMANDS.split(",").map((s) => s.trim()) : [];
const workDirBase = process.env.WORK_DIR ?? tmpdir();

function getBaseCommand(cmd: string): string {
	return cmd.trim().split(/\s+/)[0];
}

const server = new Server({ name: "pilav-shell", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "bash",
			description: "Run a shell command. Executes in a sandboxed temp directory by default.",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", description: "Shell command to execute" },
					cwd: { type: "string", description: "Working directory (optional, overrides sandbox)" },
					timeout_ms: { type: "number", description: "Timeout in milliseconds (default 30000)" },
				},
				required: ["command"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const args = req.params.arguments as { command: string; cwd?: string; timeout_ms?: number };

	if (req.params.name !== "bash") {
		return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
	}

	const base = getBaseCommand(args.command);
	if (allowedCommands.length > 0 && !allowedCommands.includes(base)) {
		return {
			content: [{ type: "text", text: `Command '${base}' not in allowed list: ${allowedCommands.join(", ")}` }],
			isError: true,
		};
	}

	// Create a fresh temp sandbox if no explicit cwd
	let cwd = args.cwd;
	if (!cwd) {
		mkdirSync(workDirBase, { recursive: true });
		cwd = mkdtempSync(join(workDirBase, "pilav-shell-"));
	}

	try {
		const stdout = execSync(args.command, {
			cwd,
			timeout: args.timeout_ms ?? 30_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { content: [{ type: "text", text: stdout }] };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
		return { content: [{ type: "text", text: output }], isError: true };
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
