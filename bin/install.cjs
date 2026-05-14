#!/usr/bin/env node
/**
 * One-command installer for Feishu Channel for Claude Code.
 * Usage: npx lark-for-claude
 *
 * Copies the npm package contents (only files that pass .npmignore)
 * to the install directory, then registers the plugin with Claude Code.
 */
const { execSync } = require('child_process')
const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('fs')
const { join, resolve } = require('path')
const { homedir } = require('os')

const INSTALL_DIR = join(homedir(), '.local', 'share', 'lark-for-claude')
const CURRENT_PKG = resolve(__dirname, '..')

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    if (name === 'node_modules') continue
    const s = join(src, name), d = join(dest, name)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

// ── Copy package ──────────────────────────────────────────────────────────

console.log('\nInstalling Feishu Channel for Claude Code...\n')

if (existsSync(INSTALL_DIR)) {
  console.log('Updating existing installation...')
  rmSync(INSTALL_DIR, { recursive: true, force: true })
}

copyDir(CURRENT_PKG, INSTALL_DIR)
console.log(`  Copied to ${INSTALL_DIR}`)

// ── Install dependencies ──────────────────────────────────────────────────

run('bun install', { cwd: INSTALL_DIR })

// ── Register plugin ───────────────────────────────────────────────────────

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

// ── Done ──────────────────────────────────────────────────────────────────

console.log(`
\x1b[32mDone!\x1b[0m Next steps:

  1. Start Claude with Feishu channel:
     $ claude-feishu

  2. Configure credentials:
     $ claude-feishu auth <app_id> <app_secret>

  3. Pair your Feishu account — send a message to the bot, then:
     $ claude-feishu access pair <code>
`)
