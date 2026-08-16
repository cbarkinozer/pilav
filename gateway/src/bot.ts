import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import TelegramBot from "node-telegram-bot-api";
import type { UserQueue } from "./queue.ts";
import type { SessionRouter } from "./router.ts";
import { LMStudioChat } from "./lm-chat.ts";
import { spawn } from "node:child_process";
import type { ActionStore } from "./action-store.ts";
import { ClaudeCodeRunner } from "./claude-code-session.ts";
import { OpenCodeRunner, opencodeQuickChat, OPENCODE_DEFAULT_MODEL, OPENCODE_FREE_MODELS } from "./opencode-runner.ts";
import { IntentClassifier } from "./intent-classifier.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { savePendingResumes, type PendingResume } from "./pending-resumes.ts";

/**
 * Convert CommonMark-style markdown (from LLMs) to Telegram Markdown.
 * Telegram Markdown uses *bold* and _italic_, not **bold** / __italic__.
 * Falls back gracefully: returns original text if conversion would break.
 */
export function toTelegramMarkdown(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, "*$1*")       // ***bold italic*** → *bold italic*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")             // **bold** → *bold*
    .replace(/__(.+?)__/g, "_$1_")                 // __italic__ → _italic_
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")          // # Heading → *Heading*
    .replace(/^[-*]\s/gm, "• ")                    // - list / * list → bullet
    .replace(/^\d+\.\s/gm, (m) => m);              // numbered lists: keep as-is
}

// One LMStudioChat instance per chat ID for conversation history
const chatSessions = new Map<number, LMStudioChat>();

function getChatSession(chatId: number): LMStudioChat {
  let session = chatSessions.get(chatId);
  if (!session) {
    session = new LMStudioChat(chatId);
    chatSessions.set(chatId, session);
  }
  return session;
}

export interface HandlerDeps {
  router: Pick<SessionRouter, "getOrCreate" | "getIfExists">;
  queue: Pick<UserQueue, "enqueue">;
  sendReply: (chatId: number, text: string) => Promise<void>;
  sendTyping?: (chatId: number) => Promise<void>;
  /** Send an initial message and return its message_id (for later editing). */
  sendStreamingMessage?: (chatId: number, text: string) => Promise<number>;
  /** Edit a previously sent message in-place with new text. */
  editMessage?: (chatId: number, messageId: number, text: string) => Promise<void>;
  allowedUsers: number[];
  bot?: TelegramBot;
  /** Override the LM Studio chat function for testing. Receives (chatId, text). */
  lmChatFn?: (chatId: number, text: string) => Promise<string>;
  /** SQLite action store for Claude Code session traces. */
  actionStore?: ActionStore;
  /** Working directory for Claude Code code_dev sessions. */
  defaultProjectDir?: string;
}

type TgMessage = {
  chat: { id: number };
  from?: { id: number };
  text?: string;
  message_id: number;
  document?: { file_id: string; file_name?: string };
  photo?: Array<{ file_id: string }>;
};

const TELEGRAM_MAX_LENGTH = 4096;

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_LENGTH) {
    chunks.push(text.slice(i, i + TELEGRAM_MAX_LENGTH));
  }
  return chunks.length > 0 ? chunks : [""];
}

function isAllowed(userId: number, allowedUsers: number[]): boolean {
  if (allowedUsers.length === 0) return true;
  return allowedUsers.includes(userId);
}

const TYPING_INTERVAL_MS = 4000;

// One runner per process — shared across all sessions
let _claudeRunner: ClaudeCodeRunner | null = null;
let _openCodeRunner: OpenCodeRunner | null = null;
let _classifier: IntentClassifier | null = null;
let _projectRegistry: ProjectRegistry | null = null;

// Cached OpenCode CLI version (checked once at startup)
let _openCodeVersion: string | null = null;

interface ActiveSession {
  sessionId: string;   // our internal UUID
  chatId: number;
  startedAt: number;
  task: string;
  cwd: string | undefined;
  claudeSessionId?: string;  // filled in when Claude emits its session_id
}
// Named sessions: name → ActiveSession. "_auto" is used for auto-routed / /claude sessions.
const _activeSessions = new Map<string, ActiveSession>();

interface PendingFix {
  chatId: number;
  diagnosisText: string;
  expiresAt: number;
}
let _pendingFix: PendingFix | null = null;

interface ResumeChoice {
  claudeSessionId: string | null;
  task: string;
  status: string;
  name: string | null;
  startedAt: number;
}
// Two-step resume: after /sessions, store the shown list so numbers stay stable
const _pendingResume = new Map<number, ResumeChoice[]>();   // chatId → choices
const _pendingResumeExpiry = new Map<number, number>();      // chatId → expiry ms

export function createHandlers(deps: HandlerDeps) {
  const { router, queue, sendReply, allowedUsers } = deps;

  if (deps.actionStore && !_claudeRunner) {
    _claudeRunner = new ClaudeCodeRunner(deps.actionStore);
  }
  if (deps.actionStore && !_openCodeRunner) {
    _openCodeRunner = new OpenCodeRunner(deps.actionStore);
    // Cache OpenCode CLI version at startup
    if (_openCodeVersion === null) {
      const proc = spawn("opencode", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      proc.on("close", () => { _openCodeVersion = out.trim() || null; });
      proc.on("error", () => { _openCodeVersion = null; });
    }
  }
  if (!_classifier) {
    _classifier = new IntentClassifier();
  }
  if (!_projectRegistry) {
    _projectRegistry = new ProjectRegistry();
  }

  const sendTyping = deps.sendTyping ?? ((chatId: number) =>
    deps.bot ? deps.bot.sendChatAction(chatId, "typing").then(() => {}) : Promise.resolve()
  );

  async function replyChunked(chatId: number, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await sendReply(chatId, chunk);
    }
  }

  function startTypingInterval(chatId: number): ReturnType<typeof setInterval> {
    return setInterval(() => { void sendTyping(chatId); }, TYPING_INTERVAL_MS);
  }

  async function onMessage(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized to use this bot.");
      return;
    }

    const text = msg.text ?? "";
    if (!text) return;

    // /pilav <task> — explicit Pi override (skip classifier)
    const isPiCommand = text.startsWith("/pilav ");
    // Drop other slash commands (they have their own handlers)
    if (text.startsWith("/") && !isPiCommand) return;

    // ---- Natural language self-fix detection ----
    const SELF_FIX_PHRASES = ["fix yourself", "fix pilav", "fix the bot", "update yourself", "patch yourself", "fix the gateway"];
    if (SELF_FIX_PHRASES.some((p) => text.toLowerCase().includes(p))) {
      await onFixSelf(msg, text);
      return;
    }

    // ---- Pending fix approval (YES/NO after auto-diagnosis) ----
    if (_pendingFix && _pendingFix.chatId === chatId && Date.now() < _pendingFix.expiresAt) {
      const lower = text.trim().toLowerCase();
      if (lower === "yes" || lower === "y" || lower === "fix it" || lower === "yes fix it") {
        const fix = _pendingFix;
        _pendingFix = null;
        await onApplyFix(chatId, userId, fix.diagnosisText);
        return;
      }
      if (lower === "no" || lower === "n" || lower === "skip") {
        _pendingFix = null;
        await sendReply(chatId, "OK, skipping auto-fix. Use /fix-yourself if you change your mind.");
        return;
      }
    }
    // Clear expired pending fix
    if (_pendingFix && Date.now() >= _pendingFix.expiresAt) _pendingFix = null;

    // ---- Two-step resume: if user sent a number after /sessions ----
    const pendingChoices = _pendingResume.get(chatId);
    if (pendingChoices && /^\d+(\s.*)?$/.test(text.trim())) {
      const parts = text.trim().split(/\s+/);
      const idx = parseInt(parts[0]) - 1;
      if (idx >= 0 && idx < pendingChoices.length) {
        const expiry = _pendingResumeExpiry.get(chatId) ?? 0;
        if (Date.now() < expiry) {
          _pendingResume.delete(chatId);
          _pendingResumeExpiry.delete(chatId);
          const instruction = parts.slice(1).join(" ") || "Continue from where you left off.";
          await doResume(chatId, userId, pendingChoices[idx], instruction);
          return;
        }
      }
    }
    // Clear expired pending resume state
    if (pendingChoices && Date.now() >= (_pendingResumeExpiry.get(chatId) ?? 0)) {
      _pendingResume.delete(chatId);
      _pendingResumeExpiry.delete(chatId);
    }

    void sendTyping(chatId);
    await queue.enqueue(userId, async () => {
      const typingTimer = startTypingInterval(chatId);
      try {
        // ---- Explicit /pilav override → Pi agent ----
        if (isPiCommand) {
          const task = text.slice(7).trim();
          await routeToPi(chatId, task);
          return;
        }

        // ---- Auto-routing via intent classifier ----
        const intent = await _classifier!.classify(text);
        console.log(`[pilav] chat=${chatId} intent=${intent} msg="${text.slice(0, 60)}"`);

        if (intent === "code_dev") {
          if (_activeSessions.has("_auto")) {
            await sendReply(chatId, "A session is already running. Use /cancel to stop it, or /work <name> <task> to start a parallel named session.");
            return;
          }
          if (_claudeRunner) {
            runClaudeSession({ name: "_auto", task: text, chatId, userId, cwd: deps.defaultProjectDir });
          } else if (_openCodeRunner) {
            await sendReply(chatId, "Claude Code unavailable — using OpenCode free model instead.");
            runOpenCodeSession({ name: "_auto", task: text, chatId, cwd: deps.defaultProjectDir });
          } else {
            await sendReply(chatId, "No coding agent available (Claude Code and OpenCode both unavailable).");
          }
          return;
        }

        if (intent === "local_action") {
          await routeToPi(chatId, text);
          return;
        }

        await routeToLMStudio(chatId, text);
      } finally {
        clearInterval(typingTimer);
      }
    });
  }

  /** Shared logic for launching a Claude Code session and streaming results to Telegram.
   *  Runs fully in background — does NOT block the message queue. */
  function runClaudeSession(opts: {
    name: string;
    task: string;
    chatId: number;
    userId: number;
    cwd?: string;
    resumeClaudeSessionId?: string;
  }): void {
    const { name, task, chatId, cwd } = opts;
    const startedAt = Date.now();

    _activeSessions.set(name, { sessionId: "", chatId, startedAt, task, cwd });

    const PROGRESS_MIN_MS = 3000;
    const HEARTBEAT_MS = 2 * 60 * 1000; // send "still working" if silent for 2 min

    let lastSent = "";
    let lastSentTime = 0;
    let lastActivityTime = Date.now();

    const prefix = (): string => _activeSessions.size > 1 ? `[${name}] ` : "";

    const sendProgress = async (progressText: string) => {
      const now = Date.now();
      const truncated = (prefix() + progressText).slice(0, 3800);
      if (truncated === lastSent || now - lastSentTime < PROGRESS_MIN_MS) return;
      lastSent = truncated;
      lastSentTime = now;
      lastActivityTime = now;
      await sendReply(chatId, truncated);
    };

    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivityTime >= HEARTBEAT_MS) {
        const elapsed = Math.round((Date.now() - startedAt) / 60000);
        lastActivityTime = Date.now();
        void sendReply(chatId, `${prefix()}⏳ Still working… (${elapsed}m elapsed)`);
      }
    }, 60_000); // check every minute, fire when 2+ min silent

    void (async () => {
      try {
        const result = await _claudeRunner!.run({
          task,
          name,
          telegramChatId: chatId,
          cwd,
          onProgress: sendProgress,
          resumeClaudeSessionId: opts.resumeClaudeSessionId,
        });

        const isSessionLimit = result.status === "error" &&
          result.errorMessage?.toLowerCase().includes("session limit");

        if (isSessionLimit && _openCodeRunner) {
          _activeSessions.delete(name);
          clearInterval(heartbeat);
          await sendReply(chatId, `${prefix()}Claude Code session limit hit — falling back to OpenCode free model...`);
          runOpenCodeSession({ name, task, chatId, cwd });
          return;
        }

        // Store claudeSessionId so /fix-yourself can save it for resume after restart
        if (result.claudeSessionId) {
          const s = _activeSessions.get(name);
          if (s) _activeSessions.set(name, { ...s, claudeSessionId: result.claudeSessionId });
        }

        _activeSessions.delete(name);
        clearInterval(heartbeat);

        const elapsed = Math.round((Date.now() - startedAt) / 60000);
        const timeStr = elapsed > 0 ? ` in ${elapsed}m` : "";
        const statusLine = result.status === "completed"
          ? `${prefix()}✅ Done${timeStr} (${result.eventsLogged} events, id: ${result.claudeSessionId?.slice(0, 8) ?? result.sessionId.slice(0, 8)})`
          : `${prefix()}❌ ${result.status}${timeStr}: ${result.errorMessage?.slice(0, 150) ?? ""}`;
        await sendReply(chatId, statusLine);

        if (result.finalText) {
          for (const chunk of splitMessage(prefix() + result.finalText)) {
            await sendReply(chatId, chunk);
          }
        }
      } catch (err) {
        _activeSessions.delete(name);
        clearInterval(heartbeat);
        const msg = (err as Error).message.toLowerCase();
        if (msg.includes("session limit") && _openCodeRunner) {
          await sendReply(chatId, `${prefix()}Claude Code session limit hit — falling back to OpenCode free model...`);
          runOpenCodeSession({ name, task, chatId, cwd });
        } else {
          await sendReply(chatId, `${prefix()}Claude Code error: ${(err as Error).message.slice(0, 300)}`);
        }
      }
    })();
  }

  function runOpenCodeSession(opts: {
    name: string;
    task: string;
    chatId: number;
    model?: string;
    cwd?: string;
    resumeSessionId?: string;
  }): void {
    const { name, task, chatId, cwd } = opts;
    const startedAt = Date.now();

    _activeSessions.set(name, { sessionId: "", chatId, startedAt, task, cwd });

    const PROGRESS_MIN_MS = 3000;
    const HEARTBEAT_MS = 2 * 60 * 1000;
    let lastSent = "";
    let lastSentTime = 0;
    let lastActivityTime = Date.now();

    const prefix = (): string => _activeSessions.size > 1 ? `[${name}] ` : "";

    const sendProgress = async (progressText: string) => {
      const now = Date.now();
      const truncated = (prefix() + progressText).slice(0, 3800);
      if (truncated === lastSent || now - lastSentTime < PROGRESS_MIN_MS) return;
      lastSent = truncated;
      lastSentTime = now;
      lastActivityTime = now;
      await sendReply(chatId, truncated);
    };

    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivityTime >= HEARTBEAT_MS) {
        const elapsed = Math.round((Date.now() - startedAt) / 60000);
        lastActivityTime = Date.now();
        void sendReply(chatId, `${prefix()}⏳ Still working… (${elapsed}m elapsed)`);
      }
    }, 60_000);

    void (async () => {
      try {
        const result = await _openCodeRunner!.run({
          task,
          name,
          model: opts.model,
          telegramChatId: chatId,
          cwd,
          onProgress: sendProgress,
          resumeSessionId: opts.resumeSessionId,
        });

        _activeSessions.delete(name);
        clearInterval(heartbeat);

        const elapsed = Math.round((Date.now() - startedAt) / 60000);
        const timeStr = elapsed > 0 ? ` in ${elapsed}m` : "";
        const modelLabel = (opts.model ?? OPENCODE_DEFAULT_MODEL).split("/").pop()!;
        const statusLine = result.status === "completed"
          ? `${prefix()}✅ Done${timeStr} (${modelLabel}, ${result.eventsLogged} events, id: ${result.opencodeSessionId?.slice(0, 12) ?? result.sessionId.slice(0, 8)})`
          : `${prefix()}❌ ${result.status}${timeStr}: ${result.errorMessage?.slice(0, 150) ?? ""}`;
        await sendReply(chatId, statusLine);

        if (result.finalText) {
          for (const chunk of splitMessage(prefix() + result.finalText)) {
            await sendReply(chatId, chunk);
          }
        }
      } catch (err) {
        _activeSessions.delete(name);
        clearInterval(heartbeat);
        await sendReply(chatId, `${prefix()}OpenCode error: ${(err as Error).message.slice(0, 300)}`);
      }
    })();
  }

  async function doResume(chatId: number, userId: number, choice: ResumeChoice, instruction: string): Promise<void> {
    if (!_claudeRunner) {
      await sendReply(chatId, "Claude Code runner not available.");
      return;
    }
    if (!choice.claudeSessionId) {
      await sendReply(chatId, "That session has no recorded Claude session ID — it may have been started before resume tracking was added. Start a new session instead.");
      return;
    }
    const name = choice.name ?? "resumed";
    if (_activeSessions.has(name)) {
      await sendReply(chatId, `Session "${name}" is already running. Use a different name or /cancel ${name} first.`);
      return;
    }
    const label = choice.name ?? choice.task.slice(0, 30);
    await sendReply(chatId, `▶️ Resuming session "${label}"…`);
    runClaudeSession({
      name,
      task: instruction,
      chatId,
      userId,
      resumeClaudeSessionId: choice.claudeSessionId!,
      cwd: _projectRegistry?.get(name) ?? deps.defaultProjectDir,
    });
  }

  async function routeToPi(chatId: number, task: string): Promise<void> {
    console.log(`[pilav] chat=${chatId} route=Pi task="${task.slice(0, 80)}"`);
    try {
      const session = await router.getOrCreate(chatId);
      // Always send the final response as a new message — no edit-in-place
      const response = await session.sendMessage(task);
      await replyChunked(chatId, response || "(no response)");
    } catch (err) {
      console.error("[pilav] Pi session error:", (err as Error).message);
      await sendReply(chatId, `Pi agent error: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  async function routeToLMStudio(chatId: number, text: string): Promise<void> {
    console.log(`[pilav] chat=${chatId} route=LMStudio msg="${text.slice(0, 60)}"`);
    try {
      if (deps.lmChatFn) {
        const response = await deps.lmChatFn(chatId, text);
        await replyChunked(chatId, response || "I didn't get a response from the model. Try rephrasing.");
        return;
      }
      const response = await getChatSession(chatId).chat(text);
      await replyChunked(chatId, response || "I didn't get a response. Try rephrasing.");
    } catch (err) {
      // LM Studio is down — fall back to OpenCode free model
      console.warn("[pilav] LM Studio unavailable, falling back to OpenCode:", (err as Error).message);
      try {
        await sendReply(chatId, "⚡ LM Studio offline — using OpenCode free model…");
        const response = await opencodeQuickChat(text);
        await replyChunked(chatId, response);
      } catch (fallbackErr) {
        await sendReply(chatId, `Both LM Studio and OpenCode are unavailable. Error: ${(fallbackErr as Error).message.slice(0, 150)}`);
      }
    }
  }

  async function onStart(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    await sendReply(chatId,
      "Hello! I'm Pilav — your always-on AI assistant.\n\n" +
      "Just talk to me naturally:\n\n" +
      "  • Ask anything → I answer (weather, facts, questions)\n" +
      "  • 'Write this to my local' → Pi writes the file\n" +
      "  • 'Continue the project' → Claude Code takes over\n\n" +
      "Claude Code commands:\n" +
      "  /claude <task> — run Claude Code (Sonnet 4.6)\n" +
      "  /opencode <task> — run OpenCode free model (DeepSeek/Nemotron/MiMo)\n" +
      "  /opencode models — list available free models\n" +
      "  /work <name> <task> — named parallel session\n" +
      "  /sessions — list sessions + resume menu\n" +
      "  /resume [n] [instruction] — resume a past session\n" +
      "  /cancel [name] — stop a running session\n\n" +
      "Project registry:\n" +
      "  /addproject <name> <path> — register a project dir\n\n" +
      "Chat memory:\n" +
      "  /compact — summarize long history (like Claude Code /compact)\n" +
      "  /clear — wipe history, start fresh\n\n" +
      "Other:\n" +
      "  /ping — health check (gateway + LM Studio + active sessions)\n" +
      "  /pilav <task> — force Pi agent\n" +
      "  /status — active session info",
    );
  }

  async function onStatus(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    const session = router.getIfExists(chatId);
    if (!session) {
      await sendReply(chatId, "Pi: no active session\nChat goes to LM Studio. Use /pilav <task> to invoke Pi agent.");
      return;
    }

    try {
      const status = await session.getStatus();
      const modelStr = status.model ? `${status.model.provider}/${status.model.id}` : "unknown";
      const streamingStr = status.isStreaming ? "streaming" : "idle";
      await sendReply(chatId, `Pi: ${streamingStr}\nModel: ${modelStr}\nSession: ${status.sessionId}`);
    } catch (err) {
      await sendReply(chatId, `Pi: error getting status — ${(err as Error).message.slice(0, 100)}`);
    }
  }

  async function onCancel(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    const text = msg.text ?? "";
    const nameArg = text.replace(/^\/cancel\s*/i, "").trim().toLowerCase() || null;

    if (_claudeRunner && _activeSessions.size > 0) {
      if (nameArg) {
        // Cancel a specific named session
        const session = _activeSessions.get(nameArg);
        if (session) {
          _claudeRunner.cancel(session.sessionId);
          _activeSessions.delete(nameArg);
          await sendReply(chatId, `Cancelled session "${nameArg}".`);
          return;
        }
        await sendReply(chatId, `No active session named "${nameArg}". Active: ${[..._activeSessions.keys()].join(", ") || "none"}`);
        return;
      }
      // Cancel the default session if only one is running
      if (_activeSessions.has("_auto")) {
        const s = _activeSessions.get("_auto")!;
        _claudeRunner.cancel(s.sessionId);
        _activeSessions.delete("_auto");
        await sendReply(chatId, "Cancelled Claude Code session.");
        return;
      }
      // Multiple named sessions — ask which one
      const names = [..._activeSessions.keys()].join(", ");
      await sendReply(chatId, `Multiple sessions running: ${names}\nUse /cancel <name> to stop one.`);
      return;
    }

    const session = await router.getOrCreate(chatId);
    await session.cancel();
    await sendReply(chatId, "Cancelled current operation.");
  }

  async function onClaudeCommand(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    const text = msg.text ?? "";
    const task = text.replace(/^\/claude\s*/i, "").trim();

    if (!task) {
      await sendReply(chatId, "Usage: /claude <task>\n\nExample: /claude list all files in the project");
      return;
    }

    if (_activeSessions.has("_auto")) {
      await sendReply(chatId, "A Claude Code session is already running. Use /cancel to stop it, or /work <name> <task> to start a parallel named session.");
      return;
    }

    if (!_claudeRunner) {
      await sendReply(chatId, "Claude Code runner not available (no action store configured).");
      return;
    }

    runClaudeSession({ name: "_auto", task, chatId, userId, cwd: deps.defaultProjectDir });
  }

  async function onWork(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    if (!_claudeRunner) {
      await sendReply(chatId, "Claude Code runner not available.");
      return;
    }

    const text = msg.text ?? "";
    const body = text.replace(/^\/work\s*/i, "").trim();
    const spaceIdx = body.indexOf(" ");

    if (spaceIdx === -1) {
      await sendReply(chatId,
        "Usage: /work <name> <task>\n\n" +
        "Example: /work btmotor implement the product listing page\n\n" +
        "Registered projects: " + (_projectRegistry!.list().map((p) => p.name).join(", ") || "none") + "\n" +
        "Add one: /addproject btmotor /Users/cbarkinozer/Documents/GitHub/btmotor",
      );
      return;
    }

    const name = body.slice(0, spaceIdx).toLowerCase();
    const task = body.slice(spaceIdx + 1).trim();

    if (_activeSessions.has(name)) {
      await sendReply(chatId, `Session "${name}" is already running. Use /cancel ${name} to stop it first.`);
      return;
    }

    const cwd = _projectRegistry!.get(name) ?? deps.defaultProjectDir;
    const cwdNote = _projectRegistry!.get(name) ? ` (${cwd})` : " (default project dir — use /addproject to register)";
    await sendReply(chatId, `Starting session "${name}"${cwdNote}…`);

    runClaudeSession({ name, task, chatId, userId, cwd });
  }

  async function onSessions(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    const lines: string[] = [];

    // Active sessions
    if (_activeSessions.size > 0) {
      lines.push("*Running now:*");
      for (const [name, s] of _activeSessions) {
        const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
        const label = name === "_auto" ? "session" : name;
        lines.push(`• ${label} — ${elapsed}s running — /cancel ${name === "_auto" ? "" : name}`);
      }
      lines.push("");
    }

    // Recent sessions from DB
    const recent = deps.actionStore?.recentSessions(8) ?? [];
    const resumable = recent.filter((s) => s.status !== "running");

    if (resumable.length === 0) {
      lines.push("No past sessions to resume.");
    } else {
      lines.push("*Recent sessions (send number to resume):*");
      const choices: ResumeChoice[] = [];
      resumable.forEach((s, i) => {
        const age = formatAge(s.startedAt);
        const label = s.name ?? "session";
        const canResume = s.claudeSessionId ? "" : " (no resume ID)";
        lines.push(`${i + 1}. [${s.status}] ${label} — "${s.task.slice(0, 50)}" (${age})${canResume}`);
        choices.push({ claudeSessionId: s.claudeSessionId, task: s.task, status: s.status, name: s.name, startedAt: s.startedAt });
      });
      _pendingResume.set(chatId, choices);
      _pendingResumeExpiry.set(chatId, Date.now() + 2 * 60 * 1000); // 2 min to pick
      lines.push("\nReply with a number to resume, or /resume <n> [instruction].");
    }

    await replyChunked(chatId, lines.join("\n"));
  }

  async function onResume(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    const text = msg.text ?? "";
    const body = text.replace(/^\/resume\s*/i, "").trim();

    if (!body) {
      // No argument → show sessions list (same as /sessions)
      await onSessions(msg);
      return;
    }

    const parts = body.split(/\s+/);
    const n = parseInt(parts[0]);
    const instruction = parts.slice(1).join(" ") || "Continue from where you left off.";

    // If pending choices exist, use them; otherwise fetch fresh
    let choices = _pendingResume.get(chatId);
    const expired = Date.now() >= (_pendingResumeExpiry.get(chatId) ?? 0);
    if (!choices || expired) {
      const recent = deps.actionStore?.recentSessions(8) ?? [];
      choices = recent.filter((s) => s.status !== "running").map((s) => ({
        claudeSessionId: s.claudeSessionId,
        task: s.task,
        status: s.status,
        name: s.name,
        startedAt: s.startedAt,
      }));
    }

    if (isNaN(n) || n < 1 || n > choices.length) {
      await sendReply(chatId, `Please give a number between 1 and ${choices.length}. Use /sessions to see the list.`);
      return;
    }

    _pendingResume.delete(chatId);
    _pendingResumeExpiry.delete(chatId);
    await doResume(chatId, userId, choices[n - 1], instruction);
  }

  async function onAddProject(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    const text = msg.text ?? "";
    const body = text.replace(/^\/addproject\s*/i, "").trim();
    const spaceIdx = body.indexOf(" ");

    if (spaceIdx === -1) {
      const list = _projectRegistry!.list();
      const listStr = list.length
        ? list.map((p) => `• ${p.name}: ${p.path}`).join("\n")
        : "None registered yet.";
      await sendReply(chatId, `Usage: /addproject <name> <path>\n\nRegistered projects:\n${listStr}`);
      return;
    }

    const name = body.slice(0, spaceIdx).toLowerCase();
    const path = body.slice(spaceIdx + 1).trim();
    _projectRegistry!.set(name, path);
    await sendReply(chatId, `Registered project "${name}" → ${path}\n\nNow use: /work ${name} <task>`);
  }

  async function onDocument(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    void sendTyping(chatId);

    if (!msg.document || !deps.bot) {
      await sendReply(chatId, "File received (no bot instance to download).");
      return;
    }

    try {
      const fileInfo = await deps.bot.getFile(msg.document.file_id);
      const filePath = await downloadFile(deps.bot, fileInfo.file_path!, msg.document.file_name ?? "upload");
      const prompt = `[File uploaded: ${filePath}]\nPlease analyze or use this file as needed.`;

      await queue.enqueue(userId, async () => {
        const typingTimer = startTypingInterval(chatId);
        try {
          const session = await router.getOrCreate(chatId);
          const response = await session.sendMessage(prompt);
          await replyChunked(chatId, response || "(no response)");
        } finally {
          clearInterval(typingTimer);
        }
      });
    } catch (err) {
      await sendReply(chatId, `Failed to download file: ${(err as Error).message}`);
    }
  }

  async function onPhoto(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    void sendTyping(chatId);

    if (!msg.photo || msg.photo.length === 0 || !deps.bot) {
      await sendReply(chatId, "Photo received (no bot instance to download).");
      return;
    }

    try {
      const largest = msg.photo[msg.photo.length - 1];
      const fileInfo = await deps.bot.getFile(largest.file_id);
      const filePath = await downloadFile(deps.bot, fileInfo.file_path!, "photo.jpg");
      const prompt = `[Photo uploaded: ${filePath}]\nPlease describe or analyze this image.`;

      await queue.enqueue(userId, async () => {
        const typingTimer = startTypingInterval(chatId);
        try {
          const session = await router.getOrCreate(chatId);
          const response = await session.sendMessage(prompt);
          await replyChunked(chatId, response || "(no response)");
        } finally {
          clearInterval(typingTimer);
        }
      });
    } catch (err) {
      await sendReply(chatId, `Failed to download photo: ${(err as Error).message}`);
    }
  }

  async function onFixSelf(msg: TgMessage, description?: string): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    if (!isAllowed(userId, allowedUsers)) return;

    if (!_claudeRunner) {
      await sendReply(chatId, "Claude Code runner not available.");
      return;
    }

    const fixDesc = description?.trim() || "Fix any bugs or issues you find in the Pilav gateway code.";

    // 1. Save all active sessions to disk so we can resume after restart
    const toSave: PendingResume[] = [];
    for (const [name, s] of _activeSessions) {
      if (name === "_fix_self") continue; // don't save the fix session itself
      toSave.push({
        name,
        task: s.task,
        chatId: s.chatId,
        cwd: s.cwd ?? null,
        claudeSessionId: s.claudeSessionId ?? null,
        savedAt: Date.now(),
      });
    }

    if (toSave.length > 0) {
      savePendingResumes(toSave);
      const names = toSave.map((s) => `"${s.name}"`).join(", ");
      await sendReply(chatId, `Pausing ${names} and saving for resume after restart…`);
      // Cancel all active sessions
      for (const [name, s] of _activeSessions) {
        if (name !== "_fix_self") {
          _claudeRunner.cancel(s.sessionId);
          _activeSessions.delete(name);
        }
      }
    }

    await sendReply(chatId, `🔧 Starting self-fix: "${fixDesc.slice(0, 100)}"\n\nWill restart automatically when done.`);

    // 2. Run Claude Code on the gateway codebase
    const gatewayDir = process.cwd(); // launchd sets WorkingDirectory to gateway/
    runClaudeSession({
      name: "_fix_self",
      task: `You are fixing the Pilav Telegram gateway (this codebase).

Issue to fix: ${fixDesc}

After applying your fix:
1. Run: npx tsc --noEmit to verify no TypeScript errors
2. Do NOT restart the gateway — the calling process will handle that

Work in: ${gatewayDir}`,
      chatId,
      userId,
      cwd: gatewayDir,
    });

    // 3. Wait for the fix session to complete, then restart
    const pollRestart = setInterval(async () => {
      if (!_activeSessions.has("_fix_self")) {
        clearInterval(pollRestart);
        await sendReply(chatId, "Fix applied. Restarting Pilav in 3 seconds…");
        setTimeout(() => {
          // launchd KeepAlive will bring us back automatically
          spawn("launchctl", ["stop", "com.pilav.gateway"], { detached: true, stdio: "ignore" }).unref();
        }, 3000);
      }
    }, 5000);
  }

  async function onOpenCode(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    if (!isAllowed(userId, allowedUsers)) return;

    if (!_openCodeRunner) {
      await sendReply(chatId, "OpenCode runner not available.");
      return;
    }

    const text = msg.text ?? "";
    const body = text.replace(/^\/opencode\s*/i, "").trim();

    // /opencode models — list available free models
    if (body === "models" || body === "--models") {
      await sendReply(chatId,
        "Free OpenCode models:\n" +
        OPENCODE_FREE_MODELS.map((m, i) => `${i + 1}. ${m.split("/").pop()} → ${m}`).join("\n") +
        `\n\nDefault: ${OPENCODE_DEFAULT_MODEL.split("/").pop()}\n\n` +
        "Usage: /opencode -m nemotron-3-ultra-free <task>\n" +
        "Or: /opencode <task>  (uses default)"
      );
      return;
    }

    if (!body) {
      await sendReply(chatId,
        "Usage: /opencode <task>\n\n" +
        "Optional model: /opencode -m deepseek-v4-flash-free <task>\n\n" +
        "Use /opencode models to see all free models."
      );
      return;
    }

    // Parse optional -m <model> flag
    let model = OPENCODE_DEFAULT_MODEL;
    let task = body;
    const mFlag = body.match(/^-m\s+(\S+)\s+([\s\S]+)$/);
    if (mFlag) {
      const modelShort = mFlag[1];
      task = mFlag[2];
      // Accept short name (e.g. "nemotron-3-ultra-free") or full name
      const found = OPENCODE_FREE_MODELS.find(
        (m) => m === modelShort || m.endsWith(`/${modelShort}`)
      );
      model = found ?? `opencode/${modelShort}`;
    }

    const name = `oc-${Date.now().toString(36)}`;
    if (_activeSessions.has(name)) {
      await sendReply(chatId, "Session name conflict — try again.");
      return;
    }

    const cwd = deps.defaultProjectDir;
    await sendReply(chatId, `Starting OpenCode session with ${model.split("/").pop()}…`);
    runOpenCodeSession({ name, task, chatId, model, cwd });
  }

  async function onSelfDiagnose(chatId: number): Promise<void> {
    if (!_claudeRunner) {
      await sendReply(chatId, "⚠️ Claude Code runner not available — cannot auto-diagnose.");
      return;
    }

    const logPath = join(homedir(), "Library", "Logs", "pilav-gateway.log");
    let logSnippet = "(log unavailable)";
    try {
      const content = readFileSync(logPath, "utf-8");
      logSnippet = content.split("\n").slice(-100).join("\n");
    } catch {}

    const gatewayDir = process.cwd();

    let diagnosisText = "Could not determine cause from logs.";
    try {
      const result = await _claudeRunner.run({
        task:
          `You are diagnosing a crash loop in the Pilav Telegram gateway TypeScript codebase at ${gatewayDir}.\n\n` +
          `Recent log output (last 100 lines):\n\`\`\`\n${logSnippet}\n\`\`\`\n\n` +
          `Read the source files to understand the code. Do NOT edit anything.\n` +
          `Respond with EXACTLY this format (no extra text):\n` +
          `DIAGNOSIS: <one sentence — root cause>\n` +
          `FIX: <one sentence — exact change needed, including file and line if possible>`,
        name: "_diagnose",
        telegramChatId: chatId,
        cwd: gatewayDir,
        onProgress: async (text) => { console.log("[diagnose]", text.slice(0, 120)); },
        overridePilotDecision: {
          safe: true,
          reasoning: "Read-only crash diagnosis",
          allowedTools: ["Read", "Grep", "Glob"],
          permissionMode: "default",
        },
      });
      if (result.finalText) diagnosisText = result.finalText.trim();
    } catch (err) {
      console.error("[pilav] self-diagnose error:", (err as Error).message);
    }

    // Store pending fix with 2-hour TTL
    _pendingFix = { chatId, diagnosisText, expiresAt: Date.now() + 2 * 60 * 60 * 1000 };

    await replyChunked(chatId,
      `🔴 *Auto-diagnosis result:*\n\n${diagnosisText}\n\n` +
      `Reply *YES* to apply the fix, *NO* to skip. (Expires in 2h)`
    );
  }

  async function onApplyFix(chatId: number, userId: number, diagnosisText: string): Promise<void> {
    if (!_claudeRunner) {
      await sendReply(chatId, "Claude Code runner not available.");
      return;
    }

    // Save any active sessions before the restart
    const toSave: PendingResume[] = [];
    for (const [name, s] of _activeSessions) {
      if (name !== "_fix_self" && name !== "_diagnose") {
        toSave.push({ name, task: s.task, chatId: s.chatId, cwd: s.cwd ?? null, claudeSessionId: s.claudeSessionId ?? null, savedAt: Date.now() });
      }
    }
    if (toSave.length > 0) {
      savePendingResumes(toSave);
      const names = toSave.map((s) => `"${s.name}"`).join(", ");
      await sendReply(chatId, `Pausing ${names} for resume after restart…`);
      for (const [name, s] of _activeSessions) {
        if (name !== "_fix_self" && name !== "_diagnose") {
          _claudeRunner.cancel(s.sessionId);
          _activeSessions.delete(name);
        }
      }
    }

    await sendReply(chatId, `🔧 Applying fix…`);
    const gatewayDir = process.cwd();

    runClaudeSession({
      name: "_fix_self",
      task:
        `Apply this fix to the Pilav gateway at ${gatewayDir}:\n\n${diagnosisText}\n\n` +
        `After applying:\n1. Run npx tsc --noEmit to verify no TypeScript errors\n2. Do NOT restart — the calling process will handle that.`,
      chatId,
      userId,
      cwd: gatewayDir,
    });

    const pollRestart = setInterval(async () => {
      if (!_activeSessions.has("_fix_self")) {
        clearInterval(pollRestart);
        await sendReply(chatId, "Fix applied. Restarting Pilav in 3 seconds…");
        setTimeout(() => {
          spawn("launchctl", ["stop", "com.pilav.gateway"], { detached: true, stdio: "ignore" }).unref();
        }, 3000);
      }
    }, 5000);
  }

  async function onPing(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    if (!isAllowed(userId, allowedUsers)) return;

    // LM Studio status + loaded models
    let lmStatus = "❌ down";
    let lmModels = "";
    try {
      const r = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const data = await r.json() as { data?: Array<{ id: string }> };
        const models = data?.data?.map((m) => m.id) ?? [];
        lmStatus = `✅ up (${models.length} model${models.length !== 1 ? "s" : ""})`;
        lmModels = models.length > 0 ? "\n" + models.map((m) => `  • ${m}`).join("\n") : "";
      } else {
        lmStatus = `❌ ${r.status}`;
      }
    } catch { lmStatus = "❌ down (no connection)"; }

    // Runner availability
    const claudeOk = _claudeRunner !== null;
    const opencodeOk = _openCodeRunner !== null;
    const ocVersion = opencodeOk && _openCodeVersion ? ` (${_openCodeVersion})` : "";

    // Active sessions detail
    const activeParts = _activeSessions.size > 0
      ? [..._activeSessions.entries()].map(([n, s]) => {
          const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
          return `• ${n === "_auto" ? "session" : n} — ${elapsed}s`;
        }).join("\n")
      : "none";

    // Pi session
    let piStatus = "idle";
    try {
      const session = router.getIfExists(chatId);
      if (session) piStatus = `active (${session.isAlive ? "alive" : "dead"})`;
    } catch { piStatus = "error"; }

    await sendReply(chatId,
      `🏓 Pong!\n\n` +
      `Gateway: ✅ running  (uptime ${Math.round(process.uptime() / 60)}m)\n` +
      `Pi: ${piStatus}\n` +
      `LM Studio: ${lmStatus}${lmModels}\n` +
      `Claude runner: ${claudeOk ? "✅" : "❌"}  OpenCode runner: ${opencodeOk ? "✅" : "❌"}${ocVersion}\n` +
      `Active sessions: ${activeParts}`
    );
  }

  async function onClear(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    if (!isAllowed(userId, allowedUsers)) return;
    getChatSession(chatId).clearHistory();
    await sendReply(chatId, "Chat history cleared. Starting fresh.");
  }

  async function onCompact(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    if (!isAllowed(userId, allowedUsers)) return;
    const session = getChatSession(chatId);
    const before = session.historyLength();
    if (before === 0) {
      await sendReply(chatId, "No history to compact.");
      return;
    }
    await sendReply(chatId, `Compacting ${before} messages into a summary…`);
    const summary = await session.compact();
    if (summary) {
      await sendReply(chatId, `Compacted. Summary:\n\n${summary.slice(0, 1000)}`);
    } else {
      await sendReply(chatId, "Compact failed (LM Studio unavailable?). History unchanged.");
    }
  }

  function formatAge(ts: number): string {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  function triggerResume(opts: { name: string; task: string; chatId: number; cwd?: string; resumeClaudeSessionId: string }): void {
    runClaudeSession({
      name: opts.name,
      task: opts.task,
      chatId: opts.chatId,
      userId: opts.chatId,
      cwd: opts.cwd,
      resumeClaudeSessionId: opts.resumeClaudeSessionId,
    });
  }

  return { onMessage, onStart, onStatus, onCancel, onClaudeCommand, onWork, onOpenCode, onSessions, onResume, onAddProject, onFixSelf, onSelfDiagnose, onPing, onClear, onCompact, triggerResume, onDocument, onPhoto };
}

async function downloadFile(bot: TelegramBot, telegramPath: string, fileName: string): Promise<string> {
  const dir = join(tmpdir(), "pilav-uploads");
  mkdirSync(dir, { recursive: true });
  const localPath = join(dir, `${Date.now()}-${fileName}`);

  const stream = bot.getFileStream(telegramPath);
  await pipeline(stream, createWriteStream(localPath));
  return localPath;
}

export class TelegramGateway {
  private bot: TelegramBot;
  private handlers: ReturnType<typeof createHandlers>;

  constructor(token: string, deps: Omit<HandlerDeps, "sendReply" | "bot" | "sendStreamingMessage" | "editMessage">) {
    this.bot = new TelegramBot(token, { polling: true });

    const sendReply = async (chatId: number, text: string) => {
      const formatted = toTelegramMarkdown(text);
      try {
        await this.bot.sendMessage(chatId, formatted, { parse_mode: "Markdown" });
      } catch {
        await this.bot.sendMessage(chatId, text);
      }
    };

    const sendTyping = async (chatId: number) => {
      await this.bot.sendChatAction(chatId, "typing");
    };

    const sendStreamingMessage = async (chatId: number, text: string): Promise<number> => {
      const msg = await this.bot.sendMessage(chatId, text);
      return msg.message_id;
    };

    const editMessage = async (chatId: number, messageId: number, text: string): Promise<void> => {
      const formatted = toTelegramMarkdown(text);
      try {
        await this.bot.editMessageText(formatted, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
      } catch {
        try {
          await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
        } catch {
          // Telegram throws if the text hasn't changed — ignore silently
        }
      }
    };

    this.handlers = createHandlers({ ...deps, sendReply, sendTyping, sendStreamingMessage, editMessage, bot: this.bot });
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.bot.onText(/\/start/, (msg) => this.handlers.onStart(msg as TgMessage));
    this.bot.onText(/\/status/, (msg) => this.handlers.onStatus(msg as TgMessage));
    this.bot.onText(/^\/cancel(\s|$)/, (msg) => this.handlers.onCancel(msg as TgMessage));
    this.bot.onText(/^\/claude(\s|$)/, (msg) => this.handlers.onClaudeCommand(msg as TgMessage));
    this.bot.onText(/^\/work(\s|$)/, (msg) => this.handlers.onWork(msg as TgMessage));
    this.bot.onText(/^\/sessions/, (msg) => this.handlers.onSessions(msg as TgMessage));
    this.bot.onText(/^\/resume(\s|$)/, (msg) => this.handlers.onResume(msg as TgMessage));
    this.bot.onText(/^\/addproject(\s|$)/, (msg) => this.handlers.onAddProject(msg as TgMessage));
    this.bot.onText(/^\/opencode(\s|$)/, (msg) => this.handlers.onOpenCode(msg as TgMessage));
    this.bot.onText(/^\/fix-yourself(\s|$)/, (msg) => this.handlers.onFixSelf(msg as TgMessage, (msg.text ?? "").replace(/^\/fix-yourself\s*/i, "").trim() || undefined));
    this.bot.onText(/^\/ping/, (msg) => this.handlers.onPing(msg as TgMessage));
    this.bot.onText(/^\/clear/, (msg) => this.handlers.onClear(msg as TgMessage));
    this.bot.onText(/^\/compact/, (msg) => this.handlers.onCompact(msg as TgMessage));
    this.bot.on("message", (msg) => {
      const text = msg.text ?? "";
      // Pass through normal messages and /pilav commands; explicit commands have their own handlers
      if (!text.startsWith("/") || text.startsWith("/pilav ")) {
        void this.handlers.onMessage(msg as TgMessage);
      }
    });
    this.bot.on("document", (msg) => this.handlers.onDocument(msg as TgMessage));
    this.bot.on("photo", (msg) => this.handlers.onPhoto(msg as TgMessage));
  }

  resumeSession(opts: { name: string; task: string; chatId: number; cwd?: string; resumeClaudeSessionId: string }): void {
    this.handlers.triggerResume(opts);
  }

  triggerSelfDiagnose(chatId: number): void {
    void this.handlers.onSelfDiagnose(chatId);
  }

  sendMessage(chatId: number, text: string): void {
    const formatted = toTelegramMarkdown(text);
    void this.bot.sendMessage(chatId, formatted, { parse_mode: "Markdown" })
      .catch(() => this.bot.sendMessage(chatId, text).catch(() => {}));
  }

  sendPhoto(chatId: number, filePath: string, caption?: string): void {
    void this.bot.sendPhoto(chatId, filePath, { caption }).catch(() => {});
  }

  async stop(): Promise<void> {
    await this.bot.stopPolling();
  }
}
