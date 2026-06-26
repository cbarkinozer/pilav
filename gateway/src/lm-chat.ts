/**
 * Direct LM Studio chat client for Qwen.
 * Handles thinking mode toggle via /think and /no_think prefixes.
 * Used for casual chat — TTS loop handles long-running tasks.
 */

export type ThinkingMode = "think" | "no_think";

const TASK_KEYWORDS = [
	"build", "create", "implement", "write a", "write me", "make a", "make me",
	"develop", "refactor", "fix", "debug", "add feature", "add a", "set up",
	"analyze", "analyse", "design", "architecture", "generate", "scaffold",
	"deploy", "install", "configure", "migrate", "test", "document",
];

export function detectThinkingMode(message: string): ThinkingMode {
	const lower = message.toLowerCase();
	// Task keywords always trigger thinking regardless of length
	if (TASK_KEYWORDS.some((kw) => lower.includes(kw))) return "think";
	// Short casual messages without task intent → no thinking
	if (message.trim().length < 60) return "no_think";
	// Long messages without task keywords → still probably chat, no think
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

export class LMStudioChat {
	private baseUrl: string;
	private model: string;
	private fetchFn: typeof globalThis.fetch;
	private history: LMChatMessage[] = [];

	constructor(opts: LMChatOptions = {}) {
		this.baseUrl = opts.lmStudioUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
		this.model = opts.model ?? process.env.LM_STUDIO_MODEL ?? "qwen3.5-9b";
		this.fetchFn = opts.fetch ?? globalThis.fetch;
	}

	clearHistory(): void {
		this.history = [];
	}

	async chat(userMessage: string, mode?: ThinkingMode): Promise<string> {
		const effectiveMode = mode ?? detectThinkingMode(userMessage);
		const wrappedMessage = wrapWithThinkingMode(userMessage, effectiveMode);

		const messages: LMChatMessage[] = [
			{ role: "system", content: "You are Pilav, a helpful AI assistant running on a Mac Mini. Be concise and direct. You can handle both quick questions and long coding projects." },
			...this.history,
			{ role: "user", content: wrappedMessage },
		];

		const body = {
			model: this.model,
			messages,
			temperature: 0.6,
			max_tokens: effectiveMode === "think" ? 8192 : 1024,
		};

		const resp = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!resp.ok) throw new Error(`LM Studio error: ${resp.status}`);

		const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
		const reply = data.choices?.[0]?.message?.content ?? "(no response)";

		// Strip <think>...</think> tags from the reply before storing in history
		const cleanReply = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

		this.history.push({ role: "user", content: userMessage });
		this.history.push({ role: "assistant", content: cleanReply });

		// Keep history bounded (last 20 turns)
		if (this.history.length > 40) this.history = this.history.slice(-40);

		return cleanReply;
	}
}
