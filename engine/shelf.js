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

import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'

const ZSTD_FILE_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZSTD_FRAME_MAGIC = 0xfd2fb528
const SESSION_LOG_PLAIN = 'session.jsonl'
const SESSION_LOG_ZSTD = 'session.jsonl.zstd'
const HEADER_OUTPUT_LIMIT = 16 * 1024
const HEADER_OUTPUT_CHUNK = 2048
const HEADER_INPUT_CHUNK = 16 * 1024

/**
 * Structurally scan a concatenated-Zstandard container into complete frames.
 * Unlike a one-shot `zstdDecompressSync`, this tolerates a torn final frame
 * (a crash/power-loss mid-write) instead of throwing, so `rescue` can still
 * salvage every complete frame that came before it.
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_FRAME_MAGIC) break
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let complete = true
    for (;;) {
      if (buffer.length - offset < 3) { complete = false; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) { complete = false; break }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { complete = false; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) { complete = false } else { offset += 4 }
    }
    if (complete) frames.push({ start, end: offset })
    else break
  }
  return frames
}

/** Decompress every complete frame, skipping any frame that fails to decode. */
function decompressContainer(buffer) {
  let out = ''
  for (const frame of scanZstdFrames(buffer)) {
    try {
      out += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      // skip a corrupt frame, keep the rest
    }
  }
  return out
}

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
    // Current DSH writes compressed logs as session.jsonl.zstd; older/plain
    // sessions stay session.jsonl. Prefer the zstd name when both exist.
    if (entries.includes(SESSION_LOG_ZSTD)) out.push(join(dir, SESSION_LOG_ZSTD))
    else if (entries.includes(SESSION_LOG_PLAIN)) out.push(join(dir, SESSION_LOG_PLAIN))
  }
  walk(root, 0)
  return out
}

function parseHeaderLine(line, compressed) {
  if (line === undefined || line.trim() === '') return { compressed, id: undefined, createdAt: undefined }
  const header = JSON.parse(line)
  return {
    compressed,
    id: typeof header.id === 'string' ? header.id : undefined,
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
    title: typeof header.title === 'string' ? header.title : undefined,
    parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
    seedLength: typeof header.seedLength === 'number' ? header.seedLength : undefined,
  }
}

function lineFromBytes(bytes) {
  const nl = bytes.indexOf(0x0a)
  const end = nl === -1 ? bytes.length : (nl > 0 && bytes[nl - 1] === 0x0d ? nl - 1 : nl)
  return bytes.subarray(0, Math.min(end, HEADER_OUTPUT_LIMIT)).toString('utf8')
}

function firstZstdLineFromFile(file) {
  const fd = openSync(file, 'r')
  const decoder = createZstdDecompress({ chunkSize: HEADER_OUTPUT_CHUNK })
  const handle = decoder._handle
  try {
    if (handle === undefined || typeof handle.writeSync !== 'function') return undefined
    const magic = Buffer.alloc(4)
    if (readSync(fd, magic, 0, 4, 0) < 4 || magic.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) return undefined
    let acc = Buffer.alloc(0)
    let leftover = Buffer.alloc(0)
    let fileOff = 0
    while (acc.length < HEADER_OUTPUT_LIMIT) {
      const fresh = Buffer.alloc(HEADER_INPUT_CHUNK)
      const got = readSync(fd, fresh, 0, HEADER_INPUT_CHUNK, fileOff)
      fileOff += got
      const input = got === 0 ? leftover : Buffer.concat([leftover, fresh.subarray(0, got)])
      if (input.length === 0) break
      const out = Buffer.alloc(HEADER_OUTPUT_CHUNK)
      handle.writeSync(0, input, 0, input.length, out, 0, out.length)
      const availOut = decoder._writeState[0]
      const availIn = decoder._writeState[1]
      const produced = out.length - availOut
      if (produced > 0) acc = Buffer.concat([acc, out.subarray(0, produced)])
      if (acc.indexOf(0x0a) !== -1) return lineFromBytes(acc)
      leftover = availIn > 0 ? input.subarray(input.length - availIn) : Buffer.alloc(0)
      if (got === 0) break
    }
    return acc.length === 0 ? undefined : lineFromBytes(acc)
  } finally {
    try { handle.close() } catch { /* already closed */ }
    decoder.destroy()
    closeSync(fd)
  }
}

function readMagic(file) {
  const fd = openSync(file, 'r')
  try {
    const magic = Buffer.alloc(4)
    const n = readSync(fd, magic, 0, 4, 0)
    return n >= 4 ? magic : Buffer.alloc(0)
  } finally {
    closeSync(fd)
  }
}

function readHeader(file) {
  let zstd = file.endsWith('.zstd')
  try {
    zstd = zstd || readMagic(file).equals(ZSTD_FILE_MAGIC)
    if (zstd) return parseHeaderLine(firstZstdLineFromFile(file), true)
    const fd = openSync(file, 'r')
    try {
      const preview = Buffer.alloc(HEADER_OUTPUT_LIMIT)
      const n = readSync(fd, preview, 0, preview.length, 0)
      return parseHeaderLine(lineFromBytes(preview.subarray(0, n)), false)
    } finally {
      closeSync(fd)
    }
  } catch {
    return { compressed: zstd, id: undefined, createdAt: undefined }
  }
}

function byNewest(a, b) {
  return (b.createdAt ?? 0) - (a.createdAt ?? 0)
}

export function listSessions(root) {
  return sessionFiles(root)
    .map(file => ({ file, dir: dirname(file), ...readHeader(file) }))
    .sort(byNewest)
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

/** Top sessions by on-disk size (largest first). */
export function topSessions(root, limit = 5) {
  return listSessions(root)
    .map(session => ({ ...session, bytes: sessionBytes(session) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
}

/**
 * Read a session log (plain or zstd) into header + events.
 * The first `type: session` line is the header; everything else that
 * parses as JSON is an event. Non-JSON tail bytes are ignored.
 */
export function readSessionLog(file) {
  const buffer = readFileSync(file)
  const compressed = buffer.length >= 4 && buffer.subarray(0, 4).equals(ZSTD_FILE_MAGIC)
  const text = compressed ? decompressContainer(buffer) : buffer.toString('utf8')
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '')
  const jsonLines = []
  let header = {}
  const events = []
  let sawHeader = false
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      jsonLines.push(line)
      if (!sawHeader && parsed.type === 'session') {
        header = parsed
        sawHeader = true
      } else {
        events.push(parsed)
      }
    } catch {
      // non-JSON tail bytes are ignored
    }
  }
  return { compressed, header, events, lines: jsonLines }
}

export async function exportSession(file, format = 'md') {
  const { events, header, lines } = readSessionLog(file)
  const all = header.type === 'session' ? [header, ...events] : events
  if (format === 'jsonl') return lines.join('\n') + '\n'
  if (format === 'json') return JSON.stringify(all, null, 2) + '\n'
  return renderMarkdown(all)
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

/** Tokenize a search query: ASCII words + CJK bigrams (zero-dependency Chinese search). */
export function tokenizeQuery(query) {
  const lower = query.toLowerCase()
  const words = lower.match(/[a-z0-9_]+/g) ?? []
  const cjk = [...lower].filter(ch => /[\u4e00-\u9fff]/u.test(ch))
  const bigrams = []
  for (let i = 0; i < cjk.length - 1; i += 1) bigrams.push(cjk[i] + cjk[i + 1])
  const singles = cjk.length === 1 ? cjk : []
  return [...new Set([...words, ...bigrams, ...singles])]
}

export function searchSessions(root, query) {
  const tokens = tokenizeQuery(query)
  const hits = []
  for (const session of listSessions(root)) {
    if (session.compressed) continue
    let text = ''
    try {
      text = readFileSync(session.file, 'utf8')
    } catch {
      continue
    }
    const lowerText = text.toLowerCase()
    const header = `${session.id ?? ''} ${session.title ?? ''}`.toLowerCase()
    const headerHits = tokens.filter(token => header.includes(token)).length
    const bodyHits = tokens.filter(token => lowerText.includes(token)).length
    const matched = tokens.length > 0 && headerHits + bodyHits >= tokens.length
    if (matched || (tokens.length === 0 && header === '')) {
      hits.push({
        id: session.id ?? session.dir,
        file: session.file,
        headerHit: headerHits > 0,
        bodyHit: bodyHits > 0,
      })
    }
  }
  return hits
}

/** Per-day session counts for the last `days` days (by header createdAt). */
export function reportSessions(root, days = 7) {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const buckets = new Map()
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now - offset * dayMs).toISOString().slice(0, 10)
    buckets.set(day, { created: 0, plain: 0, compressed: 0, bytes: 0 })
  }
  let totalBytes = 0
  for (const session of listSessions(root)) {
    totalBytes += sessionBytes(session)
    if (session.createdAt === undefined) continue
    const day = new Date(session.createdAt).toISOString().slice(0, 10)
    const bucket = buckets.get(day)
    if (bucket === undefined) continue
    bucket.created += 1
    if (session.compressed) bucket.compressed += 1
    else bucket.plain += 1
    bucket.bytes += sessionBytes(session)
  }
  const total = listSessions(root).length
  return {
    generatedAt: new Date().toISOString(),
    days,
    total,
    totalBytes,
    byDay: [...buckets.entries()].map(([day, value]) => ({ day, ...value })),
  }
}

function sessionBytes(session) {
  try {
    return statSync(session.file).size
  } catch {
    return 0
  }
}

/** Move sessions whose header `createdAt` is older than `days` days. */
export function archiveOlderThan(root, archiveRoot, days, includeCompressed = false) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const moved = []
  for (const session of listSessions(root)) {
    if (session.compressed && !includeCompressed) continue
    if (session.createdAt === undefined || session.createdAt >= cutoff) continue
    const id = session.id ?? session.dir.split(/[\\/]/u).pop()
    const target = moveSession(session.dir, archiveRoot, id)
    moved.push({ id, from: session.dir, to: target })
  }
  return moved
}

/** Render the session digest as Markdown (bilingual labels not required). */
export function renderReport(report) {
  const lines = [
    `# dsh session digest`,
    '',
    `Generated ${report.generatedAt} 路 ${report.total} sessions 路 ${formatBytes(report.totalBytes)}`,
    '',
    '| Day | Created | Plain | Zstd | Bytes |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const day of report.byDay) {
    lines.push(`| ${day.day} | ${day.created} | ${day.plain} | ${day.compressed} | ${formatBytes(day.bytes)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Render the session digest as a self-contained offline HTML dashboard. */
export function renderReportHtml(report, top = []) {
  const maxDay = Math.max(1, ...report.byDay.map(day => day.created))
  const bars = report.byDay.map(day => {
    const width = Math.round((day.created / maxDay) * 100)
    return `<div class="bar-row"><span class="day">${day.day}</span>`
      + `<div class="bar"><i style="width:${width}%"></i></div>`
      + `<span class="n">${day.created}</span></div>`
  }).join('')
  const topRows = top.map(session => (
    `<div class="row"><b>${esc(session.id ?? '(no id)')}</b><span>${formatBytesHtml(session.bytes)}</span>`
    + `<code>${esc(session.file)}</code></div>`
  )).join('') || '<div class="muted">No sessions.</div>'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-shelf report</title>
<style>
  :root{color-scheme:dark;--bg:#0b1020;--card:#131a30;--line:#223050;--ink:#e8ecf8;--muted:#8a94b8;--accent:#4f9cf9;--green:#3ddc97}
  *{box-sizing:border-box}body{margin:0;background:radial-gradient(1000px 500px at 50% -10%,#1b2b52 0%,var(--bg) 60%);color:var(--ink);font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}
  .wrap{max-width:820px;margin:0 auto;padding:36px 20px 80px}
  h1{margin:0 0 4px}.sub{color:var(--muted);margin:0 0 22px}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;text-align:center}
  .card b{display:block;font-size:28px}.card span{color:var(--muted);font-size:12px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
  .panel h2{margin:0 0 14px;font-size:16px}
  .bar-row{display:flex;align-items:center;gap:10px;font-size:12px;margin:7px 0}
  .day{width:96px;color:var(--muted)}.bar{flex:1;height:10px;background:#223050;border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--green))}
  .n{width:32px;text-align:right}
  .row{display:flex;gap:10px;align-items:center;font-size:13px;margin:8px 0}.row b{min-width:120px}.row span{color:var(--muted)}.row code{color:var(--accent);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
  .muted{color:var(--muted)}
  footer{margin-top:30px;color:var(--muted);font-size:12px;text-align:center}
</style></head><body><div class="wrap">
<h1>📚 dsh-shelf report</h1><p class="sub">Generated ${esc(report.generatedAt)}</p>
<div class="cards">
  <div class="card"><b>${report.total}</b><span>sessions</span></div>
  <div class="card"><b>${report.total - report.byDay.reduce((s,d)=>s+d.compressed,0)}</b><span>plain</span></div>
  <div class="card"><b>${report.byDay.reduce((s,d)=>s+d.compressed,0)}</b><span>zstd</span></div>
  <div class="card"><b>${formatBytesHtml(report.totalBytes)}</b><span>total</span></div>
</div>
<div class="panel"><h2>Sessions per day (last ${report.days} days)</h2>${bars}</div>
<div class="panel"><h2>Largest sessions</h2>${topRows}</div>
<footer>dsh-shelf · https://github.com/zoahdev/dsh-shelf</footer>
</div></body></html>`
}

/**
 * Health-check every session log (plain only; zstd is reported separately).
 * Detects the un-resumable pattern family (#1959/#2034): orphan tool calls
 * (a tool/call without a matching result), missing turn/end (unfinished),
 * header-only files, and unreadable logs.
 */
export function verifySessions(root) {
  const report = []
  for (const session of listSessions(root)) {
    const base = { id: session.id ?? session.dir, file: session.file }
    if (session.compressed) {
      report.push({ ...base, status: 'zstd', issues: ['compressed log; use rescue for export'] })
      continue
    }
    let text = ''
    try {
      text = readFileSync(session.file, 'utf8')
    } catch {
      report.push({ ...base, status: 'corrupt', issues: ['unreadable log'] })
      continue
    }
    const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '')
    if (lines.length <= 1) {
      report.push({ ...base, status: 'empty', issues: ['header-only or empty log'] })
      continue
    }
    const events = []
    for (const line of lines) {
      try {
        events.push(JSON.parse(line))
      } catch {
        // non-JSON tail bytes are not session events
      }
    }
    const calls = events.filter(event => event.type === 'tool/call' || event.type === 'tool-call').length
    const results = events.filter(event => event.type === 'tool/result' || event.type === 'tool-result').length
    const turnEnds = events.filter(event => event.type === 'turn/end').length
    const issues = []
    if (calls > results) issues.push(`orphan tool call(s): ${calls} call(s) vs ${results} result(s)`)
    if (turnEnds === 0) issues.push('no turn/end (unfinished)')
    report.push({ ...base, status: issues.length > 0 ? 'unhealthy' : 'ok', issues })
  }
  return report
}

/** Export a session even when it is un-resumable (decode zstd too). */
export async function rescueSession(file) {
  const md = await exportSession(file, 'md')
  return { md, bytes: sessionBytes({ file }) }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function formatBytesHtml(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
