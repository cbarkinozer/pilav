/**
 * T002-CU — Screen MCP tool tests (TDD)
 * Mocks subprocess calls — no actual screen interaction.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenSession } from "../servers/screen.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pilav-screen-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("ScreenSession — screenshot", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("calls screencapture and returns the output path", async () => {
		const screenshotPath = join(dir, "test.png");
		// Inject a fake exec that pretends screencapture wrote the file
		const fakeExec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
			const outPath = args[args.length - 1];
			writeFileSync(outPath, Buffer.from("PNG_FAKE_DATA"));
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		const session = new ScreenSession({ exec: fakeExec });
		const result = await session.screenshot(screenshotPath);

		expect(result).toBe(screenshotPath);
		expect(fakeExec).toHaveBeenCalledWith("screencapture", expect.arrayContaining([screenshotPath]));
	});
});

describe("ScreenSession — click", () => {
	it("calls osascript with the correct coordinates", async () => {
		const fakeExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
		const session = new ScreenSession({ exec: fakeExec });

		await session.click(500, 300);

		const call = fakeExec.mock.calls[0];
		expect(call[0]).toBe("osascript");
		const script = call[1].join(" ");
		expect(script).toContain("500");
		expect(script).toContain("300");
	});
});

describe("ScreenSession — type", () => {
	it("calls osascript keystroke for each character block", async () => {
		const fakeExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
		const session = new ScreenSession({ exec: fakeExec });

		await session.type("hello");

		expect(fakeExec).toHaveBeenCalled();
		const script = fakeExec.mock.calls[0][1].join(" ");
		expect(script).toContain("hello");
	});
});

describe("ScreenSession — key", () => {
	it("sends Return key via osascript", async () => {
		const fakeExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
		const session = new ScreenSession({ exec: fakeExec });

		await session.key("Return");

		const script = fakeExec.mock.calls[0][1].join(" ");
		expect(script).toMatch(/Return|return/i);
	});
});
