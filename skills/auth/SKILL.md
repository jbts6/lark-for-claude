---
name: auth
description: Set up the Feishu (Lark) channel — save App ID / App Secret and review access policy. Use when the user pastes credentials, asks to configure Feishu, asks "how do I set this up", or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /feishu:auth — Feishu Channel Setup

Writes App ID and App Secret to `~/.claude/channels/feishu/.env` and orients
the user on access policy. The server reads this file at boot.

Arguments passed: `$ARGUMENTS`

---

## What you need from Feishu Open Platform

1. Go to [open.feishu.cn](https://open.feishu.cn) (or open.larksuite.com for Lark international)
2. Create a **Custom App** (enterprise internal app)
3. Note the **App ID** (`cli_...`) and **App Secret** from the app's "Credentials & Basic Info" page
4. Under **Event Subscriptions** → enable **Using persistent connection** (WebSocket mode — no public URL needed)
5. Under **Event Subscriptions** → **Add Event** → subscribe to `im.message.receive_v1`
6. Under **Permissions & Scopes** → add:
   - `im:message` (send messages)
   - `im:message.receive_v1` (read messages)
   - `im:message.group_at_msg:readonly` (group @ messages)
   - `im:message.p2p_msg:readonly` (P2P messages)
   - `im:chat:readonly` (read chat info)
   - `im:resource` (download file/image attachments)
7. Publish/release the app version so permissions take effect
8. Add the bot to the chats you want it to monitor

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give a full picture:

1. **Credentials** — check `~/.claude/channels/feishu/.env` for `FEISHU_APP_ID`
   and `FEISHU_APP_SECRET`. Show set/not-set; if set, show first 8 chars of
   App ID and mask the rest.

2. **Access** — read `~/.claude/channels/feishu/access.json` (missing = defaults:
   `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means
   - Allowed users: count and list of open_ids
   - Pending pairings: count, codes, sender open_ids, age
   - Group chats opted in: count

3. **What next** — end with a concrete next step:
   - No credentials → *"Run `/feishu:auth <appId> <appSecret>` with your app credentials."*
   - Credentials set, nobody allowed → *"Send a DM to your bot in Feishu. It replies with a code; approve with `/feishu:access pair <code>`."*
   - Credentials set, someone allowed → *"Ready. DM your bot in Feishu to reach the assistant."*

**Push toward lockdown.** Once the needed users are paired, switch to `allowlist`
policy so no new pairings can be initiated. Offer to run `/feishu:access policy allowlist`.

### `<appId> <appSecret>` — save credentials

1. Parse `$ARGUMENTS`: first token = App ID (starts with `cli_`), second = App Secret.
2. `mkdir -p ~/.claude/channels/feishu`
3. Read existing `.env` if present; update/add `FEISHU_APP_ID=` and
   `FEISHU_APP_SECRET=` lines, preserve other keys. Write back without quotes.
4. `chmod 600 ~/.claude/channels/feishu/.env`
5. Confirm, then show the no-args status so the user sees where they stand.

If the user provides only one token and it starts with `cli_`:
- It's just the App ID — ask for the App Secret too.

### `key <key> <value>` — set optional config

Save an optional key to `.env`:
- `encryptKey <value>` → `FEISHU_ENCRYPT_KEY=<value>` (for event payload encryption)

### `clear` — remove credentials

Delete `FEISHU_APP_ID=` and `FEISHU_APP_SECRET=` lines (or the whole file if empty).

---

## Implementation notes

- Missing file = not configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via `/feishu:access` take effect immediately without restart.
- The bot must be added to a group chat before it can receive group messages. For P2P, users need to find the bot in Feishu and open a conversation (search by app name).
