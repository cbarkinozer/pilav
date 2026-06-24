import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getProfile, getRecentExchanges, initDb, insertExchange, setProfile } from "./db.ts";

function extractText(content: string | { type: string; text?: string }[] | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

const memoryDbPath = process.env.DB_PATH || process.env.PI_MEMORY_PATH || undefined;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (memoryDbPath && !existsSync(memoryDbPath)) return;

		initDb(memoryDbPath);
		const recent = getRecentExchanges(5, memoryDbPath);
		if (recent.length === 0) return;

		const lines = recent.map((r) => `- Q: ${r.user_prompt} A: ${r.assistant_reply}`);

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Memory Context\n${lines.join("\n")}`,
		};
	});

	pi.on("agent_end", (event) => {
		initDb(memoryDbPath);

		const userMsg = event.messages.find((m) => m.role === "user");
		const assistantMsg = event.messages.find((m) => m.role === "assistant");
		if (!userMsg || !assistantMsg) return;

		const userContent = extractText(userMsg.content as string | { type: string; text?: string }[] | undefined);
		const assistantContent = extractText(
			assistantMsg.content as string | { type: string; text?: string }[] | undefined,
		);
		if (!userContent && !assistantContent) return;

		const sessionId = `session-${Date.now()}`;
		insertExchange(sessionId, userContent, assistantContent, memoryDbPath);
	});

	pi.registerCommand("memory-set", {
		description: "Store a profile key-value pair in memory. Usage: /memory-set <key> <value>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const dbPath = process.env.DB_PATH || process.env.PI_MEMORY_PATH;
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
			const dbPath = process.env.DB_PATH || process.env.PI_MEMORY_PATH;
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
}
