#!/usr/bin/env node
/**
 * Pilav browser MCP server — Playwright-based web automation.
 * Maintains a single persistent browser session per process.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ── Reusable session class (also exported for direct use in tests) ─────────────

export class BrowserSession {
	private browser: Browser | null = null;
	private page: Page | null = null;

	private async ensurePage(): Promise<Page> {
		if (!this.browser) {
			this.browser = await chromium.launch({ headless: true });
		}
		if (!this.page || this.page.isClosed()) {
			this.page = await this.browser.newPage();
		}
		return this.page;
	}

	async navigate(url: string): Promise<string> {
		const page = await this.ensurePage();
		await page.goto(url, { waitUntil: "domcontentloaded" });
		const title = await page.title();
		const bodyText = await page.$eval("body", (el) => (el as HTMLElement).innerText).catch(() => "");
		return `${title}\n${bodyText}`.trim();
	}

	async click(selector: string): Promise<void> {
		const page = await this.ensurePage();
		await page.click(selector);
	}

	async type(selector: string, text: string): Promise<void> {
		const page = await this.ensurePage();
		await page.fill(selector, text);
	}

	async getValue(selector: string): Promise<string> {
		const page = await this.ensurePage();
		return (await page.inputValue(selector)) ?? "";
	}

	async getText(selector: string): Promise<string> {
		const page = await this.ensurePage();
		const el = await page.$(selector);
		return el ? ((await el.innerText()) ?? "") : "";
	}

	async screenshot(outputPath: string): Promise<string> {
		const page = await this.ensurePage();
		await page.screenshot({ path: outputPath, fullPage: false });
		return outputPath;
	}

	async currentUrl(): Promise<string> {
		const page = await this.ensurePage();
		return page.url();
	}

	async close(): Promise<void> {
		if (this.browser) {
			await this.browser.close();
			this.browser = null;
			this.page = null;
		}
	}
}

// ── MCP server ─────────────────────────────────────────────────────────────────

const SCREENSHOT_DIR = join(homedir(), ".pilav", "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const session = new BrowserSession();

const server = new Server({ name: "pilav-browser", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "browser_navigate",
			description: "Navigate to a URL. Returns the page title.",
			inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
		},
		{
			name: "browser_click",
			description: "Click an element by CSS selector.",
			inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
		},
		{
			name: "browser_type",
			description: "Fill a text input by CSS selector.",
			inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"] },
		},
		{
			name: "browser_screenshot",
			description: "Take a screenshot of the current page. Returns the file path.",
			inputSchema: { type: "object", properties: {}, required: [] },
		},
		{
			name: "browser_get_text",
			description: "Get visible text of an element by CSS selector.",
			inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
		},
		{
			name: "browser_current_url",
			description: "Get the current page URL.",
			inputSchema: { type: "object", properties: {}, required: [] },
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const args = request.params.arguments as Record<string, string>;

	switch (request.params.name) {
		case "browser_navigate": {
			const title = await session.navigate(args.url);
			return { content: [{ type: "text", text: `Navigated to ${args.url} — title: "${title}"` }] };
		}
		case "browser_click": {
			await session.click(args.selector);
			return { content: [{ type: "text", text: `Clicked "${args.selector}"` }] };
		}
		case "browser_type": {
			await session.type(args.selector, args.text);
			return { content: [{ type: "text", text: `Typed into "${args.selector}"` }] };
		}
		case "browser_screenshot": {
			const path = join(SCREENSHOT_DIR, `${Date.now()}.png`);
			await session.screenshot(path);
			return { content: [{ type: "text", text: path }] };
		}
		case "browser_get_text": {
			const text = await session.getText(args.selector ?? "body");
			return { content: [{ type: "text", text }] };
		}
		case "browser_current_url": {
			const url = await session.currentUrl();
			return { content: [{ type: "text", text: url }] };
		}
		default:
			throw new Error(`Unknown tool: ${request.params.name}`);
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
