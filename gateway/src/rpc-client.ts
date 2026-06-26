import { RpcClient } from "@earendil-works/pi-coding-agent";

type AgentEvent = { type: string; [key: string]: unknown };

export interface PiSessionOptions {
  piCliPath: string;
  piArgs?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface PiSessionStatus {
  isStreaming: boolean;
  model: { provider: string; id: string; contextWindow?: number; reasoning?: boolean } | undefined;
  sessionId: string;
}

export class PiSession {
  private client: RpcClient;
  private alive = false;
  private opts: PiSessionOptions;

  constructor(opts: PiSessionOptions) {
    this.opts = opts;
    this.client = new RpcClient({
      cliPath: opts.piCliPath,
      cwd: opts.cwd,
      env: opts.env,
      args: opts.piArgs ?? [],
    });
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async start(): Promise<void> {
    await this.client.start();
    this.alive = true;

    // Watch for unexpected process death
    this.client.onEvent((event: AgentEvent) => {
      if ((event as any).type === "process_exit") {
        this.alive = false;
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    await this.client.stop();
  }

  async sendMessage(text: string): Promise<string> {
    const events = await this.client.promptAndWait(text, undefined, 30000);
    let textBuffer = "";
    for (const event of events) {
      if (event.type === "message_update") {
        const ev = event as any;
        if (ev.assistantMessageEvent?.type === "text_delta") {
          textBuffer += ev.assistantMessageEvent.delta;
        }
      }
    }
    return textBuffer;
  }

  /**
   * Send a prompt and stream text deltas to onChunk as they arrive.
   * Returns the full accumulated response text when done.
   * Uses prompt()+onEvent()+waitForIdle() so the caller gets updates mid-generation.
   */
  async sendMessageStreaming(
    text: string,
    onChunk?: (accumulatedText: string) => void,
  ): Promise<string> {
    let textBuffer = "";
    const unsubscribe = this.client.onEvent((event: AgentEvent) => {
      if (event.type === "message_update") {
        const ev = event as any;
        if (ev.assistantMessageEvent?.type === "text_delta") {
          textBuffer += ev.assistantMessageEvent.delta;
          onChunk?.(textBuffer);
        }
      }
    });
    try {
      await this.client.prompt(text);
      await this.client.waitForIdle(120_000);
    } finally {
      unsubscribe();
    }
    return textBuffer;
  }

  async cancel(): Promise<void> {
    await this.client.abort();
  }

  async getStatus(): Promise<PiSessionStatus> {
    const state = await this.client.getState();
    return {
      isStreaming: state.isStreaming,
      model: state.model as any,
      sessionId: state.sessionId,
    };
  }
}
