import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createZstdCompress } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFamilyTree,
  clip,
  cycleFilter,
  filterForest,
  flattenTree,
  forkBoundary,
  liveMessageTree,
  messagesFromEvents,
  messageVisible,
  renderTree,
  sessionLineageTree,
  sessionMessageTree,
  treeFromMessages,
} from '../engine/tree.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-shelf-tree-'))
}

function writeSession(root, header, events) {
  const id = header.id
  const dir = join(root, 'sessions', 'p', id)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 0, createdAt: 1000, ...header }),
    ...events.map(event => JSON.stringify(event)),
  ]
  writeFileSync(join(dir, 'session.jsonl'), lines.join('\n') + '\n')
  return dir
}

function user(text, seq) {
  return { type: 'user/message', ...(seq === undefined ? {} : { seq }), data: { content: [{ type: 'text', text }] } }
}

function assistant(text, seq) {
  return { type: 'assistant/message', ...(seq === undefined ? {} : { seq }), data: { content: [{ type: 'text', text }] } }
}

test('messagesFromEvents keeps user, assistant, and tools with stable indexes', () => {
  const messages = messagesFromEvents([
    { type: 'turn/start', data: { turn: 1 } },
    user('hello', 1),
    { type: 'assistant/message', seq: 2, data: { content: [] } },
    assistant('hi there', 3),
    { type: 'tool/call', seq: 4, data: { name: 'bash' } },
  ])
  assert.equal(messages.length, 4)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].preview, '(no content)')
  assert.equal(messages[2].preview, 'hi there')
  assert.equal(messages[3].role, 'tool')
  assert.equal(messages[3].preview, 'bash')
  assert.equal(messageVisible(messages[1], 'no-tool'), false)
  assert.equal(messageVisible(messages[3], 'no-tool'), false)
  assert.equal(messageVisible(messages[3], 'all'), true)
  assert.equal(messageVisible(messages[0], 'user'), true)
  assert.equal(messageVisible(messages[2], 'user'), false)
})

test('messagesFromEvents reads assistant.message.content (live DSH shape)', () => {
  const messages = messagesFromEvents([
    {
      type: 'assistant/message',
      seq: 4,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'wrapped' }] } },
    },
  ])
  assert.equal(messages[0].text, 'wrapped')
})

test('renderTree clips body to the given column width', () => {
  const roots = treeFromMessages(messagesFromEvents([
    user('abcdefghijklmnopqrstuvwxyz'),
  ]), 's')
  const line = renderTree(flattenTree(roots), { width: 20 })[0]
  assert.ok(line.length <= 20)
  assert.match(line, /…$/)
  assert.equal(clip('hello world', 8), 'hello w…')
})

test('linear flatten stays flat for a single-child chain (pi indent rule)', () => {
  const roots = treeFromMessages(messagesFromEvents([user('a'), assistant('b'), user('c')]), 's1')
  const flat = flattenTree(roots)
  assert.equal(flat.length, 3)
  assert.ok(flat.every(row => row.indent === 0 && row.showConnector === false))
  const lines = renderTree(flat, { leafId: 's1:2' })
  assert.match(lines[0], /user: a/)
  assert.match(lines[2], /user: c ←/)
})

test('family tree hangs a fork off the last inherited message', () => {
  const parent = {
    id: 'A',
    header: { id: 'A' },
    messages: messagesFromEvents([user('u1'), assistant('a1'), user('u2'), assistant('a2')]),
  }
  const child = {
    id: 'B',
    header: { id: 'B', parentSession: 'A', seedLength: 2 },
    messages: messagesFromEvents([user('u1'), assistant('a1'), user('u2-alt'), assistant('a2-alt')]),
  }
  const roots = buildFamilyTree([parent, child], 'A')
  const flat = flattenTree(roots)
  const lines = renderTree(flat)
  assert.equal(flat[0].indent, 0)
  assert.ok(flat.some(row => row.showConnector && row.node.preview === 'u2'))
  assert.ok(flat.some(row => row.showConnector && row.node.preview === 'u2-alt'))
  assert.match(lines.join('\n'), /├─ user: u2/)
  assert.match(lines.join('\n'), /└─ user: u2-alt/)
})

test('forkBoundary: user message rewinds to the previous turn/end', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    user('one', 1),
    assistant('ok', 2),
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 4, data: { turn: 2 } },
    user('two', 5),
    assistant('done', 6),
    { type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const messages = messagesFromEvents(events)
  assert.equal(forkBoundary(events, messages.find(m => m.text === 'two')), 3)
  assert.equal(forkBoundary(events, messages.find(m => m.text === 'done')), 7)
  assert.equal(forkBoundary(events, messages.find(m => m.text === 'one')), undefined)
})

test('sessionMessageTree and lineage read on-disk sessions', () => {
  const root = tempRoot()
  try {
    writeSession(root, { id: 's1' }, [user('hello'), assistant('hi')])
    writeSession(root, { id: 's2', parentSession: 's1', seedLength: 1 }, [
      user('hello'),
      assistant('other'),
    ])
    const tree = sessionMessageTree(join(root, 'sessions'), 's1')
    assert.equal(tree.id, 's1')
    assert.ok(tree.lines.some(line => line.includes('user: hello')))
    assert.ok(tree.leafId.startsWith('s1:'))
    const lineage = sessionLineageTree(join(root, 'sessions'))
    assert.equal(lineage.sessions, 2)
    assert.equal(lineage.roots.length, 1)
    assert.equal(lineage.roots[0].children.length, 1)
    const lineageLines = renderTree(flattenTree(lineage.roots, { alwaysBranch: true }))
    assert.match(lineageLines.join('\n'), /└─ session: s2/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('liveMessageTree builds a picker list for the current agent', () => {
  const tree = liveMessageTree([user('ask', 1), assistant('ans', 2)], 'live')
  assert.equal(tree.nodes.length, 2)
  assert.equal(tree.leafId, 'live:1')
  assert.equal(tree.filter, 'no-tool')
  assert.match(tree.lines.join('\n'), /assistant: ans ←/)
})

test('filterForest reparents descendants when intermediates are hidden', () => {
  const roots = treeFromMessages(messagesFromEvents([
    user('ask'),
    assistant('ok'),
    { type: 'tool/call', data: { name: 'bash' } },
    user('again'),
  ]), 's')
  const users = filterForest(roots, 'user')
  assert.equal(users.length, 1)
  assert.equal(users[0].preview, 'ask')
  assert.equal(users[0].children.length, 1)
  assert.equal(users[0].children[0].preview, 'again')
  const all = liveMessageTree([
    user('ask'),
    assistant('ok'),
    { type: 'tool/call', data: { name: 'bash' } },
  ], 's', { filter: 'all' })
  assert.ok(all.lines.some(line => line.includes('tool: bash')))
  assert.deepEqual(cycleFilter('no-tool'), 'user')
  assert.deepEqual(cycleFilter('user'), 'all')
  assert.deepEqual(cycleFilter('all'), 'no-tool')
})

test('compressed parent-child sessions stay in the family tree', async () => {
  const root = tempRoot()
  try {
    writeSession(root, { id: 'parent' }, [user('hello'), assistant('hi')])
    const childDir = join(root, 'sessions', 'p', 'child')
    mkdirSync(childDir, { recursive: true })
    const plain = [
      JSON.stringify({ type: 'session', version: 0, id: 'child', createdAt: 2000, parentSession: 'parent', seedLength: 1 }),
      JSON.stringify(user('hello')),
      JSON.stringify(assistant('other')),
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
    writeFileSync(join(childDir, 'session.jsonl'), compressed)
    const lineage = sessionLineageTree(join(root, 'sessions'))
    assert.equal(lineage.roots.length, 1)
    assert.equal(lineage.roots[0].id, 'parent')
    assert.equal(lineage.roots[0].children[0].id, 'child')
    const tree = sessionMessageTree(join(root, 'sessions'), 'parent')
    assert.ok(tree.lines.some(line => line.includes('other')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
