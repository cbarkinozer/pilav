import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolResult } from "./cache.ts";
import type { ServerConfig } from "./config.ts";

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export class McpClient {
	private client: Client;
	private transport: StdioClientTransport | null = null;
	readonly serverName: string;

	constructor(serverName: string) {
		this.serverName = serverName;
		this.client = new Client({ name: "pilav-mcp-client", version: "0.1.0" });
	}

	async connect(config: ServerConfig): Promise<void> {
		let command: string;
		let args: string[];

		if (config.builtin) {
			// Resolve built-in server path and run with tsx (available in monorepo root)
			const serverPath = new URL(`./servers/${config.builtin}.ts`, import.meta.url).pathname;
			const tsxPath = new URL("../../../../../node_modules/.bin/tsx", import.meta.url).pathname;
			command = tsxPath;
			args = [serverPath];
		} else {
			command = config.command ?? "node";
			args = config.args ?? [];
		}

		const env: Record<string, string> = { ...process.env, ...(config.env ?? {}) } as Record<string, string>;

		if (config.allowedPaths) env.ALLOWED_PATHS = config.allowedPaths.join(":");
		if (config.allowedCommands) env.ALLOWED_COMMANDS = config.allowedCommands.join(",");
		if (config.allowCommit) env.ALLOW_COMMIT = "true";

		this.transport = new StdioClientTransport({ command, args, env });
		await this.client.connect(this.transport);
	}

	async listTools(): Promise<McpTool[]> {
		const res = await this.client.listTools();
		return res.tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
		}));
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		const res = await this.client.callTool({ name, arguments: args });
		return {
			content: (res.content as ToolResult["content"]) ?? [],
			isError: res.isError === true,
		};
	}

	async disconnect(): Promise<void> {
		try {
			await this.client.close();
		} catch {
			// ignore close errors
		}
	}
}
