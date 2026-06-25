import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ServerConfig {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	builtin?: "filesystem" | "shell" | "web" | "git";
	allowedPaths?: string[];
	allowedCommands?: string[];
	allowCommit?: boolean;
	cacheResults?: boolean;
}

export interface McpConfig {
	servers: ServerConfig[];
}

const DEFAULT_CONFIG: McpConfig = {
	servers: [
		{ name: "filesystem", builtin: "filesystem" },
		{ name: "shell", builtin: "shell" },
		{ name: "web", builtin: "web" },
		{ name: "git", builtin: "git" },
	],
};

export function loadConfig(configPath?: string): McpConfig {
	const candidates = [
		configPath,
		process.env.MCP_CONFIG_PATH,
		join(homedir(), ".pilav", "mcp", "config.json"),
		join(process.cwd(), ".pilav", "mcp", "config.json"),
	].filter(Boolean) as string[];

	for (const p of candidates) {
		const resolved = resolve(p);
		if (existsSync(resolved)) {
			try {
				const raw = readFileSync(resolved, "utf-8");
				return JSON.parse(raw) as McpConfig;
			} catch {
				// malformed config — fall through to default
			}
		}
	}

	return DEFAULT_CONFIG;
}

export function builtinServerPath(builtin: string): string {
	return new URL(`./servers/${builtin}.ts`, import.meta.url).pathname;
}
