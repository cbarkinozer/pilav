import { loadConfig } from "./config.ts";
import { UserQueue } from "./queue.ts";
import { PiSession } from "./rpc-client.ts";
import { SessionRouter } from "./router.ts";
import { TelegramGateway } from "./bot.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`[pilav-gateway] Failed to load config: ${(err as Error).message}`);
    process.exit(1);
  }

  const queue = new UserQueue();
  const router = new SessionRouter({
    sessionFactory: () =>
      new PiSession({
        piCliPath: config.piCliPath,
        piArgs: [],
      }),
    timeoutMs: config.sessionTimeoutMs,
  });

  const gateway = new TelegramGateway(config.botToken, { router, queue, allowedUsers: config.allowedUsers });

  console.log("[pilav-gateway] Started. Listening for Telegram messages...");

  async function shutdown(): Promise<void> {
    console.log("[pilav-gateway] Shutting down...");
    await gateway.stop();
    await router.stopAll();
    process.exit(0);
  }

  process.once("SIGTERM", () => { shutdown().catch(console.error); });
  process.once("SIGINT", () => { shutdown().catch(console.error); });
}

main().catch((err) => {
  console.error("[pilav-gateway] Fatal error:", err);
  process.exit(1);
});
