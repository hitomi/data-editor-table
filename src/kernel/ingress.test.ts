import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { deferred } from '../../tests/kernel/source-fixture.js'
import { IngressQueue } from './ingress.js'
import { kernelId } from './model.js'
import type { KernelEvent, KernelTransition } from './transition.js'

function setup() {
  const fixture = new KernelFixture({}), sessionId = kernelId<'session'>('session')
  fixture.dispatch({ kind: 'session-opened', revision: fixture.state.revision, sessionId, inputId: kernelId<'input'>('input'), viewId: kernelId<'view'>('view'),
    target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: '' }, reads: [] })
  return { fixture, sessionId, lease: fixture.state.session!.editor! }
}
const id = (name: string) => kernelId<'ingress'>(name)
const rejected = (fixture: KernelFixture): KernelTransition => ({ state: fixture.state, result: { kind: 'rejected', issue: { code: 'not-recorded', message: 'Definitely not recorded' } }, effects: [] })

describe('runtime ingress ownership and causal input chains', () => {
  it('does not let a retry of an older apply command jump ahead of newer retained input', () => {
    const { fixture, lease } = setup()
    let rejectApply = true
    const queue = new IngressQueue(() => fixture.state, event => event.kind === 'session-query-apply' && rejectApply ? rejected(fixture) : fixture.dispatch(event))
    queue.event(id('apply'), { kind: 'session-query-apply', lease, inputVersion: 0, queryVersion: 0, predicate: null })
    queue.input(queue.envelope(id('new-input'), lease, { kind: 'resource', id: kernelId<'resource'>('missing') }, 'idle'))
    rejectApply = false
    queue.retry(id('apply'), queue.getSnapshot().generation)
    expect(fixture.state.session).not.toBeNull()
    expect(fixture.state.view.version).toBe(0)
    expect(queue.getSnapshot().pending.find(entry => entry.id === id('apply'))).toMatchObject({ phase: 'blocked' })
    expect(queue.getSnapshot().pending.find(entry => entry.id === id('new-input'))).toBeDefined()
  })

  it('queues continuous input against ingress predecessors and displays the latest owned text before any commit publishes', async () => {
    const { fixture, lease } = setup(), pending: { event: KernelEvent; done: ReturnType<typeof deferred<KernelTransition>> }[] = []
    const queue = new IngressQueue(() => fixture.state, event => { const done = deferred<KernelTransition>(); pending.push({ event, done }); return done.promise })
    const handles = ['a', 'ab', 'abc'].map(text => queue.input(queue.envelope(id(text), lease, { kind: 'encoded', value: text }, 'idle')))
    expect(fixture.state.session!.input.version).toBe(0)
    expect(queue.inputProjection(lease)).toMatchObject({ input: { value: 'abc' }, status: 'queued', ingressId: 'abc' })
    expect(queue.getSnapshot().generation).toBe(3)
    expect(queue.getSnapshot().pending.map(entry => entry.phase)).toEqual(['committing', 'queued', 'queued'])
    expect(pending).toHaveLength(1)
    for (let index = 0; index < 3; index++) {
      const request = pending[index]!
      expect(request.event).toMatchObject({ kind: 'session-input', inputVersion: index })
      request.done.resolve(fixture.dispatch(request.event))
      expect((await handles[index]!.completion).kind).toBe('completed')
    }
    expect(fixture.state.inputs.map(input => input.input)).toEqual(['', 'a', 'ab', 'abc'].map(value => ({ kind: 'encoded', value })))
    expect(fixture.state.session!.input.version).toBe(3)
    expect(queue.getSnapshot().pending).toEqual([])
    expect(queue.getSnapshot().receipts.map(entry => entry.input?.ref?.version)).toEqual([1, 2, 3])
    expect(queue.inputProjection(lease)).toMatchObject({ input: { value: 'abc' }, status: 'published' })
  })

  it('retains a failed predecessor and its successor without running the successor, then explicitly retries the intact chain', async () => {
    const { fixture, lease } = setup(), first = deferred<KernelTransition>()
    let calls = 0, declined = 0, delay = true
    const queue = new IngressQueue(() => fixture.state, event => {
      if (event.kind === 'ingress-declined') { declined++; return fixture.dispatch(event) }
      calls++; return delay ? first.promise : fixture.dispatch(event)
    })
    const a = queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle'))
    const b = queue.input(queue.envelope(id('b'), lease, { kind: 'encoded', value: 'ab' }, 'idle'))
    first.resolve(rejected(fixture)); await a.completion; await b.completion
    expect(calls).toBe(1)
    expect(declined).toBe(1)
    expect(queue.getSnapshot().pending.map(entry => entry.phase)).toEqual(['rejected', 'blocked'])
    expect(queue.inputProjection(lease)).toMatchObject({ input: { value: 'ab' }, status: 'blocked' })
    expect(() => queue.dispose([id('a')], queue.getSnapshot().generation, 'discarded')).toThrow('complete dependent')
    delay = false
    const retried = queue.retry(id('a'), queue.getSnapshot().generation)
    expect(retried.immediate?.kind).toBe('completed')
    expect(calls).toBe(3)
    expect(fixture.state.session!.rawInput).toEqual({ kind: 'encoded', value: 'ab' })
    expect(fixture.state.inputs).toHaveLength(3)
    expect(queue.getSnapshot().pending).toEqual([])
  })

  it('does not merge typing across an explicit apply command', async () => {
    const { fixture, lease } = setup(), pending: { event: KernelEvent; done: ReturnType<typeof deferred<KernelTransition>> }[] = []
    const queue = new IngressQueue(() => fixture.state, event => { const done = deferred<KernelTransition>(); pending.push({ event, done }); return done.promise })
    const a = queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'applied text' }, 'idle'))
    const apply = queue.event(id('apply'), { kind: 'session-query-apply', lease, inputVersion: 1, queryVersion: 0, predicate: null })
    const b = queue.input(queue.envelope(id('b'), lease, { kind: 'encoded', value: 'later text' }, 'idle'))
    pending[0]!.done.resolve(fixture.dispatch(pending[0]!.event)); await a.completion
    pending[1]!.done.resolve(fixture.dispatch(pending[1]!.event)); await apply.completion
    pending[2]!.done.resolve(fixture.dispatch(pending[2]!.event)); await b.completion
    expect(fixture.state.session).toBeNull()
    expect(fixture.state.inputs.at(-1)).toMatchObject({ input: { value: 'applied text' }, disposition: { kind: 'applied-to-view', queryVersion: 1 } })
    expect(queue.getSnapshot().pending[0]).toMatchObject({ id: 'b', phase: 'rejected', payload: { envelope: { input: { value: 'later text' } } } })
  })

  it('blocks old-text application after a rejected input, while explicit cancel disposes the session chain', async () => {
    const { fixture, lease, sessionId } = setup()
    const queue = new IngressQueue(() => fixture.state, event => fixture.dispatch(event))
    const bad = queue.input(queue.envelope(id('bad'), lease, { kind: 'resource', id: kernelId<'resource'>('missing') }, 'idle'))
    expect(bad.immediate?.kind).toBe('completed')
    const apply = await queue.event(id('apply'), { kind: 'session-query-apply', lease, inputVersion: 0, queryVersion: 0, predicate: null }).completion
    expect(apply).toMatchObject({ kind: 'completed', transition: { result: { kind: 'rejected' } } })
    expect(fixture.state.session).not.toBeNull()
    expect(fixture.state.view.version).toBe(0)
    queue.event(id('cancel'), { kind: 'session-cancelled', sessionId, lease, inputVersion: 0 })
    expect(fixture.state.session).toBeNull()
    expect(queue.getSnapshot().pending).toEqual([])
    expect(queue.getSnapshot().receipts.filter(entry => entry.id !== id('cancel')).every(entry => entry.disposition === 'discarded')).toBe(true)
  })

  it('fences sequences, forks, cross-lease predecessors and disposal approvals', () => {
    const { fixture, lease } = setup(), queue = new IngressQueue(() => fixture.state, event => fixture.dispatch(event))
    const first = queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle')
    queue.input(first)
    expect(() => queue.input(first)).toThrow()
    expect(() => queue.input({ ...first, ingressId: id('duplicate-sequence') })).toThrow('consecutive')
    const bad = queue.envelope(id('bad'), lease, { kind: 'encoded', value: 'retained' }, 'idle')
    queue.input({ ...bad, predecessor: { kind: 'ingress', id: id('foreign') } })
    const generation = queue.getSnapshot().generation
    const child = queue.envelope(id('child'), lease, { kind: 'encoded', value: 'newer retained' }, 'idle'); queue.input(child)
    expect(() => queue.dispose([id('bad'), id('child')], generation, 'discarded')).toThrow('current reviewed generation')
    const returned = queue.dispose([id('bad'), id('child')], queue.getSnapshot().generation, 'returned')
    expect(returned).toHaveLength(2)
    expect(queue.getSnapshot().pending).toEqual([])
    const newInput = queue.envelope(id('after-return'), lease, { kind: 'encoded', value: 'new input' }, 'idle')
    expect(newInput.predecessor).toEqual({ kind: 'published', inputVersion: 1 })
    queue.input(newInput)
    expect(fixture.state.session!.rawInput).toEqual({ kind: 'encoded', value: 'new input' })
  })

  it('holds an uncertain head and never retries it automatically when the original commit actually published', async () => {
    const { fixture, lease } = setup()
    let actual: KernelTransition | undefined, loseResponse = true, calls = 0
    const queue = new IngressQueue(() => fixture.state, event => {
      calls++; const transition = fixture.dispatch(event)
      if (loseResponse) { actual = transition; throw new Error('Commit acknowledgement lost') }
      return transition
    })
    const first = queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle'))
    const lost = await first.completion
    if (lost.kind !== 'unresolved') throw new Error('Expected an uncertain commit')
    const second = queue.input(queue.envelope(id('b'), lease, { kind: 'encoded', value: 'ab' }, 'idle'))
    expect(calls).toBe(1); expect(fixture.state.session!.input.version).toBe(1)
    expect(queue.busy).toBe(true)
    expect(() => queue.retry(first.id, queue.getSnapshot().generation)).toThrow('unknown commit')
    expect(() => queue.dispose([first.id], queue.getSnapshot().generation, 'discarded')).toThrow('unresolved commit')
    expect(() => queue.resolveUncertain({ ...lost.attempt, generation: lost.attempt.generation + 1 }, actual!)).toThrow('another ingress attempt')
    loseResponse = false
    queue.resolveUncertain(lost.attempt, actual!)
    await second.completion
    expect(calls).toBe(2)
    expect(fixture.state.inputs.map(input => input.input)).toEqual(['', 'a', 'ab'].map(value => ({ kind: 'encoded', value })))
    expect(queue.getSnapshot().pending).toEqual([])
  })

  it('rejects a stale recovery token after a known non-commit is explicitly retried', async () => {
    const { fixture, lease } = setup()
    const queue = new IngressQueue(() => fixture.state, () => Promise.reject(new Error('Storage outcome unavailable')))
    const first = await queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle')).completion
    if (first.kind !== 'unresolved') throw new Error('Expected uncertainty')
    queue.resolveUncertain(first.attempt, rejected(fixture))
    const second = await queue.retry(id('a'), queue.getSnapshot().generation).completion
    if (second.kind !== 'unresolved') throw new Error('Expected second uncertainty')
    expect(second.attempt.baseRevision).toBe(first.attempt.baseRevision)
    expect(second.attempt.generation).toBeGreaterThan(first.attempt.generation)
    expect(() => queue.resolveUncertain(first.attempt, rejected(fixture))).toThrow('another ingress attempt')
    expect(queue.getSnapshot().pending[0]?.phase).toBe('uncertain')
  })

  it('allows the new editor to apply while old-lease input remains available for explicit recovery', () => {
    const { fixture, lease, sessionId } = setup(), queue = new IngressQueue(() => fixture.state, event => fixture.dispatch(event))
    queue.event(id('detach'), { kind: 'session-detached', lease, inputVersion: 0 })
    queue.event(id('attach'), { kind: 'session-attached', sessionId, viewId: kernelId<'view'>('new') })
    const current = fixture.state.session!.editor!
    queue.input({ ingressId: id('late'), lease, inputSequence: 1, predecessor: { kind: 'published', inputVersion: 0 }, input: { kind: 'encoded', value: 'late text' }, composition: 'idle' })
    expect(queue.inputProjection(current)?.input).toEqual({ kind: 'encoded', value: '' })
    expect(queue.event(id('apply'), { kind: 'session-query-apply', lease: current, inputVersion: 0, queryVersion: 0, predicate: null }).immediate)
      .toMatchObject({ kind: 'completed', transition: { result: { kind: 'accepted' } } })
    expect(queue.getSnapshot().pending[0]).toMatchObject({ id: 'late', payload: { envelope: { input: { value: 'late text' } } } })
  })
})
