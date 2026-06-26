#!/usr/bin/env node
/**
 * Pilav ask_expert MCP server — lets the SLM escalate to Claude Code.
 *
 * Protocol:
 *   1. Tool call writes ~/.pilav/expert-request.json with {question, timestamp}
 *   2. Polls ~/.pilav/expert-response.json every POLL_INTERVAL_MS up to TIMEOUT_MS
 *   3. Returns guidance string; never throws (returns timeout message on failure)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_PILAV_DIR = join(homedir(), ".pilav");
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface AskExpertOptions {
	pilav_dir?: string;
	poll_interval_ms?: number;
	timeout_ms?: number;
}

export async function askExpert(question: string, opts: AskExpertOptions = {}): Promise<string> {
	const dir = opts.pilav_dir ?? DEFAULT_PILAV_DIR;
	const pollMs = opts.poll_interval_ms ?? POLL_INTERVAL_MS;
	const timeoutMs = opts.timeout_ms ?? TIMEOUT_MS;

	const requestPath = join(dir, "expert-request.json");
	const responsePath = join(dir, "expert-response.json");

	const requestTimestamp = new Date().toISOString();
	writeFileSync(requestPath, JSON.stringify({ question, timestamp: requestTimestamp }), "utf-8");

	const deadline = Date.now() + timeoutMs;
	// Poll: check immediately, then sleep between checks
	while (Date.now() < deadline) {
		if (existsSync(responsePath)) {
			try {
				const raw = readFileSync(responsePath, "utf-8");
				const parsed = JSON.parse(raw) as { guidance?: string; timestamp?: string };
				// Accept any response — in production, expert writes a fresh file after seeing the request
				return parsed.guidance ?? raw;
			} catch {
				return "Expert response was malformed.";
			}
		}
		await new Promise<void>((r) => setTimeout(r, pollMs));
	}

	return `[Expert timeout — no response received within ${timeoutMs / 1000}s. Proceeding without guidance.]`;
}

// ── MCP server entry point ────────────────────────────────────────────────────

const server = new Server({ name: "pilav-expert", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "ask_expert",
			description: "Escalate a blocking question to the Claude Code expert. Returns guidance text. Use when stuck after retries.",
			inputSchema: {
				type: "object",
				properties: {
					question: { type: "string", description: "The specific question or problem description to send to the expert." },
				},
				required: ["question"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name !== "ask_expert") {
		throw new Error(`Unknown tool: ${request.params.name}`);
	}
	const question = (request.params.arguments as { question: string }).question;
	const guidance = await askExpert(question);
	return { content: [{ type: "text", text: guidance }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
