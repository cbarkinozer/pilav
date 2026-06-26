import { describe, expect, it, vi } from "vitest";
import { detectThinkingMode, isTaskRequest, wrapWithThinkingMode, LMStudioChat } from "../src/lm-chat.ts";

describe("detectThinkingMode", () => {
	it("returns no_think for short casual messages", () => {
		expect(detectThinkingMode("hi")).toBe("no_think");
		expect(detectThinkingMode("what time is it?")).toBe("no_think");
		expect(detectThinkingMode("thanks")).toBe("no_think");
	});

	it("returns think for task keywords", () => {
		expect(detectThinkingMode("build me a REST API in TypeScript")).toBe("think");
		expect(detectThinkingMode("implement authentication with JWT")).toBe("think");
		expect(detectThinkingMode("refactor the database layer to use transactions")).toBe("think");
	});

	it("returns no_think for long non-task messages", () => {
		expect(detectThinkingMode("I was wondering if you could tell me a bit about how transformers work in general terms")).toBe("no_think");
	});
});

describe("isTaskRequest", () => {
	it("detects task requests", () => {
		expect(isTaskRequest("build a todo app with React")).toBe(true);
		expect(isTaskRequest("create a Python script that scrapes data")).toBe(true);
	});

	it("does not flag casual messages as tasks", () => {
		expect(isTaskRequest("hi")).toBe(false);
		expect(isTaskRequest("how are you")).toBe(false);
	});
});

describe("wrapWithThinkingMode", () => {
	it("prepends /think to the message", () => {
		const result = wrapWithThinkingMode("do something", "think");
		expect(result).toBe("/think\ndo something");
	});

	it("prepends /no_think to the message", () => {
		const result = wrapWithThinkingMode("hi", "no_think");
		expect(result).toBe("/no_think\nhi");
	});
});

describe("LMStudioChat", () => {
	it("sends max_tokens of at least 4096 in the request", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "Hello!" } }] }),
		});

		const chat = new LMStudioChat({ fetch: fetchMock });
		await chat.chat("hi");

		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { max_tokens: number };
		expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
	});

	it("sends the user message as plain text without any prefixes", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "Sure!" } }] }),
		});

		const chat = new LMStudioChat({ fetch: fetchMock });
		await chat.chat("build me a TypeScript REST API");

		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { messages: Array<{ role: string; content: string }> };
		const userMsg = body.messages.find((m) => m.role === "user");
		expect(userMsg?.content).toBe("build me a TypeScript REST API");
	});

	it("strips <think> tags from reply before storing in history", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "<think>reasoning here</think>\nThe answer is 42." } }] }),
		});

		const chat = new LMStudioChat({ fetch: fetchMock });
		const result = await chat.chat("what is the answer?");
		expect(result).toBe("The answer is 42.");
	});

	it("maintains conversation history across turns", async () => {
		let callCount = 0;
		const fetchMock = vi.fn().mockImplementation(async () => {
			callCount++;
			return {
				ok: true,
				json: async () => ({ choices: [{ message: { content: `Reply ${callCount}` } }] }),
			};
		});

		const chat = new LMStudioChat({ fetch: fetchMock });
		await chat.chat("first message");
		await chat.chat("second message");

		const body = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { messages: Array<{ role: string; content: string }> };
		const assistantTurns = body.messages.filter((m) => m.role === "assistant");
		expect(assistantTurns.length).toBeGreaterThanOrEqual(1);
	});
});
