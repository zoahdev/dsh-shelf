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
 *   dsh-shelf tree [id] [--filter no-tool|user|all]
 *
 * Defaults: root = $DSH_SESSIONS or ~/.dsh/sessions; archive/trash live next
 * to the root as `sessions-archive` / `sessions-trash`.
 *
 * @module dsh-shelf/cli
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  exportSession,
  listSessions,
  moveSession,
  archiveOlderThan,
  rescueSession,
  renderReportHtml,
  renderReport,
  reportSessions,
  searchSessions,
  sessionStats,
  topSessions,
  verifySessions,
  writeExport,
} from '../engine/shelf.js'
import { flattenTree, renderTree, sessionLineageTree, sessionMessageTree } from '../engine/tree.js'
import { createShelfServer } from './shelf-server.mjs'

function parseArgs(argv) {
  const args = { _: [], root: null, archive: null, trash: null, format: 'md', out: null, filter: null, all: false, yes: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--root') args.root = argv[++i]
    else if (value === '--archive') args.archive = argv[++i]
    else if (value === '--trash') args.trash = argv[++i]
    else if (value === '--format') args.format = argv[++i]
    else if (value === '--out') args.out = argv[++i]
    else if (value === '--filter') args.filter = argv[++i]
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
    const content = await exportSession(session.file, args.format)
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
  if (args.format === 'html') {
    const html = renderReportHtml(report, topSessions(root, 5))
    if (args.out !== null) {
      writeExport(resolve(args.out), html)
      console.log(`report -> ${resolve(args.out)}`)
    } else {
      process.stdout.write(html)
    }
  } else if (args.format === 'json' || args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderReport(report))
  }
  process.exit(0)
}

if (command === 'verify') {
  const report = verifySessions(root)
  if (args.format === 'json' || args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const entry of report) {
      console.log(`${entry.status}\t${entry.id}\t${entry.issues.join('; ') || entry.file}`)
    }
  }
  process.exit(report.some(entry => entry.status !== 'ok' && entry.status !== 'zstd') ? 1 : 0)
}

if (command === 'rescue') {
  const id = args._[1]
  if (id === undefined) {
    console.error('usage: dsh-shelf rescue <id> [--out <path>]')
    process.exit(2)
  }
  const session = findSession(id)
  const { md } = await rescueSession(session.file)
  const out = args.out !== null ? resolve(args.out) : resolve(`${session.id ?? 'rescued'}.md`)
  writeExport(out, md)
  console.log(`rescued ${session.id ?? session.dir} -> ${out}`)
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

if (command === 'tree') {
  const id = args._[1]
  if (id === undefined) {
    const { roots, sessions } = sessionLineageTree(root)
    if (sessions === 0) {
      console.log('(no sessions)')
      process.exit(0)
    }
    const lines = renderTree(flattenTree(roots, { alwaysBranch: true }), { width: process.stdout.columns })
    console.log(lines.join('\n'))
    process.exit(0)
  }
  const tree = sessionMessageTree(root, id, { filter: args.filter, width: process.stdout.columns })
  console.log(tree.lines.join('\n'))
  process.exit(0)
}

if (command === 'web') {
  const port = Number(args._[1] ?? 4174)
  const server = createShelfServer(root, archive, trash)
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
