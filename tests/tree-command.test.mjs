import test from 'node:test'
import assert from 'node:assert/strict'
import { handleTreeCommand, isDshWebProfile, navOptionLabel, registerTreeCommand } from '../lib/tree-command.js'

function user(text, seq) {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }] } }
}
function assistant(text, seq) {
  return { type: 'assistant/message', seq, data: { content: [{ type: 'text', text }] } }
}

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

test('handleTreeCommand errors without a live session', async () => {
  const result = await handleTreeCommand({}, {})
  assert.equal(result.kind, 'error')
})

test('handleTreeCommand prints the tree when there is no picker', async () => {
  const result = await handleTreeCommand({}, { agent: { session: { id: 's', events } } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /user: one/)
  assert.match(result.text, /assistant: done ←/)
})

test('handleTreeCommand /nav user hides assistant rows', async () => {
  const result = await handleTreeCommand({}, {
    agent: { session: { id: 's', events } },
    rawInput: 'user',
  })
  assert.doesNotMatch(result.text, /assistant:/)
  assert.match(result.text, /user: two/)
})

test('handleTreeCommand forks at the selected user message boundary', async () => {
  const forked = []
  const ctx = {
    get(name) {
      if (name === 'userQuestions') {
        return {
          ask: async (request) => {
            const id = request.questions[0].id
            if (id === 'filter') return { answers: [{ id: 'filter', selected: ['no-tool'] }] }
            return { answers: [{ id: 'node', selected: ['03  user: two'] }] }
          },
        }
      }
      if (name === 'sessions') {
        return {
          fork(session, boundary) {
            forked.push({ id: session.id, boundary })
            return { id: 'child-1' }
          },
        }
      }
      return undefined
    },
  }
  const result = await handleTreeCommand(ctx, { agent: { session: { id: 's', events } } })
  assert.equal(result.kind, 'success')
  assert.deepEqual(forked, [{ id: 's', boundary: 3 }])
  assert.match(result.text, /child-1/)
})

test('handleTreeCommand asks filter then messages', async () => {
  const ids = []
  const ctx = {
    get(name) {
      if (name !== 'userQuestions') return undefined
      return {
        ask: async (request) => {
          ids.push(request.questions[0].id)
          if (request.questions[0].id === 'filter') {
            return { answers: [{ id: 'filter', selected: ['user'] }] }
          }
          return { answers: [] }
        },
      }
    },
  }
  const result = await handleTreeCommand(ctx, { agent: { session: { id: 's', events } } })
  assert.deepEqual(ids, ['filter', 'node'])
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Cancelled/)
  assert.doesNotMatch(result.text, /assistant:/)
})

test('handleTreeCommand parses indexes past 99', async () => {
  const events = Array.from({ length: 100 }, (_, i) => user(`m${i}`, i))
  let selected
  const ctx = {
    get(name) {
      if (name !== 'userQuestions') return undefined
      return {
        ask: async (request) => {
          if (request.questions[0].id === 'filter') {
            return { answers: [{ id: 'filter', selected: ['user'] }] }
          }
          selected = request.questions[0].options.at(-1).label
          return { answers: [{ id: 'node', selected: [selected] }] }
        },
      }
    },
  }
  const result = await handleTreeCommand(ctx, { agent: { session: { id: 's', events } } })
  assert.match(selected, /^100 /)
  assert.match(result.text, /Already at this point|Start of session|m99/)
})

test('navOptionLabel hides the session uuid', () => {
  assert.equal(navOptionLabel({ id: 'deadbeef-uuid:2', role: 'user', preview: 'hello' }, 0, 'deadbeef-uuid:2'), '01  user: hello ←')
  assert.doesNotMatch(navOptionLabel({ id: 'deadbeef-uuid:2', role: 'user', preview: 'hello' }, 0), /deadbeef/)
})

test('isDshWebProfile detects dsh web and --profile web', () => {
  assert.equal(isDshWebProfile(['node', '/usr/bin/dsh', 'web']), true)
  assert.equal(isDshWebProfile(['node', '/usr/bin/dsh', '--profile', 'web']), true)
  assert.equal(isDshWebProfile(['node', '/usr/bin/dsh', '--profile', 'pi-tui']), false)
})

test('registerTreeCommand skips the official web profile', () => {
  const names = []
  const ctx = {
    get(name) {
      if (name !== 'commands') return undefined
      return { register(def) { names.push(def.name); return () => {} } }
    },
  }
  const prev = process.argv
  process.argv = ['node', '/usr/bin/dsh', 'web']
  try {
    registerTreeCommand(ctx)()
  } finally {
    process.argv = prev
  }
  assert.deepEqual(names, [])
})

test('registerTreeCommand is a no-op without commands', () => {
  const dispose = registerTreeCommand({})
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('registerTreeCommand registers /nav', () => {
  const names = []
  const dispose = registerTreeCommand({
    get(name) {
      if (name !== 'commands') return undefined
      return {
        register(def) {
          names.push(def.name)
          return () => {}
        },
      }
    },
  })
  assert.deepEqual(names, ['nav'])
  dispose()
})
