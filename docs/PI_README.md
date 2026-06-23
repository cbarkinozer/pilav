# Pi — AI Agent Toolkit

**Stars:** 65.1k | **Language:** TypeScript | **License:** MIT | **Author:** Mario Zechner (Earendil Works)

**Repo:** [github.com/earendil-works/pi](https://github.com/earendil-works/pi) | **Site:** [pi.dev](https://pi.dev)

---

- [Overview](#overview)
- [Architecture](#architecture)
- [Packages](#packages)
- [Extension System](#extension-system)
- [Provider & Model Support](#provider--model-support)
- [Session Management](#session-management)
- [Four Modes](#four-modes)
- [Strong Points](#strong-points)
- [Weak Points](#weak-points)
- [Use Cases](#use-cases)

---

## Overview

Pi is a minimal, opinionated, aggressively extensible agent harness created by Mario Zechner (creator of libGDX, author of OpenClaw). Its philosophy is radical minimalism: ~1000 tokens of system prompt, 4 built-in tools (read, write, edit, bash), and an extension system that lets you build exactly what you need without forking.

It ships with powerful defaults but intentionally omits features like sub-agents, plan mode, MCP, permission popups, and background bash — leaving those to extensions or third-party packages. This keeps the core small, fast, and auditable.

Pi powers OpenClaw (380k+ stars) through its SDK embedding mode.

---

## Architecture

```
                           ┌──────────────────────┐
                           │     Entry Points       │
                           │                        │
                           │  CLI  RPC  SDK  Print  │
                           └──────────┬───────────┘
                                      │
               ┌──────────────────────▼──────────────────────┐
               │            Pi Coding Agent                   │
               │  (CLI, TUI, session mgmt, extension loader)  │
               │                                               │
               │  ┌────────────────────────────────────────┐  │
               │  │        Agent Session Runtime            │  │
               │  │  (transformContext → agentLoop → emit)  │  │
               │  └────────────────────────────────────────┘  │
               │                                               │
               │  ┌────────────────────────────────────────┐  │
               │  │      Extension System                    │  │
               │  │  • Events (lifecycle, agent, tool)      │  │
               │  │  • Custom tools, commands, shortcuts    │  │
               │  │  • UI components, themes                │  │
               │  └────────────────────────────────────────┘  │
               │                                               │
               │  ┌────────────────────────────────────────┐  │
               │  │      Resource Loader                    │  │
               │  │  Skills  •  Prompts  •  Themes  •  CF  │  │
               │  └────────────────────────────────────────┘  │
               └──────────────────────┬──────────────────────┘
                                      │
               ┌──────────────────────▼──────────────────────┐
               │            pi-agent-core                     │
               │  Agent loop, tool execution, event streams   │
               │  transformContext → convertToLlm → LLM call  │
               └──────────────────────┬──────────────────────┘
                                      │
               ┌──────────────────────▼──────────────────────┐
               │                pi-ai                         │
               │  Unified LLM API • 30+ providers            │
               │  Streaming • Thinking • Tools • Token track  │
               │  OpenAI-compatible • Anthropic • Google     │
               └─────────────────────────────────────────────┘
```

### Layered Monorepo Structure

```
pi-ai          → Unified LLM API (providers, auth, streaming, tools)
pi-agent-core  → Agent loop (tool dispatch, event system, state mgmt)
pi-coding-agent → CLI + extension system + session management
pi-tui         → Terminal UI library (differential rendering)
```

Each layer builds on the one below. Packages are published individually on npm.

---

## Packages

| Package | npm | Purpose |
|---------|-----|---------|
| `@earendil-works/pi-ai` | [npm](https://www.npmjs.com/package/@earendil-works/pi-ai) | Unified LLM API — 30+ providers, streaming, thinking, tools, token tracking |
| `@earendil-works/pi-agent-core` | [npm](https://www.npmjs.com/package/@earendil-works/pi-agent-core) | Agent loop with tool execution, event streaming, state management |
| `@earendil-works/pi-coding-agent` | [npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | CLI, session management, extension system, TUI, RPC, SDK modes |
| `@earendil-works/pi-tui` | [npm](https://www.npmjs.com/package/@earendil-works/pi-tui) | Terminal UI library with differential rendering |

### pi-ai (Foundation)

Unified provider-agnostic LLM API:

- **30+ providers**: Anthropic, OpenAI, Google, Groq, Cerebras, OpenRouter, DeepSeek, xAI, Mistral, Hugging Face, Together AI, NVIDIA NIM, Amazon Bedrock, Vertex AI, GitHub Copilot, OpenCode, Ollama, LM Studio, and any OpenAI-compatible endpoint
- **Streaming** with all event types: `start`, `text_delta`, `thinking_delta`, `toolcall_delta`, `done`, `error`
- **Thinking/reasoning** support with per-provider formats (Anthropic thinking, OpenAI reasoning_effort, Google Gemini thinking)
- **Tool calling** with TypeBox schema validation, partial JSON streaming, parallel execution
- **Image input** for vision-capable models
- **Token and cost tracking** across all providers
- **Cross-provider handoffs** — switch models mid-conversation with automatic message format conversion
- **OAuth flows** for Codex, GitHub Copilot, Vertex AI
- **Custom providers** via `createProvider()` — any OpenAI/Anthropic-compatible endpoint
- **Faux provider** for testing with deterministic scripted responses

### pi-agent-core (Agent Runtime)

The agent loop engine:

- **`Agent` class** — high-level API with streaming, tool execution, state management
- **Event system** — `agent_start`, `message_update`, `tool_execution_start`, `turn_end`, etc.
- **Tool execution** — parallel (default) or sequential mode, `beforeToolCall`/`afterToolCall` hooks, `terminate` flag
- **Steering/follow-up** — queue messages while agent is working ("steer" interrupts mid-tool, "followUp" queues until idle)
- **`transformContext()`** — prune and compact messages before each LLM call
- **`convertToLlm()`** — filter custom message types, convert to provider format
- **Low-level `agentLoop()`** — for direct control without the `Agent` class
- **Proxy support** — `streamProxy()` for browser apps routing through a backend

### pi-coding-agent (CLI + Extension System)

The user-facing application:

- **4 modes**: interactive (TUI), print/JSON (non-interactive), RPC (process integration), SDK (embedding)
- **Session management**: tree-structured JSONL files with branching, compaction, fork/clone
- **Extension system**: TypeScript modules that hook into the full event lifecycle
- **Package system**: npm/git packages bundling extensions, skills, prompts, themes
- **Project trust**: scoped permissions for project-local config
- **Context files**: AGENTS.md / CLAUDE.md auto-discovery
- **Token and cost display** in footer

---

## Extension System

Extensions are TypeScript modules that export a default factory receiving `ExtensionAPI`.

### What Extensions Can Do

| Capability | API |
|------------|-----|
| Custom tools | `pi.registerTool({...})` — callable by LLM with TypeBox schemas |
| Commands | `pi.registerCommand("name", {...})` — `/name` in interactive mode |
| Keyboard shortcuts | `pi.registerShortcut("ctrl+x", {...})` |
| CLI flags | `pi.registerFlag("my-flag", {...})` |
| Lifecycle hooks | 25+ events across startup, session, agent, tool, model lifecycles |
| Custom UI components | Full TUI widgets, editor replacement, status lines, headers/footers |
| Session persistence | Per-extension state that survives restarts |
| Custom rendering | Customize how tool calls, results, and messages appear in TUI |
| Provider registration | `pi.registerProvider()` — dynamic model discovery at startup |
| Context injection | `before_agent_start` — inject messages or modify system prompt |

### Event Lifecycle

```
pi starts
  ├─ project_trust
  ├─ session_start
  ├─ resources_discover
  │
  user sends prompt
  ├─ input (intercept, transform, or handle)
  ├─ before_agent_start (inject context, modify system prompt)
  ├─ agent_start
  │  ┌─── turn (repeats while LLM calls tools) ───┐
  │  ├─ turn_start                                 │
  │  ├─ context (modify messages)                  │
  │  ├─ before_provider_request (inspect payload)  │
  │  │  LLM responds → tool calls:                 │
  │  │  ├─ tool_execution_start                    │
  │  │  ├─ tool_call (can BLOCK)                   │
  │  │  ├─ tool_execution_update                   │
  │  │  ├─ tool_result (can modify)                │
  │  │  └─ tool_execution_end                      │
  │  └─ turn_end                                   │
  └─ agent_end
```

### Key Extension Hooks for Levigen

| Hook | Purpose |
|------|---------|
| `before_agent_start` | Inject memory context into system prompt |
| `agent_end` | Save exchange to memory store |
| `context` | Prune/compact messages before LLM call |
| `tool_call` | Block dangerous commands, intercept MCP tool calls |
| `tool_result` | Post-process tool results, cache results |
| `message_end` | Capture reasoning for checkpointing |
| `input` | Classify task (chat vs reasoning), route to model |

---

## Provider & Model Support

Pi's `pi-ai` package is the most comprehensive open-source LLM provider abstraction available:

| Category | Providers |
|----------|-----------|
| **Major** | Anthropic (Claude), OpenAI (GPT, o-series), Google (Gemini) |
| **Enterprise** | Azure OpenAI, Amazon Bedrock, Vertex AI, NVIDIA NIM |
| **Open-source** | Ollama, vLLM, **LM Studio**, Hugging Face, Fireworks, Together AI |
| **Fast inference** | Groq, Cerebras, DeepSeek, Mistral |
| **Aggregators** | OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway |
| **Subscription** | GitHub Copilot, ChatGPT Codex (OAuth), Ant Ling |
| **Regional** | Kimi For Coding, MiniMax, Xiaomi MiMo, ZAI Coding Plan, Moonshot AI |
| **Custom** | Any OpenAI-compatible, Anthropic-compatible, or Google-compatible endpoint via `createProvider()` |

### Auth Resolution

- Environment variables (per provider)
- Credential store (persistent, OAuth token refresh)
- Per-request override (`apiKey`)
- OAuth flows (Codex, Copilot, Vertex AI)
- Auto-resolution — first configured source wins

---

## Session Management

Sessions are stored as JSONL files with tree structure:

```
~/.pi/agent/sessions/
└── <cwd-hash>/
    └── <session-id>.jsonl
```

### Features

| Feature | Description |
|---------|-------------|
| **Tree structure** | Each entry has `id` + `parentId` — branching without copy |
| **`/tree`** | Navigate branches, filter by type, label bookmarks |
| **Compaction** | Auto/manual summarization of old context when hitting context limits |
| **Fork/clone** | Create new sessions from any point in history |
| **Resume** | `-c` continues most recent, `-r` browses all |
| **Export** | HTML or JSONL format |
| **Share** | GitHub Gist with rendered HTML |

---

## Four Modes

| Mode | Flag | Description |
|------|------|-------------|
| **Interactive** | (default) | Full TUI with editor, commands, streaming, themes |
| **Print/JSON** | `-p` / `--mode json` | Non-interactive, pipe-friendly, structured output |
| **RPC** | `--mode rpc` | JSONL over stdin/stdout — for non-Node.js integrations |
| **SDK** | Programmatic | `createAgentSession()` — embed Pi in any app |

---

## Strong Points

- **Radically minimal core** — ~1000 token system prompt, 4 built-in tools. Easy to audit, understand, and extend.
- **Comprehensive LLM abstraction** — pi-ai supports 30+ providers with a unified streaming/thinking/tools API. Best-in-class for open source.
- **Extension system is genuinely extensible** — TypeScript modules with 25+ lifecycle events. You can do anything from MCP integration to full editor replacement without forking.
- **Proven at scale** — Powers OpenClaw (380k+ stars, 50+ platforms). The SDK/RPC modes are production-tested.
- **Session tree branching** — Native branch/session management that's better than most coding agents.
- **Security-first supply chain** — Pinned deps, shrinkwrap, CI audit, `--ignore-scripts`.
- **Cross-provider handoffs** — Switch models mid-conversation with automatic format conversion.
- **No vendor lock-in** — 30+ providers, custom provider API, local-first.

---

## Weak Points

- **No built-in persistent memory** — Sessions are isolated. No cross-session recall, user profiling, or fact extraction. You must build an extension for this (which is what we're doing).
- **No built-in MCP** — Deliberately excluded. The philosophy is "build CLI tools with READMEs." MCP requires an extension or third-party package.
- **No daemon mode** — Pi runs as a CLI process. No 24/7 gateway, no message queue, no crash recovery. You need RPC mode + a supervisor process.
- **No multi-channel support** — CLI only. OpenClaw is the multi-channel version built on Pi's SDK.
- **No sub-agents, plan mode, permission popups, or background bash** — Deliberately excluded. You build these via extensions.
- **TypeScript only** — Extensions must be written in TypeScript. No Python or other language support.
- **Single-user** — No multi-tenant or multi-profile isolation in the core.
- **No scheduling/cron** — No built-in task scheduling or time-based triggers.

---

## Use Cases

| Use Case | How |
|----------|-----|
| **Coding assistant** | Native — built-in tools (read, write, edit, bash) |
| **Custom agent harness** | Fork/extend Pi with extensions for memory, MCP, etc. |
| **Multi-channel gateway backend** | Pi + RPC/SDK mode — embed in a larger app (OpenClaw pattern) |
| **Local model playground** | Pi + Ollama/LM Studio — test local models with full tool support |
| **CI/CD agent** | Print/JSON mode — integrate into automated pipelines |
| **SDK embedding** | `createAgentSession()` — embed agent in any Node.js app |
| **Training data generation** | Batch mode + trajectory export for fine-tuning |
