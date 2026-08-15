/**
 * dsh-shelf engine: session lifecycle operations over a DSH sessions root.
 *
 * Safety model:
 * - Listing / stats / export / search are strictly read-only.
 * - Archive / trash MOVE a session directory (never delete).
 * - Restore moves it back.
 * - Permanent delete is never offered by the engine; the CLI requires an
 *   explicit `--yes` and even then moves to a trash root first.
 *
 * @module dsh-shelf/engine
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function sessionFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1)
      } catch {
        // broken links / unreadable dirs are skipped
      }
    }
    for (const entry of entries) {
      if (entry === 'session.jsonl') out.push(join(dir, entry))
    }
  }
  walk(root, 0)
  return out
}

function readHeader(file) {
  try {
    const buffer = readFileSync(file)
    if (buffer.length >= 4 && buffer.subarray(0, 4).equals(ZSTD_MAGIC)) {
      return { compressed: true, id: undefined, createdAt: undefined }
    }
    const line = buffer.toString('utf8').split(/\r?\n/u, 1)[0]
    if (line === undefined || line.trim() === '') return { compressed: false, id: undefined, createdAt: undefined }
    const header = JSON.parse(line)
    return {
      compressed: false,
      id: typeof header.id === 'string' ? header.id : undefined,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
      title: typeof header.title === 'string' ? header.title : undefined,
    }
  } catch {
    return { compressed: false, id: undefined, createdAt: undefined }
  }
}

export function listSessions(root) {
  return sessionFiles(root)
    .map(file => ({ file, dir: file.slice(0, -'session.jsonl'.length), ...readHeader(file) }))
}

export function sessionStats(root) {
  const sessions = listSessions(root)
  const plain = sessions.filter(session => !session.compressed)
  let bytes = 0
  for (const session of sessions) {
    try {
      bytes += statSync(session.file).size
    } catch {
      // missing file counted as 0
    }
  }
  return {
    total: sessions.length,
    plain: plain.length,
    compressed: sessions.length - plain.length,
    bytes,
  }
}

export function exportSession(file, format = 'md') {
  const buffer = readFileSync(file)
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(ZSTD_MAGIC)) {
    throw new Error(`session ${file} is Zstandard-compressed; export supports plain JSONL in v0.1`)
  }
  const lines = buffer.toString('utf8').split(/\r?\n/u).filter(line => line.trim() !== '')
  const events = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // non-JSON tail bytes are ignored for export
    }
  }
  if (format === 'jsonl') return lines.join('\n') + '\n'
  if (format === 'json') return JSON.stringify(events, null, 2) + '\n'
  return renderMarkdown(events)
}

function renderMarkdown(events) {
  const parts = ['# dsh session export', '']
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    if (type === 'user/message' || type === 'assistant/message') {
      const text = extractText(event)
      if (text !== '') parts.push(`## ${type === 'user/message' ? 'User' : 'Assistant'}`, '', text, '')
    } else if (type === 'turn/start' || type === 'turn/end') {
      parts.push(`<!-- ${type} ${JSON.stringify(event.data ?? {})} -->`)
    } else if (type === 'tool/call') {
      parts.push(`<!-- tool call: ${String(event.data?.name ?? event.data?.tool ?? '')} -->`)
    }
  }
  return parts.join('\n') + '\n'
}

function extractText(event) {
  const content = event.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function moveSession(sessionDir, targetRoot, id) {
  mkdirSync(targetRoot, { recursive: true })
  const target = join(targetRoot, id)
  if (target === sessionDir) throw new Error(`session already at ${target}`)
  try {
    statSync(target)
    throw new Error(`target already exists: ${target}`)
  } catch (error) {
    if (error.message.startsWith('target already exists')) throw error
  }
  renameSync(sessionDir, target)
  return target
}

export function writeExport(file, content) {
  writeFileSync(file, content)
}

export function searchSessions(root, query) {
  const needle = query.toLowerCase()
  const hits = []
  for (const session of listSessions(root)) {
    if (session.compressed) continue
    let text = ''
    try {
      text = readFileSync(session.file, 'utf8')
    } catch {
      continue
    }
    const headerHit = `${session.id ?? ''} ${session.title ?? ''}`.toLowerCase().includes(needle)
    const bodyHit = text.toLowerCase().includes(needle)
    if (headerHit || bodyHit) hits.push({ id: session.id ?? session.dir, file: session.file, headerHit, bodyHit })
  }
  return hits
}
