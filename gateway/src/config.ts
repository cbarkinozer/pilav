import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface GatewayConfig {
  botToken: string;
  allowedUsers: number[];
  piCliPath: string;
  sessionTimeoutMs: number;
  /** Working directory Claude Code uses for code_dev tasks */
  defaultProjectDir: string;
}

interface ConfigFile {
  botToken?: string;
  allowedUsers?: number[];
  piCliPath?: string;
  sessionTimeoutMs?: number;
  defaultProjectDir?: string;
}

function loadConfigFile(): ConfigFile {
  const configPath = join(homedir(), ".pilav", "config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as ConfigFile;
  } catch {
    return {};
  }
}

function defaultPiCliPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // From gateway/src/config.ts → packages/coding-agent/dist/cli.js
  return resolve(__dirname, "../../packages/coding-agent/dist/cli.js");
}

export async function loadConfig(): Promise<GatewayConfig> {
  const file = loadConfigFile();

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? file.botToken;
  if (!botToken) {
    throw new ConfigError(
      "Missing bot token. Set TELEGRAM_BOT_TOKEN env var or add botToken to ~/.pilav/config.json",
    );
  }

  let allowedUsers: number[] = [];
  if (process.env.TELEGRAM_ALLOWED_USERS) {
    allowedUsers = process.env.TELEGRAM_ALLOWED_USERS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } else if (file.allowedUsers) {
    allowedUsers = file.allowedUsers;
  }

  const piCliPath = process.env.PI_CLI_PATH ?? file.piCliPath ?? defaultPiCliPath();
  const sessionTimeoutMs = file.sessionTimeoutMs ?? 30 * 60 * 1000; // 30 minutes
  const defaultProjectDir = process.env.PILAV_PROJECT_DIR ?? file.defaultProjectDir ?? homedir();

  return { botToken, allowedUsers, piCliPath, sessionTimeoutMs, defaultProjectDir };
}
