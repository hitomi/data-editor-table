import { describe, expect, it, vi } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { deferred } from '../../tests/kernel/source-fixture.js'
import { IngressQueue } from './ingress.js'
import type { IngressCheckpoint } from './ingress-checkpoint.js'
import { kernelId } from './model.js'
import { reduceKernel, type KernelTransition } from './transition.js'

const id = (value: string) => kernelId<'ingress'>(value)
function setup() {
  const fixture = new KernelFixture({})
  fixture.dispatch({ kind: 'session-opened', revision: fixture.state.revision, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('input'),
    viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: '' }, reads: [] })
  return { fixture, lease: fixture.state.session!.editor! }
}
const denied = (fixture: KernelFixture): KernelTransition => ({ state: fixture.state, result: { kind: 'rejected', issue: { code: 'storage', message: 'Not committed' } }, effects: [] })

describe('ingress checkpoint ownership', () => {
  it('restores accepted receipts and rejected successor chains without duplicating already accepted input', async () => {
    const { fixture, lease } = setup()
    let fail = false
    const queue = new IngressQueue(() => fixture.state, event => fail ? denied(fixture) : fixture.dispatch(event))
    await queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle')).completion
    fail = true
    await queue.input(queue.envelope(id('b'), lease, { kind: 'encoded', value: 'ab' }, 'idle')).completion
    await queue.input(queue.envelope(id('c'), lease, { kind: 'encoded', value: 'abc' }, 'composing')).completion
    const saved = structuredClone(queue.exportCheckpoint()), commit = vi.fn(event => fixture.dispatch(event))
    const restored = IngressQueue.restore(saved, () => fixture.state, commit)
    expect(commit).not.toHaveBeenCalled()
    expect(restored.inputProjection(lease)).toMatchObject({ input: { value: 'abc' }, status: 'blocked' })
    expect(restored.getSnapshot()).toEqual(saved.snapshot)
    restored.resume()
    await restored.retry(id('b'), restored.getSnapshot().generation).completion
    expect(commit).toHaveBeenCalledTimes(2)
    expect(fixture.state.inputs.map(input => input.input)).toEqual(['', 'a', 'ab', 'abc'].map(value => ({ kind: 'encoded', value })))
    const next = restored.envelope(id('d'), lease, { kind: 'encoded', value: 'abcd' }, 'idle')
    expect(next.inputSequence).toBe(4); expect(next.predecessor).toEqual({ kind: 'ingress', id: 'c' })
    await restored.input(next).completion
    expect(fixture.state.session?.input.version).toBe(4)
    expect(() => restored.event(id('a'), { kind: 'view-query-set', expectedVersion: 0, filters: [], sort: [] })).toThrow('cannot be reused')
  })

  it('restores a running commit as uncertain and holds queued successors until its exact attempt is resolved', async () => {
    const { fixture, lease } = setup(), pending = deferred<KernelTransition>()
    const queue = new IngressQueue(() => fixture.state, () => pending.promise)
    const first = queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle'))
    queue.input(queue.envelope(id('b'), lease, { kind: 'encoded', value: 'ab' }, 'idle'))
    const checkpoint = queue.exportCheckpoint()
    let state = fixture.state
    const commit = vi.fn(event => { const transition = reduceKernel(state, event, fixture.schema); state = transition.state; return transition })
    const restored = IngressQueue.restore(checkpoint, () => state, commit)
    expect(restored.getSnapshot().pending.map(entry => entry.phase)).toEqual(['uncertain', 'queued'])
    restored.resume(); expect(commit).not.toHaveBeenCalled()
    expect(() => restored.retry(id('a'), checkpoint.snapshot.generation)).toThrow('unknown commit')
    expect(() => restored.dispose([id('a')], checkpoint.snapshot.generation, 'discarded')).toThrow('unresolved commit')
    const head = restored.getSnapshot().pending[0]!
    if (head.phase !== 'uncertain') throw new Error('Expected uncertain attempt')
    const accepted = reduceKernel(state, head.event, fixture.schema); state = accepted.state
    restored.resolveUncertain(head.attempt, accepted)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(state.session?.rawInput).toEqual({ kind: 'encoded', value: 'ab' })
    expect(state.inputs).toHaveLength(3)
    pending.resolve(denied(fixture)); await first.completion
  })

  it('preserves the window after semantic publication but before the ingress receipt, without replaying its event', () => {
    const { fixture, lease } = setup()
    let checkpoint: IngressCheckpoint | null = null, accepted: KernelTransition | null = null
    const queue = new IngressQueue(() => fixture.state, event => {
      accepted = fixture.dispatch(event)
      checkpoint = queue.exportCheckpoint()
      return accepted
    })
    queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'published' }, 'idle'))
    expect(checkpoint!.snapshot.pending[0]?.phase).toBe('committing')
    const commit = vi.fn(event => fixture.dispatch(event))
    const restored = IngressQueue.restore(checkpoint!, () => fixture.state, commit)
    const head = restored.getSnapshot().pending[0]!
    if (head.phase !== 'uncertain') throw new Error('Expected exact attempt coordination')
    restored.resolveUncertain(head.attempt, accepted!)
    expect(commit).not.toHaveBeenCalled()
    expect(restored.getSnapshot().receipts[0]?.input?.ref).toEqual(fixture.state.session?.input)
    expect(fixture.state.inputs).toHaveLength(2)
  })

  it('keeps returned input sequence heads while allowing later input to bind to the current published version', async () => {
    const { fixture, lease } = setup()
    const queue = new IngressQueue(() => fixture.state, () => denied(fixture))
    await queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle')).completion
    await queue.input(queue.envelope(id('b'), lease, { kind: 'encoded', value: 'ab' }, 'idle')).completion
    queue.dispose([id('a'), id('b')], queue.getSnapshot().generation, 'returned')
    const restored = IngressQueue.restore(queue.exportCheckpoint(), () => fixture.state, event => fixture.dispatch(event))
    restored.resume()
    const next = restored.envelope(id('c'), lease, { kind: 'encoded', value: 'new' }, 'idle')
    expect(next.inputSequence).toBe(3); expect(next.predecessor).toEqual({ kind: 'published', inputVersion: 0 })
    await restored.input(next).completion
    expect(restored.getSnapshot().receipts.map(receipt => receipt.disposition)).toEqual(['returned', 'returned', 'accepted'])
    expect(fixture.state.inputs).toHaveLength(2)
  })

  it('preserves intentionally rejected malformed predecessor references as raw recoverable input', async () => {
    const { fixture, lease } = setup(), queue = new IngressQueue(() => fixture.state, event => fixture.dispatch(event))
    await queue.input({ ...queue.envelope(id('a'), lease, { kind: 'encoded', value: 'raw rejected text' }, 'idle'), predecessor: { kind: 'ingress', id: id('absent') } }).completion
    const saved = queue.exportCheckpoint()
    const restored = IngressQueue.restore(saved, () => fixture.state, event => fixture.dispatch(event))
    expect(restored.getSnapshot()).toEqual(saved.snapshot)
    restored.resume()
    await restored.retry(id('a'), restored.getSnapshot().generation).completion
    expect(restored.inputProjection(lease)?.input).toEqual({ kind: 'encoded', value: 'raw rejected text' })
    expect(fixture.state.session?.input.version).toBe(0)
  })

  it('does not automatically execute a queued command when installing a checkpoint', () => {
    const { fixture, lease } = setup(), before = fixture.state
    let checkpoint: IngressCheckpoint | null = null
    const queue = new IngressQueue(() => fixture.state, event => fixture.dispatch(event), () => {
      if (queue.getSnapshot().pending[0]?.phase === 'queued') checkpoint = queue.exportCheckpoint()
    })
    queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle'))
    let state = before
    const commit = vi.fn(event => { const transition = reduceKernel(state, event, fixture.schema); state = transition.state; return transition })
    const restored = IngressQueue.restore(checkpoint!, () => state, commit)
    expect(commit).not.toHaveBeenCalled(); expect(state).toBe(before)
    restored.input(restored.envelope(id('b'), lease, { kind: 'encoded', value: 'ab' }, 'idle'))
    expect(commit).not.toHaveBeenCalled()
    restored.resume(); expect(commit).toHaveBeenCalledTimes(2)
    expect(state.session?.rawInput).toEqual({ kind: 'encoded', value: 'ab' })
  })

  it('rejects mismatched roots, invented receipts, missing chain history and duplicate scheduling identities before installing ownership', async () => {
    const { fixture, lease } = setup(), queue = new IngressQueue(() => fixture.state, event => fixture.dispatch(event))
    await queue.input(queue.envelope(id('a'), lease, { kind: 'encoded', value: 'a' }, 'idle')).completion
    await queue.input(queue.envelope(id('b'), lease, { kind: 'encoded', value: 'ab' }, 'idle')).completion
    const saved = queue.exportCheckpoint(), commit = vi.fn(event => fixture.dispatch(event))
    const cases = [
      { ...saved, revision: saved.revision + 1 },
      { ...saved, workspace: { ...saved.workspace, id: kernelId<'workspace'>('different') } },
      { ...saved, snapshot: { ...saved.snapshot, receipts: [saved.snapshot.receipts[1]!] } },
      { ...saved, snapshot: { ...saved.snapshot, receipts: [...saved.snapshot.receipts, saved.snapshot.receipts[0]!] } },
      { ...saved, snapshot: { ...saved.snapshot, receipts: saved.snapshot.receipts.map(receipt => ({ ...receipt, input: { ...receipt.input!, ref: { id: kernelId<'input'>('invented'), version: 99 } } })) } },
    ]
    for (const invalid of cases) expect(() => IngressQueue.restore(invalid, () => fixture.state, commit)).toThrow()
    expect(commit).not.toHaveBeenCalled()
    expect(queue.getSnapshot()).toEqual(saved.snapshot)
  })
})
