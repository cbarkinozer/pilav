import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface TtsStatus {
	sessionId?: string;
	step?: number;
	totalSteps?: number;
	status?: string;
	currentTask?: string;
	elapsedMs?: number;
	result?: string;
}

export interface StatusPollerOptions {
	pilav_dir?: string;
	getChatIds: () => number[];
	sendMessage: (chatId: number, text: string) => Promise<void>;
	interval_ms?: number;
}

function formatStatus(s: TtsStatus): string {
	const step = s.step !== undefined && s.totalSteps !== undefined ? ` (${s.step}/${s.totalSteps})` : "";
	const task = s.currentTask ? ` — ${s.currentTask}` : "";
	const elapsed = s.elapsedMs !== undefined ? ` [${Math.round(s.elapsedMs / 1000)}s]` : "";
	return `[TTS ${s.status ?? "unknown"}]${step}${task}${elapsed}`;
}

export class StatusPoller {
	private dir: string;
	private getChatIds: () => number[];
	private sendMessage: (chatId: number, text: string) => Promise<void>;
	private intervalMs: number;
	private timer?: ReturnType<typeof setInterval>;
	private lastKey: string | null = null;
	private initialized = false;

	constructor(opts: StatusPollerOptions) {
		this.dir = opts.pilav_dir ?? join(homedir(), ".pilav");
		this.getChatIds = opts.getChatIds;
		this.sendMessage = opts.sendMessage;
		this.intervalMs = opts.interval_ms ?? 60_000;
	}

	start(): void {
		this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}

	private async poll(): Promise<void> {
		const statusPath = join(this.dir, "tts-status.json");
		if (!existsSync(statusPath)) return;

		let status: TtsStatus;
		try {
			status = JSON.parse(readFileSync(statusPath, "utf-8")) as TtsStatus;
		} catch { return; }

		// Key = session + step + status; only notify on change (not on first read)
		const key = `${status.sessionId}:${status.step}:${status.status}`;
		if (!this.initialized) {
			this.lastKey = key;
			this.initialized = true;
			return;
		}
		if (key === this.lastKey) return;
		this.lastKey = key;

		const text = formatStatus(status);
		const chatIds = this.getChatIds();
		await Promise.all(chatIds.map((id) => this.sendMessage(id, text).catch(() => {})));
	}
}
