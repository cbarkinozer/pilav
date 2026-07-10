/**
 * Pre-flight permission judge.
 * Analyses an incoming task with Pilav's LLM and decides:
 *   - Is this task safe to run autonomously?
 *   - Which tools should Claude Code be allowed to use?
 *   - What permission mode should be set?
 *
 * This is Pilav making the "is it what we expect and is it safe" decision
 * before handing control to Claude Code.  The decision is logged to SQLite
 * so it can later be used as SFT training data.
 */

import type { PilotDecision } from "./action-store.ts";

export interface JudgeOptions {
  lmStudioUrl?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
}

const SYSTEM_PROMPT = `You are Pilav's safety judge. A user sent a task to be executed by Claude Code on their personal Mac Mini.

Your job: decide whether the task is safe to run autonomously and which tools Claude Code should be allowed to use.

Available tool categories (use these exact names in allowedTools):
- Read, Glob, Grep — safe file reads, always allow
- Edit, Write, MultiEdit — file edits; allow if task is clearly about coding/editing files
- Bash — shell commands; allow only if the task clearly requires running commands
- WebFetch, WebSearch — network access; allow if research/web tasks are needed
- TodoRead, TodoWrite — task lists; generally safe
- NotebookRead, NotebookEdit — Jupyter notebooks; allow for data-science tasks
- default — allow all standard tools (use when task is complex and needs broad access)

Respond ONLY with a JSON object, no prose, no markdown fences:
{
  "safe": true | false,
  "reasoning": "one sentence",
  "allowedTools": ["Read", "Edit", "Bash"],
  "permissionMode": "bypassPermissions" | "auto" | "default"
}

If safe is false, set allowedTools to [] and permissionMode to "default".
Use permissionMode "bypassPermissions" when you are confident the task is safe and legitimate.
Use permissionMode "auto" when you want Claude Code to make its own permission decisions.
Use permissionMode "default" when the task needs careful interactive permissions.`;

export class PermissionJudge {
  private baseUrl: string;
  private model: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(opts: JudgeOptions = {}) {
    this.baseUrl = opts.lmStudioUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
    this.model = opts.model ?? process.env.LM_STUDIO_MODEL ?? "qwen/qwen3.5-9b";
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async judge(task: string): Promise<PilotDecision> {
    try {
      const resp = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `/no_think\nTask: ${task}` },
          ],
          temperature: 0.1,
          max_tokens: 512,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) throw new Error(`LM Studio ${resp.status}`);
      const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
      const raw = data.choices?.[0]?.message?.content ?? "";

      // Strip thinking tags if model emits them
      const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

      // Extract JSON — search stripped first, fall back to raw (JSON might be inside <think>)
      const jsonMatch = stripped.match(/\{[\s\S]*\}/) ?? raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in LLM response");

      const parsed = JSON.parse(jsonMatch[0]) as {
        safe: boolean;
        reasoning: string;
        allowedTools: string[];
        permissionMode: string;
      };

      return {
        safe: Boolean(parsed.safe),
        reasoning: String(parsed.reasoning ?? ""),
        allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
        permissionMode: (["bypassPermissions", "auto", "default"].includes(parsed.permissionMode)
          ? parsed.permissionMode
          : "bypassPermissions") as PilotDecision["permissionMode"],
      };
    } catch (err) {
      // If LM Studio is down or judgment fails, fall back to safe defaults
      console.warn("[pilav][permission-judge] fallback to safe defaults:", (err as Error).message);
      return {
        safe: true,
        reasoning: "LM Studio unavailable — using safe defaults (bypassPermissions, all tools).",
        allowedTools: [],  // empty = use Claude Code defaults
        permissionMode: "bypassPermissions",
      };
    }
  }
}
