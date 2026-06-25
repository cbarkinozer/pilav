import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TtsStatus {
	sessionId: string;
	step: number;
	totalSteps: number;
	currentTask: string;
	elapsedMs: number;
	status: "working" | "done" | "cancelled" | "error";
	result?: string;
}

const STATUS_FILENAME = "tts-status.json";

function defaultDir(): string {
	const dir = join(homedir(), ".pilav");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

export function pushStatus(status: TtsStatus, dir?: string): void {
	const d = dir ?? defaultDir();
	if (!existsSync(d)) mkdirSync(d, { recursive: true });
	writeFileSync(join(d, STATUS_FILENAME), JSON.stringify(status, null, 2), "utf-8");
}

export function readStatus(dir?: string): TtsStatus | null {
	const d = dir ?? defaultDir();
	const path = join(d, STATUS_FILENAME);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as TtsStatus;
	} catch {
		return null;
	}
}
