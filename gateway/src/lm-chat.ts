/**
 * Direct LM Studio chat client for Qwen.
 * Supports streaming with live <thinking> blocks in Telegram.
 */

export type ThinkingMode = "think" | "no_think";

const TASK_KEYWORDS = [
	"build", "create", "implement", "write a", "write me", "make a", "make me",
	"develop", "refactor", "fix", "debug", "add feature", "add a", "set up",
	"analyze", "analyse", "design", "architecture", "generate", "scaffold",
	"deploy", "install", "configure", "migrate", "test", "document",
];

const MAX_TOKENS = 16384;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export function detectThinkingMode(message: string): ThinkingMode {
	const lower = message.toLowerCase();
	if (TASK_KEYWORDS.some((kw) => lower.includes(kw))) return "think";
	if (message.trim().length < 60) return "no_think";
	return "no_think";
}

export function isTaskRequest(message: string): boolean {
	const lower = message.toLowerCase();
	return TASK_KEYWORDS.some((kw) => lower.includes(kw));
}

export function wrapWithThinkingMode(text: string, mode: ThinkingMode): string {
	return `/${mode}\n${text}`;
}

export interface LMChatOptions {
	lmStudioUrl?: string;
	model?: string;
	fetch?: typeof globalThis.fetch;
}

export interface LMChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

/** Format accumulated thinking + answer for Telegram display during streaming. */
export function formatStreamDisplay(thinkContent: string, answerContent: string): string {
	const parts: string[] = [];
	if (thinkContent.trim()) {
		parts.push(`<thinking>\n${thinkContent.trim()}\n</thinking>`);
	}
	if (answerContent.trim()) {
		parts.push(answerContent.trim());
	}
	return parts.join("\n\n") || "⏳ Thinking…";
}

export class LMStudioChat {
	private baseUrl: string;
	private model: string;
	private fetchFn: typeof globalThis.fetch;
	private history: LMChatMessage[] = [];

	constructor(opts: LMChatOptions = {}) {
		this.baseUrl = opts.lmStudioUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
		this.model = opts.model ?? process.env.LM_STUDIO_MODEL ?? "qwen/qwen3.5-9b";
		this.fetchFn = opts.fetch ?? globalThis.fetch;
	}

	clearHistory(): void {
		this.history = [];
	}

	private buildMessages(userMessage: string): LMChatMessage[] {
		return [
			{ role: "system", content: "You are Pilav, a helpful AI assistant running on a Mac Mini. Be concise and direct." },
			...this.history,
			{ role: "user", content: userMessage },
		];
	}

	private updateHistory(userMessage: string, cleanReply: string): void {
		this.history.push({ role: "user", content: userMessage });
		this.history.push({ role: "assistant", content: cleanReply });
		if (this.history.length > 40) this.history = this.history.slice(-40);
	}

	/** Non-streaming fallback. Returns clean reply (thinking stripped). */
	async chat(userMessage: string): Promise<string> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

		try {
			const resp = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, messages: this.buildMessages(userMessage), temperature: 0.6, max_tokens: MAX_TOKENS }),
				signal: controller.signal,
			});

			if (!resp.ok) {
				const detail = await resp.text().catch(() => "");
				throw new Error(`LM Studio error ${resp.status}: ${detail.slice(0, 200)}`);
			}

			const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
			const reply = data.choices?.[0]?.message?.content ?? "";
			const stripped = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
			const cleanReply = stripped || reply.trim() || "(no response)";

			this.updateHistory(userMessage, cleanReply);
			return cleanReply;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Streaming chat. Calls onChunk with formatted display text as tokens arrive.
	 * Shows thinking in <thinking> blocks, answer below.
	 * Returns the final clean answer (no thinking) for history.
	 */
	async chatStreaming(
		userMessage: string,
		onChunk: (displayText: string) => Promise<void> | void,
	): Promise<string> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

		try {
			const resp = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					messages: this.buildMessages(userMessage),
					temperature: 0.6,
					max_tokens: MAX_TOKENS,
					stream: true,
				}),
				signal: controller.signal,
			});

			if (!resp.ok) {
				const detail = await resp.text().catch(() => "");
				throw new Error(`LM Studio error ${resp.status}: ${detail.slice(0, 200)}`);
			}

			const reader = resp.body!.getReader();
			const decoder = new TextDecoder();

			let raw = "";        // full raw buffer including <think> tags
			let thinkContent = "";
			let answerContent = "";
			let inThink = false;
			let residual = "";  // partial SSE line between chunks

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const text = residual + decoder.decode(value, { stream: true });
				const lines = text.split("\n");
				residual = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6).trim();
					if (payload === "[DONE]") break;
					try {
						const parsed = JSON.parse(payload) as { choices: Array<{ delta: { content?: string }; finish_reason?: string }> };
						const delta = parsed.choices?.[0]?.delta?.content ?? "";
						if (!delta) continue;

						raw += delta;

						// Parse <think>...</think> boundaries from the running buffer
						// Re-derive thinkContent and answerContent from raw each time
						// (simpler than tracking state mid-token)
						const thinkMatch = raw.match(/^<think>([\s\S]*?)<\/think>([\s\S]*)$/);
						const openThink = raw.match(/^<think>([\s\S]*)$/);

						if (thinkMatch) {
							thinkContent = thinkMatch[1];
							answerContent = thinkMatch[2];
							inThink = false;
						} else if (openThink) {
							thinkContent = openThink[1];
							answerContent = "";
							inThink = true;
						} else {
							thinkContent = "";
							answerContent = raw;
							inThink = false;
						}

						await onChunk(formatStreamDisplay(thinkContent, answerContent));
					} catch { /* skip malformed SSE line */ }
				}
			}

			// Final clean reply for history (no thinking)
			const cleanReply = answerContent.trim() || raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "(no response)";
			this.updateHistory(userMessage, cleanReply);
			return cleanReply;
		} finally {
			clearTimeout(timer);
		}
	}
}
