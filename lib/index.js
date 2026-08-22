/**
 * dsh-shelf host plugin: starts the local session-lifecycle panel bound to
 * the active profile. Prebuilt artifact - no build step at install.
 *
 * @module dsh-shelf
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createShelfServer } from '../scripts/shelf-server.mjs'

export const name = 'dsh-shelf'

export function apply(ctx, config = {}) {
  const base = resolve(config.profileDir ?? ctx.dshHomePath?.() ?? join(homedir(), '.dsh'))
  const root = join(base, 'sessions')
  const server = createShelfServer(root, `${root}-archive`, `${root}-trash`)
  const port = Number(config.port ?? 4174)
  const handle = server.listen(port, '127.0.0.1')
  ctx.logger?.info?.(`dsh-shelf: panel at http://127.0.0.1:${port} (${root})`)
  return () => {
    handle.close()
  }
}
