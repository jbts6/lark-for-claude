#!/usr/bin/env bun
/**
 * Feishu Router — central message hub for multiple Claude Code instances.
 *
 * Maintains the single Feishu WebSocket connection. Workers (server.ts in each
 * Claude Code instance) connect via a Unix socket and register their cwd.
 * Messages are routed by:  chat_id → workdir (access.json) → registered worker.
 *
 * Usage:  bun router.ts
 * Config: ~/.claude/channels/feishu/access.json  (groups.<chatId>.workdir, defaultWorkdir)
 */
import * as lark from '@larksuiteoapi/node-sdk'
import { createServer, type Socket } from 'net'
import {
  readFileSync, mkdirSync, chmodSync, unlinkSync, existsSync,
} from 'fs'
import { join, resolve } from 'path'

import { platform } from 'os'
import {
  STATE_DIR, ACCESS_FILE, ENV_FILE,
  IS_WIN32, getSocketPath,
  type Access, type GroupPolicy, type GateResult,
  makeDebugger, loadEnv, requireCredentials,
  readAccess, saveAccess, gate,
  checkMention,
  fetchBotOpenId, fetchParentQuote,
  parseMessageContent, buildAttachmentInfo, formatTimestamp,
} from './shared.ts'

// ── Config ──────────────────────────────────────────────────────────────────

const DEBUG_LOG = join(STATE_DIR, 'router-debug.log')
const SOCK_PATH = getSocketPath()

const dbg = makeDebugger(DEBUG_LOG, '[router] ')

// ── Env & credentials ────────────────────────────────────────────────────────

loadEnv(ENV_FILE)
const { appId: APP_ID, appSecret: APP_SECRET, encryptKey: ENCRYPT_KEY } = requireCredentials()

// ── Access control ───────────────────────────────────────────────────────────

function loadRouterAccess(): Access {
  return readAccess(ACCESS_FILE, dbg)
}

// ── Feishu API ──────────────────────────────────────────────────────────────

const apiClient = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.warn })
let botOpenId: string | null = null

// ── Worker registry (Unix socket) ───────────────────────────────────────────

type Worker = { socket: Socket; workdir: string; buf: string }

const workers = new Map<Socket, Worker>()

function findWorker(workdir: string): Worker | undefined {
  const target = normalizeWorkdir(workdir)
  for (const w of workers.values()) {
    const wd = normalizeWorkdir(w.workdir)
    if (wd === target) return w
  }
  dbg(`findWorker: target="${target}" workers=${workers.size}`)
  for (const w of workers.values()) {
    dbg(`findWorker:  worker="${normalizeWorkdir(w.workdir)}"`)
  }
  return undefined
}

function normalizeWorkdir(p: string): string {
  let n = resolve(p)
  if (n.length > 3 && (n.endsWith('/') || n.endsWith('\\'))) n = n.slice(0, -1)
  return platform() === 'win32' ? n.toLowerCase() : n
}

function sendToWorker(w: Worker, payload: Record<string, unknown>) {
  try { w.socket.write(JSON.stringify(payload) + '\n') } catch (e) { dbg(`send failed: ${e}`) }
}

function routeToWorkdir(workdir: string, payload: Record<string, unknown>): boolean {
  const w = findWorker(workdir)
  if (!w) { dbg(`no worker for workdir ${workdir}`); return false }
  sendToWorker(w, payload)
  return true
}

let idleTimer: ReturnType<typeof setTimeout> | null = null
const IDLE_GRACE_MS = 10_000

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer)
  if (workers.size > 0) return
  idleTimer = setTimeout(() => {
    if (workers.size === 0) {
      dbg('all workers disconnected, shutting down')
      shutdown()
    }
  }, IDLE_GRACE_MS)
}

const sockServer = createServer((socket) => {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const w: Worker = { socket, workdir: '', buf: '' }
  workers.set(socket, w)
  dbg(`worker connected (${workers.size} total)`)

  socket.on('data', (chunk) => {
    w.buf += chunk.toString()
    let idx: number
    while ((idx = w.buf.indexOf('\n')) !== -1) {
      const line = w.buf.slice(0, idx)
      w.buf = w.buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'register' && msg.workdir) {
          w.workdir = resolve(msg.workdir)
          dbg(`worker registered: ${w.workdir}`)
        }
      } catch (e) { dbg(`bad message from worker: ${e}`) }
    }
  })

  socket.on('close', () => {
    workers.delete(socket)
    dbg(`worker disconnected: ${w.workdir} (${workers.size} remaining)`)
    scheduleIdleShutdown()
  })

  socket.on('error', (e) => {
    dbg(`worker socket error: ${e}`)
    workers.delete(socket)
    scheduleIdleShutdown()
  })
})

// ── Message routing ─────────────────────────────────────────────────────────

function resolveWorkdir(chatId: string, chatType: string, access: Access): string | undefined {
  if (chatType === 'group') {
    const wd = access.groups[chatId]?.workdir
    if (wd) return wd
  }
  return access.defaultWorkdir
}

function saveRouterAccess(a: Access) {
  saveAccess(a, ACCESS_FILE, STATE_DIR, false)
}

async function handleInbound(data: any) {
  const ev = data.event ?? data
  const sender = ev.sender, message = ev.message
  if (!sender || !message) return

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

  const access = loadRouterAccess()
  const mentioned = checkMention(mentions, text, botOpenId, access.mentionPatterns)
  const result = gate(senderId, chatId, chatType, mentioned, loadRouterAccess, saveRouterAccess)
  dbg(`gate result: ${result.action}, senderId=${senderId}, chatId=${chatId}, chatType=${chatType}, mentioned=${mentioned}`)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await (apiClient as any).im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: `${lead} — run:\n\nclaude-feishu access pair ${result.code}` }), reply_in_thread: false },
      })
    } catch (e) { dbg(`pairing reply failed: ${e}`) }
    return
  }

  if (access.ackReaction) {
    void (apiClient as any).im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: access.ackReaction } },
    }).catch((e: unknown) => dbg(`ack reaction failed: ${e}`))
  }

  const atts = buildAttachmentInfo(msgType, contentStr, postImageKeys)
  const ts = formatTimestamp(createTime)

  const parentId: string = (message as any).parent_id ?? ''
  const quotePrefix = parentId ? await fetchParentQuote(apiClient, parentId, dbg) : ''
  const body = text || (atts.length ? '(attachment)' : '')
  const content = quotePrefix + body
  if (!content) return

  const workdir = resolveWorkdir(chatId, chatType, result.access)
  if (!workdir) { dbg(`no workdir for ${chatId}, dropping`); return }

  dbg(`routing ${chatId} (${chatType}) → ${workdir}${parentId ? ' (reply)' : ''}`)
  const delivered = routeToWorkdir(workdir, {
    type: 'channel_message',
    content,
    meta: {
      chat_id: chatId,
      message_id: messageId,
      user: senderId,
      user_id: senderId,
      ts,
      chat_type: chatType,
      ...(parentId ? { parent_id: parentId } : {}),
      ...(atts.length ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    },
  })
  if (!delivered) {
    const hint = `⚠️ No active Claude Code session for \`${workdir}\`. Please run \`claude-feishu\` in that directory, then send your message again.`
    void (apiClient as any).im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: hint }), reply_in_thread: false },
    }).catch((e: unknown) => dbg(`no-worker hint reply failed: ${e}`))
  }
}

async function handleCardAction(data: any): Promise<Record<string, unknown>> {
  const value = data?.action?.value ?? {}
  const code = value.code as string | undefined
  const action = value.action as string | undefined
  if (!code || !action) return {}

  const chatId = data?.open_chat_id ?? ''
  const workdir = chatId ? resolveWorkdir(chatId, 'group') ?? resolveWorkdir(chatId, 'p2p') : undefined

  if (action === 'perm_allow' || action === 'perm_deny') {
    const behavior = action === 'perm_deny' ? 'deny' : 'allow'
    const payload = { type: 'permission_response', request_id: code, behavior }
    if (workdir) routeToWorkdir(workdir, payload)
    else for (const w of workers.values()) sendToWorker(w, payload)

    const statusText = behavior === 'allow' ? '✅ 已允许' : '❌ 已拒绝'
    return {
      toast: { type: behavior === 'deny' ? 'info' : 'success', content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `🔐 Permission Request — ${statusText}` }, template: behavior === 'deny' ? 'grey' : 'green' },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
        },
      },
    }
  }

  if (action === 'confirm' || action === 'cancel') {
    const isConfirm = action === 'confirm'
    const payload = {
      type: 'confirm_response',
      content: isConfirm ? `CONFIRMED ${code}` : `CANCELLED ${code}`,
      meta: {
        chat_id: chatId || 'system',
        message_id: `card-${Date.now()}`,
        user: 'system',
        user_id: 'system',
        ts: new Date().toISOString(),
        chat_type: 'p2p',
      },
    }
    if (workdir) routeToWorkdir(workdir, payload)
    else for (const w of workers.values()) sendToWorker(w, payload)

    const statusText = isConfirm ? '✅ 已确认' : '❌ 已取消'
    return {
      toast: { type: isConfirm ? 'success' : 'info', content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `⚡ 操作确认 — ${statusText}` }, template: isConfirm ? 'green' : 'grey' },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
        },
      },
    }
  }

  return {}
}

// ── Startup ─────────────────────────────────────────────────────────────────

dbg('router starting')
mkdirSync(STATE_DIR, { recursive: true })
botOpenId = await fetchBotOpenId(apiClient, dbg)

if (!IS_WIN32 && existsSync(SOCK_PATH)) { try { unlinkSync(SOCK_PATH) } catch (e) { dbg(`failed to unlink stale socket: ${e}`) } }

sockServer.listen(SOCK_PATH, () => {
  if (!IS_WIN32) chmodSync(SOCK_PATH, 0o600)
  dbg(`socket listening: ${SOCK_PATH}`)
})

const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.warn })
const dispatcher = new lark.EventDispatcher({ encryptKey: ENCRYPT_KEY }).register({
  'im.message.receive_v1': async (data: any) => {
    dbg('im.message.receive_v1 fired')
    return handleInbound(data).catch(e => dbg(`handleInbound failed: ${e}`))
  },
  'card.action.trigger': async (data: any) => {
    dbg('card.action.trigger fired')
    return handleCardAction(data).catch(e => { dbg(`handleCardAction failed: ${e}`); return {} })
  },
})

wsClient.start({ eventDispatcher: dispatcher }).catch(e => dbg(`wsClient error: ${e}`))

if (!IS_WIN32) process.on('SIGUSR1', () => {
  const lines = [`\n=== Router Status ===`, `workers: ${workers.size}`]
  for (const w of workers.values()) {
    lines.push(`  ${w.workdir}`)
  }
  dbg(lines.join('\n'))
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return; shuttingDown = true
  dbg('shutting down')
  sockServer.close()
  if (!IS_WIN32) try { unlinkSync(SOCK_PATH) } catch (e) { dbg(`failed to unlink socket on shutdown: ${e}`) }
  try { (wsClient as any).disconnect?.() } catch (e) { dbg(`wsClient disconnect failed: ${e}`) }
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const access = loadRouterAccess()
const groupCount = Object.keys(access.groups).length
dbg(`router ready — ${groupCount} groups, defaultWorkdir=${access.defaultWorkdir ?? '(none)'}`)

await new Promise(() => {})
