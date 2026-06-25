import type { Fact } from "./db.ts";
import { getFacts, initDb, insertFact } from "./db.ts";

function lmStudioUrl(): string {
	return (process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1") + "/chat/completions";
}

const FEW_SHOT = `Extract factual statements about the user from this conversation.
Return a JSON array of objects: [{"subject":"...","predicate":"...","object":"...","confidence":0.0-1.0}]
Only extract clear facts. Return [] if no facts found. Return only the JSON array.

Examples:
User: "I prefer TypeScript over Python"
→ [{"subject":"user","predicate":"prefers","object":"TypeScript over Python","confidence":0.9}]

User: "My project runs on Mac Mini M4"
→ [{"subject":"project","predicate":"runs-on","object":"Mac Mini M4","confidence":0.85}]

User: "I use SQLite for all my projects"
→ [{"subject":"user","predicate":"uses","object":"SQLite for persistence","confidence":0.8}]`;

export async function extractFacts(userPrompt: string, assistantReply: string): Promise<Fact[]> {
	const prompt = `${FEW_SHOT}

Conversation:
User: ${userPrompt.slice(0, 1000)}
Assistant: ${assistantReply.slice(0, 1000)}

Return only the JSON array:`;

	try {
		const response = await fetch(lmStudioUrl(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gemma-4-4b",
				messages: [{ role: "user", content: prompt }],
				temperature: 0.1,
				max_tokens: 512,
			}),
			signal: AbortSignal.timeout(10000),
		});

		if (!response.ok) return [];

		const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
		const content = data.choices?.[0]?.message?.content ?? "";

		// Extract JSON array from content (may have surrounding text)
		const match = content.match(/\[[\s\S]*\]/);
		if (!match) return [];

		const parsed: unknown = JSON.parse(match[0]);
		if (!Array.isArray(parsed)) return [];

		return parsed.filter(isValidFact);
	} catch {
		return [];
	}
}

function isValidFact(f: unknown): f is Fact {
	if (typeof f !== "object" || f === null) return false;
	const obj = f as Record<string, unknown>;
	return (
		typeof obj.subject === "string" &&
		typeof obj.predicate === "string" &&
		typeof obj.object === "string" &&
		typeof obj.confidence === "number"
	);
}

export async function extractAndSaveFacts(userPrompt: string, assistantReply: string, dbPath?: string): Promise<void> {
	try {
		const facts = await extractFacts(userPrompt, assistantReply);
		if (facts.length === 0) return;
		initDb(dbPath);
		// Avoid duplicates: skip facts already known (same subject+predicate+object)
		const existing = getFacts(200, dbPath);
		const existingKeys = new Set(existing.map((f) => `${f.subject}|${f.predicate}|${f.object}`));
		for (const fact of facts) {
			const key = `${fact.subject}|${fact.predicate}|${fact.object}`;
			if (!existingKeys.has(key)) {
				insertFact(fact, dbPath);
			}
		}
	} catch {
		// Never throw — fact extraction is best-effort
	}
}
