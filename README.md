# Feishu Channel for Claude Code

[![npm version](https://img.shields.io/npm/v/lark-for-claude)](https://www.npmjs.com/package/lark-for-claude)
[![license](https://img.shields.io/npm/l/lark-for-claude)](LICENSE)

A [Feishu (Lark)](https://www.feishu.cn/) channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), built on the **native [Channel interface](https://docs.anthropic.com/en/docs/claude-code/channels)**. Chat with Claude directly in Feishu — DMs, group chats, interactive cards.

**English** | [中文](./README_CN.md)

Uses the MCP Channel protocol with **WebSocket persistent connection** — no public HTTPS endpoint needed.

```bash
npx lark-for-claude   # one-command install
```

---

## Table of Contents

- [Architecture & Modes](#architecture--modes)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Multi-Group Router Setup](#multi-group-router-setup)
- [Access Management](#access-management)
- [File Layout](#file-layout)
- [Multi-Device Sync](#multi-device-sync)
- [Environment Variables](#environment-variables)
- [How It Works](#how-it-works)
- [Testing & Development](#testing--development)
- [Security](#security)
- [AI Automated Deployment Guide](#ai-automated-deployment-guide)

---

## Architecture & Modes

The plugin operates in **three modes**, selected automatically based on runtime context:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Mode Selection Flow                        │
│                                                                 │
│  claude-feishu launched                                         │
│       │                                                         │
│       ▼                                                         │
│  Is --channels feishu in ancestor process?                      │
│       │                                                         │
│    NO ──→ Passive Mode (no connection, tools only)              │
│    YES                                                          │
│       │                                                         │
│       ▼                                                         │
│  Can we start/connect to a Router?                              │
│       │                                                         │
│    YES ──→ Worker Mode (connects to Router via Unix socket)     │
│    NO  ──→ Channel Mode (direct Feishu WebSocket)               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Mode Comparison

| | Channel Mode | Worker Mode (via Router) | Passive Mode |
|---|---|---|---|
| **Connection** | Direct Feishu WebSocket | Unix socket → Router → Feishu WebSocket | None |
| **Use case** | Single user / single project | Multi-user / multi-project | Non-channel Claude instances |
| **Message routing** | All messages → this instance | chat_id → workdir → worker | N/A |
| **Auto-started** | Fallback when Router fails | First `claude-feishu` auto-spawns Router | Always |
| **How many instances** | 1 Claude per bot | N Claudes per bot | N/A |

### Channel Mode (1:1)

```
┌─────────────┐
│  Feishu Bot  │──── WebSocket ────→ Claude Code Instance
└─────────────┘
```

Simplest setup. One bot, one Claude. All messages go to the single connected instance.

### Worker Mode (1:N via Router)

```
┌─────────────┐                    ┌─ Claude Code (/path/to/project-a)
│  Feishu Bot  │──── WebSocket ──→ Router ──┼─ Claude Code (/path/to/project-b)
└─────────────┘                    └─ Claude Code (/path/to/project-c)
                                        ▲
                                   Unix socket
```

The Router holds the single Feishu WebSocket. Each Claude Code instance connects as a **worker** via Unix socket. Messages are routed by:

```
chat_id → groups[chat_id].workdir → registered worker (by cwd)
```

**Key behaviors:**
- First `claude-feishu` **auto-spawns** the Router process
- Subsequent instances **auto-connect** as workers
- When all workers disconnect, Router **auto-shuts down** after 10s grace period
- If Router fails to start, falls back to Channel Mode

---

## Features

- **Multi-group routing** — One Feishu bot serves multiple Claude Code instances, each in its own project
- **Auto-managed router** — Router spawns on first launch, shuts down when all workers disconnect
- **Direct messages** — Chat with Claude through Feishu DMs
- **Group chats** — Add the bot to group chats with @mention support and custom trigger patterns
- **Access control** — Allowlist-based user authorization and per-group policies
- **Permission cards** — Interactive approve/deny cards for tool permission requests (✅ allow once / ✅✅ always allow / ❌ deny)
- **Confirm cards** — Interactive confirmation cards for risky actions (✅ / ✅✅ / ❌ buttons + text reply)
- **Unanswered reminders** — Auto-nudges at 30min / 60min / 120min if Claude hasn't replied
- **Reactions** — Configurable emoji reactions on message receipt (default: 👍)
- **Message editing** — Update previously sent messages (no push notification)
- **Smart connection** — Only connects when launched as a Feishu channel
- **Graceful shutdown** — Detects parent process exit via ppid polling
- **Worker auto-reconnect** — Workers automatically reconnect to Router after disconnection
- **Log rotation** — Automatic log rotation (5MB max, 3 backups) to prevent disk exhaustion

---

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- A Feishu (or Lark) workspace with admin access to create apps

---

## Quick Start

### Step 1: Create a Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn) (or [Lark Open Platform](https://open.larksuite.com))
2. Create a **Custom App** (enterprise internal app)
3. Note the **App ID** (`cli_...`) and **App Secret**

4. Under **Events & Callbacks**, configure **two separate tabs**:

   **Event Configuration tab:**
   - Switch to **Using persistent connection** (WebSocket mode)
   - Add event: `im.message.receive_v1`

   **Callback Configuration tab:**
   - Switch to **Using persistent connection** (WebSocket mode)
   - Add callback: `card.action.trigger` (required for confirm/permission card buttons)

5. Under **Permissions & Scopes**, add:

   | Permission | Purpose |
   |---|---|
   | `im:message` | Send messages |
   | `im:message.receive_v1` | Receive messages |
   | `im:message.p2p_msg:readonly` | Read DM messages |
   | `im:message.group_at_msg:readonly` | Read group @mentions |
   | `im:chat:readonly` | Read chat metadata |
   | `im:resource` | Download and upload attachments |

6. **Publish** the app version so permissions take effect

### Step 2: Install the Plugin

```bash
npx lark-for-claude
```

This clones the repo, installs dependencies, registers the Claude Code plugin, and creates the `claude-feishu` shortcut.

<details>
<summary>Manual installation</summary>

```bash
git clone https://github.com/jbts6/lark-for-claude.git
cd lark-for-claude
bun install
claude plugin marketplace add .
claude plugin install feishu@feishu-local
```

</details>

### Step 3: Start Claude Code with Feishu Channel

```bash
claude-feishu
```

On subsequent launches, `claude-feishu` automatically resumes the session named after the current directory. If no matching session is found, an interactive session picker opens.

Full command equivalent:

```bash
claude --dangerously-load-development-channels plugin:feishu@feishu-local
```

### Step 4: Configure Credentials

In your Claude Code terminal:

```
claude-feishu auth cli_YOUR_APP_ID YOUR_APP_SECRET
```

Credentials are stored in `~/.claude/channels/feishu/.env` (mode 600).

### Step 5: Authorize Users

Add users to the allowlist by their Feishu open_id:

```bash
claude-feishu access allow ou_xxxxxxxxxxxxxxxxxxxx
```

To find a user's open_id, check the debug log after they send a message to the bot:

```bash
tail -5 ~/.claude/channels/feishu/debug.log
```

You can also set a default chat ID for outbound messages (optional):

```bash
claude-feishu auth chat-id oc_xxxxxxxxxxxxxxxxxxxx
```

You're ready — authorized users can now message the bot and Claude will respond.

---

## Multi-Group Router Setup

### 1. Configure Group Workdirs

Add `workdir` to each group in `~/.claude/channels/feishu/access.json`:

```jsonc
{
  "groups": {
    "oc_groupA": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/path/to/project-a"
    },
    "oc_groupB": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/path/to/project-b"
    }
  },
  "defaultWorkdir": "/path/to/default-project"  // DMs and unconfigured groups route here
}
```

### 2. Start Claude Code Instances

In separate terminals, start Claude in each project directory:

```bash
cd /path/to/project-a && claude-feishu   # first: spawns router + connects as worker
cd /path/to/project-b && claude-feishu   # subsequent: connects to existing router
cd /path/to/project-c && claude-feishu   # subsequent: connects to existing router
```

The **first** instance auto-spawns the Router. Subsequent instances connect as workers. The Router routes incoming messages by `chat_id → workdir → connected worker`.

### 3. Manual Router Start (Optional)

```bash
bun run router
```

### 4. Check Router Status

```bash
kill -USR1 $(pgrep -f 'bun router.ts')
cat ~/.claude/channels/feishu/router-debug.log | tail -10
```

---

## Access Management

All access commands are run in your Claude Code terminal via `claude-feishu access`.

### Check Status

```
claude-feishu access
```

### DM Policies

| Policy | Behavior |
|---|---|
| `allowlist` (default) | Only users in `allowFrom` can send DMs; others are silently dropped |
| `disabled` | All DMs dropped |

```
claude-feishu access policy allowlist
```

### Manage Users

```bash
# Allow a user by open_id
claude-feishu access allow ou_xxxxxxxxxxxxxxxxxxxx

# Remove a user
claude-feishu access remove ou_xxxxxxxxxxxxxxxxxxxx
```

### Group Chats

Groups are off by default. The bot must be added to the group by a group admin first.

```bash
# Enable a group (responds on @mention only)
claude-feishu access group add oc_xxxxxxxxxxxxxxxxxxxx

# Respond to all messages (no @mention needed)
claude-feishu access group add oc_xxxxxxxxxxxxxxxxxxxx --no-mention

# Restrict to specific users within the group
claude-feishu access group add oc_xxxxxxxxxxxxxxxxxxxx --allow ou_id1,ou_id2

# Remove a group
claude-feishu access group rm oc_xxxxxxxxxxxxxxxxxxxx
```

### Delivery Settings

```bash
# React to received messages with an emoji (default: Get)
claude-feishu access set ackReaction Get

# Set max characters per message chunk
claude-feishu access set textChunkLimit 4096

# Custom mention patterns for group chats
claude-feishu access set mentionPatterns ["@claude","@assistant"]
```

---

## File Layout

```
~/.claude/channels/feishu/
├── .env              # App credentials (FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_CHAT_ID)
├── access.json       # Access control state (auto-managed)
├── debug.log         # Server debug log (auto-rotated at 5MB, 3 backups)
├── router-debug.log  # Router debug log (auto-rotated at 5MB, 3 backups)
└── router.sock       # Unix socket for worker-router IPC
```

---

## Multi-Device Sync

To use the same Feishu bot on multiple devices (e.g., office desktop + home laptop), you only need to copy **two files**:

### What to Copy

| File | Contains | Must Sync? |
|---|---|---|
| `.env` | App credentials (FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_CHAT_ID) | ✅ **Yes** — without this, the bot can't connect |
| `access.json` | Access control (allowFrom, groups, policies) | ✅ **Yes** — without this, all users appear unauthorized |
| `debug.log` | Debug log | ❌ No — auto-created and auto-rotated |
| `router-debug.log` | Router debug log | ❌ No — auto-created and auto-rotated |
| `router.sock` | Unix socket | ❌ No — auto-created at runtime |

### How to Sync

**Option 1: Manual copy**

```bash
# On the source device
scp ~/.claude/channels/feishu/.env ~/.claude/channels/feishu/access.json target-device:~

# On the target device
mkdir -p ~/.claude/channels/feishu
mv ~/.env ~/.claude/channels/feishu/.env
mv ~/access.json ~/.claude/channels/feishu/access.json
chmod 600 ~/.claude/channels/feishu/.env
```

**Option 2: Symlink to a synced folder** (e.g., Dropbox, iCloud, Syncthing)

```bash
# Create a synced config folder
mkdir -p ~/Sync/feishu-config

# Copy existing config into it
cp ~/.claude/channels/feishu/.env ~/.claude/channels/feishu/access.json ~/Sync/feishu-config/

# Replace original files with symlinks
mv ~/.claude/channels/feishu/.env ~/.claude/channels/feishu/.env.bak
mv ~/.claude/channels/feishu/access.json ~/.claude/channels/feishu/access.json.bak
ln -s ~/Sync/feishu-config/.env ~/.claude/channels/feishu/.env
ln -s ~/Sync/feishu-config/access.json ~/.claude/channels/feishu/access.json
```

**Option 3: Use FEISHU_STATE_DIR** to point to a synced location

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export FEISHU_STATE_DIR="$HOME/Sync/feishu-config"
```

This makes the entire state directory live in your synced folder — no symlinks needed.

### Important Notes

- **Only one device should run the bot at a time** in Channel mode. Two simultaneous WebSocket connections from the same app may cause message loss or duplication.
- **Router mode is safe for multi-device**: each device runs its own Worker, and the Router handles deduplication. But only one device should run the Router.
- **`access.json` changes are not auto-synced**: if you add a user on device A, device B won't see it until the file syncs. The 2-second access cache means changes take effect quickly after sync.
- **`workdir` paths in `access.json` are absolute**: `/home/user/project-a` on one device may not exist on another. Use consistent paths or adjust per device.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FEISHU_APP_ID` | Yes | Feishu app ID (`cli_...`) |
| `FEISHU_APP_SECRET` | Yes | Feishu app secret |
| `FEISHU_ENCRYPT_KEY` | No | Event payload encryption key |
| `FEISHU_APP_CHAT_ID` | No | Default chat ID for outbound messages (fallback when no chat_id is specified) |
| `FEISHU_ACCESS_MODE` | No | Set to `static` to use allowlist-only mode (no runtime access.json writes) |
| `FEISHU_STATE_DIR` | No | Override state directory path (default: `~/.claude/channels/feishu/`) |

---

## How It Works

### Smart Connection Detection

The plugin detects whether it's running under a Feishu channel Claude instance by walking up the process tree and checking for `--dangerously-load-development-channels` with `feishu` in the ancestor's command line. Non-channel Claude instances (e.g., regular `claude` or `claude --channels plugin:discord@...`) skip the Feishu WebSocket connection entirely, keeping the MCP tools available without unnecessary remote connections.

### Orphan Protection

When the parent Claude process exits, the plugin detects the ppid change within 2 seconds and shuts down gracefully. This prevents orphaned `bun server.ts` processes from consuming 100% CPU — a workaround for Bun not reliably firing stdin `end`/`close` events on broken Unix domain sockets.

### Worker Auto-Reconnect

When a worker's Unix socket connection to the Router breaks, it automatically attempts to reconnect after 3 seconds. This handles temporary Router restarts and network glitches without requiring manual intervention.

### Access Caching

The `access.json` file is cached with a 2-second TTL based on file modification time. This avoids redundant `readFileSync` calls on every message while still reflecting configuration changes within seconds.

### Log Rotation

Debug logs (`debug.log`, `router-debug.log`) are automatically rotated when they exceed 5MB. Up to 3 backup files are kept (`debug.log.1`, `debug.log.2`, `debug.log.3`). Rotation is checked lazily every 100 writes to minimize overhead.

---

## Testing & Development

```bash
bun test              # Run tests (65 tests)
bun run lint          # Check code style with Biome
bun run lint:fix      # Auto-fix code style issues
bun run format        # Format code with Biome
bun run typecheck     # TypeScript type checking
bun run check         # Full check: typecheck + lint + test
```

Tests cover: access control (gate logic), text chunking, mention detection, permission reply parsing (including `yy`/`yesyes` for always-allow), confirm code generation, chat authorization, chat ID resolution and fallback, message parsing, attachment info, timestamp formatting, log rotation, router workdir resolution, and access caching.

---

## Security

- Credentials stored with `chmod 600` — only the owner can read them
- State directory uses `chmod 700`
- Router Unix socket uses `chmod 600`
- Confirm codes use 8-byte cryptographic randomness (`crypto.randomBytes`)
- Access mutations can only be made from the Claude Code terminal — never from channel messages (prompt injection protection)
- Chat allowlist prevents unauthorized message delivery
- Log rotation prevents disk exhaustion from unbounded log growth
- Log output redacts sensitive IDs (open_id, chat_id)
- PID validation prevents misidentifying ancestor processes
- Regex escaping prevents injection in CLI pattern handling
- Pending permissions and confirms auto-expire after 1 hour

---

## AI Automated Deployment Guide

This section provides a condensed, step-by-step guide for AI agents to deploy and configure the Feishu Channel plugin automatically.

### Prerequisites Check

```bash
# Verify Bun is installed
bun --version || (echo "INSTALL bun: curl -fsSL https://bun.sh/install | bash" && exit 1)

# Verify Claude Code is installed
claude --version || (echo "INSTALL claude-code first" && exit 1)
```

### One-Command Deploy

```bash
npx lark-for-claude
```

This handles: clone → install → plugin register → `claude-feishu` shortcut.

### Credential Configuration

```bash
# Write credentials to state directory
mkdir -p ~/.claude/channels/feishu
cat > ~/.claude/channels/feishu/.env << 'EOF'
FEISHU_APP_ID=cli_YOUR_APP_ID
FEISHU_APP_SECRET=YOUR_APP_SECRET
FEISHU_APP_CHAT_ID=oc_YOUR_CHAT_ID
EOF
chmod 600 ~/.claude/channels/feishu/.env
```

Or use the CLI command inside a Claude Code session:

```
claude-feishu auth cli_YOUR_APP_ID YOUR_APP_SECRET
claude-feishu auth chat-id oc_YOUR_CHAT_ID
```

### Multi-Group Router Configuration

Write `~/.claude/channels/feishu/access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": [],
  "p2pChats": {},
  "groups": {
    "oc_GROUP_ID_A": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/absolute/path/to/project-a"
    },
    "oc_GROUP_ID_B": {
      "requireMention": false,
      "allowFrom": [],
      "workdir": "/absolute/path/to/project-b"
    }
  },
  "ackReaction": "Get",
  "defaultWorkdir": "/absolute/path/to/default-project"
}
```

Key fields:
- `groups[chat_id].workdir` — maps a Feishu group to a project directory
- `defaultWorkdir` — fallback for DMs and groups without explicit workdir
- `dmPolicy` — `allowlist` (default) or `disabled`
- `ackReaction` — emoji code for read receipts (default: `Get`)

### Launch Commands

```bash
# Single project (Channel mode or auto-Router)
cd /path/to/project && claude-feishu

# Multi-project (Router mode)
cd /path/to/project-a && claude-feishu &  # first: spawns Router
cd /path/to/project-b && claude-feishu &  # connects as worker
```

### User Authorization

Pre-authorize users by open_id:

```bash
claude-feishu access allow ou_xxxxxxxxxxxxxxxxxxxx
```

To find a user's open_id, check the debug log after they send a message:

```bash
tail -5 ~/.claude/channels/feishu/debug.log
```

### Verification Checklist

```bash
# 1. Plugin installed
claude plugin list | grep feishu

# 2. Credentials configured
test -f ~/.claude/channels/feishu/.env && echo "OK" || echo "MISSING"

# 3. Tests pass
cd $(dirname $(which claude-feishu))/.. && bun test

# 4. Router running (multi-group mode)
test -S ~/.claude/channels/feishu/router.sock && echo "Router active" || echo "No router"

# 5. Debug logs
tail -5 ~/.claude/channels/feishu/debug.log
tail -5 ~/.claude/channels/feishu/router-debug.log
```

### Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Bot not responding | `debug.log` for errors | Verify credentials in `.env` |
| Router not starting | `router-debug.log` | Check if port/socket is in use |
| Worker not connecting | `debug.log` for "worker" entries | Verify Router socket exists |
| DMs silently dropped | `dmPolicy` in `access.json` | Must be `allowlist`, not `disabled`; add user to `allowFrom` |
| Group messages ignored | Group in `access.json`? | `claude-feishu access group add <chat_id>` |
| Card buttons not working | Callback configured? | Add `card.action.trigger` in Feishu app |
| No default chat for outbound | `FEISHU_APP_CHAT_ID` set? | `claude-feishu auth chat-id <chat_id>` |

---

## License

MIT
