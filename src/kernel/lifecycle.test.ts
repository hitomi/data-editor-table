import { describe, expect, it, vi } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { DurableTaskFixture } from '../../tests/kernel/durable-task-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { kernelId, type TaskResult } from './model.js'
import { defineKernelSchema } from './schema.js'
import { Workspace } from './workspace.js'

let serial = 0
const fieldId = kernelId<'field'>('x')
async function setup(durable = false, external = new DurableTaskFixture(), release?: () => Promise<void>) {
  const scope = { sourceId: `close:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0, hidden: 7 } })
  const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: fieldId, path: ['x'], readonly: false }] })
  const options = { scope, source, schema, policy: permissivePolicy, tasks: [external.definition] }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`close:${serial}`), scope, schema: schema.version, codec: schema.codec })
  const session = storage.acquire()
  const workspace = durable ? await Workspace.openDurable({ ...options, session: { ...session, release: release ?? session.release }, restore: false }) : new Workspace(options)
  await workspace.refresh()
  const fixture = new KernelFixture(undefined, schema)
  async function edit(value: number) {
    fixture.state = workspace.getState()
    const prepared = fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: value })])
    expect(await workspace.dispatch({ kind: 'prepared-action', prepared })).toMatchObject({ kind: 'accepted' })
    return prepared
  }
  return { workspace, source, storage, session, options, edit }
}
async function open(workspace: Workspace) {
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>(`session:${++serial}`),
    inputId: kernelId<'input'>(`input:${serial}`), viewId: kernelId<'view'>('view'), input: { kind: 'encoded', value: 'raw' }, reads: [],
    target: { kind: 'cell', field: { entityId: workspace.getProjection().rows[0]!.entityId, fieldId } } })
  return workspace.getState().session!
}
async function cancel(workspace: Workspace) {
  const session = workspace.getState().session!
  expect(await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })).toMatchObject({ kind: 'accepted' })
}
const kinds = (workspace: Workspace) => workspace.requestClose().blockers.map(blocker => blocker.kind)

describe('Workspace close protocol', () => {
  it('blocks unsaved hidden contributions and closes only after exact save, without changing input proofs', async () => {
    const { workspace, edit, source } = await setup()
    await edit(1)
    await workspace.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [{ columnId: 'x', predicate: { kind: 'compare', fieldId, operator: 'equals', value: 9 } }], sort: [] })
    expect(workspace.getView().rows).toEqual([])
    expect(kinds(workspace)).toContain('intent')
    expect(await workspace.close(workspace.requestClose().ticket, 'clean-close')).toMatchObject({ kind: 'blocked', reason: 'work' })
    expect((await workspace.save()).kind).toBe('committed')
    const state = workspace.getState(), review = workspace.requestClose()
    expect(review.blockers).toEqual([])
    expect(await workspace.close(review.ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
    expect(workspace.getState()).toBe(state)
    expect(await workspace.undo()).toMatchObject({ kind: 'rejected' })
    expect((await workspace.refresh()).kind).toBe('rejected')
    expect((await workspace.save()).kind).toBe('blocked')
    expect(source.writes).toBe(1)
  })

  it('reports reversible neutral history separately, without inventing settlement', async () => {
    const { workspace, edit, source } = await setup()
    await edit(1); await edit(0)
    const review = workspace.requestClose(), inputs = workspace.getState().inputs
    expect(review.neutralIntentIds).toHaveLength(2); expect(review.blockers).toEqual([])
    expect(await workspace.close(review.ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
    expect(workspace.getState().inputs).toBe(inputs)
    expect(inputs.every(input => input.disposition.kind === 'intents')).toBe(true)
    expect(source.writes).toBe(0)
  })

  it('retains a detached session, and invalidates its ticket for rejected input even with no published revision change', async () => {
    const { workspace } = await setup(), session = await open(workspace)
    const review = workspace.requestClose(), state = workspace.getState()
    const bad = workspace.typeInput(session.editor!, { kind: 'resource', id: kernelId<'resource'>('missing') })
    await bad.completion
    expect(workspace.getState()).toBe(state)
    expect(await workspace.close(review.ticket, 'retain')).toMatchObject({ kind: 'blocked', reason: 'stale' })
    expect(kinds(workspace)).toEqual(['session', 'ingress'])
    expect(await workspace.close(workspace.requestClose().ticket, 'retain')).toMatchObject({ kind: 'retained' })
    await workspace.dispatch({ kind: 'session-detached', lease: session.editor!, inputVersion: session.input.version })
    expect(kinds(workspace)).toContain('session'); expect(workspace.getIngress().pending).toHaveLength(1)
    await cancel(workspace)
    expect(workspace.requestClose().blockers).toEqual([])
  })

  it('invalidates a ticket synchronously when source work queues before its first semantic event', async () => {
    const { workspace, source } = await setup(), gate = deferred<void>(), entered = deferred<void>()
    const review = workspace.requestClose(), revision = workspace.getState().revision
    source.readHook = async () => { entered.resolve(); await gate.promise; return source.snapshot() }
    const refresh = workspace.refresh()
    expect(workspace.getState().revision).toBe(revision)
    expect(kinds(workspace)).toContain('runtime')
    expect(await workspace.close(review.ticket, 'clean-close')).toMatchObject({ kind: 'blocked', reason: 'stale' })
    await entered.promise; gate.resolve(); await refresh
    expect(workspace.requestClose().blockers).toEqual([])
  })

  it('keeps File registration and uncertain storage visible before semantic publication', async () => {
    const { workspace, storage } = await setup(true), gate = deferred<void>(), entered = deferred<void>()
    const review = workspace.requestClose(), revision = workspace.getState().revision
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise }
    const resource = workspace.registerResource(new File(['bytes'], 'input.txt'))
    await entered.promise
    expect(workspace.getState().revision).toBe(revision)
    expect(kinds(workspace)).toEqual(['ingress', 'storage'])
    expect(await workspace.close(review.ticket, 'clean-close')).toMatchObject({ reason: 'stale' })
    storage.loseResponse = true; gate.resolve()
    await expect(resource).rejects.toThrow()
    expect(kinds(workspace)).toEqual(['ingress', 'storage'])
    expect(await workspace.close(workspace.requestClose().ticket, 'clean-close')).toMatchObject({ reason: 'work' })
    expect(await workspace.reconcileStorage()).toMatchObject({ kind: 'accepted' })
    expect(kinds(workspace)).toEqual(['resource'])
    await workspace.releaseResource(workspace.getState().resources[0]!.descriptor.id)
    expect(await workspace.close(workspace.requestClose().ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
  })

  it('does not treat cancellation as completion of a memory callback that ignores abort', async () => {
    const { workspace } = await setup(), session = await open(workspace), started = deferred<void>(), result = deferred<TaskResult>()
    const run = workspace.runTask({ owner: { kind: 'session', sessionId: session.id, input: session.input }, input: { kind: 'encoded', value: 'job' }, reads: [] },
      async () => { started.resolve(); return result.promise })
    await started.promise; await cancel(workspace)
    expect(workspace.getState().tasks[0]?.kind).toBe('cancelled')
    expect(kinds(workspace)).toContain('runtime')
    expect(await workspace.close(workspace.requestClose().ticket, 'clean-close')).toMatchObject({ reason: 'work' })
    result.resolve({ kind: 'session-candidate', sessionId: session.id, input: { kind: 'encoded', value: 'late' } })
    await workspace.waitForTask(run.taskId)
    expect(workspace.requestClose().blockers).toEqual([])
  })

  it('queries a cancelled unknown durable execution before clean close instead of equating AbortSignal with a terminal result', async () => {
    const external = new DurableTaskFixture(), { workspace } = await setup(true, external), session = await open(workspace)
    external.loseResponse = true
    const run = workspace.runDurableTask({ definition: external.definition.ref, owner: { kind: 'session', sessionId: session.id, input: session.input }, input: { kind: 'encoded', value: 'job' }, reads: [] })
    await run.result; await workspace.waitForTask(run.taskId); await cancel(workspace)
    expect(kinds(workspace)).toEqual(['task'])
    expect(await workspace.close(workspace.requestClose().ticket, 'clean-close')).toMatchObject({ reason: 'work' })
    await workspace.recoverTask(run.taskId)
    expect(workspace.requestClose().blockers).toEqual([])
    expect(external.executions).toBe(1)
  })

  it('blocks a lost source acknowledgement until original-operation recovery completes', async () => {
    const { workspace, source, edit } = await setup()
    await edit(1)
    source.submitHook = async (_submission, execute) => { await execute(); throw new Error('response lost') }
    expect((await workspace.save()).kind).toBe('unresolved')
    expect(kinds(workspace)).toContain('submission')
    expect(await workspace.close(workspace.requestClose().ticket, 'clean-close')).toMatchObject({ reason: 'work' })
    expect((await workspace.recover()).kind).toBe('committed')
    expect(await workspace.close(workspace.requestClose().ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
    expect(source.writes).toBe(1)
  })

  it('keeps a previous runtime reservation visible when the restored semantic root is already idle', async () => {
    const { workspace, storage, options, edit, source } = await setup(true)
    await edit(1)
    storage.beforeCommit = async write => {
      if (write.record.event.kind === 'server-authority-received' && write.record.transition.state.commits.length) storage.loseResponse = true
    }
    expect((await workspace.save()).kind).toBe('unresolved')
    storage.beforeCommit = null
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(restored.getState().persistence.kind).toBe('idle')
    expect(kinds(restored)).toEqual(['submission'])
    expect(await restored.close(restored.requestClose().ticket, 'clean-close')).toMatchObject({ reason: 'work' })
    expect((await restored.recover()).kind).toBe('committed')
    expect(await restored.close(restored.requestClose().ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
    expect(source.writes).toBe(1)
  })

  it('fences admission synchronously, waits for release, and retries failed release without reopening admission', async () => {
    const gate = deferred<void>(), release = vi.fn(async (): Promise<void> => { await gate.promise; throw new Error('release failed') })
    const { workspace } = await setup(true, undefined, release), ticket = workspace.requestClose().ticket, state = workspace.getState()
    const closing = workspace.close(ticket, 'clean-close')
    expect(workspace.requestClose().lifecycle).toBe('closing')
    const late = workspace.dispatch({ kind: 'view-query-set', expectedVersion: state.view.version, filters: [], sort: [] })
    expect(await late).toMatchObject({ kind: 'rejected' }); expect(workspace.getIngress().pending).toEqual([])
    await expect(workspace.registerResource(new Blob(['late']))).rejects.toThrow('no longer accepts')
    expect(workspace.getState()).toBe(state)
    gate.resolve()
    expect(await closing).toMatchObject({ kind: 'blocked', reason: 'release-failed' })
    expect(workspace.requestClose().lifecycle).toBe('closing')
    release.mockImplementation(async () => {})
    expect(await workspace.close(ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
    expect(release).toHaveBeenCalledTimes(2)
    expect(await workspace.close(ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('rejects tickets from another runtime and permits a fresh durable lease after clean release', async () => {
    const { workspace, storage, options } = await setup(true), old = workspace.requestClose().ticket
    expect(await workspace.close(old, 'clean-close')).toMatchObject({ kind: 'closed' })
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(await restored.close(old, 'clean-close')).toMatchObject({ kind: 'blocked', reason: 'stale' })
    expect(restored.getProjection().rows[0]?.preview).toEqual({ x: 0, hidden: 7 })
    expect(await restored.close(restored.requestClose().ticket, 'clean-close')).toMatchObject({ kind: 'closed' })
  })
})
