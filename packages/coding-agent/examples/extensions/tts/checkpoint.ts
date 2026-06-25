import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CheckpointData {
	sessionId: string;
	checkpointId: string;
	timestamp: string;
	elapsedMs: number;
	step: number;
	totalSteps: number;
	currentTask: string;
	context: {
		messages: unknown[];
		toolResults: unknown[];
		scratchpad: string;
	};
	status: "working" | "done" | "cancelled" | "error";
}

function defaultDir(): string {
	const dir = join(homedir(), ".pilav", "checkpoints");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function resolve(dir?: string): string {
	const d = dir ?? defaultDir();
	if (!existsSync(d)) mkdirSync(d, { recursive: true });
	return d;
}

export function saveCheckpoint(data: CheckpointData, dir?: string): string {
	const d = resolve(dir);
	const filename = `${data.sessionId}-${data.checkpointId}.json`;
	const path = join(d, filename);
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
	return path;
}

export function loadCheckpoint(sessionId: string, dir?: string): CheckpointData | null {
	const d = resolve(dir);
	const files = readdirSync(d).filter((f) => f.startsWith(`${sessionId}-`) && f.endsWith(".json"));
	if (files.length === 0) return null;

	const checkpoints = files
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(d, f), "utf-8")) as CheckpointData;
			} catch {
				return null;
			}
		})
		.filter((c): c is CheckpointData => c !== null);

	if (checkpoints.length === 0) return null;
	return checkpoints.sort((a, b) => b.step - a.step)[0];
}

export function listCheckpoints(dir?: string): CheckpointData[] {
	const d = resolve(dir);
	const files = readdirSync(d).filter((f) => f.endsWith(".json"));
	return files
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(d, f), "utf-8")) as CheckpointData;
			} catch {
				return null;
			}
		})
		.filter((c): c is CheckpointData => c !== null)
		.sort((a, b) => b.step - a.step);
}

export function deleteCheckpoints(sessionId: string, dir?: string): void {
	const d = resolve(dir);
	const files = readdirSync(d).filter((f) => f.startsWith(`${sessionId}-`) && f.endsWith(".json"));
	for (const f of files) {
		rmSync(join(d, f), { force: true });
	}
}
