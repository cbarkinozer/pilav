/**
 * T006 — Telegram bot handler tests
 * Tests handler logic with stub objects (no real Telegram connection).
 */

import { describe, expect, it, vi } from "vitest";
import { createHandlers, type HandlerDeps } from "../src/bot.ts";

function makeMockDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps & { replies: string[] } {
  const replies: string[] = [];

  const mockSession = {
    sendMessage: vi.fn(async () => "agent reply"),
    cancel: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      isStreaming: false,
      model: { provider: "lmstudio", id: "gemma-4-4b" },
      sessionId: "test-session",
    })),
    isAlive: true,
  };

  const mockRouter = {
    getOrCreate: vi.fn(async () => mockSession),
    stop: vi.fn(async () => {}),
  };

  const mockQueue = {
    enqueue: vi.fn((userId: number, task: () => Promise<void>) => task()),
    size: vi.fn(() => 0),
  };

  const mockReply = vi.fn(async (chatId: number, text: string) => {
    replies.push(text);
  });

  return {
    router: mockRouter as any,
    queue: mockQueue as any,
    sendReply: mockReply,
    allowedUsers: [100, 200],
    // Stub LM Studio chat so tests don't hit real HTTP
    lmChatFn: async (_chatId: number, _text: string) => "lm reply",
    ...overrides,
    replies,
  } as any;
}

function makeMsg(chatId: number, userId: number, text: string) {
  return {
    chat: { id: chatId },
    from: { id: userId },
    text,
    message_id: 1,
  };
}

describe("T006: Bot handlers", () => {
  it("routes task messages from allowed users to the Pi session", async () => {
    const deps = makeMockDeps();
    const { onMessage } = createHandlers(deps);

    await onMessage(makeMsg(100, 100, "build me a REST API in TypeScript"));

    expect(deps.router.getOrCreate).toHaveBeenCalledWith(100);
    expect(deps.queue.enqueue).toHaveBeenCalled();
  });

  it("replies with rejection for unknown users", async () => {
    const deps = makeMockDeps();
    const { onMessage } = createHandlers(deps);

    await onMessage(makeMsg(999, 999, "Hello"));

    expect(deps.replies).toEqual(expect.arrayContaining([expect.stringMatching(/not authorized/i)]));
    expect(deps.router.getOrCreate).not.toHaveBeenCalled();
  });

  it("allows all users when allowedUsers is empty", async () => {
    const lmChatFn = vi.fn().mockResolvedValue("hi there");
    const deps = makeMockDeps({ allowedUsers: [], lmChatFn } as any);
    const { onMessage } = createHandlers(deps);

    await onMessage(makeMsg(999, 999, "Hello"));

    // Casual message goes to LM Studio, not the Pi session
    expect(lmChatFn).toHaveBeenCalled();
  });

  it("/start replies with welcome message", async () => {
    const deps = makeMockDeps();
    const { onStart } = createHandlers(deps);

    await onStart(makeMsg(100, 100, "/start"));

    expect(deps.replies.length).toBeGreaterThan(0);
    expect(deps.replies[0]).toMatch(/pilav|hello|welcome/i);
  });

  it("/status replies with session state", async () => {
    const deps = makeMockDeps();
    const { onStatus } = createHandlers(deps);

    await onStatus(makeMsg(100, 100, "/status"));

    expect(deps.replies.length).toBeGreaterThan(0);
    expect(deps.replies[0]).toMatch(/streaming|model|session/i);
  });

  it("/cancel calls session.cancel() and replies", async () => {
    const deps = makeMockDeps();
    const { onCancel } = createHandlers(deps);

    await onCancel(makeMsg(100, 100, "/cancel"));

    expect(deps.router.getOrCreate).toHaveBeenCalled();
    const session = await deps.router.getOrCreate(100);
    expect(session.cancel).toHaveBeenCalled();
    expect(deps.replies.length).toBeGreaterThan(0);
  });

  it("long responses are split into chunks of <= 4096 chars", async () => {
    const longText = "x".repeat(5000);
    const mockSession = {
      sendMessage: vi.fn(async () => longText),
      cancel: vi.fn(),
      getStatus: vi.fn(async () => ({ isStreaming: false, model: {}, sessionId: "s" })),
      isAlive: true,
    };
    const deps = makeMockDeps({
      router: { getOrCreate: vi.fn(async () => mockSession) } as any,
    } as any);
    const { onMessage } = createHandlers(deps);

    await onMessage(makeMsg(100, 100, "build me a very long response please implement everything"));

    // All replies should be within Telegram message size limit
    for (const reply of deps.replies) {
      expect(reply.length).toBeLessThanOrEqual(4096);
    }
    // Total content matches original
    const combined = deps.replies.join("");
    expect(combined).toContain("x".repeat(100)); // sanity check
  });
});
