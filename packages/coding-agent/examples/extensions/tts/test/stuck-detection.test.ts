/**
 * T002 — Heuristic stuck detection tests (TDD: written before implementation)
 */

import { describe, expect, it } from "vitest";
import { isStuck, buildRetryPrompt } from "../stuck.ts";

describe("isStuck — response length", () => {
	it("flags a response shorter than 80 chars as stuck", () => {
		expect(isStuck("ok", { retryCount: 0 })).toBe(true);
	});

	it("does not flag a normal-length response", () => {
		const normal = "Here is the analysis of the codebase. I examined all the files and found several interesting patterns that worth discussing at length.";
		expect(isStuck(normal, { retryCount: 0 })).toBe(false);
	});
});

describe("isStuck — refusal phrases", () => {
	it("flags 'I cannot assist with that'", () => {
		const r = "I'm sorry, I cannot assist with that request as it goes against my guidelines.";
		expect(isStuck(r, { retryCount: 0 })).toBe(true);
	});

	it("flags 'I'm unable to'", () => {
		const r = "I'm unable to complete this task because it requires access to external resources that I do not have.";
		expect(isStuck(r, { retryCount: 0 })).toBe(true);
	});

	it("flags 'as an AI language model'", () => {
		const r = "As an AI language model, I don't have the ability to browse the internet or access real-time information.";
		expect(isStuck(r, { retryCount: 0 })).toBe(true);
	});

	it("does not flag a response that mentions AI incidentally", () => {
		const r = "The AI integration in this codebase uses a retrieval-augmented generation pipeline with vector embeddings stored in a Postgres database with pgvector.";
		expect(isStuck(r, { retryCount: 0 })).toBe(false);
	});
});

describe("isStuck — repetition detection", () => {
	it("flags when response exactly matches previous response", () => {
		const prev = "I have analyzed the task and here is what I found about the codebase structure.";
		expect(isStuck(prev, { retryCount: 0, previousResponse: prev })).toBe(true);
	});

	it("does not flag when responses differ", () => {
		const prev = "Step one is complete. I have examined the first module and found several patterns.";
		const curr = "Step two is complete. I have examined the second module thoroughly and found no issues worth flagging.";
		expect(isStuck(curr, { retryCount: 0, previousResponse: prev })).toBe(false);
	});
});

describe("isStuck — retry count", () => {
	it("flags when retry count reaches threshold (3)", () => {
		const normal = "Here is a normal-length response that would otherwise not trigger stuck detection by itself.";
		expect(isStuck(normal, { retryCount: 3 })).toBe(true);
	});

	it("does not flag below threshold", () => {
		const normal = "Here is a normal-length response that would otherwise not trigger stuck detection by itself.";
		expect(isStuck(normal, { retryCount: 2 })).toBe(false);
	});
});

describe("buildRetryPrompt", () => {
	it("wraps original prompt with hint for first retry", () => {
		const prompt = "Execute subtask 2/5: analyze the auth module";
		const result = buildRetryPrompt(prompt, "short_response", 1);
		expect(result).toContain(prompt);
		expect(result.length).toBeGreaterThan(prompt.length);
	});

	it("includes escalation note on second retry", () => {
		const prompt = "Execute subtask 3/5: refactor the DB layer";
		const result = buildRetryPrompt(prompt, "refusal", 2);
		expect(result).toContain("expert");
	});
});
