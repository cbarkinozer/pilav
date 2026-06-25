/**
 * T004 — Pi RPC client wrapper tests
 * Uses mock-pi.js subprocess — no LM Studio required.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSession } from "../src/rpc-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PI_PATH = join(__dirname, "mock-pi.js");

describe("T004: PiSession", () => {
  let session: PiSession;

  beforeEach(() => {
    session = new PiSession({
      piCliPath: MOCK_PI_PATH,
      piArgs: [],
      env: { MOCK_PI_RESPONSE: "Hello from Pi!" },
    });
  });

  afterEach(async () => {
    await session.stop();
  });

  it("start() spawns the Pi process without throwing", async () => {
    await expect(session.start()).resolves.not.toThrow();
    expect(session.isAlive).toBe(true);
  });

  it("sendMessage() returns the assistant text", async () => {
    await session.start();
    const response = await session.sendMessage("Hello");
    expect(response).toContain("Hello from Pi!");
  });

  it("getStatus() returns session state with isStreaming=false at rest", async () => {
    await session.start();
    const status = await session.getStatus();
    expect(status.isStreaming).toBe(false);
    expect(typeof status.sessionId).toBe("string");
  });

  it("getStatus() returns model info", async () => {
    await session.start();
    const status = await session.getStatus();
    expect(status.model).toBeDefined();
  });

  it("cancel() calls abort and resolves", async () => {
    await session.start();
    await expect(session.cancel()).resolves.not.toThrow();
  });

  it("stop() terminates the process and isAlive becomes false", async () => {
    await session.start();
    expect(session.isAlive).toBe(true);
    await session.stop();
    expect(session.isAlive).toBe(false);
  });

  it("sendMessage() with custom response text", async () => {
    const customSession = new PiSession({
      piCliPath: MOCK_PI_PATH,
      piArgs: [],
      env: { MOCK_PI_RESPONSE: "Custom response text" },
    });
    await customSession.start();
    const response = await customSession.sendMessage("test");
    await customSession.stop();
    expect(response).toContain("Custom response text");
  });

  it("multiple sequential messages work correctly", async () => {
    await session.start();
    const r1 = await session.sendMessage("First");
    const r2 = await session.sendMessage("Second");
    expect(r1).toBeTruthy();
    expect(r2).toBeTruthy();
  });
});
