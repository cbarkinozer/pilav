#!/usr/bin/env node
/**
 * Pilav screen MCP server — macOS desktop automation.
 * Uses built-in macOS tools: screencapture + osascript (no extra installs).
 */

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultExec: ExecFn = async (cmd, args) => {
	const { stdout, stderr } = await execFileAsync(cmd, args);
	return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
};

export interface ScreenSessionOptions {
	exec?: ExecFn;
}

export class ScreenSession {
	private exec: ExecFn;

	constructor(opts: ScreenSessionOptions = {}) {
		this.exec = opts.exec ?? defaultExec;
	}

	async screenshot(outputPath: string): Promise<string> {
		await this.exec("screencapture", ["-x", "-t", "png", outputPath]);
		return outputPath;
	}

	async click(x: number, y: number): Promise<void> {
		const script = `tell application "System Events" to click at {${x}, ${y}}`;
		await this.exec("osascript", ["-e", script]);
	}

	async type(text: string): Promise<void> {
		const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const script = `tell application "System Events" to keystroke "${escaped}"`;
		await this.exec("osascript", ["-e", script]);
	}

	async key(keyName: string): Promise<void> {
		const code = osKeyCodes[keyName] ?? 36;
		const script = `tell application "System Events" to key code ${code} -- ${keyName}`;
		await this.exec("osascript", ["-e", script]);
	}
}

const osKeyCodes: Record<string, number> = {
	Return: 36,
	Tab: 48,
	Space: 49,
	Delete: 51,
	Escape: 53,
	Up: 126,
	Down: 125,
	Left: 123,
	Right: 124,
};

// ── MCP server ─────────────────────────────────────────────────────────────────

const SCREENSHOT_DIR = join(homedir(), ".pilav", "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const screenSession = new ScreenSession();

const server = new Server({ name: "pilav-screen", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "screen_screenshot",
			description: "Take a screenshot of the entire desktop. Returns the file path.",
			inputSchema: { type: "object", properties: {}, required: [] },
		},
		{
			name: "screen_click",
			description: "Click at screen coordinates (x, y).",
			inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
		},
		{
			name: "screen_type",
			description: "Type text using keyboard input.",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
		{
			name: "screen_key",
			description: "Press a named key: Return, Tab, Escape, Up, Down, Left, Right, Delete.",
			inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const args = request.params.arguments as Record<string, unknown>;

	switch (request.params.name) {
		case "screen_screenshot": {
			const path = join(SCREENSHOT_DIR, `${Date.now()}.png`);
			await screenSession.screenshot(path);
			return { content: [{ type: "text", text: path }] };
		}
		case "screen_click": {
			await screenSession.click(Number(args.x), Number(args.y));
			return { content: [{ type: "text", text: `Clicked at (${args.x}, ${args.y})` }] };
		}
		case "screen_type": {
			await screenSession.type(String(args.text));
			return { content: [{ type: "text", text: `Typed: ${String(args.text).slice(0, 40)}` }] };
		}
		case "screen_key": {
			await screenSession.key(String(args.key));
			return { content: [{ type: "text", text: `Pressed key: ${args.key}` }] };
		}
		default:
			throw new Error(`Unknown tool: ${request.params.name}`);
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
