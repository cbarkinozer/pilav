/**
 * T005 — Session router tests
 * Tests session lifecycle: create, reuse, timeout, cleanup.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRouter } from "../src/router.ts";
import type { PiSessionFactory } from "../src/router.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PI_PATH = join(__dirname, "mock-pi.js");

// Mock PiSession factory for router tests (avoids spawning real processes)
function makeMockFactory(): { factory: PiSessionFactory; stopped: Set<string> } {
  const stopped = new Set<string>();
  let idCounter = 0;

  const factory: PiSessionFactory = () => {
    const id = `mock-session-${++idCounter}`;
    return {
      start: async () => {},
      stop: async () => { stopped.add(id); },
      sendMessage: async () => "mock response",
      cancel: async () => {},
      getStatus: async () => ({
        isStreaming: false,
        model: { provider: "lmstudio", id: "gemma-4-4b", contextWindow: 128000, reasoning: false },
        sessionId: id,
      }),
      get isAlive() { return !stopped.has(id); },
      _id: id,
    } as any;
  };

  return { factory, stopped };
}

describe("T005: SessionRouter", () => {
  let router: SessionRouter;
  const { factory, stopped } = makeMockFactory();

  beforeEach(() => {
    router = new SessionRouter({ sessionFactory: factory, timeoutMs: 200 });
  });

  afterEach(async () => {
    await router.stopAll();
  });

  it("getOrCreate returns a session for a new chatId", async () => {
    const session = await router.getOrCreate(1001);
    expect(session).toBeDefined();
  });

  it("getOrCreate returns the same session for the same chatId", async () => {
    const s1 = await router.getOrCreate(1001);
    const s2 = await router.getOrCreate(1001);
    expect(s1).toBe(s2);
  });

  it("getOrCreate returns different sessions for different chatIds", async () => {
    const s1 = await router.getOrCreate(1001);
    const s2 = await router.getOrCreate(1002);
    expect(s1).not.toBe(s2);
  });

  it("stop(chatId) removes and stops the session", async () => {
    const session = await router.getOrCreate(1001) as any;
    const sessionId = session._id as string;

    await router.stop(1001);

    // Session stopped
    expect(stopped.has(sessionId)).toBe(true);

    // Next call creates a new session
    const s2 = await router.getOrCreate(1001) as any;
    expect(s2._id).not.toBe(sessionId);
  });

  it("stopAll() stops all active sessions", async () => {
    const s1 = await router.getOrCreate(1001) as any;
    const s2 = await router.getOrCreate(1002) as any;

    await router.stopAll();

    expect(stopped.has(s1._id)).toBe(true);
    expect(stopped.has(s2._id)).toBe(true);
  });

  it("idle sessions are cleaned up after timeout", async () => {
    const { factory: f2, stopped: s2 } = makeMockFactory();
    const shortTimeoutRouter = new SessionRouter({ sessionFactory: f2, timeoutMs: 100 });

    const session = await shortTimeoutRouter.getOrCreate(2001) as any;
    const sid = session._id;

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 400));

    expect(s2.has(sid)).toBe(true);
    await shortTimeoutRouter.stopAll();
  });

  it("activity resets the idle timer", async () => {
    const { factory: f3, stopped: s3 } = makeMockFactory();
    const shortTimeoutRouter = new SessionRouter({ sessionFactory: f3, timeoutMs: 150 });

    await shortTimeoutRouter.getOrCreate(3001) as any;

    // Access before timeout to reset timer
    await new Promise((r) => setTimeout(r, 80));
    const session = await shortTimeoutRouter.getOrCreate(3001) as any;

    // Wait a bit more but not enough for a full timeout from first access
    await new Promise((r) => setTimeout(r, 80));

    // Session should still be alive (timer was reset)
    expect(session.isAlive).toBe(true);

    await shortTimeoutRouter.stopAll();
  });
});
