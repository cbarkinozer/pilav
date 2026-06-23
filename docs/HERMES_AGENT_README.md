# Hermes Agent — The Self-Improving AI Agent

**Stars:** 200k+ (fastest-growing agent framework of 2026) | **Language:** Python | **License:** MIT
**Author:** Nous Research (teknium1, etc.) | **Release:** February 2026

**Repo:** [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
**Docs:** [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs)
**Site:** [hermes-agent.org](https://hermes-agent.org)

---

- [Overview](#overview)
- [Architecture](#architecture)
- [Memory System](#memory-system)
- [Skill System (Self-Improving)](#skill-system-self-improving)
- [Messaging Gateway](#messaging-gateway)
- [Tool System](#tool-system)
- [Cron & Scheduling](#cron--scheduling)
- [Strong Points](#strong-points)
- [Weak Points](#weak-points)
- [Comparison: Hermes vs Pi vs OpenClaw](#comparison-hermes-vs-pi-vs-openclaw)

---

## Overview

Hermes Agent is the first self-hosted AI agent with a **built-in learning loop**. Created by Nous Research (the lab behind the Hermes model family and Atropos RL environments), it runs persistently on your machine, connects to your messaging apps, and gets smarter the longer you use it.

It's not a coding copilot or a chatbot — it's an **autonomous agent** that:
- **Remembers** everything across sessions via multi-layer memory (SQLite + FTS5, semantic search, Honcho dialectic modeling)
- **Creates skills** from experience — writes new SKILL.md files as it solves problems, improves them during use
- **Schedules work** via natural-language cron — "remind me daily" works out of the box
- **Reaches you** on Telegram, Discord, Slack, WhatsApp, Signal, and 15+ other platforms
- **Generates training data** — exports tool-calling trajectories in ShareGPT format for fine-tuning
- **Runs anywhere** — $5 VPS, GPU cluster, serverless (Modal, Daytona), Mac, Windows, Linux

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Entry Points                                  │
│  CLI (cli.py)    Gateway (gateway/run.py)    ACP (acp_adapter/)     │
│  Batch Runner    API Server                  Python Library          │
└──────────┬──────────────┬───────────────────────┬───────────────────┘
           │              │                       │
           ▼              ▼                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AIAgent (run_agent.py)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ Prompt       │  │ Provider     │  │ Tool         │               │
│  │ Builder      │  │ Resolution   │  │ Dispatch     │               │
│  │ (prompt_     │  │ (runtime_    │  │ (model_      │               │
│  │  builder.py) │  │  provider.py)│  │  tools.py)   │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐               │
│  │ Compression  │  │ 3 API Modes  │  │ Tool Registry│               │
│  │ & Caching    │  │ chat_compl.  │  │ 70+ tools    │               │
│  │              │  │ codex_resp.  │  │ 28 toolsets  │               │
│  │              │  │ anthropic    │  │              │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
└─────────┴─────────────────┴─────────────────┴───────────────────────┘
          │                                    │
          ▼                                    ▼
┌───────────────────┐              ┌──────────────────────┐
│ Session Storage    │              │ Tool Backends         │
│ (SQLite + FTS5)    │              │ Terminal (6 backends) │
│ hermes_state.py    │              │ Browser (5 backends)  │
│ gateway/session.py │              │ Web (4 backends)      │
└───────────────────┘              │ MCP (dynamic)         │
                                   │ File, Vision, etc.    │
                                   └──────────────────────┘
```

### Data Flow

**CLI Session:**
```
User input → HermesCLI.process_input()
  → AIAgent.run_conversation()
    → prompt_builder.build_system_prompt()
    → runtime_provider.resolve_runtime_provider()
    → API call (chat_completions / codex_responses / anthropic_messages)
    → tool_calls → model_tools.handle_function_call() → loop
    → final response → display → save to SessionDB
```

**Gateway Message:**
```
Platform event → Adapter.on_message() → MessageEvent
  → GatewayRunner._handle_message()
    → authorize user → resolve session key
    → create AIAgent with session history
    → AIAgent.run_conversation()
    → deliver response back through adapter
```

**Cron Job:**
```
Scheduler tick → load due jobs from jobs.json
  → create fresh AIAgent (no history)
  → inject attached skills as context
  → run job prompt → deliver response to target platform
```

### Directory Structure

```
hermes-agent/
├── run_agent.py              # AIAgent — core conversation loop
├── cli.py                    # HermesCLI — interactive terminal UI
├── model_tools.py            # Tool discovery, schema collection, dispatch
├── hermes_state.py           # SQLite session/state database with FTS5
├── batch_runner.py           # Batch trajectory generation
│
├── agent/                    # Agent internals
│   ├── prompt_builder.py     # System prompt assembly (3-tier: stable/context/volatile)
│   ├── context_compressor.py # Lossy summarization of middle turns
│   ├── prompt_caching.py     # Anthropic prompt caching
│   ├── memory_manager.py     # Memory manager orchestration
│   ├── memory_provider.py    # Memory provider ABC (pluggable backends)
│   ├── skill_commands.py     # Skill slash commands
│   ├── trajectory.py         # Trajectory saving for training data
│   └── ...
│
├── hermes_cli/               # CLI subcommands
│   ├── config.py, auth.py    # Config and credential management
│   ├── runtime_provider.py   # Provider → API mode + credentials
│   ├── models.py             # Model catalog
│   ├── plugins.py            # PluginManager — discovery, loading, hooks
│   └── ...
│
├── tools/                    # Tool implementations (70+ tools, 28 toolsets)
│   ├── registry.py           # Central tool registry
│   ├── terminal_tool.py      # Terminal orchestration (6 backends)
│   ├── browser_tool.py       # 10 browser automation tools
│   ├── file_tools.py         # read/write/patch/search
│   ├── web_tools.py          # web_search, web_extract
│   ├── code_execution_tool.py# Sandboxed code execution
│   ├── delegate_tool.py      # Subagent delegation
│   ├── mcp_tool.py           # MCP client
│   └── environments/         # Terminal backends
│
├── gateway/                  # Messaging platform gateway
│   ├── run.py                # GatewayRunner — message dispatch
│   ├── session.py            # SessionStore — conversation persistence
│   ├── delivery.py           # Outbound message delivery
│   ├── pairing.py            # DM pairing authorization
│   ├── hooks.py              # Hook system (pre/post LLM call)
│   └── platforms/            # 20 adapters (Telegram, Discord, etc.)
│
├── cron/                     # Scheduler (jobs.py, scheduler.py)
├── plugins/memory/           # Memory provider plugins (Honcho, Hindsight, etc.)
├── acp_adapter/              # ACP server (VS Code / Zed / JetBrains)
├── skills/                   # Bundled skills (118+, always available)
└── tests/                    # ~25,000 tests across ~1,250 files
```

### Design Principles

| Principle | Practice |
|-----------|---------|
| **Prompt stability** | System prompt never changes mid-conversation. No cache-breaking mutations. |
| **Observable execution** | Every tool call visible via callbacks. CLI spinner + gateway chat messages. |
| **Interruptible** | API calls and tool execution cancellable mid-flight by user input. |
| **Platform-agnostic core** | One AIAgent class serves CLI, gateway, ACP, batch, API server. |
| **Loose coupling** | MCP, plugins, memory providers use registry/gating, not hard deps. |
| **Profile isolation** | Each `hermes -p <name>` gets own HERMES_HOME, config, sessions, gateway PID. |

---

## Memory System

Hermes Agent's memory is its standout feature — the most sophisticated memory architecture of any open-source agent.

### Three-Layer Architecture

| Layer | Backend | Scope | Purpose |
|-------|---------|-------|---------|
| **1. Native (built-in)** | SQLite + FTS5 + MEMORY.md + USER.md | Session persistence, full-text search | Conversation history, manual agent-curated notes |
| **2. Memory Provider (pluggable)** | Honcho, Hindsight, Nowledge Mem, GBrain | Cross-session, semantic, dialectic | User modeling, semantic recall, automatic fact extraction |
| **3. Skill System** | SKILL.md files on disk | Procedural memory | Reusable task knowledge created from experience |

### Native Memory (Layer 1)

- **SQLite session storage** with FTS5 full-text search across all sessions
- **Session lineage** — parent/child tracking across compressions
- **Per-platform isolation** — separate sessions per messaging platform
- **Atomic writes** with contention handling
- `MEMORY.md` and `USER.md` — files the agent reads/writes via tools

### Honcho Memory Provider (Layer 2 — the "Knows You" component)

[Hemcho](https://honcho.dev) adds dialectic reasoning and deep user modeling:

| Capability | What it does |
|-----------|-------------|
| Dialectic reasoning | After each conversation turn, analyzes exchange → derives insights about user preferences, habits, goals |
| Session-scoped context | Inject session summary + user representation + peer card into system prompt |
| Multi-agent profiles | Separate "peer" profiles per AI instance talking to same user |
| Dual-peer architecture | User peer (preferences, style) + AI peer (agent's knowledge representation) |
| Semantic search | Query past conclusions via similarity search |
| Cross-session continuity | Preferences learned in one session persist across all future sessions |

**Four Honcho tools exposed to the agent:**

| Tool | Function |
|------|----------|
| `honcho_profile` | Fast peer card retrieval (no LLM) |
| `honcho_search` | Semantic search over memory |
| `honcho_context` | Dialectic Q&A — synthesizes answers from conversation history |
| `honcho_conclude` | Writes durable facts to Honcho when user states preferences |

### Cognitive Memory (upcoming — Phase 1 of proposed feature)

Inspired by CrewAI's cognitive memory system. Planned additions:
- **Encoding analysis** — auto-classify memories, detect contradictions
- **Confidence-aware retrieval** — system knows when it's unsure
- **Automatic extraction** from tool outputs and conversation context
- **Importance decay** — stale memories pruned over time
- **Scoped access** — per-user memory subtrees for gateway platforms

---

## Skill System (Self-Improving)

This is the "built-in learning loop" that makes Hermes unique:

### How Skills Work

```
1. Agent solves a novel problem using tools
2. Agent identifies the solution as reusable
3. Agent writes a SKILL.md file to ~/.hermes/skills/
4. On future related tasks, the skill is auto-loaded
5. Agent improves the skill during use (refinement loop)
```

### Skill Format

SKILL.md follows the [Agent Skills standard](https://agentskills.io):

```markdown
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

### Bundled Skills

- 118+ bundled skills (always available)
- Community skills via [agentskills.io](https://agentskills.io)
- Auto-created skills — infinite, generated from experience
- Per-platform skill enable/disable

---

## Messaging Gateway

Long-running daemon with 20 platform adapters:

| Platform | Support |
|----------|---------|
| **Telegram** | Full — messages, files, commands |
| **Discord** | Full — messages, slash commands, threads |
| **Slack** | Full — messages, channels, DMs |
| **WhatsApp** | Via business API |
| **Signal** | Via signal-cli |
| **iMessage** | Via BlueBubbles bridge |
| **Microsoft Teams** | Full |
| **Matrix** | Full |
| **IRC** | Full |
| **Email** | SMTP/IMAP |
| **SMS** | Via gateway |
| **+ 10 more** | DingTalk, Feishu, WeCom, QQ, etc. |

### Gateway Features

- Unified session routing per platform/user
- User authorization (allowlists + DM pairing)
- Slash command dispatch
- Hook system (pre/post LLM call)
- Background maintenance
- Cron ticking
- Profile-scoped process isolation

---

## Tool System

70+ registered tools across ~28 toolsets. Each tool file self-registers at import time via `registry.register()`.

### Tool Categories

| Category | Tools | Backends |
|----------|-------|----------|
| **Terminal** | bash, execute, process management | 6 backends: local, Docker, SSH, Daytona, Modal, Singularity |
| **Browser** | navigate, click, type, screenshot, extract | 5 backends |
| **Web** | search, fetch, extract | 4 backends |
| **File** | read, write, patch, search, glob | Local + sandboxed |
| **Code execution** | execute_code | Python sandbox, arbitrary language |
| **MCP** | Dynamic MCP server tool loading | Any MCP server |
| **Vision** | Image analysis, OCR | Multi-model |
| **Audio** | Text-to-speech, speech-to-text | Multiple providers |
| **Delegation** | Subagent spawning | Recursive Hermes instances |
| **Memory** | Native + Honcho + plugin-based | Pluggable backends |

### Tool Backends

| Backend | Execution Environment |
|---------|---------------------|
| **Local** | Direct host execution |
| **Docker** | Containerized with security hardening (read-only root, dropped capabilities, PID limits) |
| **SSH** | Remote server execution |
| **Daytona** | Cloud dev environment |
| **Modal** | Serverless cloud execution |
| **Singularity** | HPC container |

---

## Cron & Scheduling

First-class agent tasks (not shell tasks):

- **Natural language scheduling** — "remind me daily at 9am" works
- **Multiple schedule formats** — cron expressions, natural language, intervals
- **Skill attachment** — jobs can attach skills and scripts
- **Platform delivery** — results sent to any messaging platform
- **Job state persistence** — stored in JSON with next_run tracking

---

## Strong Points

- **Self-improving skill system** — The only open-source agent that creates, refines, and persists skills from experience. This is the genuine differentiator — it compounds in capability over time.
- **Deepest memory architecture** — 3-layer system (SQLite + pluggable providers + skills) with dialectic user modeling via Honcho. Cross-session recall actually works.
- **Most comprehensive tool ecosystem** — 70+ tools, 28 toolsets, 6 terminal backends, 5 browser backends, 4 web backends. Best-in-class for open source agents.
- **20 messaging platforms** — Widest multi-channel support of any agent. Telegram, Discord, Slack, WhatsApp, Signal, iMessage, Teams, Matrix, IRC, email, SMS, and more.
- **Training data generation** — Built-in trajectory export in ShareGPT format for fine-tuning models on agent behavior. Direct RL pipeline integration with Atropos.
- **Batch processing** — Generate thousands of tool-calling trajectories in parallel with checkpointing.
- **Profile isolation** — Multiple independent agent profiles running concurrently, each with its own config, memory, sessions, and gateway.
- **Massive community** — 200k+ stars, 35k+ forks, fastest-growing agent framework of 2026.

---

## Weak Points

- **Python stack** — Slower than TypeScript alternatives for the agent loop itself. No tree-shaking or static analysis benefits.
- **No built-in test-time scaling** — No native extended reasoning loop for hours-long tasks. Cron scheduling exists but no checkpoint/resume for long single tasks.
- **Memory provider fragmentation** — Multiple competing providers (Honcho, Hindsight, Nowledge Mem, GBrain) with different APIs and setup complexity. No "just works" default.
- **Desktop app is new** — Hermes Desktop was released after the CLI, still maturing.
- **No SDK embedding mode** (like Pi's AgentSession) — You can't embed Hermes in another app as a library as easily as Pi.
- **Complex setup for self-hosting** — Requires Python 3.11, uv, clone, setup wizard. Not as simple as `npm install -g`.
- **MCP is server-only** — Hermes connects to MCP servers but doesn't expose itself as an MCP server to other apps (unlike OpenClaw).
- **No local-only offline mode** — Many memory providers (Honcho, Hindsight) require cloud API keys by default.
- **Python dependency chain** — Can be brittle across Python versions, especially for ML dependencies.

---

## Comparison: Hermes vs Pi vs OpenClaw

| Feature | Hermes Agent | Pi | OpenClaw |
|---------|-------------|-----|----------|
| **Language** | Python | TypeScript | TypeScript |
| **Memory** | 3-layer (SQLite + plugins + skills) | None (session-isolated) | SQLite + sessions |
| **Self-improving skills** | **Yes** (unique) | No | No |
| **Skill auto-creation** | **Yes** | No | No |
| **Messaging platforms** | 20+ | CLI only (RPC/SDK for embedding) | **50+** |
| **Built-in tools** | 70+ | 4 (read/write/edit/bash) | 12+ |
| **MCP** | Client mode | Via extension | **Client + Server mode** |
| **Test-time scaling** | No | No | No |
| **SDK embedding** | Limited | **First-class** | First-class |
| **Provider support** | 18+ | **30+** | 20+ |
| **Batch/trajectory gen** | **Built-in** | Via extension | No |
| **Cron/scheduling** | **First-class** | No | Limited |
| **Token tracking** | Yes | **Built-in** | Yes |
| **Install** | `curl | bash` | `npm install -g` | `npm install -g` |
| **Stars** | 200k | 65k | 380k |
