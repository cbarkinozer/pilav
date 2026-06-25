export interface ToolResult {
	content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	isError?: boolean;
}

interface CacheEntry {
	result: ToolResult;
	expiresAt: number;
}

export const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_MAX_SIZE = 100;

export class ToolCache {
	private entries = new Map<string, CacheEntry>();
	private readonly ttlMs: number;
	private readonly maxSize: number;

	constructor(ttlMs = DEFAULT_TTL_MS, maxSize = DEFAULT_MAX_SIZE) {
		this.ttlMs = ttlMs;
		this.maxSize = maxSize;
	}

	static key(serverName: string, toolName: string, args: Record<string, unknown>): string {
		return `${serverName}:${toolName}:${JSON.stringify(args)}`;
	}

	get(key: string): ToolResult | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.entries.delete(key);
			return undefined;
		}
		// Move to end (LRU refresh) by re-inserting
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.result;
	}

	set(key: string, result: ToolResult): void {
		if (this.entries.has(key)) {
			this.entries.delete(key);
		} else if (this.entries.size >= this.maxSize) {
			// Evict oldest (first in Map insertion order)
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		this.entries.set(key, { result, expiresAt: Date.now() + this.ttlMs });
	}

	invalidate(pattern?: string): void {
		if (!pattern) {
			this.entries.clear();
			return;
		}
		for (const key of this.entries.keys()) {
			if (key.startsWith(pattern)) this.entries.delete(key);
		}
	}

	get size(): number {
		return this.entries.size;
	}
}
