#!/usr/bin/env node
/**
 * Pilav MCP filesystem server — exposes read_file, write_file, edit_file,
 * list_directory, glob, grep_files as MCP tools via stdio transport.
 *
 * Config (from environment):
 *   ALLOWED_PATHS — colon-separated list of allowed absolute paths (optional)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { glob as globPromise } from "node:fs/promises";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const allowedPaths = process.env.ALLOWED_PATHS ? process.env.ALLOWED_PATHS.split(":") : [];

function checkAllowed(p: string): void {
	if (allowedPaths.length === 0) return;
	const abs = resolve(p);
	if (!allowedPaths.some((ap) => abs.startsWith(resolve(ap)))) {
		throw new Error(`Path not allowed: ${p}`);
	}
}

const server = new Server({ name: "pilav-filesystem", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "read_file",
			description: "Read a file and return its contents as text.",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		{
			name: "write_file",
			description: "Write text content to a file (creates parent dirs if needed).",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
		},
		{
			name: "edit_file",
			description: "Replace occurrences of old_string with new_string in a file.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string" },
					old_string: { type: "string" },
					new_string: { type: "string" },
				},
				required: ["path", "old_string", "new_string"],
			},
		},
		{
			name: "list_directory",
			description: "List files and directories at the given path.",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		{
			name: "glob",
			description: "Find files matching a glob pattern.",
			inputSchema: {
				type: "object",
				properties: { pattern: { type: "string" }, cwd: { type: "string" } },
				required: ["pattern"],
			},
		},
		{
			name: "grep_files",
			description: "Search for a regex pattern in files under a directory.",
			inputSchema: {
				type: "object",
				properties: {
					pattern: { type: "string" },
					dir: { type: "string" },
					extension: { type: "string" },
				},
				required: ["pattern", "dir"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const args = req.params.arguments as Record<string, string>;
	try {
		switch (req.params.name) {
			case "read_file": {
				checkAllowed(args.path);
				const content = readFileSync(args.path, "utf-8");
				return { content: [{ type: "text", text: content }] };
			}
			case "write_file": {
				checkAllowed(args.path);
				const dir = resolve(args.path, "..");
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				writeFileSync(args.path, args.content, "utf-8");
				return { content: [{ type: "text", text: `Written ${args.path}` }] };
			}
			case "edit_file": {
				checkAllowed(args.path);
				const original = readFileSync(args.path, "utf-8");
				if (!original.includes(args.old_string)) {
					return { content: [{ type: "text", text: "old_string not found in file" }], isError: true };
				}
				writeFileSync(args.path, original.replaceAll(args.old_string, args.new_string), "utf-8");
				return { content: [{ type: "text", text: `Edited ${args.path}` }] };
			}
			case "list_directory": {
				checkAllowed(args.path);
				const entries = readdirSync(args.path).map((name) => {
					const full = resolve(args.path, name);
					return statSync(full).isDirectory() ? `${name}/` : name;
				});
				return { content: [{ type: "text", text: entries.join("\n") }] };
			}
			case "glob": {
				const cwd = args.cwd ?? process.cwd();
				checkAllowed(cwd);
				const matches: string[] = [];
				for await (const f of globPromise(args.pattern, { cwd })) {
					matches.push(f as string);
				}
				return { content: [{ type: "text", text: matches.join("\n") }] };
			}
			case "grep_files": {
				checkAllowed(args.dir);
				const re = new RegExp(args.pattern, "g");
				const results: string[] = [];
				function walk(dir: string) {
					for (const name of readdirSync(dir)) {
						const full = resolve(dir, name);
						if (statSync(full).isDirectory()) {
							walk(full);
						} else if (!args.extension || name.endsWith(args.extension)) {
							const text = readFileSync(full, "utf-8");
							const lines = text.split("\n");
							lines.forEach((line, i) => {
								if (re.test(line)) results.push(`${full}:${i + 1}: ${line.trim()}`);
								re.lastIndex = 0;
							});
						}
					}
				}
				walk(args.dir);
				return { content: [{ type: "text", text: results.join("\n") || "(no matches)" }] };
			}
			default:
				return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
		}
	} catch (err) {
		return { content: [{ type: "text", text: String(err) }], isError: true };
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
