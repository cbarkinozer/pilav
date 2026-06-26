import { readFileSync } from "node:fs";

export type VisionAction =
	| { action: "click"; x: number; y: number; reason: string }
	| { action: "type"; text: string; reason: string }
	| { action: "navigate"; url: string; reason: string }
	| { action: "key"; key: string; reason: string }
	| { action: "done"; reason: string }
	| { action: "stuck"; reason: string };

export interface VisionOptions {
	lmStudioUrl?: string;
	model?: string;
	fetch?: typeof globalThis.fetch;
}

const SYSTEM_PROMPT = `You are a computer-use assistant. Given a screenshot and a task, output EXACTLY one action in this format:

ACTION: click|type|navigate|key|done|stuck
X: <number>          (only for click)
Y: <number>          (only for click)
TEXT: <text>         (only for type)
URL: <url>           (only for navigate)
KEY: <key name>      (only for key — Return, Tab, Escape, etc.)
REASON: <one sentence>

Use "done" when the task is complete. Use "stuck" when you cannot determine the next step.`;

function parseAction(text: string): VisionAction {
	const lines = text.trim().split("\n").map((l) => l.trim());
	const get = (key: string) => lines.find((l) => l.startsWith(key + ":"))?.slice(key.length + 1).trim() ?? "";

	const action = get("ACTION").toLowerCase();
	const reason = get("REASON") || get("reason") || "No reason given.";

	switch (action) {
		case "click": {
			const x = parseInt(get("X"), 10);
			const y = parseInt(get("Y"), 10);
			if (!isNaN(x) && !isNaN(y)) return { action: "click", x, y, reason };
			break;
		}
		case "type": {
			const t = get("TEXT");
			if (t) return { action: "type", text: t, reason };
			break;
		}
		case "navigate": {
			const url = get("URL");
			if (url) return { action: "navigate", url, reason };
			break;
		}
		case "key": {
			const key = get("KEY");
			if (key) return { action: "key", key, reason };
			break;
		}
		case "done":
			return { action: "done", reason };
		case "stuck":
			return { action: "stuck", reason };
	}

	return { action: "stuck", reason: `Unrecognized model output: ${text.slice(0, 100)}` };
}

export async function analyzeScreenshot(
	screenshotPath: string,
	task: string,
	opts: VisionOptions = {},
): Promise<VisionAction> {
	const lmUrl = opts.lmStudioUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
	const model = opts.model ?? process.env.LM_STUDIO_VISION_MODEL ?? process.env.LM_STUDIO_EXTRACTION_MODEL ?? "gemma-4-4b";
	const fetchFn = opts.fetch ?? globalThis.fetch;

	const imageData = readFileSync(screenshotPath);
	const base64 = imageData.toString("base64");
	const mimeType = screenshotPath.endsWith(".png") ? "image/png" : "image/jpeg";

	const body = {
		model,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{
				role: "user",
				content: [
					{ type: "text", text: `Task: ${task}` },
					{ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
				],
			},
		],
		max_tokens: 200,
		temperature: 0.1,
	};

	try {
		const resp = await fetchFn(`${lmUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!resp.ok) return { action: "stuck", reason: `LM Studio error: ${resp.status}` };

		const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
		const content = data.choices?.[0]?.message?.content ?? "";
		return parseAction(content);
	} catch (err) {
		return { action: "stuck", reason: `Vision call failed: ${(err as Error).message}` };
	}
}
