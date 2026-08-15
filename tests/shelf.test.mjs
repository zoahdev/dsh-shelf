import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportSession,
  listSessions,
  moveSession,
  searchSessions,
  sessionStats,
} from '../engine/shelf.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-shelf-'))
}

function writeSession(root, id, events) {
  const dir = join(root, 'sessions', 'p', id)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id, createdAt: 1000 }),
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
