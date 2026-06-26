/**
 * T001 — Typing indicator tests
 * Verifies sendTyping is called immediately and at 4s intervals during processing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHandlers, type HandlerDeps } from "../src/bot.ts";
import { UserQueue } from "../src/queue.ts";

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps & {
  replies: string[];
  typingCalls: number[];
} {
  const replies: string[] = [];
  const typingCalls: number[] = [];

  const mockSession = {
    sendMessage: vi.fn(async () => "ok"),
    cancel: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      isStreaming: false,
      model: { provider: "lmstudio", id: "gemma" },
      sessionId: "s1",
    })),
    isAlive: true,
  };

  const queue = new UserQueue();

  return {
    router: { getOrCreate: vi.fn(async () => mockSession) } as any,
    queue,
    sendReply: vi.fn(async (_chatId: number, text: string) => { replies.push(text); }),
    sendTyping: vi.fn(async (chatId: number) => { typingCalls.push(Date.now()); }),
    allowedUsers: [1],
    lmChatFn: async () => "lm reply",
    ...overrides,
    replies,
    typingCalls,
  } as any;
}

function makeMsg(text = "build me a REST API") {
  return { chat: { id: 1 }, from: { id: 1 }, text, message_id: 1 };
}

describe("T001: Typing indicator", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("calls sendTyping immediately when a message arrives", async () => {
    const deps = makeDeps();
    const { onMessage } = createHandlers(deps);

    const promise = onMessage(makeMsg());
    // sendTyping should be called synchronously before queue settles
    expect(deps.sendTyping).toHaveBeenCalledWith(1);
    await promise;
  });

  it("calls sendTyping at 4s intervals during a slow queue task", async () => {
    let resolveSlow!: () => void;
    const slowSession = {
      sendMessage: vi.fn(
        () => new Promise<string>((res) => { resolveSlow = () => res("done"); })
      ),
      cancel: vi.fn(),
      getStatus: vi.fn(async () => ({ isStreaming: false, model: {}, sessionId: "s" })),
      isAlive: true,
    };

    const deps = makeDeps({
      router: { getOrCreate: vi.fn(async () => slowSession) } as any,
    } as any);
    const { onMessage } = createHandlers(deps);

    const msgPromise = onMessage(makeMsg());

    // Advance 8 seconds — should fire interval twice (at 4s and 8s)
    await vi.advanceTimersByTimeAsync(8100);
    resolveSlow();
    await msgPromise;

    // Initial call + 2 interval calls = at least 3
    expect((deps.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("stops calling sendTyping after the queue task completes", async () => {
    const deps = makeDeps();
    const { onMessage } = createHandlers(deps);

    await onMessage(makeMsg());
    const callCountAfterDone = (deps.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length;

    // Advance another 8s — interval should be cleared, no new calls
    await vi.advanceTimersByTimeAsync(8000);
    expect((deps.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountAfterDone);
  });

  it("calls sendTyping for document messages too", async () => {
    const deps = makeDeps();
    const { onDocument } = createHandlers(deps);

    const docMsg = {
      chat: { id: 1 },
      from: { id: 1 },
      message_id: 2,
      document: { file_id: "f1", file_name: "test.txt" },
      bot: undefined,
    };

    // Without a bot instance, onDocument short-circuits after typing — that's fine
    await onDocument(docMsg as any);
    expect(deps.sendTyping).toHaveBeenCalledWith(1);
  });

  it("calls sendTyping for photo messages too", async () => {
    const deps = makeDeps();
    const { onPhoto } = createHandlers(deps);

    const photoMsg = {
      chat: { id: 1 },
      from: { id: 1 },
      message_id: 3,
      photo: [{ file_id: "p1" }],
    };

    await onPhoto(photoMsg as any);
    expect(deps.sendTyping).toHaveBeenCalledWith(1);
  });
});
