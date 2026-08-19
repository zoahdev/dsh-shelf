/**
 * Session message navigation for dsh-shelf.
 *
 * Slim clone of pi's `/tree` (double-Esc): walk a session's messages, render
 * an ASCII tree, and pick a stable fork boundary. DSH stores branches *between*
 * sessions (`parentSession` + `seedLength`), not as an in-file entry tree, so
 * a family tree is reconstructed from fork lineage.
 *
 * Filters (cycle with `o` / Ctrl+O, like pi): `no-tool` (default), `user`, `all`.
 * Deliberately omitted from pi: labels, timestamps, fold, branch summarization.
 *
 * @module dsh-shelf/tree
 */

import { listSessions, readSessionLog } from './shelf.js'

const PREVIEW = 80

/** Cycle order for double-Esc navigation. */
export const FILTER_MODES = ['no-tool', 'user', 'all']

export function normalizeFilter(mode) {
  if (mode === 'user' || mode === 'user-only') return 'user'
  if (mode === 'all') return 'all'
  return 'no-tool'
}

export function cycleFilter(mode) {
  const current = normalizeFilter(mode)
  return FILTER_MODES[(FILTER_MODES.indexOf(current) + 1) % FILTER_MODES.length]
}

function eventText(event) {
  const data = event?.data ?? {}
  const content = data.content ?? data.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function clip(text, max = PREVIEW) {
  const one = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (one.length <= max) return one
  return `${one.slice(0, Math.max(1, max - 1))}…`
}

function displayText(node) {
  if (node?.role === 'assistant' && node.text === '') return '(no content)'
  return node?.text ?? node?.preview ?? ''
}

function eventSeq(event, fallback) {
  return Number.isSafeInteger(event?.seq) ? event.seq : fallback
}

function toolText(event) {
  const data = event?.data ?? {}
  const type = event?.type
  if (type === 'tool/call' || type === 'tool-call') {
    const name = data.name ?? data.tool ?? 'tool'
    const args = data.arguments
    const argText = typeof args === 'string' ? args : args !== undefined ? JSON.stringify(args) : ''
    return argText === '' ? String(name) : `${name} ${argText}`
  }
  const text = eventText(event)
  if (text !== '') return text
  const error = data.error
  if (error !== undefined) return String(error.message ?? error.code ?? error)
  return '(result)'
}

/**
 * Navigable messages from a session event log (unfiltered).
 * Ids stay stable across filter changes.
 */
export function messagesFromEvents(events) {
  const messages = []
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]
    const type = typeof event?.type === 'string' ? event.type : ''
    let role
    let text
    if (type === 'user/message') {
      role = 'user'
      text = eventText(event)
    } else if (type === 'assistant/message') {
      role = 'assistant'
      text = eventText(event)
    } else if (type === 'tool/call' || type === 'tool-call' || type === 'tool/result' || type === 'tool-result') {
      role = 'tool'
      text = toolText(event)
    } else {
      continue
    }
    messages.push({
      index: messages.length,
      eventIndex,
      seq: eventSeq(event, eventIndex),
      role,
      text,
      preview: role === 'assistant' && text === '' ? '(no content)' : clip(text),
    })
  }
  return messages
}

export function messageVisible(message, mode) {
  if (message?.role === 'session') return true
  const filter = normalizeFilter(mode)
  if (filter === 'user') return message.role === 'user'
  if (filter === 'no-tool') return message.role === 'user' || (message.role === 'assistant' && message.text !== '')
  return true
}

/** Drop hidden nodes; descendants attach to the nearest visible ancestor. */
export function filterForest(roots, mode) {
  const out = []
  const stack = []
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push({ node: roots[i], attach: undefined })
  }
  while (stack.length > 0) {
    const { node, attach } = stack.pop()
    const visible = messageVisible(node, mode)
    let next = attach
    if (visible) {
      const copy = { ...node, children: [] }
      if (attach !== undefined) attach.children.push(copy)
      else out.push(copy)
      next = copy
    }
    const children = node.children ?? []
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], attach: next })
    }
  }
  return out
}

/** Single-session linear chain (no fork siblings). */
export function treeFromMessages(messages, sessionId) {
  const nodes = messages.map(message => ({
    ...message,
    id: sessionId === undefined ? String(message.index) : `${sessionId}:${message.index}`,
    sessionId,
    children: [],
  }))
  for (let i = 1; i < nodes.length; i += 1) nodes[i - 1].children.push(nodes[i])
  return nodes.length > 0 ? [nodes[0]] : []
}

function seedEndOf(header) {
  return Number.isSafeInteger(header?.seedLength) && header.seedLength >= 0 ? header.seedLength : 0
}

function collectFamily(logs, focusId) {
  const byId = new Map()
  for (const log of logs) {
    if (typeof log.id === 'string') byId.set(log.id, log)
  }
  if (focusId === undefined || !byId.has(focusId)) return [...byId.values()]

  const family = new Set()
  const seen = new Set()
  let cursor = focusId
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor)
    family.add(cursor)
    cursor = byId.get(cursor).header?.parentSession
  }
  const stack = [focusId]
  while (stack.length > 0) {
    const id = stack.pop()
    family.add(id)
    for (const log of byId.values()) {
      if (log.header?.parentSession === id && !family.has(log.id)) stack.push(log.id)
    }
  }
  return [...family].map(id => byId.get(id)).filter(Boolean)
}

function topoSessions(family) {
  const remaining = new Set(family.map(log => log.id))
  const byId = new Map(family.map(log => [log.id, log]))
  const ordered = []
  while (remaining.size > 0) {
    let progressed = false
    for (const id of remaining) {
      const parent = byId.get(id)?.header?.parentSession
      if (parent !== undefined && remaining.has(parent)) continue
      ordered.push(byId.get(id))
      remaining.delete(id)
      progressed = true
    }
    if (!progressed) {
      for (const id of remaining) ordered.push(byId.get(id))
      break
    }
  }
  return ordered
}

/**
 * Reconstruct a message tree from fork lineage.
 * Each child's post-`seedLength` messages hang off the last inherited message.
 */
export function buildFamilyTree(logs, focusId) {
  const family = collectFamily(logs, focusId)
  const byId = new Map(family.map(log => [log.id, log]))
  const owned = new Map()
  const roots = []

  const owningNode = (sessionId, eventIndex) => {
    let cursor = sessionId
    const seen = new Set()
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      const log = byId.get(cursor)
      const seedEnd = seedEndOf(log.header)
      if (eventIndex >= seedEnd) return owned.get(`${cursor}#${eventIndex}`)
      cursor = log.header?.parentSession
    }
    return undefined
  }

  for (const log of topoSessions(family)) {
    const seedEnd = seedEndOf(log.header)
    const own = log.messages.filter(message => message.eventIndex >= seedEnd)
    let attach
    if (typeof log.header?.parentSession === 'string' && seedEnd > 0) {
      const parent = byId.get(log.header.parentSession)
      if (parent !== undefined) {
        const lastShared = [...parent.messages].reverse().find(message => message.eventIndex < seedEnd)
        if (lastShared !== undefined) attach = owningNode(parent.id, lastShared.eventIndex)
      }
    }
    let prev = attach
    for (const message of own) {
      const node = {
        ...message,
        id: `${log.id}:${message.index}`,
        sessionId: log.id,
        children: [],
      }
      owned.set(`${log.id}#${message.eventIndex}`, node)
      if (prev !== undefined) prev.children.push(node)
      else roots.push(node)
      prev = node
    }
  }
  return roots
}

/**
 * Flatten a forest into rows with indent / sibling connectors.
 * Indentation rules follow pi's tree-selector (single-child chains stay flat).
 */
export function flattenTree(roots, options = {}) {
  const alwaysBranch = options.alwaysBranch === true
  const result = []
  const stack = []
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push([roots[i], 0, false, false, i === roots.length - 1, []])
  }
  while (stack.length > 0) {
    const [node, indent, justBranched, showConnector, isLast, gutters] = stack.pop()
    result.push({ node, indent, showConnector, isLast, gutters })
    const children = node.children ?? []
    const branched = children.length > 1 || (alwaysBranch && children.length > 0)
    const childIndent = branched || (justBranched && indent > 0) ? indent + 1 : indent
    const childGutters = showConnector
      ? [...gutters, { position: Math.max(0, indent - 1), show: !isLast }]
      : gutters
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push([children[i], childIndent, branched, branched, i === children.length - 1, childGutters])
    }
  }
  return result
}

function renderPrefix(flat) {
  const { indent, showConnector, isLast, gutters } = flat
  if (indent === 0 && !showConnector) return ''
  let out = ''
  for (let level = 0; level < indent; level += 1) {
    if (level === indent - 1 && showConnector) {
      out += isLast ? '└─ ' : '├─ '
    } else {
      const gutter = gutters.find(entry => entry.position === level)
      out += gutter?.show === true ? '│  ' : '   '
    }
  }
  return out
}

/** Render flattened rows as ASCII lines. `width` is the terminal/panel column budget. */
export function renderTree(flat, options = {}) {
  const selectedId = options.selectedId
  const leafId = options.leafId
  const width = Number.isSafeInteger(options.width) && options.width > 0 ? options.width : undefined
  return flat.map(row => {
    const cursor = row.node.id === selectedId ? '>' : ' '
    const mark = row.node.id === leafId ? ' ←' : ''
    const prefix = renderPrefix(row)
    const role = `${row.node.role}: `
    const budget = width === undefined
      ? PREVIEW
      : Math.max(8, width - cursor.length - prefix.length - role.length - mark.length)
    return `${cursor}${prefix}${role}${clip(displayText(row.node), budget)}${mark}`
  })
}

/**
 * Inclusive event seq to pass to `sessions.fork`.
 * User message → last completed turn *before* it (resubmit, like pi).
 * Assistant → last completed turn at or after it (continue from here).
 */
export function forkBoundary(events, message) {
  if (message === undefined) return undefined
  const seq = message.seq
  const ends = events
    .map((event, index) => ({ type: event.type, seq: eventSeq(event, index) }))
    .filter(event => event.type === 'turn/end')
  if (message.role === 'user') {
    const prior = ends.filter(event => event.seq < seq)
    return prior.at(-1)?.seq
  }
  const after = ends.find(event => event.seq >= seq)
  if (after !== undefined) return after.seq
  return ends.filter(event => event.seq < seq).at(-1)?.seq
}

function loadLog(session) {
  const { header, events, compressed } = readSessionLog(session.file)
  const id = session.id ?? (typeof header.id === 'string' ? header.id : session.dir)
  return {
    id,
    file: session.file,
    compressed,
    header: {
      ...header,
      parentSession: session.parentSession ?? header.parentSession,
      seedLength: session.seedLength ?? header.seedLength,
    },
    events,
    messages: messagesFromEvents(events),
  }
}

/** Session-level fork forest (no message bodies). */
export function sessionLineageTree(root) {
  const sessions = listSessions(root)
  const nodes = new Map()
  for (const session of sessions) {
    let id = session.id
    let title = session.title
    let parentSession = session.parentSession
    if (session.compressed) {
      try {
        const log = readSessionLog(session.file)
        if (id === undefined && typeof log.header.id === 'string') id = log.header.id
        if (title === undefined && typeof log.header.title === 'string') title = log.header.title
        if (parentSession === undefined) parentSession = log.header.parentSession
      } catch {
        // unreadable compressed header stays a root
      }
    }
    id = id ?? session.dir
    nodes.set(id, {
      id,
      role: 'session',
      text: title ?? id,
      preview: clip(title ?? id, 60),
      sessionId: id,
      parentSession,
      children: [],
    })
  }
  const roots = []
  for (const node of nodes.values()) {
    const parent = node.parentSession !== undefined ? nodes.get(node.parentSession) : undefined
    let ancestor = parent
    const seen = new Set([node.id])
    while (ancestor !== undefined && !seen.has(ancestor.id)) {
      seen.add(ancestor.id)
      ancestor = ancestor.parentSession === undefined
        ? undefined
        : nodes.get(ancestor.parentSession)
    }
    if (parent !== undefined && ancestor === undefined) parent.children.push(node)
    else roots.push(node)
  }
  return { roots, sessions: sessions.length }
}

function serializeFlat(flat, extra = {}) {
  return flat.map(row => ({
    id: row.node.id,
    role: row.node.role,
    text: row.node.text,
    preview: row.node.preview,
    sessionId: row.node.sessionId,
    seq: row.node.seq,
    eventIndex: row.node.eventIndex,
    indent: row.indent,
    showConnector: row.showConnector,
    isLast: row.isLast,
    gutters: row.gutters,
    ...extra,
  }))
}

function finishTree(fullRoots, options = {}) {
  const filter = normalizeFilter(options.filter)
  const roots = filterForest(fullRoots, filter)
  const flat = flattenTree(roots)
  const preferred = options.leafId === undefined ? undefined : flat.find(row => row.node.id === options.leafId)
  const leaf = preferred
    ?? [...flat].reverse().find(row => options.sessionId === undefined || row.node.sessionId === options.sessionId)
    ?? flat.at(-1)
  const leafId = leaf?.node.id
  return { filter, filters: FILTER_MODES, roots, flat, leafId, lines: renderTree(flat, { leafId, width: options.width }) }
}

/**
 * Message tree for one session plus its fork family.
 * @returns {{ id, leafId, roots, flat, lines, nodes, compressed, filter }}
 */
export function sessionMessageTree(root, id, options = {}) {
  const sessions = listSessions(root)
  const match = sessions.find(session => session.id === id || session.dir.endsWith(`/${id}`))
  if (match === undefined) throw new Error(`session not found: ${id}`)
  const logs = []
  for (const session of sessions) {
    try {
      logs.push(loadLog(session))
    } catch {
      // skip unreadable siblings; the focus session is required below
    }
  }
  const focus = logs.find(log => log.id === match.id) ?? loadLog(match)
  const full = logs.length > 1 ? buildFamilyTree(logs, focus.id) : treeFromMessages(focus.messages, focus.id)
  const tree = finishTree(full, { filter: options.filter, sessionId: focus.id, width: options.width })
  return {
    id: focus.id,
    compressed: focus.compressed,
    ...tree,
    nodes: serializeFlat(tree.flat),
  }
}

/** Live-agent path: build a linear tree from in-memory events. */
export function liveMessageTree(events, sessionId, options = {}) {
  const messages = messagesFromEvents(events)
  const full = treeFromMessages(messages, sessionId)
  const leafSeq = options.leafSeq
  const prefer = leafSeq === undefined
    ? undefined
    : messages.find(message => message.seq === leafSeq)
  const preferId = prefer === undefined ? undefined : `${sessionId}:${prefer.index}`
  const tree = finishTree(full, { filter: options.filter, leafId: preferId, sessionId, width: options.width })
  return {
    id: sessionId,
    messages,
    ...tree,
    nodes: serializeFlat(tree.flat),
  }
}
