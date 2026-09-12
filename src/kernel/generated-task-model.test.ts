import { expect, it } from 'vitest'
import { minimizeTrace } from '../../tests/kernel/generated-trace.js'
import { generateTaskSessionTrace, replayTaskSessionTrace, taskValueShrinker } from '../../tests/kernel/task-session-trace.js'

it.each(['', '转换结果', '😀\t原文\n'])('retains exact result text %j through blocked review and duplicate completion', async text => {
  expect(await replayTaskSessionTrace([
    { kind: 'remote', target: 'a', value: 7 },
    { kind: 'complete', wrongExecution: false, wrongSession: false, text },
    { kind: 'complete', wrongExecution: false, wrongSession: false, text: 'different late result' },
    { kind: 'retarget', target: 'b' }, { kind: 'detach' }, { kind: 'reapply' },
    { kind: 'cancel-task' }, { kind: 'cancel-session' },
  ])).toEqual({ kind: 'pass' })
})

it('retains old and new input through blocked completion, retargeting, detached reapplication and session cancellation', async () => {
  expect(await replayTaskSessionTrace([
    { kind: 'remote', target: 'a', value: 1 },
    { kind: 'complete', wrongExecution: false, wrongSession: false },
    { kind: 'consume' }, { kind: 'retarget', target: 'b' }, { kind: 'detach' },
    { kind: 'stale-reapply' }, { kind: 'reapply' }, { kind: 'cancel-task' },
    { kind: 'cancel-session' }, { kind: 'complete', wrongExecution: false, wrongSession: false },
  ])).toEqual({ kind: 'pass' })
})

it('ignores wrong execution and cancelled completion without transferring the original file', async () => {
  expect(await replayTaskSessionTrace([
    { kind: 'complete', wrongExecution: true, wrongSession: false },
    { kind: 'type', text: 'new original text' }, { kind: 'cancel-task' },
    { kind: 'complete', wrongExecution: false, wrongSession: false }, { kind: 'reapply' },
  ])).toEqual({ kind: 'pass' })
})

it.each(Array.from({ length: 64 }, (_, seed) => seed))('matches independent task ownership semantics for seed %i', async seed => {
  const events = generateTaskSessionTrace(seed), result = await replayTaskSessionTrace(events)
  if (result.kind === 'fail') {
    const minimized = await minimizeTrace(events, replayTaskSessionTrace, taskValueShrinker)
    throw new Error(JSON.stringify({ seed, original: events, ...minimized }, null, 2))
  }
  expect(result.kind, JSON.stringify({ seed, events })).toBe('pass')
})
