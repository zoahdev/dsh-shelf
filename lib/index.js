/**
 * dsh-shelf host plugin: starts the local session-lifecycle panel bound to
 * the active profile, and registers `/nav` on pi-tui (`dsh --profile web`
 * is unsupported and does not get the command).
 *
 * Cordis forbids reading undeclared ctx properties (no `ctx.baseDir` /
 * `ctx.logger` without `inject`).
 *
 * @module dsh-shelf
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createShelfServer } from '../scripts/shelf-server.mjs'
import { registerTreeCommand } from './tree-command.js'

export const name = 'dsh-shelf'
export const inject = ['commands']

function dshHome(ctx, config = {}) {
  return resolve(config.profileDir ?? ctx.dshHomePath?.() ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

export function apply(ctx, config = {}) {
  const base = dshHome(ctx, config)
  const root = join(base, 'sessions')
  const port = Number(config.port ?? 4174)
  const server = createShelfServer(root, `${root}-archive`, `${root}-trash`)
  server.on('error', () => {
    // EADDRINUSE must not take down the host; /nav still registers.
  })
  const handle = server.listen(port, '127.0.0.1')
  ctx.logger?.info?.(`dsh-shelf: panel at http://127.0.0.1:${port} (${root})`)
  const disposeTree = registerTreeCommand(ctx)
  return () => {
    disposeTree()
    handle.close()
  }
}
