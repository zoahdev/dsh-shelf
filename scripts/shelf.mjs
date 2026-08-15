#!/usr/bin/env node
/**
 * dsh-shelf CLI.
 *
 *   dsh-shelf list [--root <sessions>]
 *   dsh-shelf stats [--root <sessions>]
 *   dsh-shelf export <id|--all> [--format md|json|jsonl] [--out <path>]
 *   dsh-shelf search <query> [--root <sessions>]
 *   dsh-shelf archive <id> [--archive <root>]
 *   dsh-shelf restore <id> --archive <root>
 *   dsh-shelf trash <id> [--trash <root>]
 *   dsh-shelf restore-trash <id> --trash <root>
 *
 * Defaults: root = $DSH_SESSIONS or ~/.dsh/sessions; archive/trash live next
 * to the root as `sessions-archive` / `sessions-trash`.
 *
 * @module dsh-shelf/cli
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  exportSession,
  listSessions,
  moveSession,
  archiveOlderThan,
  renderReport,
  reportSessions,
  searchSessions,
  sessionStats,
  writeExport,
} from '../engine/shelf.js'

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web')

function parseArgs(argv) {
  const args = { _: [], root: null, archive: null, trash: null, format: 'md', out: null, all: false, yes: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--root') args.root = argv[i + 1]
    else if (value === '--archive') args.archive = argv[i + 1]
    else if (value === '--trash') args.trash = argv[i + 1]
    else if (value === '--format') args.format = argv[i + 1]
    else if (value === '--out') args.out = argv[i + 1]
    else if (value === '--all') args.all = true
    else if (value === '--yes') args.yes = true
    else args._.push(value)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const root = resolve(args.root ?? process.env.DSH_SESSIONS ?? join(homedir(), '.dsh', 'sessions'))
const archive = resolve(args.archive ?? `${root}-archive`)
const trash = resolve(args.trash ?? `${root}-trash`)

function findSession(id) {
  const match = listSessions(root).find(session => session.id === id || session.dir.endsWith(`/${id}`))
  if (match === undefined) throw new Error(`session not found: ${id}`)
  return match
}

if (command === 'list') {
  for (const session of listSessions(root)) {
    const marker = session.compressed ? ' [zstd]' : ''
    console.log(`${session.id ?? '(no id)'}${marker}\t${session.file}`)
  }
  process.exit(0)
}

if (command === 'stats') {
  console.log(JSON.stringify(sessionStats(root), null, 2))
  process.exit(0)
}

if (command === 'search') {
  const query = args._[1]
  if (query === undefined) {
    console.error('usage: dsh-shelf search <query>')
    process.exit(2)
  }
  for (const hit of searchSessions(root, query)) {
    console.log(`${hit.id}\t${hit.headerHit ? 'header' : 'body'}\t${hit.file}`)
  }
  process.exit(0)
}

if (command === 'export') {
  const sessions = args.all ? listSessions(root) : [findSession(args._[1])]
  for (const session of sessions) {
    const content = exportSession(session.file, args.format)
    if (args.out !== null) {
      const target = args.out === '--' ? args.out : resolve(args.out)
      writeExport(target, content)
      console.log(`exported ${session.id ?? session.dir} -> ${target}`)
    } else {
      process.stdout.write(content)
    }
  }
  process.exit(0)
}

if (command === 'report') {
  const days = Number(args._[1] ?? 7)
  const report = reportSessions(root, Number.isInteger(days) && days > 0 ? days : 7)
  if (args.format === 'json' || args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderReport(report))
  }
  process.exit(0)
}

if (command === 'archive-old') {
  const days = Number(args._[1] ?? 30)
  if (!Number.isInteger(days) || days <= 0) {
    console.error('usage: dsh-shelf archive-old <days> [--yes]')
    process.exit(2)
  }
  if (!args.yes) {
    console.error(`dry run: ${archiveOlderThan(root, archive, days).length} session(s) would move; pass --yes to archive`)
    process.exit(0)
  }
  const moved = archiveOlderThan(root, archive, days)
  console.log(`archived ${moved.length} session(s) older than ${days} days`)
  for (const entry of moved) console.log(`${entry.id}\t${entry.from} -> ${entry.to}`)
  process.exit(0)
}

if (command === 'web') {
  const port = Number(args._[1] ?? 4174)
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    res.setHeader('content-type', 'application/json; charset=utf-8')
    try {
      if (url.pathname === '/api/sessions') {
        res.end(JSON.stringify({ sessions: listSessions(root), stats: sessionStats(root) }))
        return
      }
      if (url.pathname === '/api/search') {
        res.end(JSON.stringify(searchSessions(root, url.searchParams.get('q') ?? '')))
        return
      }
      if (url.pathname === '/api/export') {
        const id = url.searchParams.get('id') ?? ''
        const session = listSessions(root).find(s => s.id === id)
        if (session === undefined) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return }
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(exportSession(session.file, url.searchParams.get('format') ?? 'md'))
        return
      }
      if (url.pathname === '/api/move' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        const { id, action } = JSON.parse(body)
        const session = listSessions(root).find(s => s.id === id)
        if (session === undefined) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return }
        const targetRoot = action === 'archive' ? archive : action === 'trash' ? trash : null
        const sourceRoot = action === 'restore' ? archive : action === 'restore-trash' ? trash : null
        let target
        if (targetRoot !== null) target = moveSession(session.dir, targetRoot, id)
        else if (sourceRoot !== null) target = moveSession(resolve(sourceRoot, id), root, id)
        else { res.statusCode = 400; res.end(JSON.stringify({ error: 'unknown action' })); return }
        res.end(JSON.stringify({ ok: true, target }))
        return
      }
      const file = resolve(WEB_ROOT, url.pathname === '/' ? 'index.html' : `.${url.pathname}`)
      if (!file.startsWith(WEB_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream')
      createReadStream(file).pipe(res)
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`dsh-shelf web: http://127.0.0.1:${port} (root: ${root})`)
  })
}

if (command !== 'web' && (command === 'archive' || command === 'trash')) {
  const session = findSession(args._[1])
  const targetRoot = command === 'archive' ? archive : trash
  const target = moveSession(session.dir, targetRoot, session.id ?? 'unknown')
  console.log(`${command}ed ${session.id ?? session.dir} -> ${target}`)
  process.exit(0)
}

if (command !== 'web' && (command === 'restore' || command === 'restore-trash')) {
  const id = args._[1]
  const sourceRoot = command === 'restore' ? archive : trash
  const source = resolve(sourceRoot, id)
  const target = moveSession(source, root, id)
  console.log(`restored ${id} -> ${target}`)
  process.exit(0)
}

if (command !== 'web') {
  console.error(`unknown command: ${command ?? '(none)'}\nrun 'dsh-shelf help'`)
  process.exit(1)
}
