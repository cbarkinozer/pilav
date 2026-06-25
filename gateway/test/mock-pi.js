#!/usr/bin/env node
/**
 * Mock Pi RPC subprocess for gateway integration tests.
 * Speaks the Pi JSONL protocol on stdin/stdout.
 * Env vars:
 *   MOCK_PI_RESPONSE  — text to return for prompt (default: "Hello from mock Pi!")
 *   MOCK_PI_DELAY_MS  — ms delay before responding (default: 10)
 *   MOCK_PI_SESSION_ID — session id to return (default: "mock-session-001")
 */

const RESPONSE_TEXT = process.env.MOCK_PI_RESPONSE ?? "Hello from mock Pi!";
const DELAY_MS = parseInt(process.env.MOCK_PI_DELAY_MS ?? "10", 10);
const SESSION_ID = process.env.MOCK_PI_SESSION_ID ?? "mock-session-001";

let isStreaming = false;
let abortRequested = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handlePrompt(id) {
  isStreaming = true;
  abortRequested = false;

  send({ id, type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "assistant", content: [] } });

  await sleep(DELAY_MS);

  if (!abortRequested) {
    // Send text_delta events
    for (const char of RESPONSE_TEXT) {
      if (abortRequested) break;
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: char },
      });
    }
  }

  send({ type: "message_end" });
  send({ type: "agent_end" });
  isStreaming = false;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }

    const id = cmd.id;

    if (cmd.type === "prompt") {
      await handlePrompt(id);
    } else if (cmd.type === "abort") {
      abortRequested = true;
      isStreaming = false;
      send({ id, type: "response", command: "abort", success: true });
    } else if (cmd.type === "get_state") {
      send({
        id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          model: { provider: "lmstudio", id: "gemma-4-4b", contextWindow: 128000, reasoning: false },
          thinkingLevel: "none",
          isStreaming,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "all",
          sessionFile: null,
          sessionId: SESSION_ID,
          sessionName: null,
          autoCompactionEnabled: false,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
    } else if (cmd.type === "new_session") {
      send({ id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// Signal ready
process.stderr.write("mock-pi ready\n");
