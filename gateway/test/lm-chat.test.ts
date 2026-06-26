import { describe, expect, it, vi } from "vitest";
import { detectThinkingMode, isTaskRequest, wrapWithThinkingMode, formatStreamDisplay, LMStudioChat } from "../src/lm-chat.ts";

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
		expect(wrapWithThinkingMode("do something", "think")).toBe("/think\ndo something");
	});

	it("prepends /no_think to the message", () => {
		expect(wrapWithThinkingMode("hi", "no_think")).toBe("/no_think\nhi");
	});
});

describe("formatStreamDisplay", () => {
	it("shows only thinking block while thinking", () => {
		const result = formatStreamDisplay("let me think about this", "");
		expect(result).toContain("<thinking>");
		expect(result).toContain("let me think about this");
		expect(result).toContain("</thinking>");
	});

	it("shows thinking block and answer when both present", () => {
		const result = formatStreamDisplay("some reasoning", "The answer is 42.");
		expect(result).toContain("<thinking>");
		expect(result).toContain("</thinking>");
		expect(result).toContain("The answer is 42.");
	});

	it("shows only answer when no thinking", () => {
		const result = formatStreamDisplay("", "Just the answer.");
		expect(result).not.toContain("<thinking>");
		expect(result).toBe("Just the answer.");
	});

	it("returns placeholder when both empty", () => {
		expect(formatStreamDisplay("", "")).toBe("⏳ Thinking…");
	});
});

describe("LMStudioChat — chat()", () => {
	it("sends max_tokens of at least 16384 in the request", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "Hello!" } }] }),
		});

		const chat = new LMStudioChat({ fetch: fetchMock });
		await chat.chat("hi");

		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { max_tokens: number };
		expect(body.max_tokens).toBeGreaterThanOrEqual(16384);
	});

	it("sends the user message as plain text without prefixes", async () => {
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

	it("strips <think> tags from reply", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "<think>reasoning</think>\nThe answer is 42." } }] }),
		});

		const chat = new LMStudioChat({ fetch: fetchMock });
		const result = await chat.chat("what is the answer?");
		expect(result).toBe("The answer is 42.");
	});

	it("maintains conversation history across turns", async () => {
		let n = 0;
		const fetchMock = vi.fn().mockImplementation(async () => ({
			ok: true,
			json: async () => ({ choices: [{ message: { content: `Reply ${++n}` } }] }),
		}));

		const chat = new LMStudioChat({ fetch: fetchMock });
		await chat.chat("first message");
		await chat.chat("second message");

		const body = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { messages: Array<{ role: string }> };
		expect(body.messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(1);
	});
});

describe("LMStudioChat — chatStreaming()", () => {
	function makeSSEStream(tokens: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				for (const token of tokens) {
					const line = `data: ${JSON.stringify({ choices: [{ delta: { content: token }, finish_reason: null }] })}\n\n`;
					controller.enqueue(encoder.encode(line));
				}
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
	}

	it("calls onChunk and returns clean answer", async () => {
		const tokens = ["<think>", "reasoning", "</think>", "Final answer."];
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			body: makeSSEStream(tokens),
		});

		const chunks: string[] = [];
		const chat = new LMStudioChat({ fetch: fetchMock });
		const result = await chat.chatStreaming("hi", (d) => { chunks.push(d); });

		expect(chunks.length).toBeGreaterThan(0);
		expect(result).toBe("Final answer.");
	});

	it("onChunk display contains <thinking> block while in think phase", async () => {
		const tokens = ["<think>", "some reasoning here"];
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			body: makeSSEStream(tokens),
		});

		const chunks: string[] = [];
		const chat = new LMStudioChat({ fetch: fetchMock });
		await chat.chatStreaming("question", (d) => { chunks.push(d); });

		const thinkingChunk = chunks.find((c) => c.includes("<thinking>"));
		expect(thinkingChunk).toBeDefined();
	});

	it("sends stream: true in the request", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			body: makeSSEStream(["hello"]),
		});

		const chat = new LMStudioChat({ fetch: fetchMock });
		await chat.chatStreaming("hi", () => {});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { stream: boolean };
		expect(body.stream).toBe(true);
	});
});
