import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createZstdCompress } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportSession,
  listSessions,
  moveSession,
  archiveOlderThan,
  renderReportHtml,
  reportSessions,
  rescueSession,
  searchSessions,
  sessionStats,
  topSessions,
  tokenizeQuery,
  verifySessions,
} from '../engine/shelf.js'
import { apply } from '../lib/index.js'

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

async function compressZstd(plain) {
  return new Promise((resolve, reject) => {
    const stream = createZstdCompress()
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
    stream.end(plain)
  })
}

async function writeZstdSession(root, id, events, createdAt = 1000, name = 'session.jsonl.zstd') {
  const dir = join(root, 'sessions', 'p', id)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id, createdAt }),
    ...events.map(event => JSON.stringify(event)),
  ]
  writeFileSync(join(dir, name), await compressZstd(lines.join('\n') + '\n'))
  return dir
}

test('host plugin uses dshHomePath without probing an uninjected baseDir service', () => {
  const root = tempRoot()
  const messages = []
  const ctx = new Proxy({
    dshHomePath: () => root,
    logger: { info: message => messages.push(message) },
  }, {
    get(target, property, receiver) {
      if (property === 'baseDir') throw new Error('baseDir service was probed')
      return Reflect.get(target, property, receiver)
    },
  })

  const dispose = apply(ctx, { port: 0 })
  try {
    assert.match(messages[0], new RegExp(join(root, 'sessions').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

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

test('listSessions finds DSH session.jsonl.zstd logs and parses their headers', async () => {
  const root = tempRoot()
  try {
    const dir = await writeZstdSession(root, 'z1', [{ type: 'turn/start' }], 2000)
    const sessions = listSessions(join(root, 'sessions'))
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, 'z1')
    assert.equal(sessions[0].createdAt, 2000)
    assert.equal(sessions[0].compressed, true)
    assert.equal(sessions[0].file, join(dir, 'session.jsonl.zstd'))
    assert.equal(sessions[0].dir, dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listSessions returns newest createdAt first', () => {
  const root = tempRoot()
  try {
    writeSession(root, 'old', [{ type: 'turn/start' }], 1000)
    writeSession(root, 'mid', [{ type: 'turn/start' }], 2000)
    writeSession(root, 'new', [{ type: 'turn/start' }], 3000)
    const sessions = listSessions(join(root, 'sessions'))
    assert.deepEqual(sessions.map(session => session.id), ['new', 'mid', 'old'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listSessions prefers session.jsonl.zstd when both log names exist', async () => {
  const root = tempRoot()
  try {
    writeSession(root, 'both', [{ type: 'turn/start' }], 1000)
    await writeZstdSession(root, 'both', [{ type: 'turn/start' }], 3000)
    const sessions = listSessions(join(root, 'sessions'))
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].createdAt, 3000)
    assert.match(sessions[0].file, /session\.jsonl\.zstd$/u)
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

test('exportSession renders markdown with user/assistant messages', async () => {
  const root = tempRoot()
  try {
    const dir = writeSession(root, 's1', [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi there' }] } },
    ])
    const md = await exportSession(join(dir, 'session.jsonl'), 'md')
    assert.match(md, /## User/)
    assert.match(md, /hello/)
    assert.match(md, /hi there/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportSession decodes Zstandard session logs via node:zlib', async () => {
  const root = tempRoot()
  try {
    const dir = join(root, 'sessions', 'p', 'zstd')
    mkdirSync(dir, { recursive: true })
    const plain = [
      JSON.stringify({ type: 'session', version: 0, id: 'zstd', createdAt: 1000 }),
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'zstd hello' }] } }),
      '',
    ].join('\n')
    const compressed = await new Promise((resolve, reject) => {
      const stream = createZstdCompress()
      const chunks = []
      stream.on('data', chunk => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
      stream.end(plain)
    })
    writeFileSync(join(dir, 'session.jsonl'), compressed)
    const md = await exportSession(join(dir, 'session.jsonl'), 'md')
    assert.match(md, /zstd hello/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportSession salvages complete frames before a torn (crash-truncated) zstd frame', async () => {
  const root = tempRoot()
  try {
    const compress = (s) => new Promise((resolve, reject) => {
      const stream = createZstdCompress()
      const chunks = []
      stream.on('data', chunk => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
      stream.end(s)
    })
    const frame1 = await compress([
      JSON.stringify({ type: 'session', version: 0, id: 'torn', createdAt: 1000 }),
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'salvaged hello' }] } }),
      '',
    ].join('\n'))
    const frame2 = await compress([
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'LOST tail' }] } }),
      '',
    ].join('\n'))
    const torn = Buffer.concat([frame1, frame2]).subarray(0, frame1.length + frame2.length - 5)
    const dir = join(root, 'sessions', 'p', 'torn')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), torn)
    const md = await exportSession(join(dir, 'session.jsonl'), 'md')
    assert.match(md, /salvaged hello/)
    assert.doesNotMatch(md, /LOST tail/)
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

test('topSessions sorts by size descending', () => {
  const root = tempRoot()
  try {
    const small = writeSession(root, 'small', [{ type: 'turn/start' }], Date.now())
    const big = writeSession(root, 'big', [{ type: 'turn/start' }], Date.now())
    writeFileSync(join(big, 'session.jsonl'), readBigFile(small, big))
    const top = topSessions(join(root, 'sessions'), 2)
    assert.equal(top[0].id, 'big')
    assert.ok(top[0].bytes > top[1].bytes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('renderReportHtml emits a self-contained dashboard', () => {
  const root = tempRoot()
  try {
    writeSession(root, 's1', [{ type: 'turn/start' }], Date.now())
    const report = reportSessions(join(root, 'sessions'), 3)
    const html = renderReportHtml(report, topSessions(join(root, 'sessions'), 3))
    assert.match(html, /dsh-shelf report/)
    assert.match(html, /Sessions per day/)
    assert.match(html, /Largest sessions/)
    assert.match(html, /<html/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifySessions detects orphan tool calls and unfinished turns (#1959/#2034)', () => {
  const root = tempRoot()
  try {
    writeSession(root, 'broken', [
      { type: 'turn/start' },
      { type: 'tool/call', data: { name: 'bash' } },
    ])
    writeSession(root, 'fine', [
      { type: 'turn/start' },
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'tool/result', data: {} },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ], Date.now())
    const report = verifySessions(join(root, 'sessions'))
    const broken = report.find(entry => entry.id === 'broken')
    const fine = report.find(entry => entry.id === 'fine')
    assert.equal(broken.status, 'unhealthy')
    assert.ok(broken.issues.some(issue => issue.includes('orphan tool call')))
    assert.ok(broken.issues.some(issue => issue.includes('no turn/end')))
    assert.equal(fine.status, 'ok')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rescueSession exports content from an un-resumable session', async () => {
  const root = tempRoot()
  try {
    const dir = writeSession(root, 'stuck', [
      { type: 'turn/start' },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'precious context' }] } },
      { type: 'tool/call', data: { name: 'bash' } },
    ])
    const { md } = await rescueSession(join(dir, 'session.jsonl'))
    assert.match(md, /precious context/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function readBigFile(small, big) {
  const base = JSON.stringify({ type: 'session', version: 0, id: 'big', createdAt: Date.now() }) + '\n' + JSON.stringify({ type: 'turn/start' }) + '\n'
  return base + 'x'.repeat(500) + '\n'
}

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
