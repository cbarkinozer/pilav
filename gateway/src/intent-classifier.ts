/**
 * 3-way intent classifier for routing Telegram messages.
 *
 * chat        → LM Studio answers directly (weather, questions, conversation)
 * local_action → Pi agent acts on the device (write file, run script, note)
 * code_dev    → Claude Code does software development (continue project, implement, fix)
 *
 * Keyword pre-screening handles obvious cases instantly (<1ms).
 * Ambiguous messages call Qwen for a single-word classification (~100ms).
 */

export type Intent = "chat" | "local_action" | "code_dev";

interface ClassifierOptions {
  lmStudioUrl?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
}

// Fast keyword check — covers the majority of clear-cut cases
const CODE_DEV_KEYWORDS = [
  "project", "implement", "refactor", "continue", "feature",
  "fix bug", "fix the bug", "fix a bug", "debug", "add function", "create class", "unit test",
  "typescript", "javascript", "python", "commit", "push to git",
  "pull request", "code review", "write code", "build the", "develop",
  "add to the codebase", "update the code", "edit the code",
  "new endpoint", "new route", "new component", "new module",
  "sprint", "task", "ticket", "story",
  ".ts file", ".py file", ".js file", ".tsx file",
  "codebase", "repository", "repo", "source code",
  "gateway", "backend", "frontend", "api", "database",
];

const LOCAL_ACTION_KEYWORDS = [
  "write this", "write it", "save this", "save it",
  "create a file", "make a file", "write to file", "write a txt",
  "write a note", "make a note", "create a note",
  "on my local", "on my machine", "on my computer", "on my mac",
  "run this script", "execute this", "open this app", "open app",
  "move this file", "delete this file", "rename this file",
  "install this", "download this",
];

function keywordMatch(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

const CLASSIFIER_SYSTEM = `You are an intent classifier. Given a user message, reply with EXACTLY ONE WORD — no explanation, no punctuation:

chat          — general question, weather, facts, conversation, what to do, recommendations
local_action  — write/create/save a file or note on the local machine, run a script, open an app
code_dev      — work on a software project, implement/fix/refactor code, continue the project

Reply with only: chat OR local_action OR code_dev`;

export class IntentClassifier {
  private baseUrl: string;
  private model: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(opts: ClassifierOptions = {}) {
    this.baseUrl = opts.lmStudioUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
    this.model = opts.model ?? process.env.LM_STUDIO_MODEL ?? "qwen/qwen3.5-9b";
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async classify(message: string): Promise<Intent> {
    // Fast path: keyword pre-screening
    if (keywordMatch(message, CODE_DEV_KEYWORDS)) return "code_dev";
    if (keywordMatch(message, LOCAL_ACTION_KEYWORDS)) return "local_action";

    // LLM path for ambiguous messages
    try {
      const resp = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM },
            { role: "user", content: message },
          ],
          temperature: 0,
          max_tokens: 10,
          stream: false,
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!resp.ok) throw new Error(`LM Studio ${resp.status}`);
      const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
      const raw = data.choices?.[0]?.message?.content ?? "";
      // Strip thinking tags, lowercase, trim
      const word = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().toLowerCase().split(/\s/)[0];

      if (word === "local_action") return "local_action";
      if (word === "code_dev") return "code_dev";
      return "chat"; // default
    } catch {
      // If LM Studio is down, fall back to chat (safe default)
      return "chat";
    }
  }
}
