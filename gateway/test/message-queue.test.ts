/**
 * T003 — Message queue per user tests
 * Verifies per-user serialization and cross-user parallelism.
 */

import { describe, expect, it } from "vitest";
import { UserQueue } from "../src/queue.ts";

describe("T003: UserQueue", () => {
  it("executes a single task and resolves", async () => {
    const q = new UserQueue();
    const result = await new Promise<string>((resolve) => {
      q.enqueue("user1", async () => {
        resolve("done");
      });
    });
    expect(result).toBe("done");
  });

  it("executes tasks for same user sequentially", async () => {
    const q = new UserQueue();
    const order: number[] = [];

    const p1 = new Promise<void>((resolve) => {
      q.enqueue("user1", async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
        resolve();
      });
    });

    const p2 = new Promise<void>((resolve) => {
      q.enqueue("user1", async () => {
        order.push(2);
        resolve();
      });
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("executes tasks for different users in parallel", async () => {
    const q = new UserQueue();
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    const p1 = new Promise<void>((resolve) => {
      q.enqueue("user1", async () => {
        startTimes.user1 = Date.now();
        await new Promise((r) => setTimeout(r, 30));
        endTimes.user1 = Date.now();
        resolve();
      });
    });

    const p2 = new Promise<void>((resolve) => {
      q.enqueue("user2", async () => {
        startTimes.user2 = Date.now();
        await new Promise((r) => setTimeout(r, 30));
        endTimes.user2 = Date.now();
        resolve();
      });
    });

    await Promise.all([p1, p2]);

    // Both tasks should have started before either finished (parallel)
    expect(startTimes.user1).toBeDefined();
    expect(startTimes.user2).toBeDefined();
    // user2 should start before user1 ends (they overlap)
    expect(startTimes.user2).toBeLessThan(endTimes.user1);
  });

  it("continues processing after a task throws", async () => {
    const q = new UserQueue();
    const results: string[] = [];

    const p1 = q.enqueue("user1", async () => {
      throw new Error("task failed");
    });

    const p2 = new Promise<void>((resolve) => {
      q.enqueue("user1", async () => {
        results.push("second");
        resolve();
      });
    });

    await p1.catch(() => {});
    await p2;
    expect(results).toEqual(["second"]);
  });

  it("size() returns number of pending tasks", async () => {
    const q = new UserQueue();
    let resolveTask!: () => void;

    q.enqueue("user1", () => new Promise<void>((r) => { resolveTask = r; }));
    q.enqueue("user1", async () => {});
    q.enqueue("user1", async () => {});

    // At least 1 pending after first blocks
    await new Promise((r) => setTimeout(r, 5));
    expect(q.size("user1")).toBeGreaterThanOrEqual(1);

    resolveTask();
  });

  it("enqueue returns a promise that resolves when the task completes", async () => {
    const q = new UserQueue();
    let resolved = false;

    const p = q.enqueue("user1", async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });

    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
  });
});
