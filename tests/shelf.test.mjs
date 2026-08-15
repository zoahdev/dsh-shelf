import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportSession,
  listSessions,
  moveSession,
  archiveOlderThan,
  reportSessions,
  searchSessions,
  sessionStats,
  tokenizeQuery,
} from '../engine/shelf.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-shelf-'))
}

function writeSession(root, id, events, createdAt = 1000) {
  const dir = join(root, 'sessions', 'p', id)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id, createdAt }),
    ...events.map(event => JSON.stringify(event)),
  ]
  writeFileSync(join(dir, 'session.jsonl'), lines.join('\n') + '\n')
  return dir
}

test('listSessions finds session files and parses headers', () => {
  const root = tempRoot()
  try {
    writeSession(root, 's1', [{ type: 'turn/start', data: { turn: 1 } }])
    const sessions = listSessions(join(root, 'sessions'))
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, 's1')
    assert.equal(sessions[0].createdAt, 1000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sessionStats counts plain and compressed sessions and bytes', () => {
  const root = tempRoot()
  try {
    writeSession(root, 's1', [{ type: 'turn/start' }])
    const dir = writeSession(root, 's2', [{ type: 'turn/start' }])
    writeFileSync(join(dir, 'session.jsonl'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2]))
    const stats = sessionStats(join(root, 'sessions'))
    assert.equal(stats.total, 2)
    assert.equal(stats.plain, 1)
    assert.equal(stats.compressed, 1)
    assert.ok(stats.bytes > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportSession renders markdown with user/assistant messages', () => {
  const root = tempRoot()
  try {
    const dir = writeSession(root, 's1', [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi there' }] } },
    ])
    const md = exportSession(join(dir, 'session.jsonl'), 'md')
    assert.match(md, /## User/)
    assert.match(md, /hello/)
    assert.match(md, /hi there/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('moveSession archives and restores without deleting', () => {
  const root = tempRoot()
  try {
    const dir = writeSession(root, 's1', [{ type: 'turn/start' }])
    const archiveRoot = join(root, 'archive')
    const archived = moveSession(dir, archiveRoot, 's1')
    assert.equal(archived, join(archiveRoot, 's1'))
    const restored = moveSession(archived, join(root, 'sessions', 'p'), 's1')
    assert.equal(restored, join(root, 'sessions', 'p', 's1'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchSessions matches header and body text', () => {
  const root = tempRoot()
  try {
    writeSession(root, 'alpha', [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'fix the parser bug' }] } },
    ])
    writeSession(root, 'beta', [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'unrelated' }] } },
    ])
    const hits = searchSessions(join(root, 'sessions'), 'parser')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 'alpha')
    assert.equal(hits[0].bodyHit, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tokenizeQuery builds ASCII words and CJK bigrams for Chinese search', () => {
  assert.deepEqual(tokenizeQuery('parser bug'), ['parser', 'bug'])
  const tokens = tokenizeQuery('修复解析器')
  assert.ok(tokens.includes('修复'))
  assert.ok(tokens.includes('复解'))
  assert.ok(tokens.includes('解析'))
  assert.ok(tokens.includes('析器'))
})

test('searchSessions finds Chinese sessions by bigram', () => {
  const root = tempRoot()
  try {
    writeSession(root, 'cn', [
      { type: 'user/message', data: { content: [{ type: 'text', text: '修复解析器的缓存问题' }] } },
    ])
    writeSession(root, 'other', [
      { type: 'user/message', data: { content: [{ type: 'text', text: '无关内容' }] } },
    ])
    const hits = searchSessions(join(root, 'sessions'), '解析器')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 'cn')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reportSessions buckets sessions by creation day', () => {
  const root = tempRoot()
  try {
    writeSession(root, 'today', [{ type: 'turn/start' }])
    const dir = join(root, 'sessions', 'p', 'old')
    mkdirSync(dir, { recursive: true })
    const createdAt = Date.now() - 3 * 24 * 60 * 60 * 1000
    writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ type: 'session', version: 0, id: 'old', createdAt }) + '\n')
    const report = reportSessions(join(root, 'sessions'), 7)
    assert.equal(report.total, 2)
    const oldDay = new Date(createdAt).toISOString().slice(0, 10)
    assert.equal(report.byDay.find(day => day.day === oldDay)?.created, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiveOlderThan moves only sessions past the cutoff', () => {
  const root = tempRoot()
  try {
    writeSession(root, 'recent', [{ type: 'turn/start' }], Date.now())
    const dir = join(root, 'sessions', 'p', 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({
      type: 'session', version: 0, id: 'old',
      createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    }) + '\n')
    const moved = archiveOlderThan(join(root, 'sessions'), join(root, 'archive'), 30)
    assert.equal(moved.length, 1)
    assert.equal(moved[0].id, 'old')
    assert.equal(listSessions(join(root, 'sessions')).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
