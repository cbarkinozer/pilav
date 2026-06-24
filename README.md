# pilav

A memory-persistent AI agent — forked from [Pi](https://github.com/earendil-works/pi) — that knows you across sessions, works 24/7 on your Mac Mini, reaches you via Telegram, and can think for up to 10 hours on complex tasks.

**Name:** *pilav* — pi + pilav (Turkish rice dish). A fork of Pi.

---

- [What is Pilav?](#what-is-pilav)
- [Architecture](#architecture)
- [The Four Pillars](#the-four-pillars)
  - [1. Hermes-like Memory](#1-hermes-like-memory)
  - [2. Test-Time Scaling (up to 10h)](#2-test-time-scaling-up-to-10h)
  - [3. MCP Tool Integration](#3-mcp-tool-integration)
  - [4. Telegram Gateway](#4-telegram-gateway)
- [Why Fork Pi?](#why-fork-pi)
- [Stack Overview](#stack-overview)
- [Model Strategy](#model-strategy)
- [Project Structure](#project-structure)
- [Phase Plan](#phase-plan)
  - [Phase 1 — Fork & Core](#phase-1--fork--core)
  - [Phase 2 — Telegram Gateway](#phase-2--telegram-gateway)
  - [Phase 3 — Memory & Recall](#phase-3--memory--recall)
  - [Phase 4 — MCP & Tools](#phase-4--mcp--tools)
  - [Phase 5 — Test-Time Scaling](#phase-5--test-time-scaling)
  - [Phase 6 — Speed & Fidelity (Future)](#phase-6--speed--fidelity-future)
- [Performance Targets](#performance-targets)
- [Quick Start (placeholder)](#quick-start-placeholder)
- [License](#license)
- [Inspiration](#inspiration)

---

## What is Pilav?

Pilav is an always-on AI agent based on a fork of [Pi](https://github.com/earendil-works/pi) — the minimalist TypeScript agent harness by Mario Zechner that powers [OpenClaw](https://github.com/OpenClaw/OpenClaw). We chose Pi because it ships with exactly the right foundation: a clean agent loop, tool execution, session management, event streaming, and an extensible plugin architecture — all in ~1000 tokens of system prompt.

We fork Pi to add four things it intentionally leaves out:

1. **Persistent memory** — Hermes-like dialectic user modeling across sessions (SQLite + FTS5). It knows your coding style, project context, preferences, and goals. You never have to re-explain yourself.

2. **Test-time scaling** — The agent can reason for minutes to hours on a single task, checkpointing progress and streaming status to you on Telegram. Overnight research, codebase analysis, dataset prep — it keeps working while you sleep.

3. **MCP (Model Context Protocol)** — Standardized tool integration so the agent can use filesystem, shell, web, git, and custom MCP servers through a unified interface.

4. **Telegram gateway** — A Node.js daemon that lets you message the agent from anywhere. Long-running tasks send progress updates. `/status` checks in, `/cancel` aborts cleanly.

The agent runs 24/7 on an M4 Mac Mini (24GB) via [LM Studio](https://lmstudio.ai/) serving local models. Later phases will push speed further with model distillation, multi-token prediction, MLX-native loading, and TurboQuant KV-cache compression — all aimed at making small language models (1-4B) fast and capable enough to be genuine personal assistants.

---

## Architecture

```
                         ┌─────────────────────────────────┐
                         │           Telegram Bot           │
                         │  (messages, files, commands)     │
                         └───────────────┬─────────────────┘
                                         │
                         ┌───────────────▼─────────────────┐
                         │      Gateway Daemon (Node.js)     │
                         │  Telegram long-polling → queue    │
                         │  Session routing, auth, rate-limit│
                         │  launchd-managed (auto-start,     │
                         │  crash recovery, 24/7)           │
                         └───────────────┬─────────────────┘
                                         │    RPC mode (stdin/stdout JSONL)
                         ┌───────────────▼─────────────────┐
                         │     Pi Agent (fork — TypeScript)  │
                         │                                   │
                         │  ┌─────────────────────────────┐  │
                         │  │  Memory Extension            │  │
                         │  │  • onBeforePrompt: inject    │  │
                         │  │    relevant past context     │  │
                         │  │  • onAfterResponse: save     │  │
                         │  │  • Fact extraction + profile │  │
                         │  └─────────────────────────────┘  │
                         │                                   │
                         │  ┌─────────────────────────────┐  │
                         │  │  MCP Extension               │  │
                         │  │  • Filesystem, Shell, Web,   │  │
                         │  │    Git, Custom MCP servers   │  │
                         │  │  • Sandboxed execution       │  │
                         │  │  • Tool result caching       │  │
                         │  └─────────────────────────────┘  │
                         │                                   │
                         │  ┌─────────────────────────────┐  │
                         │  │  TTS Extension               │  │
                         │  │  • Extended reasoning loop   │  │
                         │  │  • Checkpoint/resume         │  │
                         │  │  • Status streaming          │  │
                         │  │  • Graceful interrupt        │  │
                         │  └─────────────────────────────┘  │
                         │                                   │
                          └───────────────┬─────────────────┘
                                         │    OpenAI-compatible API
                         ┌───────────────▼─────────────────┐
                         │         LM Studio (local)         │
                         │  ┌──────────────────────────┐    │
                         │  │  Gemma 4 4B (fast chat)  │    │
                         │  │  Qwen 3.5 8B (reasoning) │    │
                         │  └──────────────────────────┘    │
                         │  Mac Mini M4 — 24GB — 120 GB/s   │
                         └─────────────────────────────────┘
```

### Message Flow

```
1. User sends message via Telegram
2. Gateway receives it, enqueues, classifies task type (chat vs reasoning)
3. Gateway spawns/connects to Pi via RPC mode
4. Pi loads relevant memory context from SQLite (past sessions, user profile, facts)
5. Pi runs agent loop: prompt → model inference (LM Studio) → tool calls (MCP) → response
6. Memory extension extracts facts and saves exchange
8. Response streamed back through Gateway → Telegram
```

For long-running tasks (Phase 5), the TTS extension adds:
- Periodic checkpoint saves every N steps
- `/status` reports current progress (e.g., "Step 47/120 — analyzing file tree...")
- `/cancel` stops cleanly and returns accumulated results

---

## The Four Pillars

### 1. Hermes-like Memory

Inspired by [Hermes Agent](https://github.com/NousResearch/Hermes), this is the core differentiator: the agent knows you across sessions.

**What it stores:**

| Store | Schema | Purpose |
|-------|--------|---------|
| Conversation history | SQLite with FTS5 | Full-text search across all past exchanges |
| User profile | JSON in SQLite | Dialectic model: coding style, preferences, project context, goals. Updated after each session. |
| Facts | Key-value with source | Extracted facts from conversations (e.g., "user prefers tabs over spaces", "project uses FastAPI") |
| Session tree | JSONL (Pi native) | Tree-structured branching history preserved |

**How it works:**

- **On agent start (`onBeforePrompt`):** Queries memory for relevant context — similar past sessions, current user profile, recent facts — and injects them into the system prompt as contextual preamble.
- **On response saved (`onAfterResponse`):** Saves the exchange, runs fact extraction (few-shot prompt to extract factual statements), updates user profile via dialectic analysis.
- **Cross-session synthesis:** After N sessions, runs a background synthesis that reconciles contradictions in the user profile and generates a consolidated portrait.

**Dialectic user modeling (the "Knows You" trick):**
Rather than storing static preferences, the memory system maintains a thesis/antithesis/synthesis model of the user. Each session provides evidence that either confirms or contradicts the current model. After N sessions, a synthesis step reconciles contradictions. This prevents the agent from getting stuck on outdated assumptions.

### 2. Test-Time Scaling (up to 10h)

Long-horizon reasoning is what separates a toy agent from a genuinely useful one. Pilav can work on a single task for hours — overnight research, multi-step codebase refactoring, dataset generation, project builds.

**Core loop:**

```
1. User sends task → TTS extension activates
2. Agent enters extended reasoning mode:
   a. Break task into subtasks (planning step)
   b. Execute subtasks one by one
   c. After each N steps: checkpoint to disk (JSON snapshot)
   d. Every checkpoint: send status update to Telegram
3. On completion: final summary sent to Telegram
4. On /cancel: graceful shutdown, partial results returned
```

**Checkpoint format (versioned, in `.pilav/checkpoints/`):**

```json
{
  "sessionId": "abc123",
  "checkpointId": "ckpt-047",
  "timestamp": "2026-06-23T03:14:00Z",
  "elapsedMs": 3420000,
  "step": 47,
  "totalSteps": 120,
  "currentTask": "Analyze dependency graph",
  "context": {
    "messages": [...],        // full message history to this point
    "toolResults": [...],     // tool outputs
    "scratchpad": "..."       // agent's reasoning so far
  },
  "status": "working"
}
```

**Crash recovery:** On restart after crash, the TTS extension detects incomplete checkpoints and offers to resume from the last one.

### 3. MCP Tool Integration

Model Context Protocol (MCP) provides a standardized interface for tool integration. Pilav ships with built-in MCP servers and supports custom ones.

**Built-in MCP servers:**

| Server | Tools | Description |
|--------|-------|-------------|
| Filesystem | `read`, `write`, `edit`, `ls`, `glob`, `grep` | Full filesystem access with optional sandboxing |
| Shell | `bash`, `execute` | Command execution in isolated temp directories |
| Web | `fetch`, `search` | Web fetcher + search via MCP gateway |
| Git | `status`, `diff`, `log`, `commit` | Git operations with safety gates |

**Custom MCP servers:** Any MCP-compatible server can be added via config. The MCP extension auto-discovers servers from `.pilav/mcp/` or config.

**Sandboxing:** Shell commands run in isolated temp directories by default. Optionally, the entire agent can be Docker-containerized for stronger boundaries (see Pi's [containerization docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)).

### 4. Telegram Gateway

A self-contained Node.js daemon that sits between Telegram and the Pi agent.

**Features:**

| Feature | Detail |
|---------|--------|
| Bot library | `node-telegram-bot-api` (long-polling, no webhook needed) |
| 24/7 operation | `launchd` plist auto-starts on boot, restarts on crash |
| Message queue | Concurrent requests dispatched sequentially per user |
| Session routing | Separate agent contexts per chat/user |
| Long task support | `/status` returns progress, `/cancel` aborts |
| File/media | Code snippets, images, documents exchanged |
| Markdown rendering | Assistant responses rendered as Telegram MarkdownV2 |

**launchd plist:** The gateway registers as a LaunchAgent — starts on login, survives terminal close, restarts automatically if it crashes.

**CLI fallback:** When Telegram is unavailable or you're at the machine, Pilav works as a standard Pi CLI with all extensions loaded.

---

## Why Fork Pi?

We evaluated building from scratch, forking Pi, and using Pi as an npm dependency. We chose to fork.

**Why not from scratch:** Pi already has 2+ years of battle-tested development, a clean extension API, tree-session management, multi-provider support, RPC/SDK modes, and a large community. Rewriting it would waste time and inevitably miss edge cases.

**Why not just use Pi as a dependency:** We need deep hooks into the agent lifecycle that the extension API alone can't provide without performance overhead. Specifically:

- The memory system needs to intercept and modify system prompt assembly before every turn — currently possible via `transformContext()` in `pi-agent-core`, but we need guaranteed ordering with other extensions.
- The TTS extension needs direct access to the agent loop to inject checkpoint pauses between tool calls — a natural extension point but one that benefits from a tighter integration.

**What we send upstream:** Bug fixes, small improvements, and well-isolated extensions that can work with vanilla Pi. We maintain a `upstream` branch that tracks `earendil-works/pi` for easy merging.

---

## Stack Overview

| Layer | Technology | Role |
|-------|-----------|------|
| Agent harness | TypeScript (Pi fork) | Agent loop, tool execution, session management |
| Memory sidecar | Python + SQLite + FTS5 | Persistent storage, full-text search, fact extraction |
| Gateway | Node.js + `node-telegram-bot-api` | Telegram daemon, message routing, 24/7 operation |
| Models | Gemma 4 4B / Qwen 3.5 8B via LM Studio | Local inference on M4 Mac Mini |
| MCP | TypeScript (Pi extension) | Model Context Protocol server integration |
| Containerization | Docker (optional) | Sandboxed execution for untrusted tasks |
| Process supervision | launchd | Auto-start, crash recovery, logging |

---

## Model Strategy

### LM Studio Integration

We use LM Studio instead of Ollama for two reasons:
1. **Fine-grained control** over quantization, context length, GPU layers, and inference parameters
2. **OpenAI-compatible API** — Pi's `@earendil-works/pi-ai` supports custom OpenAI-compatible endpoints out of the box

```typescript
// models config — loaded via Pi's models.json or extension
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "not-needed"
    }
  },
  "models": {
    "lmstudio/gemma-4-4b": {
      "provider": "lmstudio",
      "pattern": "gemma-4-4b",
      "description": "Fast chat model (~30 tok/s)"
    },
    "lmstudio/qwen-3.5-8b": {
      "provider": "lmstudio",
      "pattern": "qwen-3.5-8b",
      "description": "Reasoning model (~25 tok/s)"
    }
  }
}
```

### Model Dispatch

An extension classifies each incoming task and routes to the appropriate model:

```
Task ───► Classifier ───► Fast chat (Gemma 4 4B): conversational, quick edits, status
                          │
                          └──► Reasoning (Qwen 3.5 8B): complex coding, analysis, TTS
```

Classification is lightweight: keyword-based + LLM-as-judge (the fast model itself decides, ~50ms overhead).

### Performance Table

| Model | Quant | RAM | Est. tok/s (M4) | Use case |
|-------|-------|-----|-----------------|----------|
| Gemma 4 4B | 4-bit | ~3 GB | ~30 | Chat, quick edits, classification |
| Qwen 3.5 8B | 4-bit | ~5 GB | ~25 | Reasoning, coding, deep analysis |

Both fit comfortably in 24GB RAM simultaneously. LM Studio keeps both loaded and swaps on dispatch.

---

## Project Structure

```
pilav/
│
├── agent/                          # Pi fork — modified agent core
│   ├── packages/
│   │   ├── ai/                     # Unified LLM API (upstream + patches)
│   │   ├── agent-core/             # Agent loop, tool execution, events (upstream + patches)
│   │   └── coding-agent/           # CLI entrypoint + extension system (upstream + patches)
│   ├── extensions/
│   │   ├── memory/                 # Hermes-like memory extension
│   │   │   ├── src/
│   │   │   │   ├── index.ts        # Extension factory: hooks into lifecycle
│   │   │   │   ├── store.ts        # SQLite + FTS5 storage layer
│   │   │   │   ├── profile.ts      # Dialectic user modeling
│   │   │   │   ├── extractor.ts    # Fact extraction from conversations
│   │   │   │   └── search.ts       # Semantic + FTS5 query over past sessions
│   │   │   └── schema.sql
│   │   ├── mcp/                    # MCP tool integration
│   │   │   ├── src/
│   │   │   │   ├── index.ts        # Extension factory
│   │   │   │   ├── client.ts       # MCP client (stdio + SSE transports)
│   │   │   │   └── servers/        # Built-in MCP server implementations
│   │   │   │       ├── filesystem.ts
│   │   │   │       ├── shell.ts
│   │   │   │       ├── web.ts
│   │   │   │       └── git.ts
│   │   │   └── config.ts
│   │   ├── tts/                    # Test-time scaling
│   │   │   ├── src/
│   │   │   │   ├── index.ts        # Extension factory
│   │   │   │   ├── loop.ts         # Extended reasoning loop
│   │   │   │   ├── checkpoint.ts   # Checkpoint/resume logic
│   │   │   │   └── streaming.ts    # Status streaming to gateway
│   │   │   └── config.ts
│   │   └── dispatch/               # Model dispatch by task type
│   │       ├── src/
│   │       │   ├── index.ts
│   │       │   └── classifier.ts
│   │       └── config.ts
│   ├── prompts/                    # System prompts per model
│   │   ├── gemma-4-chat.md
│   │   ├── qwen-reasoning.md
│   │   └── memory-preamble.md      # Injected by memory extension
│   └── lib/                        # Pi core patches
│
├── gateway/                        # Telegram daemon (Node.js)
│   ├── src/
│   │   ├── index.ts                # Entry: bot setup, launchd integration
│   │   ├── bot.ts                  # Telegram bot handlers
│   │   ├── router.ts               # Message → session routing
│   │   ├── pi-client.ts            # RPC client to Pi agent
│   │   ├── queue.ts                # Message queue per user
│   │   └── types.ts
│   ├── launchd/
│   │   └── com.pilav.gateway.plist
│   ├── package.json
│   └── tsconfig.json
│
├── memory/                         # Python memory sidecar (optional)
│   ├── src/
│   │   ├── server.py               # FastAPI or Unix socket server
│   │   ├── store.py                # SQLite operations
│   │   ├── profile.py              # Dialectic user model
│   │   └── extract.py              # Fact extraction via LM
│   ├── schema.sql
│   ├── requirements.txt
│   └── pyproject.toml
│
├── models/                         # LM Studio configs and prompt templates
│   ├── gemma-4-4b.json             # LM Studio preset
│   ├── qwen-3.5-8b.json
│   ├── system-prompts/
│   │   ├── chat.md
│   │   └── reasoning.md
│   └── routing.md                  # Classification rules
│
├── config/                         # Shared configuration
│   ├── default.json
│   ├── local.json.example
│   └── schema.json
│
├── scripts/                        # Utility scripts
│   ├── setup.sh                    # First-time setup (LM Studio check, npm install, launchd)
│   ├── dev.sh                      # Local development launcher
│   └── benchmark.sh                # Model performance benchmark
│
├── docs/                           # Documentation
│   ├── memory.md
│   ├── gateway.md
│   ├── tts.md
│   └── development.md
│
├── package.json
├── tsconfig.json
├── biome.json
└── README.md
```

---

## Phase Plan

### Phase 1 — Fork & Core

*Week 1 — Goal: working Pi fork with LM Studio and a basic memory extension.*

- [x] Fork `earendil-works/pi` — track upstream branch
- [x] Configure for LM Studio (OpenAI-compatible endpoint in `models.json`)
- [x] Test both models (Gemma 4 4B, Qwen 3.5 8B) respond correctly
- [x] Build minimal memory extension:
  - [x] Hooks `onBeforePrompt` (inject relevant past context)
  - [x] Hooks `onAfterResponse` (save to SQLite with FTS5)
  - [x] Simple user profile store (JSON in SQLite)
- [x] Verify: cross-session recall works — start a new session and see past context injected

### Phase 2 — Telegram Gateway

*Week 2 — Goal: message the agent from anywhere via Telegram.*

- [ ] Node.js daemon with `node-telegram-bot-api`
- [ ] RPC client that communicates with Pi via JSONL on stdin/stdout
- [ ] Message queue: concurrent requests serialized per user
- [ ] Session routing: separate agent contexts per Telegram chat
- [ ] `launchd` plist for 24/7 operation
- [ ] `/status`, `/cancel` handlers
- [ ] File/media exchange (code snippets, images, documents)
- [ ] Verify: send message from Telegram → Pi processes it → response back

### Phase 3 — Memory & Recall

*Week 3 — Goal: the agent knows you across days and contexts.*

- [ ] Fact extraction pipeline (few-shot prompt → structured JSON → SQLite)
- [ ] Dialectic user profile (thesis/antithesis/synthesis after N sessions)
- [ ] FTS5 full-text search with relevance ranking
- [ ] Contextual injection: on startup, query memory for:
  - User profile summary
  - Top-3 most relevant past sessions
  - Recent facts related to current project
- [ ] Background profile consolidation (run after session ends)
- [ ] Optional Python sidecar for heavier NLP (fact extraction, classification)
- [ ] Verify: after a week of use, agent knows your preferences without being told

### Phase 4 — MCP & Tools

*Week 4 — Goal: rich tool ecosystem via MCP.*

- [ ] MCP extension implementing `@modelcontextprotocol/sdk`
- [ ] Built-in MCP servers: filesystem, shell, web, git
- [ ] Auto-discovery of MCP servers from `.pilav/mcp/`
- [ ] Sandboxed shell execution (temp directories, path restrictions)
- [ ] Tool result caching (avoid repeated expensive operations during TTS)
- [ ] Verify: agent can browse the web, edit files, run git commands via MCP

### Phase 5 — Test-Time Scaling

*Week 5 — Goal: agent works overnight on complex tasks.*

- [ ] Extended reasoning loop (break task into subtasks, execute sequentially)
- [ ] Checkpoint system: save full agent state every N steps to `.pilav/checkpoints/`
- [ ] Crash recovery: detect incomplete checkpoints, offer resume
- [ ] Status streaming: periodic progress updates pushed to Telegram via gateway
- [ ] Graceful interrupt (`/cancel` from Telegram)
- [ ] Overnight use case: "Analyze this codebase and write a migration plan"
- [ ] Verify: start a task, leave it running for 2+ hours, check results

### Phase 6 — Speed & Fidelity (Future)

*After core features are stable — goal: make small models fast enough to be genuinely useful.*

- [ ] **Model distillation pipeline** (cloud GPU → M4):
  - Generate training data from teacher model (e.g., Qwen 3.5 8B or larger)
  - Distill down to student (e.g., Gemma 4 4B or custom 1.5B)
  - Quantize with MLX for maximum throughput
- [ ] **Multi-token prediction (MTP):**
  - Train/patch models to predict 2-3 tokens at once vs 1
  - Self-distillation: model teaches itself MTP head
  - Potential 2-3× speedup on M4 hardware
- [ ] **MLX-native model loading** (bypass LM Studio):
  - Direct MLX inference in a sidecar process
  - Custom sampling, KV-cache management
  - Lower latency than LM Studio's HTTP bridge
- [ ] **TurboQuant KV cache:**
  - 3-bit keys / 2-bit values for KV cache
  - Already integrated in MLX — ~5× compression, 2× speedup on long contexts
  - Essential for TTS (10h runs generate massive KV caches)
- [ ] **Custom quantized fine-tunes:**
  - Separate fine-tuned models for:
    - Coding (trained on code + tool use traces)
    - Conversation (trained on chat + memory retrieval)
    - Classification (lightweight routing model)
  - Each optimized to smallest viable size (0.5B - 1.5B)
- [ ] **Quality/speed benchmark suite:**
  - Per-model: tok/s, latency, memory usage
  - Per-task: accuracy, completion rate, regression tracking
  - Run automatically on every change

---

## Performance Targets

| Metric | Phase 1-5 Target | Phase 6 Target |
|--------|------------------|----------------|
| Chat latency (first token) | <2s | <500ms |
| Chat throughput | ~25-30 tok/s | ~60-90 tok/s |
| Reasoning throughput | ~20-25 tok/s | ~40-60 tok/s |
| Memory query (FTS5) | <10ms | <10ms |
| Memory recall injection | <100ms | <50ms |
| MCP tool call overhead | <50ms | <20ms |
| 10h task reliability | 99.5% (no crash) | 99.9% |
| Checkpoint cost | <200ms per snapshot | <50ms per snapshot |
| Context switch (model swap) | ~2s | <500ms |
| Telegram → response (simple) | ~5s | ~2s |

---

## Quick Start (placeholder)

*These instructions will be filled in as each phase completes.*

```bash
# Prerequisites
brew install node python3 sqlite3
# Install LM Studio, load Gemma 4 4B / Qwen 3.5 8B
# Enable local API server in LM Studio (port 1234)

# Clone and setup
git clone https://github.com/cbarkinozer/pilav
cd pilav
npm install
cp config/local.json.example config/local.json
# Edit local.json: set LM Studio endpoint, Telegram bot token

# Start gateway (launchd service)
./scripts/setup.sh

# Or use CLI directly
./agent/packages/coding-agent/bin/pi.js
```

---

## License

MIT (inherited from Pi). See [LICENSE](LICENSE).

---

## Inspiration

- **[Hermes Agent](https://github.com/NousResearch/Hermes)** — Persistent memory, dialectic user modeling, cross-session learning. The gold standard for agents that know their users.
- **[OpenClaw](https://github.com/OpenClaw/OpenClaw)** — Multi-channel AI assistant (145k+ GitHub stars) built on Pi's AgentSession SDK. Proof that Pi-scale architecture works at massive scale across Telegram, Discord, WhatsApp, Signal, and 50+ other platforms.
- **[Pi](https://github.com/earendil-works/pi)** — Minimal, extensible, single-machine agent harness by Mario Zechner. The foundation we fork. 65k+ stars, battle-tested, MIT licensed.
- **[MCP (Model Context Protocol)](https://modelcontextprotocol.io)** — Standardized tool interface for LLM agents, originated by Anthropic. Makes tool integration portable and interoperable.
- **[Honcho](https://honcho.dev)** — Dialectic user modeling for LLM applications. Influenced the memory profile design.
- **[MLX](https://github.com/ml-explore/mlx)** — Apple's machine learning framework for Apple Silicon. Essential for future inference optimizations.
- **[Multi-Token Prediction (MTP)](https://arxiv.org/abs/2404.19737)** — Technique for predicting multiple future tokens at once, enabling 2-3× inference speedup.
