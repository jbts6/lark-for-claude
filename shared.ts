#!/usr/bin/env bun
/**
 * Shared types, constants, and utilities for server.ts and router.ts.
 * Eliminates code duplication between the two modules.
 */
import * as lark from '@larksuiteoapi/node-sdk'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, chmodSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep, extname } from 'path'
import { realpathSync } from 'fs'

// ── Constants ────────────────────────────────────────────────────────────────

export const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const MAX_CHUNK = 4096
export const MAX_FILE = 30 * 1024 * 1024
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
export const FEISHU_FTYPES: Record<string, string> = {
  '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt', '.mp4': 'mp4', '.opus': 'opus',
}

export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
export const CONFIRM_CHARS = 'abcdefghijkmnopqrstuvwxyz'

// ── Types ────────────────────────────────────────────────────────────────────

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  workdir?: string
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  p2pChats: Record<string, string>
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  textChunkLimit?: number
  defaultWorkdir?: string
}

// ── Debug logging ────────────────────────────────────────────────────────────

export function makeDebugger(logFile: string, prefix = '') {
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${prefix}${msg}\n`
    process.stderr.write(line)
    try { appendFileSync(logFile, line) } catch (e) { process.stderr.write(`debug log write failed: ${e}\n`) }
  }
}

// ── Environment / credentials ────────────────────────────────────────────────

export function loadEnv(envFile: string) {
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      if (line.startsWith('#')) continue
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
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
  return { dmPolicy: 'pairing', allowFrom: [], p2pChats: {}, groups: {}, pending: {}, ackReaction: 'Get' }
}

export function readAccess(accessFile: string, dbg: (msg: string) => void): Access {
  try {
    const p = JSON.parse(readFileSync(accessFile, 'utf8')) as Partial<Access>
    return {
      dmPolicy: p.dmPolicy ?? 'pairing',
      allowFrom: p.allowFrom ?? [],
      p2pChats: p.p2pChats ?? {},
      groups: p.groups ?? {},
      pending: p.pending ?? {},
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

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [k, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[k]; changed = true }
  }
  return changed
}

export function assertSendable(f: string, stateDir: string) {
  try {
    const real = realpathSync(f), sr = realpathSync(stateDir), inbox = join(sr, 'inbox')
    if (real.startsWith(sr + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  } catch (e) {
    if ((e as any).message?.startsWith('refusing')) throw e
    throw new Error(`cannot resolve path for security check: ${f} — ${e}`)
  }
}

export function assertAllowedChat(chatId: string, a: Access) {
  const oid = a.p2pChats[chatId]
  if (oid !== undefined && a.allowFrom.includes(oid)) return
  if (a.allowFrom.includes(chatId)) return
  if (chatId in a.groups) return
  throw new Error(`chat ${chatId} is not allowlisted — add via /feishu:access`)
}

// ── Confirm code generation ──────────────────────────────────────────────────

export function genConfirmCode(): string {
  const bytes = randomBytes(5)
  return Array.from(bytes).map(b => CONFIRM_CHARS[b % CONFIRM_CHARS.length]).join('')
}

// ── Gate (DM pairing / group access) ─────────────────────────────────────────

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export function gate(
  senderId: string, chatId: string, chatType: string, mentioned: boolean,
  loadAccess: () => Access, saveAccessFn: (a: Access) => void,
): GateResult {
  const a = loadAccess()
  if (pruneExpired(a)) saveAccessFn(a)
  if (a.dmPolicy === 'disabled') return { action: 'drop' }

  if (chatType === 'p2p') {
    if (a.allowFrom.includes(senderId)) return { action: 'deliver', access: a }
    if (a.dmPolicy === 'allowlist') return { action: 'drop' }
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1; saveAccessFn(a)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(a.pending).length >= 3) return { action: 'drop' }
    const code = genConfirmCode()
    const now = Date.now()
    a.pending[code] = { senderId, chatId, createdAt: now, expiresAt: now + 3600000, replies: 1 }
    saveAccessFn(a)
    return { action: 'pair', code, isResend: false }
  }

  const policy = a.groups[chatId]
  if (!policy) return { action: 'drop' }
  if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) return { action: 'drop' }
  if ((policy.requireMention ?? true) && !mentioned) return { action: 'drop' }
  return { action: 'deliver', access: a }
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

export function checkMention(mentions: any[], text: string, botOpenId: string | null, extra?: string[]): boolean {
  for (const m of mentions) {
    if (m.mentioned_type === 'bot') return true
    if (botOpenId && m.id?.open_id === botOpenId) return true
  }
  for (const p of extra ?? []) {
    try { if (new RegExp(p, 'i').test(text)) return true } catch (e) { process.stderr.write(`invalid mention pattern "${p}": ${e}\n`) }
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

// ── Access cache with TTL ────────────────────────────────────────────────────

export class AccessCache {
  private cached: Access | null = null
  private mtimeMs = 0
  private ttlMs: number

  constructor(ttlMs = 2000) { this.ttlMs = ttlMs }

  get(accessFile: string, dbg: (msg: string) => void): Access {
    try {
      const stat = { mtimeMs: 0 }
      try { const fs = require('fs'); const s = fs.statSync(accessFile); stat.mtimeMs = s.mtimeMs } catch {}
      if (this.cached && stat.mtimeMs === this.mtimeMs) return this.cached
      this.cached = readAccess(accessFile, dbg)
      this.mtimeMs = stat.mtimeMs
      return this.cached
    } catch {
      this.cached = null
      this.mtimeMs = 0
      return readAccess(accessFile, dbg)
    }
  }

  invalidate() { this.cached = null; this.mtimeMs = 0 }
}
