import { expect, it, vi } from 'vitest'
import { minimizeTrace, seededRandom, type TraceOutcome } from '../../tests/kernel/generated-trace.js'
import { replaySaveTrace, saveValueShrinker, type SaveEvent } from '../../tests/kernel/save-trace.js'
import { ReferenceEditor } from '../../tests/kernel/reference-model.js'

it('replays a seed exactly, including zero, without consulting wall clock or randomness', () => {
  const sequence = (seed: number) => { const random = seededRandom(seed); return Array.from({ length: 100 }, () => random(17)) }
  expect(sequence(0)).toEqual(sequence(0))
  expect(sequence(41)).toEqual(sequence(41))
  expect(sequence(0)).not.toEqual(sequence(41))
  expect(sequence(41).every(value => value >= 0 && value < 17)).toBe(true)
})

it('shrinks only the original semantic failure and preserves prerequisite events', async () => {
  const replay = async (trace: readonly string[]): Promise<TraceOutcome> => {
    if (!trace.includes('submit')) return { kind: 'invalid' }
    if (!trace.includes('input')) return { kind: 'fail', failure: { property: 'different-bug', diagnostics: trace } }
    return trace.includes('old-read') ? { kind: 'fail', failure: { property: 'lost-input', diagnostics: trace } } : { kind: 'pass' }
  }
  const result = await minimizeTrace(['noise', 'input', 'submit', 'noise', 'old-read', 'noise'], replay)
  expect(result.trace).toEqual(['input', 'submit', 'old-read'])
  expect(result.failure.property).toBe('lost-input')
  for (let i = 0; i < result.trace.length; i++) {
    const outcome = await replay(result.trace.filter((_, index) => index !== i))
    expect(outcome.kind !== 'fail' || outcome.failure.property !== 'lost-input').toBe(true)
  }
})

it('does not disguise infrastructure errors as a smaller semantic counterexample', async () => {
  let calls = 0
  await expect(minimizeTrace(['event'], async () => {
    if (calls++) throw new Error('broken harness')
    return { kind: 'fail', failure: { property: 'input', diagnostics: null } }
  })).rejects.toThrow('broken harness')
  const failure = new TypeError('broken reference model')
  const freeze = vi.spyOn(ReferenceEditor.prototype, 'freeze').mockImplementation(() => { throw failure })
  try {
    await expect(replaySaveTrace([{ kind: 'freeze' }])).rejects.toBe(failure)
  } finally { freeze.mockRestore() }
  expect(await replaySaveTrace([{ kind: 'freeze' }])).toEqual({ kind: 'invalid' })
})

it('revisits event deletion after value simplification without changing the failing property', async () => {
  const replay = async (events: readonly SaveEvent[]): Promise<TraceOutcome> => {
    const write = events.find(event => event.kind === 'write')
    if (!write || !events.some(event => event.kind === 'freeze')) return { kind: 'invalid' }
    if (write.value === 0) return { kind: 'fail', failure: { property: 'another-bug', diagnostics: 0 } }
    if (write.value !== 1 && !events.some(event => event.kind === 'read')) return { kind: 'pass' }
    return { kind: 'fail', failure: { property: 'lost-input', diagnostics: write.value } }
  }
  const input: SaveEvent[] = [{ kind: 'read' }, { kind: 'write', entity: 'a', value: 128 }, { kind: 'freeze' }]
  const result = await minimizeTrace(input, replay, saveValueShrinker)
  expect(input[1]).toEqual({ kind: 'write', entity: 'a', value: 128 })
  expect(result.trace).toEqual([{ kind: 'write', entity: 'a', value: 1 }, { kind: 'freeze' }])
  expect(result.failure).toEqual({ property: 'lost-input', diagnostics: 1 })
  expect(result.minimality).toBe('single-event-deletion-and-value-candidates')
})

it('rejects cyclic value candidates and propagates value replay failures', async () => {
  const failing = async (events: readonly number[]): Promise<TraceOutcome> => events.length
    ? { kind: 'fail', failure: { property: 'bug', diagnostics: events } } : { kind: 'invalid' }
  await expect(minimizeTrace([2], failing, { rank: Math.abs, candidates: value => [-value] })).rejects.toThrow('strictly decrease')
  await expect(minimizeTrace([2], async events => {
    if (events[0] === 1) throw new Error('value harness failed')
    return failing(events)
  }, { rank: Math.abs, candidates: () => [1] })).rejects.toThrow('value harness failed')
})


it('shrinks task text by code point and remote values while preserving the original failure property', async () => {
  const { taskValueShrinker } = await import('../../tests/kernel/task-session-trace.js')
  type Event = import('../../tests/kernel/task-session-model.js').TaskSessionEvent
  const events: Event[] = [{ kind: 'type', text: '😀中文输入' }, { kind: 'remote', target: 'b', value: -128 }, { kind: 'consume' }]
  const replay = async (trace: readonly Event[]): Promise<TraceOutcome> => {
    const text = trace.find(event => event.kind === 'type'), remote = trace.find(event => event.kind === 'remote')
    if (!text || !remote || !trace.some(event => event.kind === 'consume')) return { kind: 'invalid' }
    return { kind: 'fail', failure: { property: text.text.startsWith('😀') && remote.value < 0 ? 'task-ownership' : 'different-property', diagnostics: [text.text, remote.value] } }
  }
  const result = await minimizeTrace(events, replay, taskValueShrinker)
  expect(result.trace).toEqual([{ kind: 'type', text: '😀' }, { kind: 'remote', target: 'b', value: -1 }, { kind: 'consume' }])
  expect(result.failure.property).toBe('task-ownership')
  expect(result.minimality).toBe('single-event-deletion-and-value-candidates')
  expect(events[0]).toEqual({ kind: 'type', text: '😀中文输入' })
  expect(events[1]).toEqual({ kind: 'remote', target: 'b', value: -128 })
})
