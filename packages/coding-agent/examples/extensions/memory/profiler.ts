import { countExchanges, getFacts, getRecentExchanges, initDb, setProfile } from "./db.ts";

function lmStudioUrl(): string {
	return (process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1") + "/chat/completions";
}

export function shouldConsolidate(threshold: number, dbPath?: string): boolean {
	initDb(dbPath);
	const count = countExchanges(dbPath);
	return count > 0 && count % threshold === 0;
}

export async function consolidateProfile(dbPath?: string): Promise<void> {
	try {
		initDb(dbPath);

		const exchanges = getRecentExchanges(50, dbPath);
		const facts = getFacts(30, dbPath);

		const exchangeSummary = exchanges
			.map((e) => `User: ${e.user_prompt.slice(0, 200)}\nAssistant: ${e.assistant_reply.slice(0, 200)}`)
			.join("\n\n");

		const factsSummary =
			facts.length > 0
				? facts.map((f) => `${f.subject} ${f.predicate} ${f.object} (confidence: ${f.confidence})`).join("\n")
				: "No extracted facts yet.";

		const prompt = `Analyze these conversations and facts about a user. Write a dialectic user profile.

Known facts:
${factsSummary}

Recent conversations (newest first):
${exchangeSummary}

Return a JSON object with exactly these keys:
- synthesis: 3-5 sentence consolidated profile covering coding style, preferred tools, current projects, communication preferences
- thesis: positive patterns and confirmed preferences observed
- antithesis: contradictions, uncertainties, or things that don't fit the pattern

Return only the JSON object, no other text.`;

		const response = await fetch(lmStudioUrl(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gemma-4-4b",
				messages: [{ role: "user", content: prompt }],
				temperature: 0.3,
				max_tokens: 1024,
			}),
			signal: AbortSignal.timeout(30000),
		});

		if (!response.ok) return;

		const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
		const content = data.choices?.[0]?.message?.content ?? "";

		// Extract JSON object from content
		const match = content.match(/\{[\s\S]*\}/);
		if (!match) return;

		const parsed = JSON.parse(match[0]) as Record<string, unknown>;
		if (typeof parsed.synthesis === "string") setProfile("user_profile_synthesis", parsed.synthesis, dbPath);
		if (typeof parsed.thesis === "string") setProfile("user_profile_thesis", parsed.thesis, dbPath);
		if (typeof parsed.antithesis === "string") setProfile("user_profile_antithesis", parsed.antithesis, dbPath);
	} catch {
		// Silent fail — profile consolidation is background work
	}
}
