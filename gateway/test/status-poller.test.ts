/**
 * T006 — Proactive Telegram status push tests (TDD)
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusPoller } from "../src/status-poller.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pilav-poller-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeStatus(dir: string, status: object): void {
	writeFileSync(join(dir, "tts-status.json"), JSON.stringify(status), "utf-8");
}

describe("StatusPoller", () => {
	let dir: string;
	beforeEach(() => { dir = makeTempDir(); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

	it("sends a message when status changes step", async () => {
		vi.useFakeTimers();
		const sendMessage = vi.fn().mockResolvedValue(undefined);
		const getChatIds = vi.fn().mockReturnValue([123456]);

		writeStatus(dir, { sessionId: "s1", step: 1, totalSteps: 5, status: "working", currentTask: "Analyze code", elapsedMs: 1000 });

		const poller = new StatusPoller({ pilav_dir: dir, getChatIds, sendMessage, interval_ms: 1000 });
		poller.start();

		await vi.advanceTimersByTimeAsync(1100);
		// No change yet — no message
		expect(sendMessage).not.toHaveBeenCalled();

		// Now change the status
		writeStatus(dir, { sessionId: "s1", step: 2, totalSteps: 5, status: "working", currentTask: "Write tests", elapsedMs: 2000 });
		await vi.advanceTimersByTimeAsync(1100);

		expect(sendMessage).toHaveBeenCalledOnce();
		expect(sendMessage).toHaveBeenCalledWith(123456, expect.stringContaining("Write tests"));

		poller.stop();
	});

	it("does not send when status is unchanged", async () => {
		vi.useFakeTimers();
		const sendMessage = vi.fn().mockResolvedValue(undefined);
		const getChatIds = vi.fn().mockReturnValue([111]);

		writeStatus(dir, { sessionId: "s1", step: 3, totalSteps: 5, status: "working", currentTask: "Do work", elapsedMs: 3000 });

		const poller = new StatusPoller({ pilav_dir: dir, getChatIds, sendMessage, interval_ms: 500 });
		poller.start();

		await vi.advanceTimersByTimeAsync(2000);
		expect(sendMessage).not.toHaveBeenCalled();

		poller.stop();
	});

	it("sends to all active chat IDs", async () => {
		vi.useFakeTimers();
		const sendMessage = vi.fn().mockResolvedValue(undefined);
		const getChatIds = vi.fn().mockReturnValue([111, 222, 333]);

		writeStatus(dir, { sessionId: "s1", step: 1, totalSteps: 3, status: "working", currentTask: "Initial step", elapsedMs: 500 });
		const poller = new StatusPoller({ pilav_dir: dir, getChatIds, sendMessage, interval_ms: 500 });
		poller.start();
		await vi.advanceTimersByTimeAsync(600);

		writeStatus(dir, { sessionId: "s1", step: 2, totalSteps: 3, status: "done", currentTask: "Final step", elapsedMs: 1500 });
		await vi.advanceTimersByTimeAsync(600);

		expect(sendMessage).toHaveBeenCalledTimes(3);
		expect(sendMessage).toHaveBeenCalledWith(111, expect.any(String));
		expect(sendMessage).toHaveBeenCalledWith(222, expect.any(String));
		expect(sendMessage).toHaveBeenCalledWith(333, expect.any(String));

		poller.stop();
	});

	it("does nothing when no status file exists", async () => {
		vi.useFakeTimers();
		const sendMessage = vi.fn().mockResolvedValue(undefined);
		const getChatIds = vi.fn().mockReturnValue([999]);

		const poller = new StatusPoller({ pilav_dir: dir, getChatIds, sendMessage, interval_ms: 300 });
		poller.start();
		await vi.advanceTimersByTimeAsync(1000);

		expect(sendMessage).not.toHaveBeenCalled();
		poller.stop();
	});
});
