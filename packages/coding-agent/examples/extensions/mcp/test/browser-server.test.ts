/**
 * T001-CU — Browser MCP tool tests (TDD)
 * Uses a real Playwright browser against a local HTTP server.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrowserSession } from "../servers/browser.ts";

let server: Server;
let port: number;
let dir: string;

beforeAll(async () => {
	await new Promise<void>((resolve) => {
		server = createServer((req, res) => {
			if (req.url === "/") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(`<html><body>
					<h1 id="title">Hello Pilav</h1>
					<button id="btn" onclick="document.getElementById('title').textContent='Clicked'">Click me</button>
					<input id="inp" type="text" />
					<a href="/page2" id="link">Go to page 2</a>
				</body></html>`);
			} else if (req.url === "/page2") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end("<html><body><h1 id='p2'>Page 2</h1></body></html>");
			} else {
				res.writeHead(404); res.end();
			}
		});
		server.listen(0, "127.0.0.1", () => {
			port = (server.address() as { port: number }).port;
			resolve();
		});
	});
});

afterAll(() => { server.close(); });

beforeEach(() => {
	dir = join(tmpdir(), `pilav-browser-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("BrowserSession — navigation", () => {
	it("navigates to a URL and returns page title", async () => {
		const session = new BrowserSession();
		try {
			const result = await session.navigate(`http://127.0.0.1:${port}/`);
			expect(result).toContain("Hello Pilav");
		} finally {
			await session.close();
		}
	});

	it("returns page 2 content after navigation", async () => {
		const session = new BrowserSession();
		try {
			await session.navigate(`http://127.0.0.1:${port}/`);
			const result = await session.navigate(`http://127.0.0.1:${port}/page2`);
			expect(result).toContain("Page 2");
		} finally {
			await session.close();
		}
	});
});

describe("BrowserSession — click", () => {
	it("clicks a button and reflects DOM change", async () => {
		const session = new BrowserSession();
		try {
			await session.navigate(`http://127.0.0.1:${port}/`);
			await session.click("#btn");
			const text = await session.getText("#title");
			expect(text).toBe("Clicked");
		} finally {
			await session.close();
		}
	});
});

describe("BrowserSession — type", () => {
	it("types into an input field", async () => {
		const session = new BrowserSession();
		try {
			await session.navigate(`http://127.0.0.1:${port}/`);
			await session.type("#inp", "hello world");
			const val = await session.getValue("#inp");
			expect(val).toBe("hello world");
		} finally {
			await session.close();
		}
	});
});

describe("BrowserSession — screenshot", () => {
	it("takes a screenshot and writes a PNG file", async () => {
		const session = new BrowserSession();
		try {
			await session.navigate(`http://127.0.0.1:${port}/`);
			const screenshotPath = join(dir, "test.png");
			await session.screenshot(screenshotPath);
			expect(existsSync(screenshotPath)).toBe(true);
		} finally {
			await session.close();
		}
	});
});

describe("BrowserSession — getText", () => {
	it("returns visible page text", async () => {
		const session = new BrowserSession();
		try {
			await session.navigate(`http://127.0.0.1:${port}/`);
			const text = await session.getText("body");
			expect(text).toContain("Hello Pilav");
		} finally {
			await session.close();
		}
	});
});
