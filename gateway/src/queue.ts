/**
 * Per-user message queue.
 * Tasks for the same user execute sequentially; different users run in parallel.
 */
export class UserQueue {
  private chains = new Map<number, Promise<void>>();
  private pending = new Map<number, number>();

  enqueue(userId: number, task: () => Promise<void>): Promise<void> {
    const current = this.chains.get(userId) ?? Promise.resolve();
    this.pending.set(userId, (this.pending.get(userId) ?? 0) + 1);

    const next = current.then(() => task()).finally(() => {
      const count = (this.pending.get(userId) ?? 1) - 1;
      if (count <= 0) {
        this.pending.delete(userId);
        this.chains.delete(userId);
      } else {
        this.pending.set(userId, count);
      }
    });

    this.chains.set(userId, next.catch(() => {}));
    return next;
  }

  size(userId: number): number {
    return this.pending.get(userId) ?? 0;
  }
}
