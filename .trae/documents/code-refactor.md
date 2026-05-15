# 代码重构计划：抽离重复逻辑、简化冗余、补全注释和结构图

> **当前状态**：R1 已部分完成（`resolveAndAssertChatId` 已添加到 shared.ts，reply handler 已更新），
> 但存在 `replyTo` 变量丢失的 bug，且 `edit_message` 和 `send_confirm_card` 尚未使用新函数。

---

## 一、重复逻辑抽离

### R1. `resolveAndAssertChatId` — 完成 reply handler，修复 bug，更新其余 handler

**现状**：
- shared.ts 已有 `resolveAndAssertChatId()` 函数 ✅
- server.ts reply handler 已使用 ✅，但 `replyTo` 变量丢失 ❌
- server.ts `edit_message` handler 仍用旧模式 ❌
- server.ts `send_confirm_card` handler 仍用旧模式 ❌

**修复**：
1. 在 reply handler 中恢复 `const replyTo = a.reply_to as string | undefined`
2. 将 `edit_message` handler 改为使用 `resolveAndAssertChatId`
3. 将 `send_confirm_card` handler 改为使用 `resolveAndAssertChatId`

**具体改动**：

server.ts reply handler（当前有 bug）：
```ts
// 当前（有 bug）：
case 'reply': {
  const access = loadAccess()
  const chatId = resolveAndAssertChatId(a.chat_id as string | undefined, CLAUDE_WORKDIR, access)
  const text = a.text as string
  // replyTo 丢失！

// 修复后：
case 'reply': {
  const access = loadAccess()
  const chatId = resolveAndAssertChatId(a.chat_id as string | undefined, CLAUDE_WORKDIR, access)
  const text = a.text as string
  const replyTo = a.reply_to as string | undefined
```

server.ts edit_message handler：
```ts
// 当前：
case 'edit_message': {
  let editChatId = a.chat_id as string
  const editAccess = loadAccess()
  if (!editChatId) editChatId = resolveChatId(CLAUDE_WORKDIR, editAccess) ?? ''
  if (!editChatId) throw new Error('chat_id required — no inbound message and no fallback chat configured')
  assertAllowedChat(editChatId, editAccess)

// 修复后：
case 'edit_message': {
  const access = loadAccess()
  const chatId = resolveAndAssertChatId(a.chat_id as string | undefined, CLAUDE_WORKDIR, access)
```

server.ts send_confirm_card handler：
```ts
// 当前：
case 'send_confirm_card': {
  let confirmChatId = a.chat_id as string
  const content = a.content as string
  const title = (a.title as string | undefined) ?? '⚡ 操作确认'
  const confirmAccess = loadAccess()
  if (!confirmChatId) confirmChatId = resolveChatId(CLAUDE_WORKDIR, confirmAccess) ?? ''
  if (!confirmChatId) throw new Error('chat_id required — no inbound message and no fallback chat configured')
  assertAllowedChat(confirmChatId, confirmAccess)

// 修复后：
case 'send_confirm_card': {
  const access = loadAccess()
  const chatId = resolveAndAssertChatId(a.chat_id as string | undefined, CLAUDE_WORKDIR, access)
  const content = a.content as string
  const title = (a.title as string | undefined) ?? '⚡ 操作确认'
```

同时更新 send_confirm_card 中 `confirmChatId` → `chatId` 的所有引用。

### R2. 抽离 `parseInboundEvent`

**现状**：server.ts 和 router.ts 的 `handleInbound` 有完全相同的消息解析逻辑（~12行）：

```ts
const senderId: string = sender.sender_id?.open_id ?? ''
const chatId: string = message.chat_id ?? ''
const chatType: string = message.chat_type ?? 'p2p'
const messageId: string = message.message_id ?? ''
const msgType: string = message.message_type ?? (message as any).msg_type ?? 'text'
const contentStr: string = message.content ?? message.body?.content ?? ''
const mentions: any[] = message.mentions ?? []
const createTime: string = message.create_time ?? ''
if (!senderId || !chatId || !messageId) return
const { text, postImageKeys } = parseMessageContent(msgType, contentStr)
```

**修复**：在 shared.ts 添加 `parseInboundEvent(data)` 函数：

```ts
export type InboundEvent = {
  senderId: string
  chatId: string
  chatType: string
  messageId: string
  msgType: string
  contentStr: string
  mentions: any[]
  createTime: string
  text: string
  postImageKeys: string[]
}

export function parseInboundEvent(data: any): InboundEvent | null {
  const ev = data.event ?? data
  const sender = ev.sender, message = ev.message
  if (!sender || !message) return null
  const senderId: string = sender.sender_id?.open_id ?? ''
  const chatId: string = message.chat_id ?? ''
  const chatType: string = message.chat_type ?? 'p2p'
  const messageId: string = message.message_id ?? ''
  const msgType: string = message.message_type ?? (message as any).msg_type ?? 'text'
  const contentStr: string = message.content ?? message.body?.content ?? ''
  const mentions: any[] = message.mentions ?? []
  const createTime: string = message.create_time ?? ''
  if (!senderId || !chatId || !messageId) return null
  const { text, postImageKeys } = parseMessageContent(msgType, contentStr)
  return { senderId, chatId, chatType, messageId, msgType, contentStr, mentions, createTime, text, postImageKeys }
}
```

server.ts handleInbound 改为：
```ts
async function handleInbound(data: any) {
  const parsed = parseInboundEvent(data)
  if (!parsed) { dbg('drop: missing sender or message'); return }
  const { senderId, chatId, chatType, messageId, msgType, contentStr, mentions, createTime, text, postImageKeys } = parsed
  dbg(`handleInbound: sender=${redact(senderId)}, chat_id=${redact(chatId)}, chat_type=${chatType}, msg_type=${msgType}`)
  // ... 后续逻辑不变
}
```

router.ts handleInbound 同理。

### R3. 抽离卡片回调逻辑

**现状**：server.ts 和 router.ts 的 `handleCardAction` 有重复的权限/确认处理逻辑。

**分析**：两者的处理方式有本质区别：
- **server.ts**：直接调用 `mcp.notification()` 发送通知，有 `pendingPerms`/`pendingConfirms` 状态
- **router.ts**：通过 `routeToWorkdir()`/`sendToWorker()` 转发给 worker

因此无法完全统一处理逻辑，但可以抽离以下共用部分：

1. **action 解析和分类**：`parseCardAction(value)` → 返回 `{ type: 'perm'|'confirm'|'cancel'|'unknown', code, behavior?, isConfirm?, isAlways? }`
2. **状态卡片构建**：`buildStatusCard(title, content, statusText, isConfirm)` → 返回 card data

**具体改动**：

shared.ts 添加：
```ts
export type CardActionParsed = 
  | { type: 'perm'; code: string; behavior: 'allow' | 'allow-always' | 'deny' }
  | { type: 'confirm'; code: string; isConfirm: boolean; isAlways: boolean }
  | { type: 'unknown' }

export function parseCardAction(value: Record<string, any>): CardActionParsed {
  const code = value.code as string | undefined
  const action = value.action as string | undefined
  if (!code || !action) return { type: 'unknown' }
  if (action === 'perm_allow' || action === 'perm_allow_always' || action === 'perm_deny') {
    return { type: 'perm', code, behavior: action === 'perm_deny' ? 'deny' : action === 'perm_allow_always' ? 'allow-always' : 'allow' }
  }
  if (action === 'confirm' || action === 'confirm_always' || action === 'cancel') {
    const isConfirm = action !== 'cancel'
    const isAlways = action === 'confirm_always'
    return { type: 'confirm', code, isConfirm, isAlways }
  }
  return { type: 'unknown' }
}

export function permStatusText(behavior: 'allow' | 'allow-always' | 'deny'): string {
  return behavior === 'deny' ? '❌ 已拒绝' : behavior === 'allow-always' ? '✅✅ 已一直允许' : '✅ 已允许'
}

export function confirmStatusText(isConfirm: boolean, isAlways: boolean): string {
  return !isConfirm ? '❌ 已拒绝' : isAlways ? '✅✅ 已一直允许' : '✅ 已确认'
}

export function buildStatusCard(headerTitle: string, bodyContent: string, template: 'green' | 'grey'): Record<string, any> {
  return {
    schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: headerTitle }, template },
    body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${bodyContent}**` }] },
  }
}
```

### R4. 通用三按钮卡片构建器

**现状**：`buildPermCard` 和 `buildConfirmCard` 的按钮区域和文本回复提示完全相同。

**修复**：在 shared.ts 添加 `buildThreeButtonCard`：

```ts
export function buildThreeButtonCard(opts: {
  headerTitle: string
  headerTemplate: string
  bodyMarkdown: string
  allowAction: string
  allowAlwaysAction: string
  denyAction: string
  code: string
  replyHint: string
}): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: opts.headerTitle }, template: opts.headerTemplate },
    body: {
      elements: [
        { tag: 'markdown', content: opts.bodyMarkdown },
        { tag: 'hr' },
        {
          tag: 'column_set',
          columns: [
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { content: '✅', tag: 'plain_text' }, type: 'primary', behaviors: [{ type: 'callback', value: { action: opts.allowAction, code: opts.code } }] }] },
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { content: '✅✅', tag: 'plain_text' }, type: 'primary', behaviors: [{ type: 'callback', value: { action: opts.allowAlwaysAction, code: opts.code } }] }] },
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { content: '❌', tag: 'plain_text' }, type: 'danger', behaviors: [{ type: 'callback', value: { action: opts.denyAction, code: opts.code } }] }] },
          ],
        },
        { tag: 'hr' },
        { tag: 'markdown', content: opts.replyHint },
      ],
    },
  })
}
```

server.ts 中 `buildPermCard` 和 `buildConfirmCard` 改为调用 `buildThreeButtonCard`：
```ts
function buildPermCard(tool_name: string, description: string, code: string): string {
  return buildThreeButtonCard({
    headerTitle: '🔐 Permission Request',
    headerTemplate: 'orange',
    bodyMarkdown: `**工具：** \`${tool_name}\`\n\n${description}`,
    allowAction: 'perm_allow',
    allowAlwaysAction: 'perm_allow_always',
    denyAction: 'perm_deny',
    code,
    replyHint: `回复 \`y ${code}\` 允许，\`yy ${code}\` 一直允许，\`n ${code}\` 拒绝`,
  })
}

function buildConfirmCard(title: string, content: string, code: string): string {
  return buildThreeButtonCard({
    headerTitle: title,
    headerTemplate: 'blue',
    bodyMarkdown: content,
    allowAction: 'confirm',
    allowAlwaysAction: 'confirm_always',
    denyAction: 'cancel',
    code,
    replyHint: `回复 \`y ${code}\` 允许，\`yy ${code}\` 一直允许，\`n ${code}\` 拒绝`,
  })
}
```

### R5. 统一路径规范化

**现状**：
- shared.ts 有 `normalizePath()`（带缓存，使用 `realpathSync`）
- router.ts 有 `normalizeWorkdir()`（使用 `resolve`，无缓存）
- 两者功能类似但不完全相同

**修复**：
1. shared.ts 导出 `normalizePath`（当前是未导出的私有函数）
2. router.ts 删除 `normalizeWorkdir`，改用 `normalizePath`
3. router.ts `findWorker` 中直接调用 `normalizePath`

### R6. CLI writeEnvFile 抽离

**现状**：`handleAuth` 中有 4 处写入 `.env` 的逻辑，都有相同的 `mkdirSync` + `writeFileSync` + `chmodSync` 模式。

**修复**：在 bin/cli.ts 内部抽离 `writeEnvFile` 函数：

```ts
function writeEnvFile(content: string) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(ENV_FILE, content)
  try { chmodSync(ENV_FILE, 0o600) } catch {}
}
```

4 处调用点：
1. `key` 子命令：`writeEnvFile(content)`
2. `chat-id` 子命令：`writeEnvFile(content)`
3. `clear` 子命令：`writeEnvFile('')`
4. 初始设置：`writeEnvFile(...)` + 追加 encrypt key

---

## 二、冗余逻辑简化

### S1. `gate()` 函数签名简化

**现状**：`gate()` 接受 5 个参数，其中 `_saveAccessFn` 不再使用。

**修复**：移除 `_saveAccessFn` 参数。

shared.ts：
```ts
export function gate(
  senderId: string, chatId: string, chatType: string, mentioned: boolean,
  loadAccess: () => Access,
): GateResult {
```

server.ts：
```ts
const gateFn = (senderId: string, chatId: string, chatType: string, mentioned: boolean): GateResult =>
  gate(senderId, chatId, chatType, mentioned, loadAccess)
```

router.ts：
```ts
const result = gate(senderId, chatId, chatType, mentioned, loadRouterAccess)
```

测试文件：
```ts
const result = gate(senderId, chatId, chatType, mentioned, () => a)
```

### S2. `GateResult` 类型简化

**现状**：`GateResult = { action: 'deliver'; access: Access } | { action: 'drop' }`
`deliver` 携带 `access`，但调用处已通过 `loadAccess()` 获取了 access。

**修复**：
- `GateResult` 简化为 `{ action: 'deliver' } | { action: 'drop' }`
- server.ts `handleInbound` 中 `result.access` → 直接用 `access`（已有 `const access = loadAccess()`）
- router.ts `handleInbound` 中 `result.access` → 直接用 `access`（已有 `const access = loadRouterAccess()`）

注意：需要确认所有 `result.access` 的使用点都已改为 `access`。

### S3. AccessCache 使用已导入的 statSync

**现状**：AccessCache.get() 内部用 `require('fs')` 获取 statSync。

**修复**：
```ts
get(accessFile: string, dbg: (msg: string) => void): Access {
  try {
    let mtimeMs = 0
    try {
      const s = statSync(accessFile)
      mtimeMs = s.mtimeMs
    } catch {}
    if (this.cached && mtimeMs === this.mtimeMs) return this.cached
    this.cached = readAccess(accessFile, dbg)
    this.mtimeMs = mtimeMs
    return this.cached
  } catch {
    this.cached = null
    this.mtimeMs = 0
    return readAccess(accessFile, dbg)
  }
}
```

### S4. 简化 BOOT/loadAccess

**现状**：
```ts
const BOOT = STATIC ? readAccess(ACCESS_FILE, dbg) : null
const loadAccess = () => BOOT ?? accessCache.get(ACCESS_FILE, dbg)
```

**修复**：
```ts
const loadAccess = () => STATIC ? readAccess(ACCESS_FILE, dbg) : accessCache.get(ACCESS_FILE, dbg)
```

移除 `BOOT` 变量。同时移除 server.ts 顶部 `readAccess` 的 import（如果不再直接使用）。
注意：`readAccess` 仍在 `loadAccess` 中使用，所以 import 保留。

### S5. 优化 findChannelAncestorPid

**现状**：非 Windows 下用 `ps -ax` 获取所有进程再遍历。

**修复**：改为逐级查询：
```ts
let pid = process.ppid
for (let depth = 0; depth < 5; depth++) {
  try {
    const out = execSync(`ps -o pid=,ppid=,args= -p ${pid}`, { encoding: 'utf8' }).trim()
    const m = out.match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) break
    const ppid = Number(m[2])
    const args = m[3] ?? ''
    if (/\bchannels?\b/.test(args) && /\bfeishu\b/.test(args)) return pid
    if (ppid <= 1) break
    pid = ppid
  } catch { break }
}
```

---

## 三、移除未使用的代码

### U1. shared.ts

- `appendFileSync` import — makeDebugger 的 fallback 中使用，保留
- `openSync`/`closeSync`/`writeSync` — makeDebugger 内部使用，保留
- `GateResult` 类型 — S2 简化后仍需导出，但字段减少
- `rmSync` import — `rotateLogIfNeeded` 中使用，保留

### U2. server.ts

- `readdirSync` import — 未使用，移除
- `rmSync` import — 未使用，移除
- `resolveChatId` import — R1 完成后 edit_message/send_confirm_card 不再直接使用，但 reply handler 也不再使用。检查是否还有其他引用。如果 `resolveAndAssertChatId` 内部调用 `resolveChatId`，则 server.ts 不需要直接 import `resolveChatId`。移除。
- `assertAllowedChat` import — 同理，被 `resolveAndAssertChatId` 内部调用，server.ts 不需要直接 import。移除。

### U3. router.ts

- `readFileSync` import — 未直接使用，移除
- `GateResult` 类型 — S2 简化后可能仍需 import（如果 gate 返回类型仍用 GateResult），检查后决定
- `GroupPolicy` 类型 — 检查是否使用

---

## 四、补全注释和结构图

### D1. shared.ts 模块头注释

```
/**
 * Shared types, constants, and utilities for server.ts and router.ts.
 *
 * Module structure:
 * ┌──────────────────────────────────────────────────────────────┐
 * │ Constants          STATE_DIR, ACCESS_FILE, ENV_FILE, etc.   │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Platform helpers   IS_WIN32, getSocketPath()                │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Types              Access, GroupPolicy, GateResult, etc.    │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Debug logging      rotateLogIfNeeded(), makeDebugger()      │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Environment        loadEnv(), requireCredentials()          │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Access control     defAccess(), readAccess(), saveAccess(), │
 * │                    assertAllowedChat(), resolveChatId(),     │
 * │                    resolveAndAssertChatId(), gate()          │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Confirm codes      genConfirmCode()                         │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Text processing    chunkText(), checkMention()              │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Feishu API         fetchBotOpenId(), fetchParentQuote()     │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Message parsing    parseInboundEvent(), parseMessageContent()│
 * ├──────────────────────────────────────────────────────────────┤
 * │ Card building      buildThreeButtonCard(), parseCardAction()│
 * ├──────────────────────────────────────────────────────────────┤
 * │ Utilities          buildAttachmentInfo(), formatTimestamp() │
 * ├──────────────────────────────────────────────────────────────┤
 * │ Caching            AccessCache                              │
 * └──────────────────────────────────────────────────────────────┘
 */
```

### D2. server.ts 模块头注释

```
/**
 * Feishu (Lark) channel for Claude Code — MCP server.
 *
 * Architecture:
 *
 *   Claude Code ←(stdio)→ MCP Server ←(Feishu WS/Router)→ Feishu
 *
 * Three running modes:
 *   1. Worker mode:   Connects to router.ts via Unix socket.
 *                      Router handles WS, forwards messages.
 *   2. Direct mode:   Own WS connection to Feishu.
 *                      Used when no router is available.
 *   3. Passive mode:  No WS, no worker. Only sends messages
 *                      via tool calls (reply/edit_message).
 *
 * Message flow (inbound):
 *   Feishu WS → handleInbound() → gate() → mcp.notification()
 *   Router    → socket data    → mcp.notification()
 *
 * Message flow (outbound):
 *   Claude Code → CallTool(reply/edit_message/send_confirm_card)
 *               → Feishu API
 *
 * Permission flow:
 *   Claude Code → permission_request notification → perm card → user
 *   User → card action / text reply → handleCardAction() → permission notification
 */
```

### D3. router.ts 模块头注释

```
/**
 * Feishu Router — central message hub for multiple Claude Code instances.
 *
 * Flow:
 *   Feishu WS → handleInbound() → gate() → resolveWorkdir() → findWorker()
 *             → socket → worker (server.ts)
 *
 *   Worker → socket → (register workdir)
 *
 *   Card action → handleCardAction() → route to worker by workdir
 *
 * Worker routing:
 *   chat_id → access.json groups → workdir → registered worker socket
 */
```

### D4. 关键函数 JSDoc

为以下函数补充 JSDoc 注释：
- `gate()` — 说明 DM/group 访问控制逻辑
- `resolveChatId()` — 说明 fallback 链
- `resolveAndAssertChatId()` — 说明组合逻辑
- `parseInboundEvent()` — 说明返回值和 null 条件
- `handleInbound()` — 说明消息处理流程
- `handleCardAction()` — 说明权限/确认卡片回调处理
- `buildThreeButtonCard()` — 说明通用卡片构建器参数

---

## 实施步骤

| 步骤 | 内容 | 涉及文件 | 依赖 |
|------|------|----------|------|
| 1 | R1: 修复 replyTo bug + 更新 edit_message/send_confirm_card | server.ts | 无 |
| 2 | R2: 抽离 `parseInboundEvent` | shared.ts, server.ts, router.ts | 无 |
| 3 | R3: 抽离 `parseCardAction` + 状态卡片辅助函数 | shared.ts, server.ts, router.ts | 无 |
| 4 | R4: 抽离 `buildThreeButtonCard` | shared.ts, server.ts | R3 |
| 5 | R5: 统一路径规范化 | shared.ts, router.ts | 无 |
| 6 | R6: CLI writeEnvFile 抽离 | bin/cli.ts | 无 |
| 7 | S1+S2: 简化 gate 签名和 GateResult | shared.ts, server.ts, router.ts, server.test.ts | 无 |
| 8 | S3: AccessCache 使用已导入的 statSync | shared.ts | 无 |
| 9 | S4: 简化 BOOT/loadAccess | server.ts | 无 |
| 10 | S5: 优化 findChannelAncestorPid | server.ts | 无 |
| 11 | U1-U3: 移除未使用代码 | shared.ts, server.ts, router.ts | R1-R6, S1-S5 |
| 12 | D1-D4: 补全注释和结构图 | 全部文件 | R1-R6, S1-S5, U1-U3 |
| 13 | 测试验证 | tsc --noEmit + bun test | 全部 |

---

## 风险评估

- **R2 (parseInboundEvent)**：低风险。纯数据提取，逻辑不变。
- **R3 (parseCardAction)**：低风险。只抽离解析和辅助函数，核心逻辑不变。
- **R4 (buildThreeButtonCard)**：低风险。卡片 JSON 结构不变，只是构建方式改变。
- **S2 (GateResult 简化)**：中等风险。需要确保所有 `result.access` 引用都改为 `access`。需仔细检查 server.ts 和 router.ts。
- **S5 (findChannelAncestorPid)**：中等风险。`ps` 命令参数在不同系统上可能有差异。需测试 macOS 和 Linux。
- **R5 (normalizePath)**：低风险。`realpathSync` 比 `resolve` 多了解析符号链接的能力，行为更准确。

每步完成后运行 `tsc --noEmit` 和 `bun test` 验证。
