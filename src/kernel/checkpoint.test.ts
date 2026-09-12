import { describe, expect, it } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { DurableTaskFixture } from '../../tests/kernel/durable-task-fixture.js'
import { kernelId, type TaskResult } from './model.js'
import { Workspace } from './workspace.js'
import { createWorkspaceCheckpoint, validateWorkspaceCheckpoint, type WorkspaceCheckpoint } from './checkpoint.js'

let serial = 0
async function setup(durable = true) {
  const scope = { sourceId: `checkpoint:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0, hidden: 7 } }), service = new DurableTaskFixture()
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy, tasks: [service.definition] }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`workspace:${serial}`), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = durable ? await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false }) : new Workspace(options)
  await workspace.refresh()
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('filter'), inputId: kernelId<'input'>('filter'),
    viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'original' }, reads: [] })
  return { workspace, storage, service, source }
}

describe('complete checkpoint capture and validation', () => {
  it('rejects the previous checkpoint format without changing retained input or the current checkpoint', async () => {
    const { workspace } = await setup(false), state = workspace.getState()
    const checkpoint = await workspace.exportCheckpoint()
    expect(checkpoint.metadata.format).toBe(2)
    const old = { ...checkpoint, metadata: { ...checkpoint.metadata, format: 1 } } as unknown as WorkspaceCheckpoint
    await expect(validateWorkspaceCheckpoint(old, workspace.schema)).rejects.toThrow('Checkpoint ticket')
    expect(workspace.getState()).toBe(state)
    expect((await validateWorkspaceCheckpoint(checkpoint, workspace.schema)).metadata.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
  })
  it('exports rejected File registration with the unchanged semantic root, ingress and exact original bytes', async () => {
    const { workspace, storage } = await setup()
    storage.rejectNext = true
    await expect(workspace.registerResource(new File(['body'], 'retained.txt', { lastModified: 17 }))).rejects.toThrow()
    const state = workspace.getState(), checkpoint = await workspace.exportCheckpoint()
    const imported = await validateWorkspaceCheckpoint(checkpoint, workspace.schema)
    expect(imported.metadata.state).toEqual(state)
    expect(state.resources).toEqual([])
    const entry = imported.metadata.ingress.snapshot.pending[0]!
    if (entry.payload.kind !== 'event' || entry.payload.event.kind !== 'resource-registered') throw new Error('Expected original resource registration')
    const file = imported.resources.get(entry.payload.event.descriptor.id) as File
    expect(await file.text()).toBe('body'); expect(file.name).toBe('retained.txt'); expect(file.lastModified).toBe(17)
    expect(checkpoint.metadata.storage).toMatchObject({ kind: 'durable', record: { transition: { state } }, pending: null })
    expect(workspace.getState()).toBe(state)
  })

  it('captures unknown input with its original storage token and leaves subsequent typing outside the fixed checkpoint', async () => {
    const { workspace, storage, source } = await setup(), lease = workspace.getState().session!.editor!
    storage.loseResponse = true
    const first = workspace.typeInput(lease, { kind: 'encoded', value: 'unknown commit' })
    await first.completion
    const exporting = workspace.exportCheckpoint()
    const later = workspace.typeInput(lease, { kind: 'encoded', value: 'later input' })
    const checkpoint = await exporting
    expect(checkpoint.metadata.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(checkpoint.metadata.ingress.snapshot.pending).toHaveLength(1)
    expect(checkpoint.metadata.ingress.snapshot.pending[0]?.id).toBe(first.id)
    expect(checkpoint.metadata.storage).toMatchObject({ kind: 'durable', pending: { transition: { state: { session: { rawInput: { value: 'unknown commit' } } } } } })
    for (const disposition of ['retain', 'clean-close', 'checkpoint-close', 'discard'] as const)
      expect(await workspace.close(checkpoint.metadata.ticket, disposition)).toMatchObject({ kind: 'blocked', reason: 'stale' })
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect(workspace.getInputProjection(lease)?.input).toEqual({ kind: 'encoded', value: 'later input' })
    expect(storage.checkpointWrites).toEqual([]); expect(source.requests).toEqual([])
    await workspace.reconcileStorage(); await later.completion
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'later input' })
    expect((await validateWorkspaceCheckpoint(checkpoint, workspace.schema)).metadata.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
  })

  it('binds a compiled durable task registration to its raw ingress candidate without starting the external action', async () => {
    const { workspace, storage, service } = await setup(), session = workspace.getState().session!
    storage.loseResponse = true
    const task = workspace.runDurableTask({ definition: service.definition.ref, owner: { kind: 'session', sessionId: session.id, input: session.input }, input: { kind: 'encoded', value: 'task' }, reads: [] })
    expect((await task.result).kind).toBe('unresolved')
    const checkpoint = await workspace.exportCheckpoint()
    expect(checkpoint.metadata.storage).toMatchObject({ kind: 'durable', pending: { event: { kind: 'task-registered', execution: { ref: { taskId: task.taskId } } } } })
    expect(service.requests).toEqual([])
  })

  it('rejects mismatched components even if a new outer digest is generated', async () => {
    const { workspace, storage } = await setup()
    storage.loseResponse = true
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'original attempt' }).completion
    const checkpoint = await workspace.exportCheckpoint(), { metadata } = checkpoint
    const ingress = structuredClone(metadata.ingress)
    const pending = ingress.snapshot.pending[0]!
    if (pending.phase !== 'uncertain' || pending.event.kind !== 'session-input') throw new Error('Expected uncertain input')
    const forged = { ...ingress, snapshot: { ...ingress.snapshot, pending: [{ ...pending, event: { ...pending.event, input: { kind: 'encoded' as const, value: 'forged attempt' } } }] } }
    await expect(createWorkspaceCheckpoint({ state: metadata.state, ticket: metadata.ticket, ingress: forged, storage: metadata.storage, reservation: metadata.reservation },
      Promise.resolve({ format: 1, retired: metadata.resources.retired, bundle: { manifest: metadata.resources.manifest, contents: checkpoint.contents } }), workspace.schema)).rejects.toThrow('exact ingress attempt')
    await expect(validateWorkspaceCheckpoint({ ...checkpoint, sha256: 'sha256:wrong' }, workspace.schema)).rejects.toThrow('digest')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
  })

  it('blocks exporting a live storage write until its outcome is represented', async () => {
    const { workspace, storage } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise }
    const typing = workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'typing' })
    await entered.promise
    await expect(workspace.exportCheckpoint()).rejects.toThrow('storage preparation/publication')
    gate.resolve(); await typing.completion
    expect((await workspace.exportCheckpoint()).metadata.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'typing' })
  })

  it('blocks live memory callbacks and missing raw resource bytes instead of claiming an executable checkpoint', async () => {
    const { workspace } = await setup(false), session = workspace.getState().session!, gate = deferred<TaskResult>(), entered = deferred<void>()
    const task = workspace.runTask({ owner: { kind: 'session', sessionId: session.id, input: session.input }, input: { kind: 'encoded', value: 'work' }, reads: [] }, async () => { entered.resolve(); return gate.promise })
    await entered.promise
    await expect(workspace.exportCheckpoint()).rejects.toThrow('memory task callback')
    gate.resolve({ kind: 'session-candidate', sessionId: session.id, input: { kind: 'encoded', value: 'finished' } }); await workspace.waitForTask(task.taskId)
    expect((await workspace.exportCheckpoint()).metadata.state.tasks[0]?.kind).toBe('consumed')
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'resource', id: kernelId<'resource'>('missing') }).completion
    await expect(workspace.exportCheckpoint()).rejects.toThrow('unavailable checkpoint bytes')
  })

  it('exports a frozen source request with its original operation hash and complete authored input', async () => {
    const { workspace, source } = await setup(false), fixture = new KernelFixture()
    fixture.state = workspace.getState()
    const prepared = fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 1 })])
    await workspace.dispatch({ kind: 'prepared-action', prepared })
    source.submitHook = async (_request, execute) => { execute(); throw new Error('response lost') }
    expect((await workspace.save()).kind).toBe('unresolved')
    const checkpoint = await workspace.exportCheckpoint()
    expect(checkpoint.metadata.reservation).toEqual({ kind: 'submission', submission: source.requests[0] })
    expect(checkpoint.metadata.state.inputs.some(input => input.disposition.kind === 'intents')).toBe(true)
    expect(source.requests).toHaveLength(1)
  })
})
