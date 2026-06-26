/**
 * T003-CU — Vision analysis tests (TDD)
 * Mocks LM Studio HTTP — no actual model calls.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeScreenshot, type VisionAction } from "../vision.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pilav-vision-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function fakeFetch(responseText: string) {
	return vi.fn().mockResolvedValue({
		ok: true,
		json: async () => ({
			choices: [{ message: { content: responseText } }],
		}),
	});
}

describe("analyzeScreenshot — action parsing", () => {
	let dir: string;
	let screenshotPath: string;
	beforeEach(() => {
		dir = makeTempDir();
		screenshotPath = join(dir, "screen.png");
		writeFileSync(screenshotPath, Buffer.from("PNG_FAKE"));
	});
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("parses a click action from model response", async () => {
		const fetch = fakeFetch('ACTION: click\nX: 450\nY: 320\nREASON: The submit button is at those coordinates.');
		const result = await analyzeScreenshot(screenshotPath, "Submit the form", { fetch });
		expect(result.action).toBe("click");
		expect(result.x).toBe(450);
		expect(result.y).toBe(320);
	});

	it("parses a type action", async () => {
		const fetch = fakeFetch('ACTION: type\nTEXT: hello world\nREASON: The input field is focused.');
		const result = await analyzeScreenshot(screenshotPath, "Enter the username", { fetch });
		expect(result.action).toBe("type");
		expect(result.text).toBe("hello world");
	});

	it("parses a navigate action", async () => {
		const fetch = fakeFetch('ACTION: navigate\nURL: https://example.com/login\nREASON: Need to go to login page.');
		const result = await analyzeScreenshot(screenshotPath, "Go to login", { fetch });
		expect(result.action).toBe("navigate");
		expect(result.url).toContain("example.com");
	});

	it("parses a done action", async () => {
		const fetch = fakeFetch('ACTION: done\nREASON: The task is complete, the form was submitted successfully.');
		const result = await analyzeScreenshot(screenshotPath, "Submit form", { fetch });
		expect(result.action).toBe("done");
	});

	it("parses a stuck action", async () => {
		const fetch = fakeFetch('ACTION: stuck\nREASON: Cannot identify the correct element to interact with.');
		const result = await analyzeScreenshot(screenshotPath, "Do something", { fetch });
		expect(result.action).toBe("stuck");
		expect(result.reason).toBeTruthy();
	});

	it("defaults to stuck when model output is unrecognized", async () => {
		const fetch = fakeFetch('I see a browser window with some text on it.');
		const result = await analyzeScreenshot(screenshotPath, "Do something", { fetch });
		expect(result.action).toBe("stuck");
	});
});
