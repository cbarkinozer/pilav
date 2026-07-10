import { loadConfig } from "./config.ts";
import { UserQueue } from "./queue.ts";
import { PiSession } from "./rpc-client.ts";
import { SessionRouter } from "./router.ts";
import { TelegramGateway } from "./bot.ts";
import { StatusPoller } from "./status-poller.ts";
import { ActionStore } from "./action-store.ts";
import { loadPendingResumes, clearPendingResumes } from "./pending-resumes.ts";
import { markCleanShutdown, consumeCleanShutdownMarker, recordCrash, recentCrashCount } from "./crash-tracker.ts";

async function main(): Promise<void> {
  // Crash loop detection: if last run didn't exit cleanly, record it
  const wasClean = consumeCleanShutdownMarker();
  if (!wasClean) {
    recordCrash();
    console.log(`[pilav-gateway] Previous run was not a clean shutdown — crash recorded.`);
  }
  const recentCrashes = recentCrashCount(5 * 60 * 1000);

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`[pilav-gateway] Failed to load config: ${(err as Error).message}`);
    process.exit(1);
  }

  // SQLite action trace store — records every Claude Code session for future SFT training
  const actionStore = new ActionStore();
  console.log("[pilav-gateway] Action store initialised at ~/.pilav/pilav.db");
  console.log(`[pilav-gateway] ${actionStore.sessionCount()} Claude Code sessions recorded to date`);

  const queue = new UserQueue();
  // Project root: pilav/ — Pi auto-discovers .pi/extensions/ from here
  const pilavRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
  const router = new SessionRouter({
    sessionFactory: () =>
      new PiSession({
        piCliPath: config.piCliPath,
        cwd: pilavRoot,
        // RpcClient prepends --mode rpc automatically; we just pick provider + model
        piArgs: [
          "--provider", "lmstudio",
          "--model", "qwen-3.5-8b",
        ],
      }),
    timeoutMs: config.sessionTimeoutMs,
  });

  const gateway = new TelegramGateway(config.botToken, {
    router,
    queue,
    allowedUsers: config.allowedUsers,
    actionStore,
    defaultProjectDir: config.defaultProjectDir,
  });
  console.log(`[pilav-gateway] Default project dir: ${config.defaultProjectDir}`);

  const poller = new StatusPoller({
    getChatIds: () => router.activeChatIds(),
    sendMessage: async (chatId, text) => { gateway.sendMessage(chatId, text); },
    sendPhoto: async (chatId, filePath, caption) => { gateway.sendPhoto(chatId, filePath, caption); },
  });
  poller.start();

  console.log("[pilav-gateway] Started. Listening for Telegram messages...");

  // Notify user and trigger self-diagnosis after crash loops
  const notifyChatId = config.allowedUsers[0];
  if (notifyChatId) {
    if (recentCrashes >= 3) {
      setTimeout(() => {
        gateway.sendMessage(notifyChatId,
          `🔴 I crashed ${recentCrashes} times in the last 5 minutes. Running diagnosis…`);
        gateway.triggerSelfDiagnose(notifyChatId);
      }, 5000);
    } else if (!wasClean && recentCrashes >= 1) {
      setTimeout(() => {
        gateway.sendMessage(notifyChatId,
          `⚠️ I restarted after an unexpected crash. If it keeps happening I'll auto-diagnose. Send /ping to check status.`);
      }, 3000);
    }
  }

  // After self-fix restart: resume any sessions that were paused
  const pendingResumes = loadPendingResumes();
  if (pendingResumes.length > 0) {
    clearPendingResumes();
    // Give the bot a moment to settle before resuming
    setTimeout(async () => {
      for (const pr of pendingResumes) {
        const age = Math.round((Date.now() - pr.savedAt) / 1000);
        if (pr.claudeSessionId) {
          gateway.sendMessage(pr.chatId,
            `✅ Restarted after self-fix. Resuming "${pr.name}" (paused ${age}s ago)…`);
          // Small delay between resumes to avoid flooding
          await new Promise((r) => setTimeout(r, 2000));
          gateway.resumeSession({
            name: pr.name,
            task: "Continue from where you left off before the self-fix restart.",
            chatId: pr.chatId,
            cwd: pr.cwd ?? undefined,
            resumeClaudeSessionId: pr.claudeSessionId,
          });
        } else {
          gateway.sendMessage(pr.chatId,
            `✅ Restarted after self-fix.\n\nSession "${pr.name}" was mid-run when paused — no resume ID available.\nTask was: "${pr.task.slice(0, 150)}"\n\nUse /sessions to start again or describe the task.`);
        }
      }
      const chatIds = [...new Set(pendingResumes.map((p) => p.chatId))];
      for (const chatId of chatIds) {
        await new Promise((r) => setTimeout(r, 3000));
        gateway.sendMessage(chatId, "Everything working as expected? Let me know if the fix helped or if there's still an issue.");
      }
    }, 4000);
  }

  async function shutdown(): Promise<void> {
    console.log("[pilav-gateway] Shutting down...");
    markCleanShutdown();
    poller.stop();
    await gateway.stop();
    await router.stopAll();
    actionStore.close();
    process.exit(0);
  }

  process.once("SIGTERM", () => { shutdown().catch(console.error); });
  process.once("SIGINT", () => { shutdown().catch(console.error); });
}

main().catch((err) => {
  console.error("[pilav-gateway] Fatal error:", err);
  process.exit(1);
});
