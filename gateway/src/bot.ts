import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import TelegramBot from "node-telegram-bot-api";
import type { UserQueue } from "./queue.ts";
import type { SessionRouter } from "./router.ts";
import { LMStudioChat } from "./lm-chat.ts";
import type { ActionStore } from "./action-store.ts";
import { ClaudeCodeRunner } from "./claude-code-session.ts";
import { IntentClassifier } from "./intent-classifier.ts";

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
    session = new LMStudioChat();
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

// One ClaudeCodeRunner + one IntentClassifier per handler set
let _claudeRunner: ClaudeCodeRunner | null = null;
let _classifier: IntentClassifier | null = null;
const _activeClaude = new Map<number, string>(); // chatId → sessionId

export function createHandlers(deps: HandlerDeps) {
  const { router, queue, sendReply, allowedUsers } = deps;

  if (deps.actionStore && !_claudeRunner) {
    _claudeRunner = new ClaudeCodeRunner(deps.actionStore);
  }
  if (!_classifier) {
    _classifier = new IntentClassifier();
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
    // Drop other slash commands (/start /status /cancel /claude have their own handlers)
    if (text.startsWith("/") && !isPiCommand) return;

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
          // Code development → Claude Code
          if (!_claudeRunner) {
            await sendReply(chatId, "Claude Code runner not available (no action store).");
            return;
          }
          if (_activeClaude.has(chatId)) {
            await sendReply(chatId, "A Claude Code session is already running. Use /cancel to stop it first.");
            return;
          }

          // Each progress update is a new message so history is preserved
          let lastSent = "";
          let lastSentTime = 0;
          const MIN_INTERVAL_MS = 3000; // don't spam faster than 1 msg / 3s

          const sendProgress = async (progressText: string) => {
            const now = Date.now();
            const truncated = progressText.slice(0, 3800);
            if (truncated === lastSent) return;
            if (now - lastSentTime < MIN_INTERVAL_MS) return;
            lastSent = truncated;
            lastSentTime = now;
            await sendReply(chatId, truncated);
          };

          const result = await _claudeRunner.run({
            task: text,
            telegramChatId: chatId,
            cwd: deps.defaultProjectDir,
            onProgress: sendProgress,
          });

          _activeClaude.delete(chatId);

          const status = result.status === "completed"
            ? `✅ Done (${result.eventsLogged} events logged)`
            : `❌ ${result.status}: ${result.errorMessage?.slice(0, 150) ?? ""}`;
          await sendReply(chatId, status);

          if (result.finalText) {
            for (const chunk of splitMessage(result.finalText)) {
              await sendReply(chatId, chunk);
            }
          }
          return;
        }

        if (intent === "local_action") {
          // Local action → Pi agent
          await routeToPi(chatId, text);
          return;
        }

        // chat → LM Studio
        await routeToLMStudio(chatId, text);
      } finally {
        clearInterval(typingTimer);
      }
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
      // Collect full response then send as a single new message — no edit-in-place
      const response = await getChatSession(chatId).chat(text);
      await replyChunked(chatId, response || "I didn't get a response. Try rephrasing.");
    } catch (err) {
      console.error("[pilav-gateway] LM Studio chat error:", (err as Error).message);
      await sendReply(chatId, `Sorry, model error: ${(err as Error).message.slice(0, 200)}`);
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
      "I automatically route your message to the right tool.\n\n" +
      "Override commands:\n" +
      "  /pilav <task> — force Pi agent\n" +
      "  /claude <task> — force Claude Code\n" +
      "  /status — active session info\n" +
      "  /cancel — stop running task",
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

    // Cancel any active Claude Code session for this chat
    const activeSessionId = _activeClaude.get(chatId);
    if (activeSessionId && _claudeRunner) {
      _claudeRunner.cancel(activeSessionId);
      _activeClaude.delete(chatId);
      await sendReply(chatId, "Cancelled Claude Code session.");
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
      await sendReply(chatId, "Usage: /claude <task>\n\nExample: /claude list all files in the pilav project");
      return;
    }

    if (_activeClaude.has(chatId)) {
      await sendReply(chatId, "A Claude Code session is already running. Use /cancel to stop it first.");
      return;
    }

    if (!_claudeRunner) {
      await sendReply(chatId, "Claude Code runner not available (no action store configured).");
      return;
    }

    void queue.enqueue(userId, async () => {
      const typingTimer = startTypingInterval(chatId);

      // Send each progress update as a new message — no edit-in-place
      let lastSent = "";
      let lastSentTime = 0;
      const MIN_INTERVAL_MS = 3000;

      const sendProgress = async (progressText: string) => {
        const now = Date.now();
        const truncated = progressText.slice(0, 3800);
        if (truncated === lastSent || now - lastSentTime < MIN_INTERVAL_MS) return;
        lastSent = truncated;
        lastSentTime = now;
        await sendReply(chatId, truncated);
      };

      try {
        const result = await _claudeRunner!.run({
          task,
          telegramChatId: chatId,
          onProgress: sendProgress,
        });

        _activeClaude.delete(chatId);

        const status = result.status === "completed"
          ? `✅ Done (${result.eventsLogged} events, session ${result.sessionId.slice(0, 8)})`
          : `❌ ${result.status}: ${result.errorMessage?.slice(0, 200) ?? ""}`;
        await sendReply(chatId, status);

        if (result.finalText) {
          for (const chunk of splitMessage(result.finalText)) {
            await sendReply(chatId, chunk);
          }
        } else if (result.errorMessage) {
          await sendReply(chatId, result.errorMessage.slice(0, 1000));
        }
      } catch (err) {
        _activeClaude.delete(chatId);
        await sendReply(chatId, `Claude Code error: ${(err as Error).message.slice(0, 300)}`);
      } finally {
        clearInterval(typingTimer);
      }
    });
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

  return { onMessage, onStart, onStatus, onCancel, onClaudeCommand, onDocument, onPhoto };
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
    this.bot.onText(/\/cancel/, (msg) => this.handlers.onCancel(msg as TgMessage));
    this.bot.onText(/^\/claude(\s|$)/, (msg) => this.handlers.onClaudeCommand(msg as TgMessage));
    this.bot.on("message", (msg) => {
      const text = msg.text ?? "";
      // Pass through normal messages and /pilav commands; /claude has its own handler
      if (!text.startsWith("/") || text.startsWith("/pilav ")) {
        this.handlers.onMessage(msg as TgMessage);
      }
    });
    this.bot.on("document", (msg) => this.handlers.onDocument(msg as TgMessage));
    this.bot.on("photo", (msg) => this.handlers.onPhoto(msg as TgMessage));
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
