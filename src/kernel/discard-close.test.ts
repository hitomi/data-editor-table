import { describe, expect, it } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { DurableTaskFixture } from '../../tests/kernel/durable-task-fixture.js'
import { Workspace } from './workspace.js'
import { kernelId } from './model.js'
import { validateWorkspaceCheckpoint } from './checkpoint.js'

async function setup(durable = true) {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0, hidden: 7 } })
  const service = new DurableTaskFixture()
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy, tasks: [service.definition] }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>('workspace'), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = durable ? await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false }) : new Workspace(options)
  await workspace.refresh()
  const fixture = new KernelFixture()
  const edit = async (target: Workspace, x: number) => {
    fixture.state = target.getState()
    const result = await target.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([fixture.write(target.getProjection().rows[0]!.entityId, { x })]) })
    expect(result.kind).toBe('accepted')
    return result
  }
  const restore = () => Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  return { workspace, storage, source, service, options, edit, restore }
}
async function openEditor(workspace: Workspace) {
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('input'),
    viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'raw' }, reads: [] })
}

describe('explicit Workspace discard and close', () => {
  for (const durable of [false, true]) it(`records disposition without source writes in ${durable ? 'durable' : 'memory'} mode`, async () => {
    const { workspace, source, edit } = await setup(durable)
    await edit(workspace, 9); await openEditor(workspace)
    const before = workspace.getState(), ticket = workspace.requestClose().ticket
    expect((await workspace.close(ticket, 'discard')).kind).toBe('closed')
    const after = workspace.getState()
    expect(after.discards).toEqual([{ ticket, applicationCount: before.journal.actions.length, resources: [] }])
    expect(after.session).toBeNull(); expect(after.journal).toEqual(before.journal)
    expect(after.inputs).toHaveLength(before.inputs.length)
    expect(after.settlements).toMatchObject([{ kind: 'workspace-discarded', ticket }])
    expect(after.inputs.find(input => input.disposition.kind === 'workspace-discarded')?.input).toEqual({ kind: 'encoded', value: 'raw' })
    expect(workspace.getProjection().rows[0]!.preview).toEqual({ x: 0, hidden: 7 })
    expect(workspace.getHistory()).toEqual({ undo: [], redo: [] })
    expect(source.writes).toBe(0)
  })

  it('preserves original commit facts and starts a fresh undo boundary after reopening', async () => {
    const { workspace, source, edit, restore } = await setup()
    await edit(workspace, 1); await workspace.save()
    const commits = workspace.getState().commits, settled = workspace.getState().settlements
    await edit(workspace, 2)
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('closed')
    const restored = await restore()
    expect(restored.getState().commits).toEqual(commits)
    expect(restored.getState().settlements.slice(0, settled.length)).toEqual(settled)
    expect(restored.getProjection().rows[0]!.preview).toEqual({ x: 1, hidden: 7 })
    expect((await restored.undo()).kind).toBe('rejected')
    await edit(restored, 3); expect((await restored.undo()).kind).toBe('accepted')
    expect(restored.getProjection().rows[0]!.preview).toEqual({ x: 1, hidden: 7 })
    expect((await restored.undo()).kind).toBe('rejected')
    expect(source.writes).toBe(1)
  })

  it('atomically disposes rejected ingress and records staged file disposition without deleting retained bytes', async () => {
    const { workspace, storage, restore } = await setup()
    const unused = await workspace.registerResource(new File(['unused'], 'unused.txt'))
    storage.rejectNext = true
    await expect(workspace.registerResource(new File(['rejected'], 'rejected.txt'))).rejects.toThrow()
    const pending = workspace.getIngress().pending[0]!
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('closed')
    const restored = await restore()
    expect(restored.getIngress().pending).toEqual([])
    expect(restored.getIngress().receipts.find(receipt => receipt.id === pending.id)?.disposition).toBe('discarded')
    expect(restored.getState().resources.find(resource => resource.descriptor.id === unused.id)?.status).toBe('available')
    expect(restored.getState().discards[0]!.resources).toContain(unused.id)
    expect(await restored.getResource(unused.id).text()).toBe('unused')
    expect(restored.requestClose().blockers).toEqual([])
  })

  it('keeps all input when storage rejects and resolves a lost acknowledgement by the original token', async () => {
    const { workspace, storage, edit, restore } = await setup()
    await edit(workspace, 5); await openEditor(workspace)
    const before = workspace.getState()
    storage.rejectNext = true
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('blocked')
    expect(workspace.getState()).toBe(before); expect(workspace.requestClose().lifecycle).toBe('open')
    storage.loseResponse = true
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('blocked')
    expect(workspace.getState()).toBe(before)
    const count = storage.writes.length
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('blocked')
    expect(storage.writes).toHaveLength(count)
    expect((await workspace.reconcileStorage()).kind).toBe('accepted')
    expect(workspace.getState().discards).toHaveLength(1)
    expect((await workspace.close(workspace.requestClose().ticket, 'clean-close')).kind).toBe('closed')
    expect((await restore()).getState().discards).toHaveLength(1)
  })

  it('retains input arriving after the reviewed discard instead of closing over it', async () => {
    const { workspace, storage, edit } = await setup()
    await edit(workspace, 4); await openEditor(workspace)
    const lease = workspace.getState().session!.editor!, entered = deferred<void>(), release = deferred<void>()
    storage.beforeCommit = async write => { if (write.record.event.kind === 'workspace-discarded') { entered.resolve(); await release.promise } }
    const ticket = workspace.requestClose().ticket, closing = workspace.close(ticket, 'discard')
    expect(workspace.close(ticket, 'discard')).toBe(closing)
    await entered.promise
    const later = workspace.typeInput(lease, { kind: 'encoded', value: 'later original' })
    release.resolve()
    expect(await closing).toMatchObject({ kind: 'blocked', reason: 'stale' }); await later.completion
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect(workspace.getIngress().pending.find(entry => entry.id === later.id)?.payload).toMatchObject({ envelope: { input: { value: 'later original' } } })
    expect(workspace.getState().discards).toHaveLength(1)
  })

  it('preserves File bytes when later input references a resource reviewed for discard', async () => {
    const { workspace, storage, restore } = await setup()
    await openEditor(workspace)
    const file = await workspace.registerResource(new File(['later-owned'], 'late.txt', { lastModified: 22 }))
    const lease = workspace.getState().session!.editor!, entered = deferred<void>(), release = deferred<void>()
    storage.beforeCommit = async write => { if (write.record.event.kind === 'workspace-discarded') { entered.resolve(); await release.promise } }
    const closing = workspace.close(workspace.requestClose().ticket, 'discard')
    await entered.promise
    const later = workspace.typeInput(lease, { kind: 'resource', id: file.id })
    release.resolve(); expect(await closing).toMatchObject({ reason: 'stale' }); await later.completion
    expect((await workspace.refresh()).kind).toBe('accepted')
    const reopened = await restore()
    expect(reopened.getIngress().pending.find(entry => entry.id === later.id)?.payload).toMatchObject({ envelope: { input: { kind: 'resource', id: file.id } } })
    const recovered = reopened.getResource(file.id) as File
    expect(await recovered.text()).toBe('later-owned'); expect(recovered.name).toBe('late.txt'); expect(recovered.lastModified).toBe(22)
    expect((await reopened.close(reopened.requestClose().ticket, 'clean-close')).kind).toBe('blocked')
  })

  it('rejects stale tickets and explicit retain before committing any discard', async () => {
    const { workspace, edit } = await setup(false)
    await edit(workspace, 2)
    const ticket = workspace.requestClose().ticket
    const closing = workspace.close(ticket, 'discard')
    await workspace.close(ticket, 'retain')
    expect(await closing).toMatchObject({ reason: 'stale' })
    expect(workspace.getState().discards).toEqual([])
    expect(await workspace.close(ticket, 'discard')).toMatchObject({ reason: 'stale' })
  })

  it('never interprets an unknown source mutation as not applied', async () => {
    const { workspace, source, edit } = await setup()
    await edit(workspace, 8)
    source.submitHook = async (_request, execute) => { execute(); throw new Error('lost') }
    expect((await workspace.save()).kind).toBe('unresolved')
    const before = workspace.getState()
    expect(await workspace.close(workspace.requestClose().ticket, 'discard')).toMatchObject({ reason: 'work' })
    expect(workspace.getState()).toBe(before)
    expect((await workspace.recover()).kind).toBe('committed')
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('closed')
    expect(workspace.getState().settlements[0]?.kind).toBe('committed')
    expect(source.writes).toBe(1)
  })

  it('does not let retry of a rejected discard reuse an obsolete review ticket', async () => {
    const { workspace, storage, edit } = await setup()
    await edit(workspace, 2); storage.rejectNext = true
    await workspace.close(workspace.requestClose().ticket, 'discard')
    const rejected = workspace.getIngress().pending[0]!
    await edit(workspace, 3)
    const retried = await workspace.retryIngress(rejected.id, workspace.getIngress().generation).completion
    expect(retried.kind).toBe('completed')
    if (retried.kind === 'completed') expect(retried.transition.result).toMatchObject({ kind: 'rejected', issue: { code: 'stale-discard' } })
    expect(workspace.getState().discards).toEqual([])
    expect(workspace.getProjection().rows[0]!.preview).toEqual({ x: 3, hidden: 7 })
  })

  it('requires an exact external task outcome even after local task cancellation', async () => {
    const { workspace, service, restore } = await setup()
    await openEditor(workspace)
    const session = workspace.getState().session!
    service.loseResponse = true
    const running = workspace.runDurableTask({ definition: service.definition.ref, owner: { kind: 'session', sessionId: session.id, input: session.input },
      input: { kind: 'encoded', value: 'task input' }, reads: [] })
    await running.result; await workspace.waitForTask(running.taskId)
    const task = workspace.getState().tasks[0]!
    await workspace.dispatch({ kind: 'task-cancelled', taskId: task.id, executionId: task.executionId })
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('blocked')
    expect(workspace.getState().discards).toEqual([])
    await workspace.recoverTask(task.id)
    expect(workspace.getState().tasks[0]!.execution?.outcome?.kind).toBe('succeeded')
    expect((await workspace.close(workspace.requestClose().ticket, 'discard')).kind).toBe('closed')
    const restored = await restore()
    expect(restored.getState().tasks[0]).toMatchObject({ kind: 'cancelled', execution: { outcome: { kind: 'succeeded' } } })
    expect(service.executions).toBe(1); expect(service.lookups).toHaveLength(1)
  })

  it('validates persisted discard boundaries rather than silently losing their history cutoff', async () => {
    const { workspace, edit, restore } = await setup()
    await edit(workspace, 4); await workspace.close(workspace.requestClose().ticket, 'discard')
    const restored = await restore(), checkpoint = await restored.exportCheckpoint()
    expect((await validateWorkspaceCheckpoint(checkpoint, restored.schema)).metadata.state.discards).toHaveLength(1)
    const broken = { ...checkpoint, metadata: { ...checkpoint.metadata, state: { ...checkpoint.metadata.state, discards: undefined } } }
    await expect(validateWorkspaceCheckpoint(broken as never, restored.schema)).rejects.toThrow()
  })
})
