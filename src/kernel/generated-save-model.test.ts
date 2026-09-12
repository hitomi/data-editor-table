import { expect, it } from 'vitest'
import { minimizeTrace } from '../../tests/kernel/generated-trace.js'
import { generateRepeatedExternalSaveTrace, generateSaveTrace, replaySaveTrace, saveValueShrinker } from '../../tests/kernel/save-trace.js'

it.each(Array.from({ length: 64 }, (_, seed) => seed))('matches independent save semantics for seed %i', async seed => {
  const events = generateSaveTrace(seed), result = await replaySaveTrace(events)
  if (result.kind === 'fail') {
    const minimized = await minimizeTrace(events, replaySaveTrace, saveValueShrinker)
    throw new Error(JSON.stringify({ seed, original: events, ...minimized }, null, 2))
  }
  expect(result.kind, JSON.stringify({ seed, events })).toBe('pass')
})

it.each(Array.from({ length: 64 }, (_, seed) => seed))('matches repeated saves with external authority changes for seed %i', async seed => {
  const events = generateRepeatedExternalSaveTrace(seed), result = await replaySaveTrace(events)
  if (result.kind === 'fail') {
    const minimized = await minimizeTrace(events, replaySaveTrace, saveValueShrinker)
    throw new Error(JSON.stringify({ seed, original: events, ...minimized }, null, 2))
  }
  expect(result.kind, JSON.stringify({ seed, events })).toBe('pass')
})
