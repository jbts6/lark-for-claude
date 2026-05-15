#!/usr/bin/env bun
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
import * as lark from '@larksuiteoapi/node-sdk'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, chmodSync, realpathSync,
  statSync, existsSync, rmSync, openSync, closeSync, writeSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'

// ── Constants ────────────────────────────────────────────────────────────────

export const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const ENV_FILE = join(STATE_DIR, '.env')
export const MAX_CHUNK = 4096
export const MAX_LOG_SIZE = 5 * 1024 * 1024
export const MAX_LOG_FILES = 3
export const LOG_ROTATE_CHECK_INTERVAL = 100

export const PERMISSION_REPLY_RE = /^\s*(yy|yesyes|y|yes|n|no)\s+([a-km-z]{8})\s*$/i
export const CONFIRM_CHARS = 'abcdefghijkmnopqrstuvwxyz'

// ── Platform helpers ───────────────────────────────────────────────────────────

export const IS_WIN32 = process.platform === 'win32'

export function getSocketPath(): string {
  return IS_WIN32
    ? '\\\\.\\pipe\\feishu-router'
    : join(STATE_DIR, 'router.sock')
}

// ── Types ────────────────────────────────────────────────────────────────────

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  workdir?: string
}

export type Access = {
  dmPolicy: 'allowlist' | 'disabled'
  allowFrom: string[]
  p2pChats: Record<string, string>
  groups: Record<string, GroupPolicy>
  mentionPatterns?: string[]
  ackReaction?: string
  textChunkLimit?: number
  defaultWorkdir?: string
}

// ── Debug logging ────────────────────────────────────────────────────────────

export function rotateLogIfNeeded(logFile: string) {
  try {
    const size = statSync(logFile).size
    if (size < MAX_LOG_SIZE) return
    for (let i = MAX_LOG_FILES - 2; i >= 1; i--) {
      const oldPath = `${logFile}.${i}`
      try {
        if (!existsSync(oldPath)) continue
        if (i === MAX_LOG_FILES - 1) rmSync(oldPath, { force: true })
        else renameSync(oldPath, `${logFile}.${i + 1}`)
      } catch { /* ignore rotation errors for individual files */ }
    }
    renameSync(logFile, `${logFile}.1`)
  } catch { /* file doesn't exist or inaccessible, skip rotation */ }
}

export function makeDebugger(logFile: string, prefix = '') {
  let writeCount = 0
  let buf = ''
  let fd: number | null = null
  const FLUSH_INTERVAL_MS = 1000
  const FLUSH_THRESHOLD = 4096

  function flush() {
    if (!buf) return
    const data = buf
    buf = ''
    try {
      if (fd === null) fd = openSync(logFile, 'a')
      writeSync(fd, data)
    } catch (e) {
      fd = null
      try { appendFileSync(logFile, data) } catch { /* give up */ }
    }
  }

  rotateLogIfNeeded(logFile)

  const timer = setInterval(flush, FLUSH_INTERVAL_MS)
  timer.unref()

  return (msg: string) => {
    const line = `${new Date().toISOString()} ${prefix}${msg}\n`
    process.stderr.write(line)
    buf += line
    writeCount++
    if (buf.length >= FLUSH_THRESHOLD) flush()
    if (writeCount % LOG_ROTATE_CHECK_INTERVAL === 0) {
      flush()
      if (fd !== null) { closeSync(fd); fd = null }
      rotateLogIfNeeded(logFile)
    }
  }
}

// ── Environment / credentials ────────────────────────────────────────────────

export function loadEnv(envFile: string) {
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      if (line.startsWith('#')) continue
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && m[1] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2] ?? ''
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') process.stderr.write(`loadEnv warning: ${e}\n`)
  }
}

export function requireCredentials() {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) {
    process.stderr.write(
      `feishu channel: FEISHU_APP_ID and FEISHU_APP_SECRET required\n` +
      `  set in ${ENV_FILE}\n  format: FEISHU_APP_ID=cli_...  FEISHU_APP_SECRET=...\n`,
    )
    process.exit(1)
  }
  return { appId, appSecret, encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? '' }
}

// ── Access control ───────────────────────────────────────────────────────────

export function defAccess(): Access {
  return { dmPolicy: 'allowlist', allowFrom: [], p2pChats: {}, groups: {}, ackReaction: 'Get' }
}

export function readAccess(accessFile: string, dbg: (msg: string) => void): Access {
  try {
    const p = JSON.parse(readFileSync(accessFile, 'utf8')) as Partial<Access>
    return {
      dmPolicy: p.dmPolicy ?? 'allowlist',
      allowFrom: p.allowFrom ?? [],
      p2pChats: p.p2pChats ?? {},
      groups: p.groups ?? {},
      mentionPatterns: p.mentionPatterns,
      ackReaction: p.ackReaction ?? 'Get',
      textChunkLimit: p.textChunkLimit,
      defaultWorkdir: p.defaultWorkdir,
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return defAccess()
    try { renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`) } catch (re) { dbg(`failed to rename corrupt access file: ${re}`) }
    dbg(`access.json corrupt, starting fresh: ${e}`)
    return defAccess()
  }
}

export function saveAccess(a: Access, accessFile: string, stateDir: string, staticMode: boolean) {
  if (staticMode) return
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = accessFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, accessFile)
}

export function assertAllowedChat(chatId: string, a: Access) {
  const oid = a.p2pChats[chatId]
  if (oid !== undefined && a.allowFrom.includes(oid)) return
  if (a.allowFrom.includes(chatId)) return
  if (chatId in a.groups) return
  throw new Error(`chat ${chatId} is not allowlisted — add via claude-feishu access`)
}

/** Resolve chat_id by matching workdir against access.json groups, then fall back to FEISHU_APP_CHAT_ID. */
export function resolveChatId(workdir: string | undefined, access: Access): string | undefined {
  const cwd = workdir ? normalizePath(workdir) : undefined
  if (cwd) {
    for (const [chatId, policy] of Object.entries(access.groups)) {
      if (policy.workdir && normalizePath(policy.workdir) === cwd) return chatId
    }
  }
  return process.env.FEISHU_APP_CHAT_ID || undefined
}

const normalizePathCache = new Map<string, string>()

/** Resolve chat_id from explicit value or workdir fallback, then assert it is allowlisted. Throws if unresolvable or unauthorized. */
export function resolveAndAssertChatId(chatId: string | undefined, workdir: string | undefined, access: Access): string {
  let resolved = chatId ?? ''
  if (!resolved) resolved = resolveChatId(workdir, access) ?? ''
  if (!resolved) throw new Error('chat_id required — no inbound message and no fallback chat configured')
  assertAllowedChat(resolved, access)
  return resolved
}

/** Normalize a filesystem path: resolve symlinks, strip trailing slashes, lowercase on Windows. Results are cached. */
export function normalizePath(p: string): string {
  const cached = normalizePathCache.get(p)
  if (cached !== undefined) return cached
  let result = p
  try { result = realpathSync(p) } catch {}
  if (result.length > 3 && (result.endsWith('/') || result.endsWith('\\'))) result = result.slice(0, -1)
  result = process.platform === 'win32' ? result.toLowerCase() : result
  normalizePathCache.set(p, result)
  return result
}

// ── Confirm code generation ──────────────────────────────────────────────────

export function genConfirmCode(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes).map(b => CONFIRM_CHARS[b % CONFIRM_CHARS.length]).join('')
}

// ── Gate (DM / group access) ─────────────────────────────────────────────────

export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }

/**
 * DM / group access gate.
 * - DM: allowlist only (dmPolicy='disabled' drops all).
 * - Group: must be in access.groups; optionally require mention or restrict by allowFrom.
 * Returns { action: 'deliver' } or { action: 'drop' }.
 */
export function gate(
  senderId: string, chatId: string, chatType: string, mentioned: boolean,
  loadAccess: () => Access,
): GateResult {
  const a = loadAccess()
  if (a.dmPolicy === 'disabled') return { action: 'drop' }

  if (chatType === 'p2p') {
    if (a.allowFrom.includes(senderId)) return { action: 'deliver' }
    return { action: 'drop' }
  }

  const policy = a.groups[chatId]
  if (!policy) return { action: 'drop' }
  if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) return { action: 'drop' }
  if ((policy.requireMention ?? true) && !mentioned) return { action: 'drop' }
  return { action: 'deliver' }
}

// ── Text chunking ────────────────────────────────────────────────────────────

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Mention detection ────────────────────────────────────────────────────────

const MAX_PATTERN_LENGTH = 128

export function checkMention(mentions: any[], text: string, botOpenId: string | null, extra?: string[]): boolean {
  for (const m of mentions) {
    if (m.mentioned_type === 'bot') return true
    if (botOpenId && m.id?.open_id === botOpenId) return true
  }
  for (const p of extra ?? []) {
    try {
      if (p.length > MAX_PATTERN_LENGTH) { process.stderr.write(`mention pattern too long (${p.length} chars), skipping\n`); continue }
      if (new RegExp(p, 'i').test(text)) return true
    } catch (e) { process.stderr.write(`invalid mention pattern "${p}": ${e}\n`) }
  }
  return false
}

// ── Feishu API helpers ───────────────────────────────────────────────────────

export async function fetchBotOpenId(apiClient: lark.Client, dbg: (msg: string) => void): Promise<string | null> {
  try {
    const r = await (apiClient as any).bot.botInfo.get()
    const oid = r?.bot?.open_id ?? r?.data?.bot?.open_id ?? null
    if (oid) dbg(`bot open_id = ${oid}`)
    return oid
  } catch (e) { dbg(`could not fetch bot open_id: ${e}`); return null }
}

export async function fetchParentQuote(apiClient: lark.Client, parentId: string, dbg: (msg: string) => void): Promise<string> {
  try {
    const r = await (apiClient as any).im.message.get({ path: { message_id: parentId } })
    const items: any[] = r?.items ?? r?.data?.items ?? []
    if (!items.length) return ''
    const m = items[0]
    const raw: string = m.body?.content ?? m.content ?? ''
    let txt = raw
    try { txt = JSON.parse(raw).text ?? raw } catch {}
    const mtype: string = m.msg_type ?? m.message_type ?? ''
    const who: string = m.sender?.id ?? m.sender?.sender_id ?? ''
    const preview = (txt || `[${mtype}]`).replace(/\s+/g, ' ').trim().slice(0, 500)
    return `> [replying to ${who}]: ${preview}\n\n`
  } catch (e) { dbg(`fetchParentQuote failed: ${e}`); return '' }
}

// ── Message parsing ──────────────────────────────────────────────────────────

export type InboundEvent = {
  senderId: string
  chatId: string
  chatType: string
  messageId: string
  msgType: string
  contentStr: string
  mentions: any[]
  createTime: string
  parentId: string
  text: string
  postImageKeys: string[]
}

/** Parse a Feishu inbound event into a structured object. Returns null if sender/message missing or IDs invalid. */
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
  const parentId: string = (message as any).parent_id ?? ''
  if (!senderId || !chatId || !messageId) return null
  const { text, postImageKeys } = parseMessageContent(msgType, contentStr)
  return { senderId, chatId, chatType, messageId, msgType, contentStr, mentions, createTime, parentId, text, postImageKeys }
}

export type ParsedMessage = {
  text: string
  postImageKeys: string[]
}

export function parseMessageContent(msgType: string, contentStr: string): ParsedMessage {
  let text = ''
  const postImageKeys: string[] = []
  try {
    const parsed = JSON.parse(contentStr)
    if (msgType === 'post') {
      if (parsed.title) text += parsed.title
      const rows: any[] = Array.isArray(parsed.content) ? parsed.content : []
      for (const row of rows) {
        if (!Array.isArray(row)) continue
        const parts: string[] = []
        for (const seg of row) {
          if (seg?.tag === 'text' && seg.text) parts.push(seg.text)
          else if (seg?.tag === 'a' && seg.text) parts.push(`${seg.text}(${seg.href ?? ''})`)
          else if (seg?.tag === 'at' && (seg.user_name ?? seg.user_id)) parts.push(`@${seg.user_name ?? seg.user_id}`)
          else if (seg?.tag === 'img' && seg.image_key) postImageKeys.push(seg.image_key)
        }
        if (parts.length) text += (text ? '\n' : '') + parts.join(' ')
      }
    } else {
      text = parsed.text ?? ''
    }
  } catch { text = contentStr }
  return { text, postImageKeys }
}

// ── Attachment info ──────────────────────────────────────────────────────────

export function buildAttachmentInfo(msgType: string, contentStr: string, postImageKeys: string[]): string[] {
  const atts: string[] = []
  if (msgType === 'file') {
    try { const c = JSON.parse(contentStr); atts.push(`${c.file_name ?? 'file'} (file, key:${c.file_key ?? ''})`) } catch {}
  } else if (msgType === 'image') {
    try { const c = JSON.parse(contentStr); atts.push(`image (image/jpeg, key:${c.image_key ?? ''})`) } catch {}
  }
  for (const k of postImageKeys) atts.push(`image (image/jpeg, key:${k})`)
  return atts
}

// ── Timestamp formatting ─────────────────────────────────────────────────────

export function formatTimestamp(createTime: string): string {
  if (!createTime) return new Date().toISOString()
  const n = parseInt(createTime)
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

// ── Card action parsing ──────────────────────────────────────────────────────

export type CardActionParsed =
  | { type: 'perm'; code: string; behavior: 'allow' | 'allow-always' | 'deny' }
  | { type: 'confirm'; code: string; isConfirm: boolean; isAlways: boolean }
  | { type: 'unknown' }

/** Parse a card action callback value into a typed discriminated union. */
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

// ── Card building ────────────────────────────────────────────────────────────

/** Build a Feishu interactive card with ✅/✅✅/❌ buttons and a text-reply hint. */
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

// ── Access cache with TTL ────────────────────────────────────────────────────

export class AccessCache {
  private cached: Access | null = null
  private mtimeMs = 0
  private ttlMs: number

  constructor(ttlMs = 2000) { this.ttlMs = ttlMs }

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

  invalidate() { this.cached = null; this.mtimeMs = 0 }
}
