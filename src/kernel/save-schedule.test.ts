import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { kernelId } from './model.js'
import { Workspace } from './workspace.js'
import { reduceKernel } from './transition.js'

let serial = 0
async function setup(durable = false) {
  const scope = { sourceId: `schedule:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0, hidden: 7 }, b: { x: 0 } })
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`workspace:${serial}`), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = durable ? await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false }) : new Workspace(options)
  await workspace.refresh()
  const fixture = new KernelFixture()
  async function edit(x: number, row = 0) {
    fixture.state = workspace.getState()
    const prepared = fixture.prepare([fixture.write(workspace.getProjection().rows[row]!.entityId, { x })])
    expect(await workspace.dispatch({ kind: 'prepared-action', prepared })).toMatchObject({ kind: 'accepted' })
    return prepared
  }
  return { workspace, source, storage, options, edit }
}
const outcome = (workspace: Workspace) => workspace.getScheduledSaveResult()?.result.kind
const automatic = (workspace: Workspace, debounceMs = 0) => workspace.setSaveSchedule({ mode: debounceMs ? 'debounced' : 'immediate', debounceMs })
const tick = (time = 0) => vi.advanceTimersByTimeAsync(time)
async function finished(workspace: Workspace, kind = 'committed') {
  await vi.waitFor(() => expect(outcome(workspace)).toBe(kind))
}
afterEach(() => vi.useRealTimers())

describe('durable save schedule tokens and runtime timers', () => {
  it('defaults to manual and schedules existing authored work when switched to immediate', async () => {
    vi.useFakeTimers()
    const { workspace, source, edit } = await setup()
    await edit(1); await tick(10_000)
    expect(source.requests).toEqual([])
    await automatic(workspace); await tick(); await finished(workspace)
    expect(source.writes).toBe(1)
    expect(workspace.getState().schedule.pending).toBe(false)
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('settled-intents')
  })

  it('debounces the latest journal frontier without resetting for view events', async () => {
    vi.useFakeTimers()
    const { workspace, source, edit } = await setup()
    await automatic(workspace, 100)
    await edit(1); await tick(90); await edit(2); await tick(90)
    expect(source.requests).toEqual([])
    await workspace.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [], sort: [] })
    await tick(9); expect(source.requests).toEqual([])
    await tick(1); await finished(workspace)
    expect(source.requests).toHaveLength(1)
    expect(source.requests[0]!.coverage[0]!.intentIds).toHaveLength(2)
    expect(workspace.getProjection().rows[0]?.preview).toEqual({ x: 2, hidden: 7 })
  })

  it('switches to manual without executing the old timer and rejects stale configuration or transport injection', async () => {
    vi.useFakeTimers()
    const { workspace, source, edit } = await setup()
    await automatic(workspace, 100); await edit(1)
    const token = workspace.getState().schedule.token
    await workspace.setSaveSchedule({ mode: 'manual', debounceMs: 0 })
    await tick(10_000); expect(source.requests).toEqual([])
    expect(await workspace.setSaveSchedule({ mode: 'immediate', debounceMs: 0 }, token)).toMatchObject({ kind: 'rejected' })
    const old = reduceKernel(workspace.getState(), { kind: 'save-requested', ticket: 'expired', scheduleToken: token }, workspace.schema)
    expect(old.result.kind).toBe('ignored'); expect(old.state).toBe(workspace.getState())
    // The public dispatcher cannot forge a runtime timer or a gateway request.
    expect(await workspace.dispatch({ kind: 'save-requested', ticket: 'injected', scheduleToken: token } as never)).toMatchObject({ kind: 'rejected' })
    expect(source.requests).toEqual([])
  })

  it('keeps raw filter input out of saves and closes neutral history without running a late timer', async () => {
    vi.useFakeTimers()
    const { workspace, source, edit } = await setup()
    await automatic(workspace, 100)
    await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('filter'), inputId: kernelId<'input'>('filter'),
      viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'x', queryVersion: 0 }, input: { kind: 'encoded', value: 'unapplied' }, reads: [] })
    await tick(100); expect(outcome(workspace)).toBeUndefined()
    expect(workspace.getState().schedule.pending).toBe(false)
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'unapplied' })
    const session = workspace.getState().session!
    await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
    await edit(1); await edit(0)
    expect(await workspace.close(workspace.requestClose().ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
    await tick(10_000); expect(source.requests).toEqual([])
  })

  it('automatically saves a normalized successor after the first exact commit, with every view detached', async () => {
    vi.useFakeTimers()
    const { workspace, source, edit } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    await automatic(workspace)
    source.normalize = document => document.x === 1 ? { ...document, x: 1.5 } : document
    source.submitHook = async (_request, execute) => { const result = execute(); entered.resolve(); await gate.promise; return result }
    await edit(1); await tick(); await entered.promise
    const detach = workspace.subscribe(() => {})
    const successor = await edit(2); detach()
    await tick(10_000); expect(source.requests).toHaveLength(1)
    source.submitHook = null; gate.resolve()
    await vi.waitFor(() => expect(source.writes).toBe(2))
    await vi.waitFor(() => expect(workspace.getState().inputs.every(input => input.disposition.kind === 'settled-intents')).toBe(true))
    expect(workspace.getProjection().rows[0]?.preview).toEqual({ x: 2, hidden: 7 })
    expect(source.requests[1]!.coverage[0]!.intentIds).toEqual(successor.action.intentIds)
  })

  it('never retries an unknown operation on timers; explicit original lookup unlocks a pending successor', async () => {
    vi.useFakeTimers()
    const { workspace, source, edit } = await setup()
    await automatic(workspace)
    source.submitHook = async (_request, execute) => { execute(); throw new Error('Lost response') }
    await edit(1); await tick(); await finished(workspace, 'unresolved')
    await edit(2); await tick(60_000)
    expect(source.requests).toHaveLength(1); expect(source.lookups).toBe(0)
    const original = source.requests[0]!
    source.submitHook = null
    expect((await workspace.recover()).kind).toBe('committed')
    await tick(); await vi.waitFor(() => expect(source.writes).toBe(2))
    expect(source.lookups).toBe(1)
    expect(source.requests[1]!.operationId).not.toBe(original.operationId)
    expect(workspace.getProjection().rows[0]?.preview?.x).toBe(2)
  })

  it('does not turn read failures or equivalent refreshes into background retry loops', async () => {
    vi.useFakeTimers()
    const { workspace, source, edit } = await setup()
    await automatic(workspace)
    source.readHook = async () => { throw new Error('offline') }
    await edit(1); await tick(); await finished(workspace, 'blocked')
    const reads = source.reads
    await tick(60_000); expect(source.reads).toBe(reads); expect(source.requests).toEqual([])
    source.readHook = null; await workspace.refresh(); await tick(60_000)
    expect(source.requests).toEqual([])
    expect((await workspace.save()).kind).toBe('committed'); expect(source.writes).toBe(1)
  })

  it('saves eligible rows once and rearms only when fresh authority unblocks the remaining conflict', async () => {
    vi.useFakeTimers()
    const { workspace, source, edit } = await setup()
    await edit(1); await edit(2, 1)
    source.external({ a: { x: 9, hidden: 7 }, b: { x: 0 } }); await workspace.refresh()
    await automatic(workspace); await tick(); await finished(workspace)
    expect(source.writes).toBe(1); expect(workspace.getProjection().rows[0]!.issues.length).toBeGreaterThan(0)
    await tick(10_000); expect(source.requests).toHaveLength(1)
    source.external({ a: { x: 0, hidden: 7 }, b: { x: 2 } }); await workspace.refresh()
    await tick(); await vi.waitFor(() => expect(source.writes).toBe(2))
    expect(workspace.getProjection().rows[0]?.preview?.x).toBe(1)
  })

  it('persists configuration and the authoring trigger before starting any durable automatic request', async () => {
    vi.useFakeTimers()
    const { workspace, source, storage, edit } = await setup(true), gate = deferred<void>(), entered = deferred<void>()
    await automatic(workspace, 10)
    storage.beforeCommit = async write => { if (write.record.event.kind === 'prepared-action') { entered.resolve(); await gate.promise } }
    const editing = edit(1); await entered.promise; await tick(100)
    expect(source.requests).toEqual([])
    gate.resolve(); await editing
    storage.beforeCommit = null
    source.submitHook = async (submission, execute) => {
      expect(storage.root?.record.transition.state.persistence).toMatchObject({ kind: 'sending', submission })
      expect(storage.root?.record.transition.state.schedule.pending).toBe(false)
      return execute()
    }
    await tick(10); await finished(workspace)
    expect(source.writes).toBe(1)
  })

  it('does not execute a timer after a configuration storage acknowledgement is lost, then resumes the exact accepted mode', async () => {
    vi.useFakeTimers()
    const { workspace, source, storage, edit } = await setup(true)
    await edit(1); storage.loseResponse = true
    expect(await automatic(workspace)).toMatchObject({ kind: 'unresolved' })
    await tick(10_000); expect(source.requests).toEqual([])
    expect(workspace.getState().schedule.mode).toBe('manual')
    expect(await workspace.reconcileStorage()).toMatchObject({ kind: 'accepted' })
    await tick(); await finished(workspace)
    expect(source.writes).toBe(1)
  })

  it('coordinates a lost SaveRequested storage acknowledgement without leaving a permanent wait or sending an unowned request', async () => {
    vi.useFakeTimers()
    const { workspace, source, storage, edit } = await setup(true)
    await automatic(workspace)
    storage.beforeCommit = async write => { if (write.record.event.kind === 'save-requested') storage.loseResponse = true }
    await edit(1); await tick(); await finished(workspace, 'blocked')
    expect(workspace.getStorageStatus()?.kind).toBe('unknown')
    expect(source.requests).toEqual([])
    storage.beforeCommit = null
    expect(await workspace.reconcileStorage()).toMatchObject({ kind: 'accepted' })
    expect(workspace.getState().persistence.kind).toBe('waiting-for-gateway')
    await tick(10_000); expect(source.requests).toEqual([])
    expect(await workspace.recover()).toMatchObject({ kind: 'not-started' })
    expect(workspace.getState().persistence.kind).toBe('idle')
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('intents')
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.writes).toBe(1); expect(source.lookups).toBe(0)
  })

  it('rejects the pre-schedule durable format without replacing its stored recovery root', async () => {
    const { workspace, storage, options } = await setup(true)
    const root = storage.root!, lease = storage.acquire()
    await expect(Workspace.openDurable({ ...options, restore: true, session: { ...lease,
      load: async () => ({ ...root, record: { ...root.record, format: 1 as never } }),
    } })).rejects.toThrow('invalid workspace, token, parent or transition')
    expect(storage.root).toEqual(root)
    expect(workspace.getState().schedule.mode).toBe('manual')
  })

  it('restores a pending debounce under a new lease without executing the old timer', async () => {
    vi.useFakeTimers()
    const { workspace, source, storage, options, edit } = await setup(true)
    await automatic(workspace, 100); await edit(1)
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(restored.getState().schedule).toEqual(workspace.getState().schedule)
    await tick(100); await finished(restored)
    expect(workspace.getScheduledSaveResult()).toBeNull()
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
  })
})
