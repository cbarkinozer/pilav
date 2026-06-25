/**
 * T002 — Config loader tests
 * Tests loadConfig() reads bot token and allowed users from env vars.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type GatewayConfig } from "../src/config.ts";

// Save and restore env vars around each test
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "PI_CLI_PATH"];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("T002: Config loader", () => {
  it("reads TELEGRAM_BOT_TOKEN from env", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-123";
    process.env.TELEGRAM_ALLOWED_USERS = "100,200";

    const config = await loadConfig();
    expect(config.botToken).toBe("test-token-123");
  });

  it("reads TELEGRAM_ALLOWED_USERS as number[] from env", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-123";
    process.env.TELEGRAM_ALLOWED_USERS = "111,222,333";

    const config = await loadConfig();
    expect(config.allowedUsers).toEqual([111, 222, 333]);
  });

  it("allowedUsers is empty array when not set (open access)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-123";

    const config = await loadConfig();
    expect(config.allowedUsers).toEqual([]);
  });

  it("throws ConfigError when TELEGRAM_BOT_TOKEN is missing", async () => {
    await expect(loadConfig()).rejects.toThrow(/bot token/i);
  });

  it("returns a piCliPath string", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-123";

    const config = await loadConfig();
    expect(typeof config.piCliPath).toBe("string");
    expect(config.piCliPath.length).toBeGreaterThan(0);
  });

  it("PI_CLI_PATH env overrides default piCliPath", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-123";
    process.env.PI_CLI_PATH = "/custom/path/to/cli.js";

    const config = await loadConfig();
    expect(config.piCliPath).toBe("/custom/path/to/cli.js");
  });

  it("reads config from ~/.pilav/config.json when env var absent", async () => {
    const configDir = join(homedir(), ".pilav");
    const configPath = join(configDir, "config.json");
    const created = !existsSync(configDir);

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({ botToken: "file-token-456", allowedUsers: [789] }),
      );

      const config = await loadConfig();
      expect(config.botToken).toBe("file-token-456");
      expect(config.allowedUsers).toEqual([789]);
    } finally {
      if (existsSync(configPath)) rmSync(configPath);
      if (created && existsSync(configDir)) rmSync(configDir, { recursive: true });
    }
  });

  it("env var takes precedence over config file", async () => {
    const configDir = join(homedir(), ".pilav");
    const configPath = join(configDir, "config.json");
    const created = !existsSync(configDir);

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ botToken: "file-token", allowedUsers: [1] }));

      process.env.TELEGRAM_BOT_TOKEN = "env-token";
      process.env.TELEGRAM_ALLOWED_USERS = "2,3";

      const config = await loadConfig();
      expect(config.botToken).toBe("env-token");
      expect(config.allowedUsers).toEqual([2, 3]);
    } finally {
      if (existsSync(configPath)) rmSync(configPath);
      if (created && existsSync(configDir)) rmSync(configDir, { recursive: true });
    }
  });
});
