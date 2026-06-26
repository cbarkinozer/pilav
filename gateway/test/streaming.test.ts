/**
 * T004 — Telegram streaming response tests
 * Verifies that sendMessageStreaming emits chunks and the bot edits
 * a Thinking... message with partial output rather than waiting silently.
 */

import { describe, expect, it, vi } from "vitest";
import { PiSession } from "../src/rpc-client.ts";
import { createHandlers, type HandlerDeps } from "../src/bot.ts";
import { UserQueue } from "../src/queue.ts";

// ─── PiSession streaming tests ────────────────────────────────────────────────

describe("T004: PiSession.sendMessageStreaming", () => {
  it("emits chunks via onChunk callback as text_delta events arrive", async () => {
    const session = new PiSession({ piCliPath: "/fake/cli.js" });

    // Stub the underlying RpcClient to emit text_delta events
    const chunks: string[] = [];
    let eventListener: ((e: unknown) => void) | null = null;

    const mockClient = {
      prompt: vi.fn(async () => {}),
      onEvent: vi.fn((listener: (e: unknown) => void) => {
        eventListener = listener;
        return () => {};
      }),
      waitForIdle: vi.fn(async () => {
        // Simulate token stream then completion
        eventListener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Hello " },
        });
        eventListener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "world" },
        });
        eventListener?.({ type: "agent_end" });
      }),
    };
    (session as any).client = mockClient;
    (session as any).alive = true;

    const result = await session.sendMessageStreaming("hi", (chunk) => {
      chunks.push(chunk);
    });

    expect(chunks.length).toBeGreaterThan(0);
    expect(result).toBe("Hello world");
    expect(mockClient.prompt).toHaveBeenCalledWith("hi");
  });

  it("resolves with full text even if onChunk is not provided", async () => {
    const session = new PiSession({ piCliPath: "/fake/cli.js" });
    let eventListener: ((e: unknown) => void) | null = null;

    const mockClient = {
      prompt: vi.fn(async () => {}),
      onEvent: vi.fn((listener: (e: unknown) => void) => {
        eventListener = listener;
        return () => {};
      }),
      waitForIdle: vi.fn(async () => {
        eventListener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Done" },
        });
      }),
    };
    (session as any).client = mockClient;
    (session as any).alive = true;

    const result = await session.sendMessageStreaming("test");
    expect(result).toBe("Done");
  });
});

// ─── Bot streaming integration tests ─────────────────────────────────────────

describe("T004: Bot streaming response", () => {
  it("sends a Thinking... message before streaming starts", async () => {
    const sentMessages: string[] = [];
    const editedMessages: string[] = [];
    let thinkingMsgId = 0;

    const mockSession = {
      sendMessageStreaming: vi.fn(async (text: string, onChunk?: (t: string) => void) => {
        onChunk?.("partial response");
        return "final response";
      }),
      sendMessage: vi.fn(async () => "final response"),
      cancel: vi.fn(),
      getStatus: vi.fn(async () => ({ isStreaming: false, model: {}, sessionId: "s" })),
      isAlive: true,
    };

    const deps: HandlerDeps & { replies: string[]; edits: string[] } = {
      router: { getOrCreate: vi.fn(async () => mockSession) } as any,
      queue: new UserQueue(),
      sendReply: vi.fn(async (_chatId: number, text: string) => {
        sentMessages.push(text);
      }),
      sendTyping: vi.fn(async () => {}),
      sendStreamingMessage: vi.fn(async (_chatId: number, text: string) => {
        sentMessages.push(text);
        thinkingMsgId = 42;
        return 42;
      }),
      editMessage: vi.fn(async (_chatId: number, _msgId: number, text: string) => {
        editedMessages.push(text);
      }),
      allowedUsers: [1],
      replies: sentMessages,
      edits: editedMessages,
    } as any;

    const { onMessage } = createHandlers(deps);
    await onMessage({ chat: { id: 1 }, from: { id: 1 }, text: "hello", message_id: 1 });

    // Should have sent an initial "Thinking..." message
    expect(sentMessages.some((m) => /thinking/i.test(m))).toBe(true);
  });

  it("falls back to sendMessage if sendStreamingMessage is not provided", async () => {
    const replies: string[] = [];
    const mockSession = {
      sendMessage: vi.fn(async () => "plain response"),
      cancel: vi.fn(),
      getStatus: vi.fn(async () => ({ isStreaming: false, model: {}, sessionId: "s" })),
      isAlive: true,
    };

    const deps: HandlerDeps = {
      router: { getOrCreate: vi.fn(async () => mockSession) } as any,
      queue: new UserQueue(),
      sendReply: vi.fn(async (_chatId: number, text: string) => { replies.push(text); }),
      sendTyping: vi.fn(async () => {}),
      allowedUsers: [1],
    };

    const { onMessage } = createHandlers(deps);
    await onMessage({ chat: { id: 1 }, from: { id: 1 }, text: "hello", message_id: 1 });

    expect(replies).toContain("plain response");
  });
});
