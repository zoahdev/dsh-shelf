/**
 * `/nav` — pi-style message navigation for a live DSH agent.
 *
 * Selecting a user message forks before that turn (resubmit). Selecting an
 * assistant message forks through its completed turn (continue from there).
 * The TUI is not switched; the handler returns a resume hint.
 *
 * Double-Esc is not available here: dsh-pi-tui owns Esc (interrupt / browse).
 * Filter is a first picker step (host Ctrl+O expands tool output; a ↻ row
 * inside the message list is easy to miss / hard to reach).
 *
 * @module dsh-shelf/tree-command
 */

import { forkBoundary, liveMessageTree, normalizeFilter } from '../engine/tree.js'

function optional(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined
  return ctx.get(name)
}

function currentSession(invocation) {
  return invocation?.agent?.session
}

function shortSessionId(id) {
  const raw = String(id ?? '')
  return raw.length > 8 ? raw.slice(0, 8) : raw
}

export function navOptionLabel(node, index, leafId) {
  const n = String(index + 1).padStart(2, '0')
  return `${n}  ${node.role}: ${node.preview}${node.id === leafId ? ' ←' : ''}`
}

function requestedFilter(rawInput) {
  const token = String(rawInput ?? '').trim().split(/\s+/u)[0]
  if (token === 'user' || token === 'user-only' || token === 'all' || token === 'no-tool' || token === 'no-tools') {
    return normalizeFilter(token)
  }
  return undefined
}

async function pick(questions, invocation, question) {
  const answer = await questions.ask({
    questions: [question],
    agent: invocation.agent,
    signal: invocation.signal,
  })
  return answer.answers?.find(item => item.id === question.id)?.selected?.[0]
}

export async function handleTreeCommand(ctx, invocation) {
  const session = currentSession(invocation)
  if (!session || !Array.isArray(session.events)) {
    return { kind: 'error', text: 'No live session. Open a session, or use `dsh-shelf tree <id>` / the web panel.' }
  }

  const questions = optional(ctx, 'userQuestions')
  const sessionId = String(session.id ?? 'session')
  const titleId = shortSessionId(sessionId)
  let filter = requestedFilter(invocation?.rawInput)

  if (filter === undefined && questions && typeof questions.ask === 'function') {
    const selected = await pick(questions, invocation, {
      id: 'filter',
      question: `Filter · ${titleId}`,
      detail: 'Then pick a message. /nav user skips this step.',
      options: [
        { label: 'no-tool', description: 'user + assistant text' },
        { label: 'user', description: 'user only' },
        { label: 'all', description: 'include tool calls' },
      ],
    })
    if (selected === undefined) {
      return { kind: 'success', text: 'Cancelled.' }
    }
    filter = normalizeFilter(selected)
  } else {
    filter = normalizeFilter(filter)
  }

  const tree = liveMessageTree(session.events, sessionId, { filter })
  if (tree.nodes.length === 0) {
    return { kind: 'success', text: `No messages in this session (${filter}).` }
  }

  let picked = tree.nodes.at(-1)
  if (questions && typeof questions.ask === 'function') {
    const selected = await pick(questions, invocation, {
      id: 'node',
      question: `Jump to message · ${titleId} · ${filter}`,
      detail: 'User messages rewind to the previous turn. Assistant messages continue from here.',
      options: tree.nodes.map((node, index) => ({ label: navOptionLabel(node, index, tree.leafId) })),
    })
    if (selected === undefined) {
      return { kind: 'success', text: 'Cancelled.\n' + tree.lines.join('\n') }
    }
    const index = Number.parseInt(selected, 10) - 1
    picked = tree.nodes[index] ?? picked
  } else {
    return { kind: 'success', text: tree.lines.join('\n') }
  }

  const message = tree.messages.find(entry => `${tree.id}:${entry.index}` === picked.id)
  const boundary = forkBoundary(session.events, message)
  const sessions = optional(ctx, 'sessions')
  if (!sessions || typeof sessions.fork !== 'function') {
    return {
      kind: 'success',
      text: `${picked.role}: ${picked.preview}\n\n(no sessions.fork on this host — tree is read-only)\n${tree.lines.join('\n')}`,
    }
  }

  if (picked.id === tree.leafId && picked.role !== 'user') {
    return { kind: 'success', text: 'Already at this point.\n' + tree.lines.join('\n') }
  }

  if (boundary === undefined) {
    return {
      kind: 'success',
      text: `Start of session (${picked.role}: ${picked.preview}). No completed turn to fork before this point.`,
    }
  }

  try {
    const child = sessions.fork(session, boundary)
    const id = String(child?.id ?? '')
    return {
      kind: 'success',
      text: `Forked at ${picked.role}: ${picked.preview}\n→ ${id}\nResume: /resume ${id}\n   or: dsh --profile pi-tui --resume ${id}`,
    }
  } catch (error) {
    return { kind: 'error', text: `Fork failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function registerTreeCommand(ctx) {
  const commands = optional(ctx, 'commands')
  if (!commands || typeof commands.register !== 'function') return () => {}

  const definition = {
    name: 'nav',
    description: 'Navigate session messages and fork from a previous point',
    input: { hint: 'all|no-tool|user' },
    handler: invocation => handleTreeCommand(ctx, invocation),
  }
  try {
    return commands.register(definition)
  } catch {
    return () => {}
  }
}
