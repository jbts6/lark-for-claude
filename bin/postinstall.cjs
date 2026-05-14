#!/usr/bin/env node
/**
 * Post-install script for lark-for-claude.
 * Creates platform-appropriate launcher scripts in ~/.local/bin/
 * that delegate to the real scripts in the install directory.
 */
const { mkdirSync, writeFileSync, chmodSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')

const binDir = join(homedir(), '.local', 'bin')
const installBinDir = join(__dirname)
mkdirSync(binDir, { recursive: true })

if (process.platform === 'win32') {
  const target = join(binDir, 'claude-feishu.cmd')
  writeFileSync(target, `@echo off\r\n"${installBinDir}\\claude-feishu.cmd" %*\r\n`)
} else {
  const target = join(binDir, 'claude-feishu')
  writeFileSync(target, `#!/bin/bash\nexec "${installBinDir}/claude-feishu" "$@"\n`)
  try { chmodSync(target, 0o755) } catch {}
}
