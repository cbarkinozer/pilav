/**
 * OpenCodeRunner — spawns `opencode run` as a subprocess and streams JSON events.
 * Used as a free-model alternative/fallback to ClaudeCodeRunner.
 *
 * Free models available:
 *   opencode/deepseek-v4-flash-free   — fast, good general coding
 *   opencode/nemotron-3-ultra-free    — strong reasoning
 *   opencode/mimo-v2.5-free           — coding specialist
 *   opencode/north-mini-code-free     — very fast, small tasks
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ActionStore } from "./action-store.ts";

export const OPENCODE_FREE_MODELS = [
  "opencode/deepseek-v4-flash-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/mimo-v2.5-free",
  "opencode/north-mini-code-free",
] as const;

export const OPENCODE_DEFAULT_MODEL =
  process.env.OPENCODE_DEFAULT_MODEL ?? "opencode/deepseek-v4-flash-free";

export interface OpenCodeRunOptions {
  task: string;
  model?: string;
  name?: string;
  cwd?: string;
  telegramChatId?: number;
  onProgress?: (text: string) => void | Promise<void>;
  /** opencode ses_… ID for resuming a previous session */
  resumeSessionId?: string;
}

export interface OpenCodeRunResult {
  sessionId: string;
  /** opencode's ses_… ID — save this to resume the conversation */
  opencodeSessionId?: string;
  finalText: string;
  status: "completed" | "error" | "cancelled";
  errorMessage?: string;
  eventsLogged: number;
  name?: string;
}

export class OpenCodeRunner {
  private store: ActionStore;
  private activeProcesses = new Map<string, { kill: () => void }>();

  constructor(store: ActionStore) {
    this.store = store;
  }

  async run(opts: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    const sessionId = randomUUID();
    const model = opts.model ?? OPENCODE_DEFAULT_MODEL;
    let seq = 0;

    const args = [
      "run",
      "--format", "json",
      "--model", model,
      "--dangerously-skip-permissions",
    ];
    if (opts.cwd) args.push("--dir", opts.cwd);
    if (opts.resumeSessionId) args.push("--session", opts.resumeSessionId);
    args.push(opts.task);

    await opts.onProgress?.(
      `🚀 Launching OpenCode\nModel: ${model.split("/").pop()!}`
    );

    const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

    return new Promise<OpenCodeRunResult>((resolve) => {
      const proc = spawn("opencode", args, {
        cwd: opts.cwd ?? process.env.HOME ?? "/tmp",
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const sessionTimer = setTimeout(() => {
        proc.kill("SIGTERM");
        void opts.onProgress?.("⚠️ OpenCode session timed out after 30 minutes — killed.");
      }, SESSION_TIMEOUT_MS);

      this.activeProcesses.set(sessionId, { kill: () => proc.kill("SIGTERM") });

      let buffer = "";
      let finalText = "";
      let opencodeSessionId: string | undefined;
      let stderrOutput = "";
      let exitCode: number | null = null;

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      proc.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmed) as Record<string, unknown>;
          } catch { continue; }

          this.store.logEvent(sessionId, String(event.type ?? "unknown"), event, ++seq);

          // Capture opencode session ID from any event
          if (!opencodeSessionId && typeof event.sessionID === "string") {
            opencodeSessionId = event.sessionID;
          }

          // Accumulate text output
          if (event.type === "text") {
            const part = event.part as { text?: string } | undefined;
            if (part?.text) {
              finalText += part.text;
              void opts.onProgress?.(finalText.slice(-600));
            }
          }

          // Tool usage progress
          if (event.type === "tool_input") {
            const part = event.part as { tool?: string; input?: Record<string, unknown> } | undefined;
            const toolName = part?.tool ?? "tool";
            const inp = part?.input;
            const detail = String(inp?.command ?? inp?.path ?? inp?.description ?? "").slice(0, 120);
            void opts.onProgress?.(`🔧 ${toolName}(${detail})`);
          }

          // Step finish — cost is 0 for free models
          if (event.type === "step_finish") {
            const part = event.part as { cost?: number; tokens?: { total?: number } } | undefined;
            if (part?.cost === 0) {
              void opts.onProgress?.(`✔ Step done (free, ${part.tokens?.total ?? 0} tokens)`);
            }
          }
        }
      });

      proc.on("close", (code) => {
        clearTimeout(sessionTimer);
        exitCode = code;
        this.activeProcesses.delete(sessionId);
        const status = exitCode === 0 ? "completed" : exitCode === null ? "cancelled" : "error";
        resolve({
          sessionId,
          opencodeSessionId,
          finalText: finalText ||
            (exitCode !== 0
              ? `OpenCode exited with code ${exitCode}.\n${stderrOutput.slice(0, 300)}`
              : "(no output)"),
          status,
          errorMessage: exitCode !== 0 ? stderrOutput.slice(0, 300) : undefined,
          eventsLogged: seq,
          name: opts.name,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(sessionTimer);
        this.activeProcesses.delete(sessionId);
        resolve({
          sessionId,
          finalText: "",
          status: "error",
          errorMessage: `Failed to spawn opencode: ${err.message}`,
          eventsLogged: seq,
          name: opts.name,
        });
      });
    });
  }

  cancel(sessionId: string): void {
    this.activeProcesses.get(sessionId)?.kill();
    this.activeProcesses.delete(sessionId);
  }

  cancelAll(): void {
    for (const [id, proc] of this.activeProcesses) {
      proc.kill();
      this.activeProcesses.delete(id);
    }
  }
}

/**
 * Single-turn chat via opencode free model.
 * Used as LM Studio fallback — no session history, stateless.
 * ~2-4 seconds latency (process spawn).
 */
export async function opencodeQuickChat(
  message: string,
  systemPrompt = "You are Pilav, a helpful AI assistant running on a Mac Mini. Be concise and direct.",
  model = OPENCODE_DEFAULT_MODEL,
): Promise<string> {
  const fullPrompt = `${systemPrompt}\n\nUser: ${message}\n\nAssistant:`;

  return new Promise<string>((resolve) => {
    const proc = spawn("opencode", [
      "run", "--format", "json",
      "--model", model,
      "--dangerously-skip-permissions",
      fullPrompt,
    ], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "ignore"],
    });

    let buffer = "";
    let text = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const ev = JSON.parse(line.trim()) as Record<string, unknown>;
          if (ev.type === "text") {
            const part = ev.part as { text?: string } | undefined;
            if (part?.text) text += part.text;
          }
        } catch {}
      }
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve(text.trim() || "(OpenCode timed out)");
    }, 90_000);

    proc.on("close", () => {
      clearTimeout(timer);
      resolve(text.trim() || "(no response from OpenCode)");
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve(`(OpenCode unavailable: ${err.message})`);
    });
  });
}
