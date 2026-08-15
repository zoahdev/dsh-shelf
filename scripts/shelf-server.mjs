/**
 * Shared zero-dependency web server for the dsh-shelf panel (CLI + plugin).
 * @module dsh-shelf/server
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  exportSession,
  listSessions,
  moveSession,
  reportSessions,
  searchSessions,
  sessionStats,
} from '../engine/shelf.js'

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web')

export function createShelfServer(root, archive, trash) {
  return createServer(async (req, res) => {
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
      if (url.pathname === '/api/report') {
        const days = Number(url.searchParams.get('days') ?? 14)
        res.end(JSON.stringify(reportSessions(root, Number.isInteger(days) && days > 0 ? days : 14)))
        return
      }
      if (url.pathname === '/api/export') {
        const id = url.searchParams.get('id') ?? ''
        const session = listSessions(root).find(s => s.id === id)
        if (session === undefined) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return }
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(await exportSession(session.file, url.searchParams.get('format') ?? 'md'))
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
}
