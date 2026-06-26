import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import TelegramBot from "node-telegram-bot-api";
import type { UserQueue } from "./queue.ts";
import type { SessionRouter } from "./router.ts";

export interface HandlerDeps {
  router: Pick<SessionRouter, "getOrCreate">;
  queue: Pick<UserQueue, "enqueue">;
  sendReply: (chatId: number, text: string) => Promise<void>;
  sendTyping?: (chatId: number) => Promise<void>;
  /** Send an initial message and return its message_id (for later editing). */
  sendStreamingMessage?: (chatId: number, text: string) => Promise<number>;
  /** Edit a previously sent message in-place with new text. */
  editMessage?: (chatId: number, messageId: number, text: string) => Promise<void>;
  allowedUsers: number[];
  bot?: TelegramBot;
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

export function createHandlers(deps: HandlerDeps) {
  const { router, queue, sendReply, allowedUsers } = deps;

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
    if (!text || text.startsWith("/")) return;

    void sendTyping(chatId);
    await queue.enqueue(userId, async () => {
      const typingTimer = startTypingInterval(chatId);
      try {
        const session = await router.getOrCreate(chatId);

        if (deps.sendStreamingMessage && deps.editMessage && "sendMessageStreaming" in session) {
          // Streaming path: send Thinking..., then edit-in-place as tokens arrive
          const thinkingId = await deps.sendStreamingMessage(chatId, "⏳ Thinking…");
          let lastEdit = Date.now();
          const EDIT_INTERVAL_MS = 2000;

          const response = await (session as any).sendMessageStreaming(
            text,
            async (accumulated: string) => {
              const now = Date.now();
              if (now - lastEdit >= EDIT_INTERVAL_MS) {
                lastEdit = now;
                const preview = accumulated.slice(-TELEGRAM_MAX_LENGTH);
                await deps.editMessage!(chatId, thinkingId, preview || "⏳ Thinking…");
              }
            },
          );

          const final = response || "(no response)";
          if (final.length <= TELEGRAM_MAX_LENGTH) {
            await deps.editMessage!(chatId, thinkingId, final);
          } else {
            // Response too long for a single edit — replace thinking msg with first chunk, send rest
            await deps.editMessage!(chatId, thinkingId, final.slice(0, TELEGRAM_MAX_LENGTH));
            for (const chunk of splitMessage(final.slice(TELEGRAM_MAX_LENGTH))) {
              await sendReply(chatId, chunk);
            }
          }
        } else {
          // Fallback: wait-then-send (original behaviour)
          const response = await session.sendMessage(text);
          await replyChunked(chatId, response || "(no response)");
        }
      } finally {
        clearInterval(typingTimer);
      }
    });
  }

  async function onStart(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    await sendReply(chatId, "Hello! I'm Pilav — your always-on AI assistant. Send me a message to get started.");
  }

  async function onStatus(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    const session = await router.getOrCreate(chatId);
    const status = await session.getStatus();

    const modelStr = status.model ? `${status.model.provider}/${status.model.id}` : "unknown";
    const streamingStr = status.isStreaming ? "streaming" : "idle";
    await sendReply(chatId, `Status: ${streamingStr}\nModel: ${modelStr}\nSession: ${status.sessionId}`);
  }

  async function onCancel(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!isAllowed(userId, allowedUsers)) {
      await sendReply(chatId, "You are not authorized.");
      return;
    }

    const session = await router.getOrCreate(chatId);
    await session.cancel();
    await sendReply(chatId, "Cancelled current operation.");
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

  return { onMessage, onStart, onStatus, onCancel, onDocument, onPhoto };
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

  constructor(token: string, deps: Omit<HandlerDeps, "sendReply" | "bot">) {
    this.bot = new TelegramBot(token, { polling: true });

    const sendReply = async (chatId: number, text: string) => {
      await this.bot.sendMessage(chatId, text);
    };

    const sendTyping = async (chatId: number) => {
      await this.bot.sendChatAction(chatId, "typing");
    };

    const sendStreamingMessage = async (chatId: number, text: string): Promise<number> => {
      const msg = await this.bot.sendMessage(chatId, text);
      return msg.message_id;
    };

    const editMessage = async (chatId: number, messageId: number, text: string): Promise<void> => {
      try {
        await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
      } catch {
        // Telegram throws if the text hasn't changed — ignore silently
      }
    };

    this.handlers = createHandlers({ ...deps, sendReply, sendTyping, sendStreamingMessage, editMessage, bot: this.bot });
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.bot.onText(/\/start/, (msg) => this.handlers.onStart(msg as TgMessage));
    this.bot.onText(/\/status/, (msg) => this.handlers.onStatus(msg as TgMessage));
    this.bot.onText(/\/cancel/, (msg) => this.handlers.onCancel(msg as TgMessage));
    this.bot.on("message", (msg) => {
      if (!msg.text?.startsWith("/")) {
        this.handlers.onMessage(msg as TgMessage);
      }
    });
    this.bot.on("document", (msg) => this.handlers.onDocument(msg as TgMessage));
    this.bot.on("photo", (msg) => this.handlers.onPhoto(msg as TgMessage));
  }

  async stop(): Promise<void> {
    await this.bot.stopPolling();
  }
}
