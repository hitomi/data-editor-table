import { expect, it } from 'vitest'
import { minimizeTrace } from '../../tests/kernel/generated-trace.js'
import { generateHistoryTrace, generateRepeatedSaveTrace, replaySaveTrace, saveValueShrinker } from '../../tests/kernel/save-trace.js'
import { ReferenceEditor } from '../../tests/kernel/reference-model.js'

it.each([true, false])('keeps two unknown undos and later redo correct when applied=%s', async applied => {
  expect(await replaySaveTrace([
    { kind: 'write', entity: 'a', value: 1 }, { kind: 'write', entity: 'a', value: 2 },
    { kind: 'freeze' }, { kind: 'unknown' }, { kind: 'undo' }, { kind: 'undo' },
    ...(!applied ? [{ kind: 'external' as const, entity: 'b' as const, value: 31 }] : []),
    { kind: 'execute' }, { kind: 'receipt' }, { kind: 'read' },
    ...(applied ? [{ kind: 'freeze' as const }, { kind: 'execute' as const }, { kind: 'receipt' as const }, { kind: 'read' as const }] : []),
    { kind: 'redo' },
    { kind: 'write', entity: 'b', value: 4 },
    { kind: 'freeze' }, { kind: 'execute' }, { kind: 'receipt' }, { kind: 'read' },
  ])).toEqual({ kind: 'pass' })
})

it('previews consecutive pending undos in user control order', () => {
  const model = new ReferenceEditor({ a: { x: 0, hidden: 7 } })
  const first = model.write('a', { x: 1 }), second = model.write('a', { x: 2 })
  model.freeze('request')
  model.undo(second)
  expect(model.preview()).toEqual({ a: { x: 1, hidden: 7 } })
  model.undo(first)
  expect(model.preview()).toEqual({ a: { x: 0, hidden: 7 } })
})

it.each(Array.from({ length: 64 }, (_, seed) => seed))('matches independent conditional history semantics for seed %i', async seed => {
  const events = generateHistoryTrace(seed), result = await replaySaveTrace(events)
  if (result.kind === 'fail') {
    const minimized = await minimizeTrace(events, replaySaveTrace, saveValueShrinker)
    throw new Error(JSON.stringify({ seed, original: events, ...minimized }, null, 2))
  }
  expect(result.kind, JSON.stringify({ seed, events })).toBe('pass')
})

it.each(Array.from({ length: 64 }, (_, seed) => seed))('preserves history across repeated normalized saves for seed %i', async seed => {
  const events = generateRepeatedSaveTrace(seed)
  expect(events.filter(event => event.kind === 'freeze').length).toBeGreaterThanOrEqual(3)
  const result = await replaySaveTrace(events)
  if (result.kind === 'fail') {
    const minimized = await minimizeTrace(events, replaySaveTrace, saveValueShrinker)
    throw new Error(JSON.stringify({ seed, original: events, ...minimized }, null, 2))
  }
  expect(result.kind, JSON.stringify({ seed, events })).toBe('pass')
})
