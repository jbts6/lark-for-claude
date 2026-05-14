#!/usr/bin/env node
/**
 * One-command installer for Feishu Channel for Claude Code.
 * Usage: npx lark-for-claude
 */

const { execSync } = require('child_process')
const { existsSync, mkdirSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')

const REPO = 'https://github.com/jbts6/lark-for-claude.git'
const INSTALL_DIR = join(homedir(), '.local', 'share', 'lark-for-claude')

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

// ── Prerequisites ──────────────────────────────────────────────────────────

let ok = true
if (!ok) process.exit(1)

console.log('\nInstalling Feishu Channel for Claude Code...\n')

// ── Clone or update ────────────────────────────────────────────────────────

if (existsSync(join(INSTALL_DIR, '.git'))) {
  console.log('Updating existing installation...')
  run('git pull', { cwd: INSTALL_DIR })
} else {
  mkdirSync(join(homedir(), '.local', 'share'), { recursive: true })
  run(`git clone "${REPO}" "${INSTALL_DIR}"`)
}

// ── Install dependencies + create claude-feishu shortcut ───────────────────

run('bun install', { cwd: INSTALL_DIR })

// ── Register plugin ────────────────────────────────────────────────────────

try {
  run(`claude plugin marketplace add "${INSTALL_DIR}"`)
} catch {
  // marketplace already registered — continue
}

try {
  run('claude plugin install feishu@feishu-local')
} catch {
  // plugin already installed — continue
}

// ── Done ───────────────────────────────────────────────────────────────────

console.log(`
\x1b[32mDone!\x1b[0m Next steps:

  1. Start Claude with Feishu channel:
     $ claude-feishu

  2. Configure credentials:
     $ claude-feishu auth <app_id> <app_secret>

  3. Pair your Feishu account — send a message to the bot, then:
     $ claude-feishu access pair <code>
`)
