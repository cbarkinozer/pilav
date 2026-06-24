import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("lmstudio", {
		baseUrl: "http://localhost:1234/v1",
		apiKey: "lm-studio",
		api: "openai-completions",
		models: [
			{
				id: "gemma-4-4b",
				name: "Gemma 4 4B (LM Studio)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
			{
				id: "qwen-3.5-8b",
				name: "Qwen 3.5 8B (LM Studio)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	});
}
