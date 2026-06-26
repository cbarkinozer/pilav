import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VisionAction } from "./vision.ts";

export interface ComputerUseHandlers {
	screenshot: (outputPath: string) => Promise<string>;
	analyzeScreenshot: (screenshotPath: string, task: string) => Promise<VisionAction>;
	browserNavigate: (url: string) => Promise<void>;
	browserClick: (selector: string) => Promise<void>;
	browserType: (text: string) => Promise<void>;
	screenClick: (x: number, y: number) => Promise<void>;
	screenType: (text: string) => Promise<void>;
	screenKey: (key: string) => Promise<void>;
}

export interface ComputerUseOptions {
	maxSteps?: number;
	screenshotDir?: string;
	useScreenFallback?: boolean;
	expertFn?: (question: string, screenshotPath?: string) => Promise<string>;
}

export interface ComputerUseResult {
	status: "done" | "stuck" | "max_steps";
	steps: number;
	screenshotPath?: string;
	reason?: string;
}

export async function runComputerUseLoop(
	task: string,
	opts: ComputerUseOptions,
	handlers: ComputerUseHandlers,
): Promise<ComputerUseResult> {
	const maxSteps = opts.maxSteps ?? 30;
	const screenshotDir = opts.screenshotDir ?? join(homedir(), ".pilav", "screenshots");
	const useScreenFallback = opts.useScreenFallback ?? false;
	mkdirSync(screenshotDir, { recursive: true });

	let lastScreenshotPath: string | undefined;
	let expertGuidance: string | undefined;

	for (let step = 0; step < maxSteps; step++) {
		const screenshotPath = join(screenshotDir, `cu-${Date.now()}-${step}.png`);
		lastScreenshotPath = await handlers.screenshot(screenshotPath);

		const effectiveTask = expertGuidance ? `${task}\n\n[Expert guidance: ${expertGuidance}]` : task;
		const visionResult = await handlers.analyzeScreenshot(lastScreenshotPath, effectiveTask);

		switch (visionResult.action) {
			case "done":
				return { status: "done", steps: step + 1, screenshotPath: lastScreenshotPath };

			case "stuck": {
				if (opts.expertFn) {
					try {
						expertGuidance = await opts.expertFn(
							`Computer use stuck on task: "${task}". Vision says: ${visionResult.reason}. Last screenshot: ${lastScreenshotPath}`,
							lastScreenshotPath,
						);
						// After getting guidance, retry immediately (don't count as stuck yet)
						if (step < maxSteps - 1) continue;
					} catch { /* ignore */ }
				}
				return { status: "stuck", steps: step + 1, screenshotPath: lastScreenshotPath, reason: visionResult.reason };
			}

			case "navigate":
				await handlers.browserNavigate(visionResult.url);
				break;

			case "click":
				if (useScreenFallback) {
					await handlers.screenClick(visionResult.x, visionResult.y);
				} else {
					// Try browser click with coordinates as selector fallback
					await handlers.screenClick(visionResult.x, visionResult.y);
				}
				break;

			case "type":
				if (useScreenFallback) {
					await handlers.screenType(visionResult.text);
				} else {
					await handlers.browserType(visionResult.text);
				}
				break;

			case "key":
				await handlers.screenKey(visionResult.key);
				break;
		}
	}

	return { status: "max_steps", steps: maxSteps, screenshotPath: lastScreenshotPath };
}
