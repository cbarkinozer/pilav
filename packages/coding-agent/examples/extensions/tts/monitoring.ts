import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MonitoringEntry {
	timestamp: string;
	sessionId: string;
	step: number;
	model: string;
	task: string;
	responseLength: number;
	latencyMs: number;
	retries: number;
	retryReason?: string;
	escalated: boolean;
	status: "done" | "cancelled" | "error" | "working";
}

const DEFAULT_LOG_DIR = join(homedir(), ".pilav", "logs");

export function appendMonitoringEntry(entry: MonitoringEntry, logDir?: string): void {
	const dir = logDir ?? DEFAULT_LOG_DIR;
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "sessions.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
	} catch { /* best-effort — never crash the main loop */ }
}
