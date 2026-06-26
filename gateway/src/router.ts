import type { PiSession } from "./rpc-client.ts";

export type PiSessionFactory = () => PiSession;

export interface SessionRouterOptions {
  sessionFactory: PiSessionFactory;
  timeoutMs?: number;
}

interface SessionEntry {
  session: PiSession;
  lastActive: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionRouter {
  private sessions = new Map<number, SessionEntry>();
  private factory: PiSessionFactory;
  private timeoutMs: number;

  constructor(opts: SessionRouterOptions) {
    this.factory = opts.sessionFactory;
    this.timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  }

  async getOrCreate(chatId: number): Promise<PiSession> {
    const entry = this.sessions.get(chatId);

    if (entry) {
      this.resetTimer(chatId, entry);
      return entry.session;
    }

    const session = this.factory();
    await session.start();

    const newEntry: SessionEntry = {
      session,
      lastActive: Date.now(),
      stopTimer: null,
    };
    this.sessions.set(chatId, newEntry);
    this.resetTimer(chatId, newEntry);

    return session;
  }

  async stop(chatId: number): Promise<void> {
    const entry = this.sessions.get(chatId);
    if (!entry) return;

    if (entry.stopTimer !== null) clearTimeout(entry.stopTimer);
    this.sessions.delete(chatId);
    await entry.session.stop();
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  getIfExists(chatId: number): PiSession | null {
    const entry = this.sessions.get(chatId);
    if (!entry) return null;
    this.resetTimer(chatId, entry);
    return entry.session;
  }

  activeChatIds(): number[] {
    return [...this.sessions.keys()];
  }

  private resetTimer(chatId: number, entry: SessionEntry): void {
    if (entry.stopTimer !== null) clearTimeout(entry.stopTimer);
    entry.lastActive = Date.now();
    entry.stopTimer = setTimeout(async () => {
      await this.stop(chatId);
    }, this.timeoutMs);
  }
}
