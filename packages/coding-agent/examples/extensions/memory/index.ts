import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getFacts, getProfile, getRecentExchanges, initDb, insertExchange, searchExchangesByRelevance, setProfile } from "./db.ts";
import { extractAndSaveFacts } from "./extractor.ts";
import { consolidateProfile, shouldConsolidate } from "./profiler.ts";

const CONSOLIDATION_THRESHOLD = 5;
const MAX_INJECTION_CHARS = 8000; // ~2000 tokens

function extractText(content: string | { type: string; text?: string }[] | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars - 3) + "...";
}

export default function (pi: ExtensionAPI) {
	// Read env at factory-call time so each test invocation gets the right path
	// and the closed-over value is still available when handlers fire.
	const memoryDbPath = process.env.DB_PATH || process.env.PI_MEMORY_PATH || undefined;

	pi.on("before_agent_start", (event) => {
		if (memoryDbPath && !existsSync(memoryDbPath)) return;

		initDb(memoryDbPath);

		const sections: string[] = [];

		// 1. About You — user profile synthesis
		const synthesis = getProfile("user_profile_synthesis", memoryDbPath);
		if (synthesis) {
			sections.push(`### About You\n${synthesis}`);
		}

		// 2. Known Facts — extracted facts about the user
		const facts = getFacts(10, memoryDbPath);
		if (facts.length > 0) {
			const factLines = facts.map((f) => `- ${f.subject} ${f.predicate} ${f.object} (confidence: ${f.confidence.toFixed(2)})`);
			sections.push(`### Known Facts\n${factLines.join("\n")}`);
		}

		// 3. Relevant Past Context — FTS5 BM25-ranked search on current prompt
		const currentPrompt = (event as { prompt?: string }).prompt ?? "";
		if (currentPrompt) {
			try {
				// Build OR query from significant words so partial matches are found
				const keywords = currentPrompt
					.split(/\W+/)
					.filter((w) => w.length > 4)
					.slice(0, 6);
				const ftsQuery = keywords.length > 0 ? keywords.join(" OR ") : currentPrompt;
				const relevant = searchExchangesByRelevance(ftsQuery, 3, memoryDbPath);
				if (relevant.length > 0) {
					const relLines = relevant.map((r) => `- Q: ${r.user_prompt.slice(0, 200)} A: ${r.assistant_reply.slice(0, 200)}`);
					sections.push(`### Relevant Past Context\n${relLines.join("\n")}`);
				}
			} catch {
				// FTS5 query may throw on special characters — skip gracefully
			}
		}

		// 4. Recent History — last 3 exchanges
		const recent = getRecentExchanges(3, memoryDbPath);
		if (recent.length > 0) {
			const recentLines = recent.map((r) => `- Q: ${r.user_prompt.slice(0, 200)} A: ${r.assistant_reply.slice(0, 200)}`);
			sections.push(`### Recent History\n${recentLines.join("\n")}`);
		}

		if (sections.length === 0) return;

		const block = truncate(`## Memory Context\n\n${sections.join("\n\n")}`, MAX_INJECTION_CHARS);

		return {
			systemPrompt: `${(event as { systemPrompt?: string }).systemPrompt ?? ""}\n\n${block}`,
		};
	});

	pi.on("agent_end", async (event) => {
		initDb(memoryDbPath);

		const userMsg = (event as { messages?: Array<{ role: string; content: unknown }> }).messages?.find(
			(m) => m.role === "user",
		);
		const assistantMsg = (event as { messages?: Array<{ role: string; content: unknown }> }).messages?.find(
			(m) => m.role === "assistant",
		);
		if (!userMsg || !assistantMsg) return;

		const userContent = extractText(userMsg.content as string | { type: string; text?: string }[] | undefined);
		const assistantContent = extractText(
			assistantMsg.content as string | { type: string; text?: string }[] | undefined,
		);
		if (!userContent && !assistantContent) return;

		const sessionId = `session-${Date.now()}`;
		insertExchange(sessionId, userContent, assistantContent, memoryDbPath);

		// Background: extract facts (best-effort, no await blocking)
		void extractAndSaveFacts(userContent, assistantContent, memoryDbPath);

		// Background: consolidate profile every N sessions
		if (shouldConsolidate(CONSOLIDATION_THRESHOLD, memoryDbPath)) {
			void consolidateProfile(memoryDbPath);
		}
	});

	// ─── Existing commands ────────────────────────────────────────────────────

	// Resolve the effective DB path for command handlers — prefer the closed-over
	// factory-time value so test invocations work even after the env var is removed.
	const resolveCommandPath = (): string | undefined =>
		memoryDbPath || process.env.DB_PATH || process.env.PI_MEMORY_PATH || undefined;

	pi.registerCommand("memory-set", {
		description: "Store a profile key-value pair in memory. Usage: /memory-set <key> <value>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const dbPath = resolveCommandPath();
			if (!dbPath) {
				ctx.ui.notify("No memory path configured. Set DB_PATH or PI_MEMORY_PATH.", "error");
				return;
			}
			initDb(dbPath);
			const sep = args.indexOf(" ");
			if (sep === -1) {
				ctx.ui.notify("Usage: /memory-set <key> <value>", "error");
				return;
			}
			const key = args.slice(0, sep).trim();
			const value = args.slice(sep + 1).trim();
			if (!key) {
				ctx.ui.notify("Key cannot be empty.", "error");
				return;
			}
			setProfile(key, value, dbPath);
			ctx.ui.notify(`Stored profile ${key} = ${value}`, "info");
		},
	});

	pi.registerCommand("memory-get", {
		description: "Retrieve a profile value by key. Usage: /memory-get <key>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const dbPath = resolveCommandPath();
			if (!dbPath) {
				ctx.ui.notify("No memory path configured. Set DB_PATH or PI_MEMORY_PATH.", "error");
				return;
			}
			initDb(dbPath);
			const key = args.trim();
			if (!key) {
				ctx.ui.notify("Usage: /memory-get <key>", "error");
				return;
			}
			const value = getProfile(key, dbPath);
			if (value === undefined) {
				ctx.ui.notify(`Profile key "${key}" not found`, "info");
			} else {
				ctx.ui.notify(`${key}: ${value}`, "info");
			}
		},
	});

	// ─── New Phase 3 commands ─────────────────────────────────────────────────

	pi.registerCommand("memory-facts", {
		description: "List all known facts extracted from your conversations.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const dbPath = resolveCommandPath();
			initDb(dbPath);
			const facts = getFacts(20, dbPath);
			if (facts.length === 0) {
				ctx.ui.notify("No facts extracted yet. Facts are learned automatically from your conversations.", "info");
				return;
			}
			for (const f of facts) {
				ctx.ui.notify(`${f.subject} ${f.predicate} ${f.object} (${f.confidence.toFixed(2)})`, "info");
			}
		},
	});

	pi.registerCommand("memory-profile", {
		description: "Show your current user profile synthesis.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const dbPath = resolveCommandPath();
			initDb(dbPath);
			const synthesis = getProfile("user_profile_synthesis", dbPath);
			if (!synthesis) {
				ctx.ui.notify(
					"No profile synthesized yet. Profile is built automatically after every 5 sessions.",
					"info",
				);
				return;
			}
			ctx.ui.notify(synthesis, "info");
		},
	});

	pi.registerCommand("memory-search", {
		description: "Search your conversation history. Usage: /memory-search <query>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const dbPath = resolveCommandPath();
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /memory-search <query>", "error");
				return;
			}
			initDb(dbPath);
			try {
				const results = searchExchangesByRelevance(query, 5, dbPath);
				if (results.length === 0) {
					ctx.ui.notify(`No results found for "${query}"`, "info");
					return;
				}
				for (const r of results) {
					ctx.ui.notify(`Q: ${r.user_prompt.slice(0, 120)} → A: ${r.assistant_reply.slice(0, 120)}`, "info");
				}
			} catch {
				ctx.ui.notify(`Search failed for "${query}" — try simpler terms`, "error");
			}
		},
	});

	pi.registerCommand("memory-consolidate", {
		description: "Manually trigger user profile consolidation now.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const dbPath = resolveCommandPath();
			ctx.ui.notify("Running profile consolidation... (requires LM Studio)", "info");
			await consolidateProfile(dbPath);
			const synthesis = getProfile("user_profile_synthesis", dbPath);
			if (synthesis) {
				ctx.ui.notify(`Profile updated: ${synthesis.slice(0, 200)}`, "info");
			} else {
				ctx.ui.notify("Consolidation complete (LM Studio may be offline — synthesis not updated)", "info");
			}
		},
	});
}
