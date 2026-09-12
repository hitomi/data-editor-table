import { describe, expect, it } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { kernelId } from './model.js'
import { Workspace } from './workspace.js'
import { projectCapabilities } from './capabilities.js'

async function setup(durable = false) {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0 }, b: { x: 0 } })
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>('workspace'), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = durable ? await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false }) : new Workspace(options)
  await workspace.refresh()
  const fixture = new KernelFixture()
  const edit = async (x: number, index = 0) => {
    fixture.state = workspace.getState()
    const prepared = fixture.prepare([fixture.write(workspace.getProjection().rows[index]!.entityId, { x })])
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared })).kind).toBe('accepted')
    return prepared
  }
  return { workspace, source, storage, edit, fixture }
}

describe('Workspace command capabilities', () => {
  it('uses the actual history preparation without modifying input or performing I/O', async () => {
    const { workspace, source, edit } = await setup()
    expect(workspace.getCapabilities().save).toEqual({ kind: 'unavailable', reason: 'no-changes' })
    const prepared = await edit(2), state = workspace.getState(), ingress = workspace.getIngress(), reads = source.reads
    const first = workspace.getCapabilities(), second = workspace.getCapabilities()
    expect(first.undo).toMatchObject({ kind: 'available', applicationId: prepared.action.applicationId })
    expect(first.save).toMatchObject({ kind: 'available', intentIds: prepared.action.intentIds, remainingIntentIds: [] })
    expect(second.undo).toBe(first.undo); expect(second.save).toBe(first.save)
    expect(workspace.getState()).toBe(state); expect(workspace.getIngress()).toBe(ingress)
    expect(source.reads).toBe(reads); expect(source.writes).toBe(0)
    expect((await workspace.undo()).kind).toBe('accepted')
    expect(workspace.getCapabilities().redo.kind).toBe('available')
    expect((await workspace.redo()).kind).toBe('accepted')
    expect(workspace.getProjection().rows[0]!.preview).toEqual({ x: 2 })
  })

  it('describes partial save membership and reprojects policy changes', async () => {
    const { workspace, edit } = await setup()
    const a = await edit(1), b = await edit(2, 1), state = workspace.getState()
    await workspace.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('restricted'),
      entities: [{ entityId: workspace.getProjection().rows[0]!.entityId, policy: { ...permissivePolicy.defaultEntity, write: false } }] } })
    expect(workspace.getState()).not.toBe(state)
    expect(workspace.getCapabilities().save).toMatchObject({ kind: 'available', intentIds: b.action.intentIds, remainingIntentIds: a.action.intentIds })
    const saved = await workspace.save()
    expect(saved.kind).toBe('committed')
    if (saved.kind === 'committed') expect(saved.submission.coverage.flatMap(entry => entry.intentIds)).toEqual(b.action.intentIds)
    expect(workspace.getCapabilities().save.kind).toBe('blocked')
  })

  it('warns before an irreversible delete and blocks its committed undo', async () => {
    const { workspace, fixture } = await setup()
    fixture.state = workspace.getState()
    const entityId = workspace.getProjection().rows[0]!.entityId
    await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([{ kind: 'delete', entityId }]) })
    expect(workspace.getCapabilities().save).toMatchObject({ kind: 'available', irreversibleDeletes: [entityId] })
    expect(workspace.getCapabilities().undo.kind).toBe('available')
    expect((await workspace.save()).kind).toBe('committed')
    expect(workspace.getCapabilities().undo).toMatchObject({ kind: 'blocked', reason: 'invalid-command' })
    expect((await workspace.undo()).kind).toBe('rejected')
  })

  it('allows conditional undo while the original source operation is unknown', async () => {
    const { workspace, source, edit } = await setup()
    await edit(4)
    source.submitHook = async (_request, execute) => { execute(); throw new Error('lost acknowledgement') }
    expect((await workspace.save()).kind).toBe('unresolved')
    expect(workspace.getCapabilities().save).toMatchObject({ kind: 'blocked', reason: 'source-reserved' })
    expect(workspace.getCapabilities().undo.kind).toBe('available')
    expect((await workspace.undo()).kind).toBe('accepted')
    expect(source.writes).toBe(1)
  })

  it('updates runtime restrictions while the cached semantic state stays unchanged', async () => {
    const { workspace, source, edit } = await setup()
    await edit(5)
    const initial = workspace.getCapabilities(), before = workspace.getState(), entered = deferred<void>(), release = deferred<void>()
    source.readHook = async () => { entered.resolve(); await release.promise; return source.snapshot() }
    const refreshing = workspace.refresh()
    // The enqueued activity precedes its first semantic event.
    expect(workspace.getState()).toBe(before)
    expect(workspace.getCapabilities().save).toMatchObject({ kind: 'blocked', reason: 'source-busy' })
    expect(workspace.getCapabilities().undo).toBe(initial.undo)
    await entered.promise; release.resolve(); await refreshing
    expect(workspace.getCapabilities().save.kind).toBe('available')
  })

  it('blocks during unknown storage and invalidates history at discard and close', async () => {
    const { workspace, storage, edit } = await setup(true)
    await edit(1)
    storage.loseResponse = true
    await workspace.dispatch({ kind: 'view-query-set', expectedVersion: workspace.getState().view.version, filters: [], sort: [] })
    expect(workspace.getCapabilities().undo).toMatchObject({ kind: 'blocked', reason: 'storage-pending' })
    await workspace.reconcileStorage()
    expect(workspace.getCapabilities().undo.kind).toBe('available')
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('closed')
    expect(workspace.getCapabilities().undo).toMatchObject({ kind: 'blocked', reason: 'inactive' })
    expect(projectCapabilities(workspace.getState(), workspace.schema).undo).toEqual({ kind: 'unavailable', reason: 'no-history' })
  })

  it('does not confuse retained raw input with saveable authored changes', async () => {
    const { workspace } = await setup()
    await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('raw'),
      viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'not applied' }, reads: [] })
    const capability = workspace.getCapabilities()
    expect(capability.save).toEqual({ kind: 'unavailable', reason: 'no-changes' })
    expect(capability.close.blockers.some(blocker => blocker.kind === 'session')).toBe(true)
    expect(capability.ticket).toEqual(capability.close.ticket)
  })
})
