import { canonicalEncodedValue, ownEncodedValue } from './document.js'
import { describe, expect, it, vi } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { deferred } from '../../tests/kernel/source-fixture.js'
import { DurableCommitBarrier } from './durable-commit.js'
import { IngressQueue } from './ingress.js'
import { kernelId, type RecoveryCommitResult } from './model.js'
import { prepareRecoveryWrite, validateRecoveryWrite } from './recovery-store.js'
import { ResourceStore } from './resource-store.js'
import { reduceKernel, type KernelEvent, type KernelTransition } from './transition.js'

function setup() {
  const fixture = new KernelFixture(), resources = new ResourceStore(), storage = new RecoveryFixture(fixture.state.workspace), session = storage.acquire()
  const barrier = new DurableCommitBarrier({ state: fixture.state, schema: fixture.schema, resources, session })
  const queue = new IngressQueue(() => barrier.getState(), event => barrier.commit(event))
  return { fixture, resources, storage, session, barrier, queue }
}
const open: KernelEvent = { kind: 'session-opened', revision: 0, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('input'),
  viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: '' }, reads: [] }
const id = (name: string) => kernelId<'ingress'>(name)

describe('durable semantic commit barrier', () => {
  it.each([10, 11, 12, 13, 14, 15] as const)('reads the complete format %s root and writes its successor in format 16 without changing retained input', async format => {
    const { fixture, resources, storage, session } = setup()
    const write = await prepareRecoveryWrite(session.lease, 1, null, open, reduceKernel(fixture.state, open, fixture.schema), resources)
    expect(write.record.format).toBe(16)
    const { candidateHash: _hash, ...token } = write.record.commit.token
    const body = { ...write.record, format, commit: { ...write.record.commit, token } }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalEncodedValue(ownEncodedValue(body))))
    const candidateHash = `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
    const legacy = { ...write, record: { ...write.record, format, commit: { ...write.record.commit, token: { ...token, candidateHash } } } }
    expect((await session.commit(legacy)).kind).toBe('committed')
    const restored = await DurableCommitBarrier.restore({ initialState: fixture.state, schema: fixture.schema, session: storage.acquire() })
    expect(restored.getState().session?.rawInput).toEqual(open.input)
    expect(restored.getState().inputs).toEqual(write.record.transition.state.inputs)
    await restored.commit({ kind: 'read-started', ticket: 'next-read' })
    expect(storage.writes.at(-1)!.record.format).toBe(16)
    expect(restored.getState().session?.rawInput).toEqual(open.input)
  })

  it.each([false, true])('retains input when a new lease wins during resource preparation (preparation fails=%s)', async fails => {
    const { fixture, resources, storage, barrier, queue } = setup()
    await queue.event(id('open'), open).completion
    const before = barrier.getState(), root = storage.root, entered = deferred<void>(), gate = deferred<void>()
    const exportRecovery = resources.exportRecovery.bind(resources)
    const spy = vi.spyOn(resources, 'exportRecovery').mockImplementation(async state => {
      entered.resolve(); await gate.promise
      if (fails) throw new Error('Resource preparation interrupted')
      return exportRecovery(state)
    })
    try {
      const handle = queue.input(queue.envelope(id('retained-input'), before.session!.editor!, { kind: 'encoded', value: '未提交原文' }, 'idle'))
      await entered.promise
      expect(barrier.getStatus().kind).toBe('preparing')
      const next = storage.acquire()
      gate.resolve()
      expect((await handle.completion).kind).toBe('unresolved')
      expect(barrier.getStatus().kind).toBe('fenced')
      expect(barrier.getState()).toBe(before)
      expect(storage.root).toEqual(root)
      expect(storage.writes).toHaveLength(1)
      expect(queue.getSnapshot().pending).toMatchObject([{ payload: { envelope: { input: { kind: 'encoded', value: '未提交原文' } } } }])
      await expect(barrier.commit({ kind: 'read-started', ticket: 'obsolete' })).rejects.toThrow('fenced')
      const restored = await DurableCommitBarrier.restore({ initialState: fixture.state, schema: fixture.schema, session: next })
      expect(restored.getState()).toEqual(before)
      expect(storage.writes).toHaveLength(1)
    } finally { gate.resolve(); spy.mockRestore() }
  })

  it('uses an exact parent CAS and keeps a missing-token negative proof final even if its write arrives later', async () => {
    const { fixture, storage, session, resources, queue } = setup()
    await queue.event(id('open'), open).completion
    const originalRoot = storage.root
    const stale = await prepareRecoveryWrite(session.lease, 99, null, open, reduceKernel(fixture.state, open, fixture.schema), resources)
    expect((await session.commit(stale)).kind).toBe('not-committed')
    expect(storage.root).toEqual(originalRoot)
    const late = await prepareRecoveryWrite(session.lease, 100, null, open, reduceKernel(fixture.state, open, fixture.schema), resources)
    const entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise }
    const arriving = session.commit(late)
    await entered.promise
    const negative = await session.lookup(late.record.commit)
    expect(negative.kind).toBe('not-committed')
    gate.resolve()
    expect(await arriving).toEqual(negative)
    expect(storage.root).toEqual(originalRoot)
  })

  it('requires a new epoch for restore and automatically fences an old runtime on lease handoff', async () => {
    const { fixture, storage, session, barrier, queue } = setup()
    await queue.event(id('open'), open).completion
    await expect(DurableCommitBarrier.restore({ initialState: fixture.state, schema: fixture.schema, session })).rejects.toThrow('newly acquired')
    const nextSession = storage.acquire()
    expect(barrier.getStatus().kind).toBe('fenced')
    const restored = await DurableCommitBarrier.restore({ initialState: fixture.state, schema: fixture.schema, session: nextSession })
    expect(restored.getState()).toEqual(barrier.getState())
    expect((await nextSession.lookup(storage.root!.record.commit)).kind).toBe('committed')
    await expect(barrier.commit({ kind: 'read-started', ticket: 'obsolete' })).rejects.toThrow('fenced')
  })

  it('publishes neither state nor accepted results before the complete atomic storage record commits', async () => {
    const { storage, barrier, queue } = setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise }
    const handle = queue.event(id('open'), open)
    await entered.promise
    expect(barrier.getState().session).toBeNull(); expect(barrier.getState().revision).toBe(0)
    expect(barrier.getStatus().kind).toBe('writing'); expect(storage.root).toBeNull()
    expect(handle.immediate).toBeNull(); expect(queue.getSnapshot().pending[0]?.phase).toBe('committing')
    gate.resolve()
    expect(await handle.completion).toMatchObject({ kind: 'completed', transition: { result: { kind: 'accepted', revision: 1 } } })
    expect(barrier.getState().session?.rawInput).toEqual({ kind: 'encoded', value: '' })
    expect(storage.root?.record.transition.state).toEqual(barrier.getState())
    expect(barrier.getRoot()).toEqual(storage.root && { token: storage.root.record.commit.token, revision: 1 })
  })

  it('persists continuous typed input in predecessor order while the latest raw text remains visible', async () => {
    const { storage, barrier, queue } = setup()
    await queue.event(id('open'), open).completion
    const gate = deferred<void>(), entered = deferred<void>()
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise }
    const lease = barrier.getState().session!.editor!
    const handles = ['a', 'ab', 'abc'].map(text => queue.input(queue.envelope(id(text), lease, { kind: 'encoded', value: text }, 'idle')))
    await entered.promise
    expect(queue.inputProjection(lease)?.input).toEqual({ kind: 'encoded', value: 'abc' })
    expect(barrier.getState().session?.rawInput).toEqual({ kind: 'encoded', value: '' })
    gate.resolve(); await Promise.all(handles.map(handle => handle.completion))
    expect(storage.writes.map(write => write.record.transition.state.session?.rawInput)).toEqual(['', 'a', 'ab', 'abc'].map(value => ({ kind: 'encoded', value })))
    expect(storage.writes.slice(1).map(write => write.record.commit.parent?.revision)).toEqual([1, 2, 3])
    expect(barrier.getState().session?.input.version).toBe(3)
  })

  it('retains definitively rejected input and retries it with a new token while preserving the semantic parent', async () => {
    const { storage, barrier, queue } = setup()
    await queue.event(id('open'), open).completion
    const lease = barrier.getState().session!.editor!, before = barrier.getState(), parent = barrier.getRoot()
    storage.rejectNext = true
    await queue.input(queue.envelope(id('input'), lease, { kind: 'encoded', value: 'retained' }, 'idle')).completion
    expect(barrier.getState()).toBe(before); expect(barrier.getStatus().kind).toBe('idle')
    expect(queue.getSnapshot().pending[0]).toMatchObject({ phase: 'rejected', payload: { envelope: { input: { value: 'retained' } } } })
    await queue.retry(id('input'), queue.getSnapshot().generation).completion
    const first = storage.writes[1]!.record.commit, second = storage.writes[2]!.record.commit
    expect(first.parent).toEqual(parent); expect(second.parent).toEqual(parent)
    expect(first.semanticRevision).toBe(second.semanticRevision)
    expect(second.token.sequence).toBeGreaterThan(first.token.sequence)
    expect(first.token.candidateHash).not.toBe(second.token.candidateHash)
    expect(barrier.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'retained' })
  })

  it('queries the original committed token after an acknowledgement is lost and publishes exactly once', async () => {
    const { storage, barrier, queue } = setup()
    storage.loseResponse = true
    const handle = queue.event(id('open'), open), result = await handle.completion
    expect(result.kind).toBe('unresolved'); expect(barrier.getState().revision).toBe(0)
    expect(storage.root?.record.transition.state.revision).toBe(1)
    expect(() => queue.retry(id('open'), queue.getSnapshot().generation)).toThrow('unknown commit')
    const next = queue.event(id('read'), { kind: 'read-started', ticket: 'later' })
    expect(storage.writes).toHaveLength(1)
    const resolved = await barrier.reconcile()
    if (result.kind !== 'unresolved') throw new Error('Expected unknown ingress')
    queue.resolveUncertain(result.attempt, resolved)
    await next.completion
    expect(barrier.getState().revision).toBe(2); expect(storage.writes).toHaveLength(2)
    expect(storage.queries).toEqual([storage.writes[0]!.record.commit])
    expect(queue.getSnapshot().pending).toEqual([])
    await expect(barrier.reconcile()).rejects.toThrow('Only one unresolved')
  })

  it('rejects mismatched committed and negative receipts without releasing the unknown candidate', async () => {
    for (const kind of ['committed', 'not-committed'] as const) {
      const { storage, barrier, queue } = setup()
      storage.corruptResponse = result => ({ ...result, kind, commit: { ...result.commit, token: { ...result.commit.token, leaseEpoch: 'other' } },
        issue: { code: 'false-proof', message: 'not this commit' } }) as RecoveryCommitResult
      const handle = queue.event(id('open'), open), unknown = await handle.completion
      expect(unknown.kind).toBe('unresolved'); expect(barrier.getState().revision).toBe(0)
      expect((await barrier.reconcile()).result.kind).toBe('unresolved')
      expect(barrier.getStatus().kind).toBe('unknown'); expect(storage.writes).toHaveLength(1)
      storage.corruptResponse = null
      const resolved = await barrier.reconcile()
      if (unknown.kind !== 'unresolved') throw new Error('Expected unknown ingress')
      queue.resolveUncertain(unknown.attempt, resolved)
      expect(barrier.getState().revision).toBe(1)
    }
  })

  it('reconciles a failed transaction with lost negative acknowledgement before allowing an explicit retry', async () => {
    const { storage, barrier, queue } = setup()
    storage.rejectNext = true; storage.loseResponse = true
    const unknown = await queue.event(id('open'), open).completion
    expect(unknown.kind).toBe('unresolved'); expect(storage.root).toBeNull()
    const resolved = await barrier.reconcile()
    expect(resolved.result.kind).toBe('rejected')
    if (unknown.kind !== 'unresolved') throw new Error('Expected unknown ingress')
    queue.resolveUncertain(unknown.attempt, resolved)
    expect(barrier.getState().revision).toBe(0)
    await queue.retry(id('open'), queue.getSnapshot().generation).completion
    expect(barrier.getState().revision).toBe(1)
    expect(storage.writes[1]!.record.commit.token.sequence).toBe(2)
  })

  it('keeps resource bytes, metadata and session ownership in one restorable candidate', async () => {
    const { fixture, storage, barrier, resources, queue } = setup(), resourceId = kernelId<'resource'>('file')
    const descriptor = resources.register(resourceId, new File(['abc'], 'original.txt', { type: 'text/plain', lastModified: 42 }))
    await queue.event(id('resource'), { kind: 'resource-registered', descriptor }).completion
    await queue.event(id('open'), { ...open, revision: 1, input: { kind: 'resource', id: resourceId } } as KernelEvent).completion
    const record = storage.root!
    expect(record.record.manifest.revision).toBe(2)
    const restored = await DurableCommitBarrier.restore({ initialState: fixture.state, schema: fixture.schema, session: storage.acquire() })
    expect(restored.getState()).toEqual(barrier.getState()); expect(restored.getRestoredRecord()).toEqual(record.record)
    const recovered = restored.resources.get(resourceId) as File
    expect(recovered.name).toBe('original.txt'); expect(recovered.lastModified).toBe(42); expect(await recovered.text()).toBe('abc')
    expect((await restored.commit({ kind: 'read-started', ticket: 'after-restore' })).result.kind).toBe('accepted')
    expect(storage.root?.record.commit.parent).toEqual(barrier.getRoot())
    expect(storage.root?.record.commit.token.leaseEpoch).not.toEqual(barrier.getRoot()?.token.leaseEpoch)
    const missing = { ...record, contents: [] }
    await expect(validateRecoveryWrite(missing, fixture.state.workspace)).rejects.toThrow('exactly once')
  })

  it('hashes outbox, event, complete state and parent together and rejects tampering', async () => {
    const { fixture, storage, queue } = setup()
    await queue.event(id('open'), open).completion
    const record = storage.root!
    const damaged = [
      { ...record, record: { ...record.record, event: { kind: 'read-started' as const, ticket: 'forged' } } },
      { ...record, record: { ...record.record, transition: { ...record.record.transition, effects: [{ kind: 'read-at-least' as const, scope: fixture.state.workspace.scope, frontier: [] }] } } },
      { ...record, record: { ...record.record, transition: { ...record.record.transition, state: { ...record.record.transition.state, editorGeneration: 100 } } } },
    ]
    for (const value of damaged) await expect(validateRecoveryWrite(value, fixture.state.workspace)).rejects.toThrow('digest')
    await expect(validateRecoveryWrite(record, { ...fixture.state.workspace, codec: kernelId<'codec-version'>('wrong') })).rejects.toThrow('workspace')
  })

  it('withholds a frozen submission and its send effect until storage is committed, including later recovery', async () => {
    const { fixture, barrier, storage, queue } = setup()
    fixture.observe({ a: { value: 0 } }, 0)
    const authority = fixture.state.authority.content
    if (authority.kind !== 'complete') throw new Error('Expected authority')
    await queue.event(id('read'), { kind: 'authority-observed', snapshot: authority.snapshot }).completion
    const action = fixture.prepare([fixture.write('a', { value: 1 })])
    fixture.dispatch({ kind: 'prepared-action', prepared: action })
    await queue.event(id('action'), { kind: 'prepared-action', prepared: action }).completion
    const prepared = fixture.prepareSave(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise }
    let delivered: KernelTransition | null = null
    const saving = queue.event(id('freeze'), { kind: 'freeze-submission', prepared }).completion.then(result => {
      if (result.kind === 'completed') delivered = result.transition
    })
    await entered.promise
    expect(delivered).toBeNull(); expect(barrier.getState().persistence.kind).toBe('idle')
    expect(storage.writes.at(-1)?.record.transition.effects[0]?.kind).toBe('submit')
    gate.resolve(); await saving
    expect(delivered).toMatchObject({ effects: [{ kind: 'submit', submission: prepared.submission }] })
    storage.beforeCommit = null
    await queue.event(id('later'), { kind: 'read-started', ticket: 'later' }).completion
    const restored = await DurableCommitBarrier.restore({ initialState: new KernelFixture().state, schema: fixture.schema, session: storage.acquire() })
    expect(restored.getState().persistence).toMatchObject({ kind: 'sending', submission: prepared.submission })
    // No restored effect is automatically executed; recovery must derive a
    // lookup for this reservation even when the latest event has no effects.
    expect(restored.getRestoredRecord()?.transition.effects).toEqual([])
  })

  it('fences a candidate when its lease is lost while storage is pending, and never publishes a delayed positive receipt', async () => {
    const { storage, barrier, queue } = setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise }
    const pending = queue.event(id('open'), open).completion
    await entered.promise
    barrier.fence('lease released')
    gate.resolve()
    expect((await pending).kind).toBe('unresolved')
    expect(storage.root?.record.transition.state.revision).toBe(1)
    expect(barrier.getState().revision).toBe(0); expect(barrier.getStatus().kind).toBe('fenced')
    await expect(barrier.reconcile()).rejects.toThrow()
    await expect(barrier.commit({ kind: 'read-started', ticket: 'late' })).rejects.toThrow('fenced')
  })

  it('does not call storage for semantic rejection or unavailable physical bytes', async () => {
    const { storage, barrier, queue } = setup()
    const result = await queue.event(id('bad'), { ...open, revision: 9 } as KernelEvent).completion
    expect(result).toMatchObject({ kind: 'completed', transition: { result: { kind: 'rejected' } } })
    const missing = await queue.event(id('resource'), { kind: 'resource-registered', descriptor: { id: kernelId<'resource'>('missing'), kind: 'blob', size: 3, mediaType: '' } }).completion
    expect(missing).toMatchObject({ kind: 'completed', transition: { result: { kind: 'rejected' } } })
    expect(storage.writes).toEqual([]); expect(barrier.getState().revision).toBe(0)
    expect(barrier.getStatus().kind).toBe('idle')
  })
})
