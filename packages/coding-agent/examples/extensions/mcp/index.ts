import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolCache, ToolResult } from "./cache.ts";
import { McpClient } from "./client.ts";
import { loadConfig, ServerConfig } from "./config.ts";

export default async function (pi: ExtensionAPI) {
	const config = loadConfig();
	const cache = new ToolCache();
	const clients = new Map<string, McpClient>();

	for (const serverCfg of config.servers) {
		const client = new McpClient(serverCfg.name);
		try {
			await client.connect(serverCfg);
			const tools = await client.listTools();
			clients.set(serverCfg.name, client);

			for (const tool of tools) {
				const fullName = `${serverCfg.name}__${tool.name}`;
				const shouldCache = serverCfg.cacheResults !== false && !isMutating(tool.name);

				pi.registerTool({
					name: fullName,
					description: `[${serverCfg.name}] ${tool.description ?? tool.name}`,
					inputSchema: tool.inputSchema,
					handler: async (args: Record<string, unknown>): Promise<string> => {
						if (shouldCache) {
							const cacheKey = ToolCache.key(serverCfg.name, tool.name, args);
							const cached = cache.get(cacheKey);
							if (cached) return formatResult(cached);
							const result = await client.callTool(tool.name, args);
							cache.set(cacheKey, result);
							return formatResult(result);
						}
						const result = await client.callTool(tool.name, args);
						return formatResult(result);
					},
				});
			}
		} catch (err) {
			// Non-fatal: log and continue loading other servers
			console.error(`[pilav-mcp] Failed to connect server "${serverCfg.name}":`, err);
		}
	}

	// Cleanup on extension unload (best-effort)
	process.on("exit", () => {
		for (const client of clients.values()) {
			void client.disconnect();
		}
	});
}

function isMutating(toolName: string): boolean {
	return ["write_file", "edit_file", "bash", "git_add", "git_commit", "search_web"].includes(toolName);
}

function formatResult(result: ToolResult): string {
	return result.content
		.map((c) => (c.text ?? ""))
		.join("\n")
		.trim();
}
