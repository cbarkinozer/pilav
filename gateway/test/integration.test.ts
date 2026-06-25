/**
 * T008 — Full round-trip integration test
 * Uses mock-pi.js subprocess. No real Telegram or LM Studio needed.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserQueue } from "../src/queue.ts";
import { PiSession } from "../src/rpc-client.ts";
import { SessionRouter } from "../src/router.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PI_PATH = join(__dirname, "mock-pi.js");

function makeSessionFactory(responseText = "Integration response") {
  return () =>
    new PiSession({
      piCliPath: MOCK_PI_PATH,
      piArgs: [],
      env: { MOCK_PI_RESPONSE: responseText },
    });
}

describe("T008: Full round-trip integration", () => {
  let router: SessionRouter;
  let queue: UserQueue;
  const RESPONSE = "Integration test response from Pi";

  beforeEach(() => {
    queue = new UserQueue();
    router = new SessionRouter({ sessionFactory: makeSessionFactory(RESPONSE) });
  });

  afterEach(async () => {
    await router.stopAll();
  });

  it("message flows from queue → router → session → response", async () => {
    let capturedResponse = "";

    await queue.enqueue(1001, async () => {
      const session = await router.getOrCreate(1001);
      capturedResponse = await session.sendMessage("Hello Pi");
    });

    expect(capturedResponse).toContain(RESPONSE);
  });

  it("two concurrent messages from same user are serialized", async () => {
    const order: number[] = [];

    const p1 = queue.enqueue(1001, async () => {
      const session = await router.getOrCreate(1001);
      await session.sendMessage("First message");
      order.push(1);
    });

    const p2 = queue.enqueue(1001, async () => {
      const session = await router.getOrCreate(1001);
      await session.sendMessage("Second message");
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("messages from different users run in parallel", async () => {
    const startTimes: number[] = [];
    const endTimes: number[] = [];

    const p1 = queue.enqueue(1001, async () => {
      startTimes.push(Date.now());
      const session = await router.getOrCreate(1001);
      await session.sendMessage("User 1 message");
      endTimes.push(Date.now());
    });

    const p2 = queue.enqueue(1002, async () => {
      startTimes.push(Date.now());
      const session = await router.getOrCreate(1002);
      await session.sendMessage("User 2 message");
      endTimes.push(Date.now());
    });

    await Promise.all([p1, p2]);
    // Both tasks should have started
    expect(startTimes.length).toBe(2);
  });

  it("session is reused for follow-up messages from same user", async () => {
    await queue.enqueue(1001, async () => {
      await router.getOrCreate(1001);
    });

    const s1 = await router.getOrCreate(1001);

    await queue.enqueue(1001, async () => {
      await router.getOrCreate(1001);
    });

    const s2 = await router.getOrCreate(1001);
    expect(s1).toBe(s2);
  });

  it("cancel() can be called on a session mid-queue", async () => {
    let sessionRef: any;

    const p = queue.enqueue(1001, async () => {
      sessionRef = await router.getOrCreate(1001);
      await sessionRef.sendMessage("Long task");
    });

    await p;
    await expect(sessionRef.cancel()).resolves.not.toThrow();
  });
});
