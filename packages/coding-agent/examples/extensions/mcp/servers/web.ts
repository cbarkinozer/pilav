#!/usr/bin/env node
/**
 * Pilav MCP web server — exposes fetch_url and search_web as MCP tools.
 * fetch_url returns page text (stripped HTML). search_web uses DuckDuckGo
 * lite — no API key required.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\s{3,}/g, "\n\n")
		.trim();
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": "pilav-agent/0.1 (+https://github.com/cbarkinozer/pilav)" },
		});
		const text = await res.text();
		return stripHtml(text).slice(0, 20_000);
	} finally {
		clearTimeout(timer);
	}
}

async function searchWeb(query: string): Promise<string> {
	const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
	const html = await fetchText(url);
	// Extract result snippets from DuckDuckGo lite — plain text is sufficient
	return html.slice(0, 8_000);
}

const server = new Server({ name: "pilav-web", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "fetch_url",
			description: "Fetch a URL and return its text content (HTML stripped).",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string" },
					timeout_ms: { type: "number" },
				},
				required: ["url"],
			},
		},
		{
			name: "search_web",
			description: "Search the web via DuckDuckGo lite (no API key needed) and return result snippets.",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const args = req.params.arguments as Record<string, unknown>;
	try {
		switch (req.params.name) {
			case "fetch_url": {
				const text = await fetchText(args.url as string, (args.timeout_ms as number) ?? 15_000);
				return { content: [{ type: "text", text }] };
			}
			case "search_web": {
				const text = await searchWeb(args.query as string);
				return { content: [{ type: "text", text }] };
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
