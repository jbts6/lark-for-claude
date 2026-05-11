import { describe, test, expect } from 'bun:test'

import {
  chunkText, checkMention, assertAllowedChat, genConfirmCode, gate,
  readAccess, defAccess, pruneExpired, parseMessageContent,
  buildAttachmentInfo, formatTimestamp,
  PERMISSION_REPLY_RE, CONFIRM_CHARS,
  type Access, type PendingEntry, type GroupPolicy, type GateResult,
  AccessCache,
} from './shared.ts'

// ---------- chunkText ----------

describe('chunkText', () => {
  test('short text returns single chunk', () => {
    expect(chunkText('hello', 100)).toEqual(['hello'])
  })

  test('empty text returns single chunk', () => {
    expect(chunkText('', 100)).toEqual([''])
  })

  test('splits on paragraph boundary', () => {
    const text = 'first paragraph\n\nsecond paragraph'
    const chunks = chunkText(text, 20)
    expect(chunks[0]).toBe('first paragraph')
    expect(chunks.length).toBe(2)
  })

  test('splits on line boundary when no paragraph break', () => {
    const text = 'line one\nline two\nline three'
    const chunks = chunkText(text, 15)
    expect(chunks[0]).toBe('line one')
    expect(chunks.length).toBeGreaterThan(1)
  })

  test('splits on space when no line break', () => {
    const text = 'word1 word2 word3 word4 word5'
    const chunks = chunkText(text, 12)
    expect(chunks.every(c => c.length <= 12)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('word1')
  })

  test('hard splits when no break points', () => {
    const text = 'a'.repeat(30)
    const chunks = chunkText(text, 10)
    expect(chunks.every(c => c.length <= 10)).toBe(true)
    expect(chunks.join('')).toBe(text)
  })
})

// ---------- gate logic (uses shared gate function) ----------

function baseAccess(): Access {
  return defAccess()
}

function gateTest(
  a: Access, senderId: string, chatId: string, chatType: string, mentioned: boolean,
): GateResult {
  const result = gate(
    senderId, chatId, chatType, mentioned,
    () => a,
    (access) => { Object.assign(a, access) },
  )
  return result
}

describe('gate — DM policies', () => {
  test('disabled policy drops all', () => {
    const a = { ...baseAccess(), dmPolicy: 'disabled' as const }
    expect(gateTest(a, 'ou_user', 'oc_chat', 'p2p', false).action).toBe('drop')
  })

  test('allowed user delivers', () => {
    const a = { ...baseAccess(), allowFrom: ['ou_user'] }
    expect(gateTest(a, 'ou_user', 'oc_chat', 'p2p', false).action).toBe('deliver')
  })

  test('unknown user in allowlist mode drops', () => {
    const a = { ...baseAccess(), dmPolicy: 'allowlist' as const }
    expect(gateTest(a, 'ou_unknown', 'oc_chat', 'p2p', false).action).toBe('drop')
  })

  test('unknown user in pairing mode gets code', () => {
    const a = baseAccess()
    const result = gateTest(a, 'ou_unknown', 'oc_chat', 'p2p', false)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.isResend).toBe(false)
    }
  })

  test('pending user gets resend', () => {
    const a = { ...baseAccess(), pending: { abc123: { senderId: 'ou_user', chatId: 'oc_chat', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 1 } } }
    const result = gateTest(a, 'ou_user', 'oc_chat', 'p2p', false)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.isResend).toBe(true)
      expect(result.code).toBe('abc123')
    }
  })

  test('pending user with 2+ replies gets dropped', () => {
    const a = { ...baseAccess(), pending: { abc123: { senderId: 'ou_user', chatId: 'oc_chat', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 2 } } }
    expect(gateTest(a, 'ou_user', 'oc_chat', 'p2p', false).action).toBe('drop')
  })

  test('too many pending drops new users', () => {
    const now = Date.now()
    const pending: Record<string, PendingEntry> = {
      a: { senderId: 'ou_1', chatId: 'oc_1', createdAt: now, expiresAt: now + 3600000, replies: 1 },
      b: { senderId: 'ou_2', chatId: 'oc_2', createdAt: now, expiresAt: now + 3600000, replies: 1 },
      c: { senderId: 'ou_3', chatId: 'oc_3', createdAt: now, expiresAt: now + 3600000, replies: 1 },
    }
    const a = { ...baseAccess(), pending }
    expect(gateTest(a, 'ou_new', 'oc_new', 'p2p', false).action).toBe('drop')
  })
})

describe('gate — group policies', () => {
  test('unconfigured group drops', () => {
    const a = baseAccess()
    expect(gateTest(a, 'ou_user', 'oc_group', 'group', true).action).toBe('drop')
  })

  test('configured group without mention drops when requireMention', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: true, allowFrom: [] } } }
    expect(gateTest(a, 'ou_user', 'oc_group', 'group', false).action).toBe('drop')
  })

  test('configured group with mention delivers', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: true, allowFrom: [] } } }
    expect(gateTest(a, 'ou_user', 'oc_group', 'group', true).action).toBe('deliver')
  })

  test('group with allowFrom restricts users', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: false, allowFrom: ['ou_allowed'] } } }
    expect(gateTest(a, 'ou_other', 'oc_group', 'group', false).action).toBe('drop')
    expect(gateTest(a, 'ou_allowed', 'oc_group', 'group', false).action).toBe('deliver')
  })

  test('group without requireMention delivers any message', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: false, allowFrom: [] } } }
    expect(gateTest(a, 'ou_user', 'oc_group', 'group', false).action).toBe('deliver')
  })
})

// ---------- checkMention ----------

describe('checkMention', () => {
  test('bot mention type returns true', () => {
    expect(checkMention([{ mentioned_type: 'bot' }], '', null)).toBe(true)
  })

  test('matching botOpenId returns true', () => {
    expect(checkMention([{ id: { open_id: 'ou_bot' } }], '', 'ou_bot')).toBe(true)
  })

  test('no match returns false', () => {
    expect(checkMention([{ mentioned_type: 'user' }], 'hello', null)).toBe(false)
  })

  test('custom pattern match', () => {
    expect(checkMention([], '@claude help', null, ['@claude'])).toBe(true)
  })

  test('custom pattern case insensitive', () => {
    expect(checkMention([], '@CLAUDE help', null, ['@claude'])).toBe(true)
  })

  test('invalid regex pattern is skipped', () => {
    expect(checkMention([], 'hello', null, ['[invalid'])).toBe(false)
  })
})

// ---------- PERMISSION_REPLY_RE ----------

describe('PERMISSION_REPLY_RE', () => {
  test('y + 5-char code matches', () => {
    const m = PERMISSION_REPLY_RE.exec('y abcde')
    expect(m).not.toBeNull()
    expect(m![1]).toBe('y')
    expect(m![2]).toBe('abcde')
  })

  test('YES + code matches', () => {
    expect(PERMISSION_REPLY_RE.test('YES abcde')).toBe(true)
  })

  test('no + code matches', () => {
    expect(PERMISSION_REPLY_RE.test('no abcde')).toBe(true)
  })

  test('rejects code with l', () => {
    expect(PERMISSION_REPLY_RE.test('y abcle')).toBe(false)
  })

  test('rejects short code', () => {
    expect(PERMISSION_REPLY_RE.test('y abc')).toBe(false)
  })

  test('rejects extra text', () => {
    expect(PERMISSION_REPLY_RE.test('y abcde extra')).toBe(false)
  })
})

// ---------- genConfirmCode ----------

describe('genConfirmCode', () => {
  test('generates 5-char code', () => {
    expect(genConfirmCode().length).toBe(5)
  })

  test('code never contains l', () => {
    for (let i = 0; i < 100; i++) {
      expect(genConfirmCode()).not.toContain('l')
    }
  })

  test('code matches permission regex', () => {
    for (let i = 0; i < 50; i++) {
      const code = genConfirmCode()
      expect(PERMISSION_REPLY_RE.test(`y ${code}`)).toBe(true)
    }
  })
})

// ---------- assertAllowedChat ----------

describe('assertAllowedChat', () => {
  test('p2p chat with allowed user passes', () => {
    const a = { ...baseAccess(), p2pChats: { oc_chat: 'ou_user' }, allowFrom: ['ou_user'] }
    expect(() => assertAllowedChat('oc_chat', a)).not.toThrow()
  })

  test('group chat passes', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: true, allowFrom: [] } } }
    expect(() => assertAllowedChat('oc_group', a)).not.toThrow()
  })

  test('unknown chat throws', () => {
    expect(() => assertAllowedChat('oc_unknown', baseAccess())).toThrow('not allowlisted')
  })

  test('p2p chat with removed user throws', () => {
    const a = { ...baseAccess(), p2pChats: { oc_chat: 'ou_user' }, allowFrom: [] }
    expect(() => assertAllowedChat('oc_chat', a)).toThrow('not allowlisted')
  })
})

// ---------- parseMessageContent ----------

describe('parseMessageContent', () => {
  test('plain text message', () => {
    const result = parseMessageContent('text', JSON.stringify({ text: 'hello world' }))
    expect(result.text).toBe('hello world')
    expect(result.postImageKeys).toEqual([])
  })

  test('post message with text and images', () => {
    const content = JSON.stringify({
      title: 'Title',
      content: [[{ tag: 'text', text: 'hello' }, { tag: 'img', image_key: 'img_key_1' }]],
    })
    const result = parseMessageContent('post', content)
    expect(result.text).toContain('Title')
    expect(result.text).toContain('hello')
    expect(result.postImageKeys).toEqual(['img_key_1'])
  })

  test('post message with link', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'a', text: 'click', href: 'https://example.com' }]],
    })
    const result = parseMessageContent('post', content)
    expect(result.text).toContain('click')
    expect(result.text).toContain('https://example.com')
  })

  test('post message with @mention', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'at', user_name: 'Alice' }]],
    })
    const result = parseMessageContent('post', content)
    expect(result.text).toContain('@Alice')
  })

  test('invalid JSON falls back to raw content', () => {
    const result = parseMessageContent('text', 'raw text')
    expect(result.text).toBe('raw text')
  })
})

// ---------- buildAttachmentInfo ----------

describe('buildAttachmentInfo', () => {
  test('file attachment', () => {
    const content = JSON.stringify({ file_name: 'doc.pdf', file_key: 'fk_123' })
    const result = buildAttachmentInfo('file', content, [])
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('doc.pdf')
    expect(result[0]).toContain('fk_123')
  })

  test('image attachment', () => {
    const content = JSON.stringify({ image_key: 'ik_456' })
    const result = buildAttachmentInfo('image', content, [])
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('ik_456')
  })

  test('post image keys', () => {
    const result = buildAttachmentInfo('post', '{}', ['pk_1', 'pk_2'])
    expect(result).toHaveLength(2)
  })

  test('text message has no attachments', () => {
    const result = buildAttachmentInfo('text', '{}', [])
    expect(result).toHaveLength(0)
  })
})

// ---------- formatTimestamp ----------

describe('formatTimestamp', () => {
  test('empty string returns current time', () => {
    const result = formatTimestamp('')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('seconds timestamp converts correctly', () => {
    const result = formatTimestamp('1700000000')
    expect(result).toBe('2023-11-14T22:13:20.000Z')
  })

  test('milliseconds timestamp converts correctly', () => {
    const result = formatTimestamp('1700000000000')
    expect(result).toBe('2023-11-14T22:13:20.000Z')
  })
})

// ---------- pruneExpired ----------

describe('pruneExpired', () => {
  test('removes expired entries', () => {
    const a = { ...baseAccess(), pending: { abc: { senderId: 'ou_1', chatId: 'oc_1', createdAt: Date.now() - 7200000, expiresAt: Date.now() - 3600000, replies: 1 } } }
    expect(pruneExpired(a)).toBe(true)
    expect(Object.keys(a.pending)).toHaveLength(0)
  })

  test('keeps valid entries', () => {
    const a = { ...baseAccess(), pending: { abc: { senderId: 'ou_1', chatId: 'oc_1', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 1 } } }
    expect(pruneExpired(a)).toBe(false)
    expect(Object.keys(a.pending)).toHaveLength(1)
  })
})

// ---------- router: resolveWorkdir ----------

type RouterAccess = {
  groups: Record<string, { workdir?: string }>
  defaultWorkdir?: string
}

function resolveWorkdir(access: RouterAccess, chatId: string, chatType: string): string | undefined {
  if (chatType === 'group') {
    const wd = access.groups[chatId]?.workdir
    if (wd) return wd
  }
  return access.defaultWorkdir
}

describe('resolveWorkdir', () => {
  const access: RouterAccess = {
    groups: {
      oc_groupA: { workdir: '/path/to/project-a' },
      oc_groupB: {},
    },
    defaultWorkdir: '/path/to/default',
  }

  test('group with workdir returns workdir', () => {
    expect(resolveWorkdir(access, 'oc_groupA', 'group')).toBe('/path/to/project-a')
  })

  test('group without workdir falls back to default', () => {
    expect(resolveWorkdir(access, 'oc_groupB', 'group')).toBe('/path/to/default')
  })

  test('unknown group falls back to default', () => {
    expect(resolveWorkdir(access, 'oc_unknown', 'group')).toBe('/path/to/default')
  })

  test('p2p always returns default', () => {
    expect(resolveWorkdir(access, 'oc_groupA', 'p2p')).toBe('/path/to/default')
  })

  test('no defaultWorkdir returns undefined', () => {
    const a: RouterAccess = { groups: {} }
    expect(resolveWorkdir(a, 'oc_any', 'p2p')).toBeUndefined()
  })
})

// ---------- AccessCache ----------

describe('AccessCache', () => {
  test('cache returns default access when file missing', () => {
    const cache = new AccessCache(1000)
    const noop = () => {}
    const a = cache.get('/nonexistent/path/access.json', noop)
    expect(a.dmPolicy).toBe('pairing')
    expect(a.allowFrom).toEqual([])
  })

  test('invalidate resets cache', () => {
    const cache = new AccessCache(1000)
    const noop = () => {}
    cache.get('/nonexistent/path/access.json', noop)
    cache.invalidate()
    expect((cache as any).cached).toBeNull()
  })
})
