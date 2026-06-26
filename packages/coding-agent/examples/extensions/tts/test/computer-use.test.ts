/**
 * T004-CU — Computer use loop tests (TDD)
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runComputerUseLoop, type ComputerUseHandlers } from "../computer-use.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pilav-cu-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function fakeScreenshot(dir: string, name = "screen.png"): string {
	const p = join(dir, name);
	writeFileSync(p, Buffer.from("PNG"));
	return p;
}

describe("runComputerUseLoop — happy path", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns done when vision says done", async () => {
		const handlers: ComputerUseHandlers = {
			screenshot: vi.fn().mockResolvedValue(fakeScreenshot(dir)),
			analyzeScreenshot: vi.fn().mockResolvedValue({ action: "done", reason: "Task complete" }),
			browserNavigate: vi.fn(),
			browserClick: vi.fn(),
			browserType: vi.fn(),
			screenClick: vi.fn(),
			screenType: vi.fn(),
			screenKey: vi.fn(),
		};

		const result = await runComputerUseLoop("Submit the form", { screenshotDir: dir }, handlers);

		expect(result.status).toBe("done");
		expect(handlers.analyzeScreenshot).toHaveBeenCalled();
	});

	it("executes a click action before checking again", async () => {
		let callCount = 0;
		const handlers: ComputerUseHandlers = {
			screenshot: vi.fn().mockImplementation(() => { writeFileSync(join(dir, `s${callCount}.png`), Buffer.from("PNG")); return Promise.resolve(join(dir, `s${callCount++}.png`)); }),
			analyzeScreenshot: vi.fn()
				.mockResolvedValueOnce({ action: "click", x: 100, y: 200, reason: "Click the button" })
				.mockResolvedValueOnce({ action: "done", reason: "Done" }),
			browserNavigate: vi.fn(),
			browserClick: vi.fn().mockResolvedValue(undefined),
			browserType: vi.fn(),
			screenClick: vi.fn(),
			screenType: vi.fn(),
			screenKey: vi.fn(),
		};

		const result = await runComputerUseLoop("Click and done", { screenshotDir: dir, useScreenFallback: true }, handlers);

		expect(handlers.screenClick).toHaveBeenCalledWith(100, 200);
		expect(result.status).toBe("done");
	});

	it("executes a type action", async () => {
		let callCount = 0;
		const handlers: ComputerUseHandlers = {
			screenshot: vi.fn().mockImplementation(() => { writeFileSync(join(dir, `s${callCount}.png`), Buffer.from("PNG")); return Promise.resolve(join(dir, `s${callCount++}.png`)); }),
			analyzeScreenshot: vi.fn()
				.mockResolvedValueOnce({ action: "type", text: "hello@test.com", reason: "Type email" })
				.mockResolvedValueOnce({ action: "done", reason: "Done" }),
			browserNavigate: vi.fn(),
			browserClick: vi.fn(),
			browserType: vi.fn().mockResolvedValue(undefined),
			screenClick: vi.fn(),
			screenType: vi.fn(),
			screenKey: vi.fn(),
		};

		await runComputerUseLoop("Enter email", { screenshotDir: dir }, handlers);

		expect(handlers.browserType).toHaveBeenCalledWith("hello@test.com");
	});
});

describe("runComputerUseLoop — escalation", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns stuck status and calls expertFn when vision says stuck", async () => {
		const expertFn = vi.fn().mockResolvedValue("Look for a button labeled Submit in the bottom right.");
		const handlers: ComputerUseHandlers = {
			screenshot: vi.fn().mockImplementation(() => { const p = join(dir, `s${Date.now()}.png`); writeFileSync(p, Buffer.from("PNG")); return Promise.resolve(p); }),
			analyzeScreenshot: vi.fn().mockResolvedValue({ action: "stuck", reason: "Cannot find submit button" }),
			browserNavigate: vi.fn(),
			browserClick: vi.fn(),
			browserType: vi.fn(),
			screenClick: vi.fn(),
			screenType: vi.fn(),
			screenKey: vi.fn(),
		};

		const result = await runComputerUseLoop("Submit the form", { screenshotDir: dir, maxSteps: 3, expertFn }, handlers);

		expect(result.status).toBe("stuck");
		expect(expertFn).toHaveBeenCalled();
	});

	it("sends proof screenshot path in the result", async () => {
		const screenshotPath = fakeScreenshot(dir);
		const handlers: ComputerUseHandlers = {
			screenshot: vi.fn().mockResolvedValue(screenshotPath),
			analyzeScreenshot: vi.fn().mockResolvedValue({ action: "done", reason: "Done" }),
			browserNavigate: vi.fn(),
			browserClick: vi.fn(),
			browserType: vi.fn(),
			screenClick: vi.fn(),
			screenType: vi.fn(),
			screenKey: vi.fn(),
		};

		const result = await runComputerUseLoop("Do task", { screenshotDir: dir }, handlers);

		expect(result.screenshotPath).toBe(screenshotPath);
	});
});
