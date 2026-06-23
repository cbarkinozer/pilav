# OpenClaw — Personal AI Assistant

**Stars:** 380k+ | **Language:** TypeScript | **License:** MIT | **Author:** Peter Steinberger + Mario Zechner + Community
**Repo:** [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
**Docs:** [docs.openclaw.ai](https://docs.openclaw.ai) | **Site:** [openclaw.ai](https://openclaw.ai)

---

- [Overview](#overview)
- [Architecture](#architecture)
- [Messaging Gateway](#messaging-gateway)
- [Agent System](#agent-system)
- [Tool System](#tool-system)
- [Security Model](#security-model)
- [Companion Apps](#companion-apps)
- [Strong Points](#strong-points)
- [Weak Points](#weak-points)
- [Comparison: OpenClaw vs Pi vs Hermes](#comparison-openclaw-vs-pi-vs-hermes)

---

## Overview

OpenClaw is a **personal AI assistant** you run on your own devices. It answers you on the channels you already use — WhatsApp, Telegram, Slack, Discord, Signal, iMessage, and 50+ other platforms. It can speak and listen on macOS/iOS/Android, render a live Canvas you control, and run autonomously via cron jobs and webhooks.

Built on Pi's AgentSession SDK (Mario Zechner's framework), OpenClaw is the most widely deployed open-source multi-channel AI assistant. The Gateway is the control plane — the product is the assistant experience across every surface you use.

**Key facts:**
- **380k+ GitHub stars** — most starred AI assistant project
- **50+ messaging platforms** — widest multi-channel support of any open-source project
- **Sponsored by** OpenAI, GitHub, NVIDIA, Vercel, Convex, Blacksmith
- **62k+ commits** across a massive monorepo

---

## Architecture

```
                         ┌────────────────────────────────────────┐
                         │           Entry Points                  │
                         │  CLI  •  Gateway  •  Companion Apps    │
                         │  macOS  •  iOS  •  Android  •  Windows │
                         └──────────────────┬─────────────────────┘
                                            │
                         ┌──────────────────▼─────────────────────┐
                         │          Gateway Daemon                 │
                         │  (Node.js, launchd/systemd, 24/7)       │
                         │                                         │
                         │  ┌────────────────────────────────┐     │
                         │  │     Platform Adapters (52)      │     │
                         │  │  Telegram  Discord  Slack       │     │
                         │  │  WhatsApp  Signal  iMessage     │     │
                         │  │  IRC  Teams  Matrix  Feishu     │     │
                         │  │  LINE  Mattermost  Nostr  ...   │     │
                         │  └────────────────────────────────┘     │
                         │                                         │
                         │  ┌────────────────────────────────┐     │
                         │  │  Message Router & Session Mgr   │     │
                         │  │  Auth • Pairing • Rate-limit    │     │
                         │  │  Cron • Webhooks • Hooks       │     │
                         │  └────────────────────────────────┘     │
                         └──────────────────┬─────────────────────┘
                                            │
                         ┌──────────────────▼─────────────────────┐
                         │       AgentSession (Pi SDK)            │
                         │  ┌────────────────────────────────┐    │
                         │  │  Workspace (multi-agent)        │    │
                         │  │  ┌──────────┐ ┌──────────┐    │    │
                         │  │  │ Agent 1  │ │ Agent 2  │ ...│    │
                         │  │  │ (main)   │ │ (sandbox)│    │    │
                         │  │  └──────────┘ └──────────┘    │    │
                         │  └────────────────────────────────┘    │
                         │                                         │
                         │  Session Mgmt • Tools • MCP • Cron     │
                         └──────────────────┬─────────────────────┘
                                            │
                         ┌──────────────────▼─────────────────────┐
                         │            LLM Providers                │
                         │  OpenAI • Anthropic • Google • Ollama  │
                         │  LM Studio • OpenRouter • + 20 more   │
                         └────────────────────────────────────────┘
```

### Monorepo Structure

```
openclaw/
├── apps/                   # Companion apps
│   ├── macos/              # macOS menu bar app
│   ├── ios/                # iOS node
│   ├── android/            # Android node
│   └── windows/            # Windows Hub
│
├── src/                    # Core gateway + agent
│   ├── gateway/            # Long-running daemon
│   │   ├── platforms/      # 52 platform adapters
│   │   ├── hooks/          # Hook system (pre/post LLM)
│   │   └── ...
│   ├── agent/              # Agent session management
│   ├── tools/              # Tool implementations
│   ├── mcp/                # MCP client + server
│   └── ...
│
├── packages/               # Shared packages (Pi SDK deps)
├── extensions/             # Bundled extensions
├── skills/                 # Agent skills
├── ui/                     # Control UI (web dashboard)
├── config/                 # Configuration schemas
├── deploy/                 # Deployment configs (Docker, Fly, Render)
├── docs/                   # Documentation site (Docusaurus)
└── qa/                     # Quality assurance
```

---

## Messaging Gateway

The gateway is a long-running Node.js daemon managed by `launchd` (macOS) or `systemd` (Linux). It is the core of OpenClaw — the control plane that routes messages between users and agents.

### 52 Platform Adapters

| Tier | Platforms |
|------|-----------|
| **Core** | Telegram, Discord, Slack, WhatsApp, Signal, iMessage |
| **Chat** | IRC, Microsoft Teams, Matrix, Google Chat, Mattermost |
| **Asia** | Feishu, LINE, WeChat, QQ, DingTalk, Zalo |
| **Social** | Nostr, Twitch, X/Twitter, Bluesky |
| **Voice** | macOS/iOS/Android native voice, ElevenLabs |
| **Other** | Email, SMS, WebChat, Home Assistant, Nextcloud Talk, Synology Chat, Tlon, Webhook |

### Gateway Features

| Feature | Description |
|---------|-------------|
| **24/7 operation** | launchd/systemd auto-start, crash recovery |
| **Message queue** | Concurrent requests dispatched per user |
| **DM pairing** | Unknown senders get pairing code before access |
| **Allowlists** | Per-channel allow/deny lists |
| **Rate limiting** | Per-user, per-channel, per-platform |
| **Slash commands** | `/status`, `/new`, `/reset`, `/compact`, `/think` |
| **Long task support** | `/status` returns progress, `/cancel` aborts |
| **File/media** | Code, images, documents, voice messages |
| **Cross-platform** | Single conversation can span Telegram ↔ Discord ↔ WhatsApp |
| **Remote access** | Tailscale, SSH tunneling, public URL |

---

## Agent System

### Multi-Agent Workspace

OpenClaw supports multiple isolated agents in a single workspace:

```
~/.openclaw/workspace/
├── agents/
│   ├── main/               # Primary agent (full host access)
│   │   ├── sessions/
│   │   ├── AGENTS.md
│   │   └── SOUL.md
│   └── sandboxed/          # Secondary agent (containerized)
│       ├── sessions/
│       └── AGENTS.md
├── skills/                 # Shared skills
├── tools/                  # Tool configurations
└── openclaw.json           # Workspace config
```

### Agent Features

| Feature | Description |
|---------|-------------|
| **Session management** | Tree-structured sessions (Pi-native) |
| **Model routing** | Per-agent model config, auto-failover |
| **SOUL.md** | Personality/voice definition per agent |
| **AGENTS.md** | Per-project context files |
| **Compaction** | Auto/manual context compression |
| **Multi-model** | Switch models mid-session |
| **Thinking levels** | off → minimal → low → medium → high → xhigh |

### Cron & Automation

- Natural language scheduling
- Skill-attached cron jobs
- Webhook endpoints (HTTP → agent prompt)
- Gmail Pub/Sub integration
- Status notifications on completion

---

## Tool System

OpenClaw ships with 12+ core tools plus MCP integration for unlimited extensibility.

### Built-in Tools

| Tool | Description |
|------|-------------|
| `bash` | Shell command execution |
| `read` | File reading |
| `write` | File writing |
| `edit` | File editing |
| `browser` | Web browsing and automation |
| `canvas` | Visual workspace rendering |
| `nodes` | Companion device management |
| `cron` | Scheduled task management |
| `sessions` | Cross-session communication |
| `discord` | Discord API actions |
| `slack` | Slack API actions |
| `gateway` | Gateway control commands |

### MCP Integration

OpenClaw supports both MCP client **and** server mode — unique among the three projects:

| Mode | Description |
|------|-------------|
| **MCP Client** | Connect to external MCP servers (filesystem, shell, web, git, etc.) |
| **MCP Server** | Expose OpenClaw's agent capabilities as MCP tools to other apps |

### Sandboxing

Tools run with security boundaries configurable per agent:

| Sandbox Mode | Description |
|-------------|-------------|
| `host` | Full host access (default for `main` agent) |
| `non-main` | Docker container (default for non-main agents) |
| `docker` | Docker with configurable image and mounts |
| `ssh` | Remote execution via SSH |
| `openshell` | Policy-controlled sandbox (Pi OpenShell) |

**Default non-main sandbox:** allow `bash`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`; deny `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`.

---

## Security Model

OpenClaw connects to real messaging surfaces, so security is first-class:

| Feature | Description |
|---------|-------------|
| **DM pairing** | Unknown senders receive pairing code before access |
| **Allowlists** | Per-platform and per-channel allow/deny lists |
| **Group safety** | `dmPolicy="pairing"` by default — must opt-in to open |
| **Sandboxing** | Non-main agents run in Docker by default |
| **Redaction** | Secret redaction is ON by default |
| **TOCTOU protection** | Time-of-check/time-of-use windows closed across auth and MCP OAuth |
| **Self-audit** | `openclaw doctor` surfaces risky config |
| **Remote exposure runbook** | Step-by-step before exposing to internet |

---

## Companion Apps

All apps are optional — the Gateway alone delivers a great experience.

| App | Features |
|-----|----------|
| **macOS** | Menu bar Gateway control, Voice Wake, push-to-talk overlay, WebChat, debug tools, remote Gateway control over SSH |
| **iOS** | WS node pairing, voice trigger forwarding, Canvas surface |
| **Android** | WS node, Connect/Chat/Voice tabs, Camera/Screen capture, device command families |
| **Windows Hub** | Tray status, chat, node mode, local MCP mode |

---

## Strong Points

- **50+ messaging platforms** — Unmatched multi-channel breadth. No other open-source agent covers this many surfaces.
- **380k+ GitHub stars** — Largest community and most contributors of any agent project. Massive ecosystem of extensions, skills, and community support.
- **Production-proven** — Powers real assistants across every major messaging platform. 62k+ commits, 250+ releases, corporate sponsors (OpenAI, GitHub, NVIDIA, Vercel).
- **Security-first design** — DM pairing, sandboxing, exposure runbooks, `openclaw doctor` audit. Designed for real-world threat models.
- **MCP client + server** — Both consume and expose MCP capabilities. Unique flexibility.
- **Agent workspace isolation** — Multi-agent with per-agent sandboxing. Run a "main" agent with full access and "guest" agents in containers from the same gateway.
- **Companion app ecosystem** — macOS, iOS, Android, Windows native apps. Voice wake, Canvas, push-to-talk.
- **Enterprise sponsors** — Backed by OpenAI, GitHub, NVIDIA, Vercel. Unlikely to disappear.
- **Comprehensive docs** — Full documentation site at docs.openclaw.ai with getting started guides, configuration reference, and troubleshooting.

---

## Weak Points

- **No persistent memory** — Like Pi, OpenClaw has no cross-session user memory. Sessions are isolated; the agent doesn't build a user profile or recall facts across sessions.
- **No self-improving skills** — Unlike Hermes Agent, OpenClaw's skills are static. The agent doesn't create new skills from experience.
- **No test-time scaling** — No extended reasoning loop for hours-long tasks. Overnight autonomous work requires webhook/cron orchestration, not a native checkpointing system.
- **No batch/trajectory generation** — No built-in pipeline for generating training data from agent sessions.
- **Heavy codebase** — 62k+ commits, massive monorepo. Steep learning curve for contributors. Full clone is large.
- **No "just works" local memory** — Memory is session-isolated. You need Pi extensions to add memory (which is our plan for Levigen).
- **Dependency on Pi upstream** — Core agent loop depends on `@earendil-works/pi-agent-core`. Changes to Pi can affect OpenClaw.
- **No model distillation tools** — OpenClaw is an integration platform, not a model optimization platform. No fine-tuning or distillation pipeline.

---

## Comparison: OpenClaw vs Pi vs Hermes

| Feature | OpenClaw | Pi | Hermes Agent |
|---------|----------|-----|-------------|
| **Language** | TypeScript | TypeScript | Python |
| **Messaging platforms** | **50+** | CLI only (RPC/SDK) | 20+ |
| **Stars** | **380k** | 65k | 200k |
| **Memory** | None (session-isolated) | None | 3-layer (best) |
| **Self-improving skills** | No | No | **Yes** |
| **MCP** | **Client + Server** | Via extension | Client only |
| **Built-in tools** | 12+ | 4 | **70+** |
| **Test-time scaling** | No | No | No |
| **SDK embedding** | **First-class** (via Pi) | **First-class** | Limited |
| **Security model** | **Best** (sandboxing, DM pairing, audit) | Containerization docs | Basic |
| **Companion apps** | macOS, iOS, Android, Windows | None | Desktop (new) |
| **Batch/trajectory gen** | No | No | **Yes** |
| **Install complexity** | Simple (npm) | **Simplest** (npm) | Moderate (Python) |
| **Corporate backing** | **OpenAI, GitHub, NVIDIA** | Individual (Mario Zechner) | Nous Research |
