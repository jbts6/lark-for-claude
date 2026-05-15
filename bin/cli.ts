#!/usr/bin/env bun
/**
 * CLI for Feishu channel management.
 * Usage: bun bin/cli.ts auth|access <subcommand> [args]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import {
  STATE_DIR, ACCESS_FILE, ENV_FILE,
  readAccess, saveAccess,
  type Access,
} from '../shared.ts'

const cmd = process.argv[2]
const args = process.argv.slice(3)

function usage() {
  console.log(`Usage:
  claude-feishu auth [<appId> <appSecret>|key <k> <v>|chat-id <chat_id>|clear]
  claude-feishu access [status|allow <id>|remove <id>|policy <mode>|group add/rm <chatId> [--no-mention] [--allow ids] [--workdir <path>]|set <k> <v>]`)
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function writeEnvFile(content: string) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(ENV_FILE, content)
  try { chmodSync(ENV_FILE, 0o600) } catch {}
}

function handleAuth(a: string[]) {
  if (a.length === 0) {
    const content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
    const appId = content.match(/^FEISHU_APP_ID=(.+)$/m)?.[1]
    const appSecret = content.match(/^FEISHU_APP_SECRET=(.+)$/m)?.[1]
    const encryptKey = content.match(/^FEISHU_ENCRYPT_KEY=(.+)$/m)?.[1]
    const appChatId = content.match(/^FEISHU_APP_CHAT_ID=(.+)$/m)?.[1]
    console.log('')
    if (appId) {
      console.log(`  App ID:       ${appId}`)
      console.log(`  App Secret:   ${appSecret ? appSecret.slice(0, 4) + '****' : '(not set)'}`)
      if (encryptKey) console.log(`  Encrypt Key:  ${encryptKey.slice(0, 4)}****`)
      console.log(`  App Chat ID:  ${appChatId ?? '(not set)'}`)
    } else {
      console.log('  Credentials:  NOT CONFIGURED')
      console.log('  Run: claude-feishu auth <app_id> <app_secret>\n')
    }
    console.log('  ── Access Summary ──')
    const ac = readAccess(ACCESS_FILE, () => {})
    console.log(`  DM Policy:    ${ac.dmPolicy}`)
    console.log(`  Allowlist:    ${ac.allowFrom.length} user(s)`)
    console.log(`  Groups:       ${Object.keys(ac.groups).length} chat(s)`)
    return
  }
  if (a[0] === 'key') {
    const key = a[1]
    const val = a[2]
    if (!key || !val) { console.error('Usage: claude-feishu auth key <key> <value>'); process.exit(1) }
    let content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
    const re = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm')
    if (re.test(content)) content = content.replace(re, `${key}=${val}`)
    else content += `${key}=${val}\n`
    writeEnvFile(content)
    console.log(`Set ${key}`)
    return
  }
  if (a[0] === 'chat-id') {
    const chatId = a[1]
    if (!chatId) { console.error('Usage: claude-feishu auth chat-id <chat_id>'); process.exit(1) }
    let content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
    const re = /^FEISHU_APP_CHAT_ID=.*$/m
    if (re.test(content)) content = content.replace(re, `FEISHU_APP_CHAT_ID=${chatId}`)
    else content += `FEISHU_APP_CHAT_ID=${chatId}\n`
    writeEnvFile(content)
    console.log(`Set FEISHU_APP_CHAT_ID=${chatId}`)
    return
  }
  if (a[0] === 'clear') {
    writeEnvFile('')
    console.log('Credentials cleared')
    return
  }
  if (a.length >= 2) {
    writeEnvFile(`FEISHU_APP_ID=${a[0]}\nFEISHU_APP_SECRET=${a[1]}\n`)
    if (a[2]) writeFileSync(ENV_FILE, `\nFEISHU_ENCRYPT_KEY=${a[2]}\n`, { flag: 'a' })
    console.log('Credentials saved. Restart Claude Code or run /reload-plugins.')
    return
  }
  usage(); process.exit(1)
}

// ── Access ───────────────────────────────────────────────────────────────────

function showAccessFull() {
  const ac = readAccess(ACCESS_FILE, () => {})
  console.log('')
  console.log(`  DM Policy:          ${ac.dmPolicy}`)
  console.log(`  Default Workdir:    ${ac.defaultWorkdir ?? '(none)'}`)
  console.log(`  Ack Reaction:       ${ac.ackReaction ?? '(none)'}`)
  console.log(`  Text Chunk Limit:   ${ac.textChunkLimit ?? 4096}`)
  console.log(`  Mention Patterns:   ${ac.mentionPatterns?.join(', ') ?? '(none)'}\n`)

  console.log(`  Allowlist (${ac.allowFrom.length}):`)
  for (const id of ac.allowFrom) {
    const chat = Object.entries(ac.p2pChats).find(([, oid]) => oid === id)
    console.log(`    ${id}${chat ? `  (chat: ${chat[0]})` : ''}`)
  }

  const groups = Object.entries(ac.groups)
  if (groups.length) {
    console.log(`\n  Groups (${groups.length}):`)
    for (const [chatId, g] of groups) {
      console.log(`    ${chatId}`)
      console.log(`      mention required: ${g.requireMention}`)
      if (g.allowFrom.length) console.log(`      allowed users: ${g.allowFrom.join(', ')}`)
      if (g.workdir) console.log(`      workdir: ${g.workdir}`)
    }
  }
}

function handleAccess(a: string[]) {
  const sub = a[0]
  const rest = a.slice(1)
  if (!sub || sub === 'status') { showAccessFull(); return }

  if (sub === 'allow') {
    const id = rest[0]
    if (!id) { console.error('Usage: claude-feishu access allow <senderId>'); process.exit(1) }
    const ac = readAccess(ACCESS_FILE, () => {})
    if (ac.allowFrom.includes(id)) { console.log('Already in allowlist'); return }
    ac.allowFrom.push(id)
    saveAccess(ac, ACCESS_FILE, STATE_DIR, false)
    console.log(`Added ${id}`)
    return
  }

  if (sub === 'remove') {
    const id = rest[0]
    if (!id) { console.error('Usage: claude-feishu access remove <senderId>'); process.exit(1) }
    const ac = readAccess(ACCESS_FILE, () => {})
    ac.allowFrom = ac.allowFrom.filter(x => x !== id)
    for (const [chatId, oid] of Object.entries(ac.p2pChats)) {
      if (oid === id) delete ac.p2pChats[chatId]
    }
    saveAccess(ac, ACCESS_FILE, STATE_DIR, false)
    console.log(`Removed ${id}`)
    return
  }

  if (sub === 'policy') {
    const mode = rest[0]
    if (!mode || !['allowlist', 'disabled'].includes(mode)) {
      console.error('Usage: claude-feishu access policy <allowlist|disabled>')
      process.exit(1)
    }
    const ac = readAccess(ACCESS_FILE, () => {})
    ac.dmPolicy = mode as Access['dmPolicy']
    saveAccess(ac, ACCESS_FILE, STATE_DIR, false)
    console.log(`DM policy set to ${mode}`)
    return
  }

  if (sub === 'group') {
    const action = rest[0]
    const chatId = rest[1]
    if (!action || !chatId) {
      console.error('Usage: claude-feishu access group add|rm <chatId> [--no-mention] [--allow ids] [--workdir <path>]')
      process.exit(1)
    }
    const ac = readAccess(ACCESS_FILE, () => {})
    if (action === 'add') {
      const requireMention = !rest.includes('--no-mention')
      const allowIdx = rest.indexOf('--allow')
      const allowFrom = allowIdx >= 0 ? rest[allowIdx + 1]?.split(',').map(s => s.trim()).filter(Boolean) ?? [] : []
      const workdirIdx = rest.indexOf('--workdir')
      const workdir = workdirIdx >= 0 ? rest[workdirIdx + 1] : process.cwd()
      ac.groups[chatId] = { requireMention, allowFrom, workdir }
      saveAccess(ac, ACCESS_FILE, STATE_DIR, false)
      console.log(`Group ${chatId} added (mention required: ${requireMention}, workdir: ${workdir})`)
    } else if (action === 'rm' || action === 'remove') {
      delete ac.groups[chatId]
      saveAccess(ac, ACCESS_FILE, STATE_DIR, false)
      console.log(`Group ${chatId} removed`)
    } else {
      console.error('Usage: claude-feishu access group add|rm <chatId> [--no-mention] [--allow ids] [--workdir <path>]')
      process.exit(1)
    }
    return
  }

  if (sub === 'set') {
    const key = rest[0]
    const val = rest.slice(1).join(' ')
    if (!key || !val) { console.error('Usage: claude-feishu access set <key> <value>'); process.exit(1) }
    const ac = readAccess(ACCESS_FILE, () => {})
    if (key === 'ackReaction') ac.ackReaction = val
    else if (key === 'textChunkLimit') ac.textChunkLimit = parseInt(val)
    else if (key === 'mentionPatterns') {
      try { ac.mentionPatterns = JSON.parse(val) } catch { ac.mentionPatterns = [val] }
    } else { console.error(`Unknown key: ${key}`); process.exit(1) }
    saveAccess(ac, ACCESS_FILE, STATE_DIR, false)
    console.log(`Set ${key} = ${val}`)
    return
  }

  usage(); process.exit(1)
}

// ── Main ────────────────────────────────────────────────────────────────────

if (!cmd || cmd === 'help') { usage(); process.exit(0) }

switch (cmd) {
  case 'auth':    handleAuth(args); break
  case 'access':  handleAccess(args); break
  default:
    console.error(`Unknown command: ${cmd}`)
    usage()
    process.exit(1)
}
