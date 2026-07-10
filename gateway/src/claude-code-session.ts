/**
 * ClaudeCodeRunner — spawns `claude` as a subprocess, streams its JSON events,
 * and logs every action to the SQLite trace store.
 *
 * Uses `--print --output-format stream-json` so Claude Code runs headlessly.
 * Permission mode and allowed tools are decided by the PermissionJudge before launch.
 *
 * The JSON event stream becomes our SFT training data:
 * task → pilot decision → tool calls → results → final answer.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ActionStore, PilotDecision } from "./action-store.ts";
import { PermissionJudge } from "./permission-judge.ts";

export interface RunOptions {
  task: string;
  telegramChatId?: number;
  cwd?: string;
  /** User-given name for this session (e.g. "btmotor") */
  name?: string;
  /** Called on each progress update (tool name, partial text, etc.) */
  onProgress?: (text: string) => void | Promise<void>;
  /** Skip the LLM permission judge and use these settings directly */
  overridePilotDecision?: PilotDecision;
  /** Claude Code internal session ID — resumes an existing conversation */
  resumeClaudeSessionId?: string;
}

export interface RunResult {
  sessionId: string;
  finalText: string;
  status: "completed" | "error" | "cancelled";
  errorMessage?: string;
  pilotDecision: PilotDecision;
  eventsLogged: number;
  /** Claude Code's internal session ID — save this for future --resume calls */
  claudeSessionId?: string;
  name?: string;
}

/** Summarise a Claude Code stream-json event into a human-readable progress line. */
function summariseEvent(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "assistant": {
      const msg = event.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } | undefined;
      if (!msg?.content) return null;
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) parts.push(block.text.slice(0, 200));
        if (block.type === "tool_use" && block.name) {
          const inp = block.input as Record<string, unknown> | undefined;
          const detail = inp?.command ?? inp?.path ?? inp?.description ?? "";
          parts.push(`🔧 ${block.name}(${String(detail).slice(0, 120)})`);
        }
      }
      return parts.join("\n") || null;
    }
    case "tool_result": {
      const content = event.content;
      const text = typeof content === "string"
        ? content.slice(0, 300)
        : Array.isArray(content)
          ? (content as Array<{ text?: string }>).map((c) => c.text ?? "").join("").slice(0, 300)
          : "";
      return text ? `✅ Result:\n${text}` : null;
    }
    case "result":
      return `✔ Done${(event as Record<string, unknown>).total_cost_usd ? ` ($${Number((event as Record<string, unknown>).total_cost_usd).toFixed(4)})` : ""}`;
    default:
      return null;
  }
}

export class ClaudeCodeRunner {
  private store: ActionStore;
  private judge: PermissionJudge;
  private activeProcesses = new Map<string, { kill: () => void }>();

  constructor(store: ActionStore, judgeOpts?: { lmStudioUrl?: string; model?: string }) {
    this.store = store;
    this.judge = new PermissionJudge(judgeOpts);
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const sessionId = randomUUID();
    let seq = 0;

    // --- Step 1: Permission pre-flight ---
    let pilotDecision: PilotDecision;
    if (opts.overridePilotDecision) {
      pilotDecision = opts.overridePilotDecision;
    } else {
      await opts.onProgress?.("🔍 Pilav is evaluating the task…");
      pilotDecision = await this.judge.judge(opts.task);
    }

    if (!pilotDecision.safe) {
      return {
        sessionId,
        finalText: "",
        status: "error",
        errorMessage: `Task blocked by safety judge: ${pilotDecision.reasoning}`,
        pilotDecision,
        eventsLogged: 0,
      };
    }

    // --- Step 2: Record session start ---
    this.store.startSession({
      sessionId,
      task: opts.task,
      startedAt: Date.now(),
      telegramChatId: opts.telegramChatId ?? null,
      permissionMode: pilotDecision.permissionMode,
      allowedTools: pilotDecision.allowedTools.length ? pilotDecision.allowedTools : null,
      pilotDecision,
      name: opts.name,
    });

    this.store.logEvent(sessionId, "pilot_decision", pilotDecision, ++seq);

    await opts.onProgress?.(
      `🚀 Launching Claude Code\n` +
      `Mode: ${pilotDecision.permissionMode}\n` +
      `Reason: ${pilotDecision.reasoning}`,
    );

    // --- Step 3: Build claude args ---
    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "claude-sonnet-4-6",
      "--permission-mode", pilotDecision.permissionMode,
    ];

    if (pilotDecision.allowedTools.length > 0) {
      args.push("--allowedTools", pilotDecision.allowedTools.join(","));
    }
    if (opts.resumeClaudeSessionId) {
      args.push("--resume", opts.resumeClaudeSessionId);
    }
    // Note: task is fed via stdin to avoid Commander.js eating it when --allowedTools is variadic

    // --- Step 4: Spawn and stream ---
    const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

    return new Promise<RunResult>((resolve) => {
      const claudeProcess = spawn(CLAUDE_BIN, args, {
        cwd: opts.cwd ?? process.env.HOME ?? "/tmp",
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const sessionTimer = setTimeout(() => {
        claudeProcess.kill("SIGTERM");
        void opts.onProgress?.("⚠️ Session timed out after 30 minutes — killed.");
      }, SESSION_TIMEOUT_MS);

      // Feed task via stdin so --allowedTools flag doesn't consume it as an argument
      claudeProcess.stdin?.write(opts.task);
      claudeProcess.stdin?.end();

      this.activeProcesses.set(sessionId, { kill: () => claudeProcess.kill("SIGTERM") });

      let buffer = "";
      let finalText = "";
      let exitCode: number | null = null;
      let stderrOutput = "";
      let capturedClaudeSessionId: string | undefined;

      claudeProcess.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      claudeProcess.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            // Non-JSON line (rare) — log as raw output
            this.store.logEvent(sessionId, "raw_output", { text: trimmed }, ++seq);
            continue;
          }

          this.store.logEvent(sessionId, String(event.type ?? "unknown"), event, ++seq);

          // Extract final text and Claude's session ID from result event
          if (event.type === "result") {
            finalText = String(event.result ?? "");
            if (typeof event.session_id === "string" && event.session_id) {
              capturedClaudeSessionId = event.session_id;
              this.store.setClaudeSessionId(sessionId, event.session_id);
            }
          }

          // Extract text from assistant events (for streaming display)
          if (event.type === "assistant") {
            const msg = event.message as { content?: Array<{ type: string; text?: string }> } | undefined;
            if (msg?.content) {
              for (const block of msg.content) {
                if (block.type === "text" && block.text) {
                  finalText = block.text;
                }
              }
            }
          }

          // Send progress to Telegram
          const summary = summariseEvent(event);
          if (summary) {
            void opts.onProgress?.(summary);
          }
        }
      });

      claudeProcess.on("close", (code) => {
        clearTimeout(sessionTimer);
        exitCode = code;
        this.activeProcesses.delete(sessionId);

        const status = exitCode === 0 ? "completed" : exitCode === null ? "cancelled" : "error";
        this.store.endSession(sessionId, status);
        this.store.logEvent(sessionId, "session_end", { exitCode, stderrOutput: stderrOutput.slice(0, 2000) }, ++seq);

        resolve({
          sessionId,
          finalText: finalText || (exitCode !== 0 ? `Claude Code exited with code ${exitCode}.\n${stderrOutput.slice(0, 500)}` : "(no output)"),
          status,
          errorMessage: exitCode !== 0 ? stderrOutput.slice(0, 300) : undefined,
          pilotDecision,
          eventsLogged: seq,
          claudeSessionId: capturedClaudeSessionId,
          name: opts.name,
        });
      });

      claudeProcess.on("error", (err) => {
        clearTimeout(sessionTimer);
        this.activeProcesses.delete(sessionId);
        this.store.logEvent(sessionId, "spawn_error", { message: err.message }, ++seq);
        this.store.endSession(sessionId, "error");
        resolve({
          sessionId,
          finalText: "",
          status: "error",
          errorMessage: `Failed to spawn claude: ${err.message}`,
          pilotDecision,
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
