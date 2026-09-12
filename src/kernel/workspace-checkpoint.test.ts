import { describe, expect, it } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { deferred, SourceFixture } from '../../tests/kernel/source-fixture.js'
import { DurableTaskFixture } from '../../tests/kernel/durable-task-fixture.js'
import { kernelId } from './model.js'
import { Workspace } from './workspace.js'

let serial = 0
async function setup(editor = true) {
  const scope = { sourceId: `workspace-checkpoint:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0 } }), service = new DurableTaskFixture()
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy, tasks: [service.definition] }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`workspace:${serial}`), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })
  await workspace.refresh()
  if (editor) await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('editor'), inputId: kernelId<'input'>('input'),
    viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'original' }, reads: [] })
  const restore = () => Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  return { workspace, storage, source, service, options, restore }
}

describe('full checkpoint activation in Workspace', () => {
  it('retains an unavailable task definition through checkpoint export and later recovers with the exact definition', async () => {
    const { workspace, storage, options, service, source } = await setup()
    service.loseResponse = true
    const owner = workspace.getState().session!
    const task = workspace.runDurableTask({ definition: service.definition.ref, owner: { kind: 'session', sessionId: owner.id, input: owner.input },
      input: { kind: 'encoded', value: '保留的任务原文' }, reads: [] })
    expect((await task.result).kind).toBe('accepted'); await workspace.waitForTask(task.taskId)
    const checkpoint = await workspace.exportCheckpoint(), original = JSON.stringify(checkpoint.metadata)
    const restored = await Workspace.openCheckpoint({ ...options, tasks: [], checkpoint, session: storage.acquire(), recovery: 'manual' })
    const inputs = restored.getState().inputs, result = await restored.recoverPendingWork()
    expect(result.outcomes.find(outcome => outcome.candidate.kind === 'task')?.result).toMatchObject({ kind: 'rejected', issue: { code: 'recovery-definition-missing' } })
    expect(restored.getState().inputs).toEqual(inputs)
    expect(restored.getState().tasks.find(entry => entry.id === task.taskId)?.kind).not.toBe('consumed')
    expect(service.lookups).toHaveLength(0); expect(service.executions).toBe(1)
    expect(JSON.stringify(checkpoint.metadata)).toBe(original)
    const retained = await restored.exportCheckpoint()
    const available = await Workspace.openCheckpoint({ ...options, checkpoint: retained, session: storage.acquire(), recovery: 'manual' })
    expect((await available.recoverPendingWork()).kind).toBe('completed')
    expect(available.getState().tasks.find(entry => entry.id === task.taskId)?.kind).toBe('consumed')
    expect(available.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 })
    expect(service.lookups).toHaveLength(1); expect(service.executions).toBe(1); expect(service.requests).toHaveLength(1)
    expect(source.writes).toBe(0)
  })

  it('recovers one file-task execution through competing checkpoint owners without losing its original bytes', async () => {
    const { workspace, storage, options, service, source, restore } = await setup()
    const bytes = new Uint8Array([0, 255, 17, 128]), file = await workspace.registerResource(new File([bytes], '原始输入.bin', { lastModified: 71 }))
    const sessionOwner = workspace.getState().session!
    service.loseResponse = true
    const task = workspace.runDurableTask({ definition: service.definition.ref,
      owner: { kind: 'session', sessionId: sessionOwner.id, input: sessionOwner.input }, input: file, reads: [] })
    expect((await task.result).kind).toBe('accepted'); await workspace.waitForTask(task.taskId)
    const checkpoint = await workspace.exportCheckpoint(), request = JSON.stringify(service.requests[0])
    expect(service.executions).toBe(1)
    const entered = deferred<void>(), gate = deferred<void>(), session = storage.acquire()
    const first = Workspace.openCheckpoint({ ...options, checkpoint, recovery: 'lookup', session: { ...session,
      load: async () => { entered.resolve(); await gate.promise; return session.load() },
    } }).then(value => ({ value }), error => ({ error }))
    await entered.promise
    const winner = await Workspace.openCheckpoint({ ...options, checkpoint, recovery: 'lookup', session: storage.acquire() })
    gate.resolve(); expect(await first).toMatchObject({ error: expect.any(Error) })
    expect((await winner.recoverPendingWork()).kind).toBe('completed')
    const consumed = winner.getState().tasks.find(entry => entry.id === task.taskId)!
    expect(consumed).toMatchObject({ kind: 'consumed', execution: { outcome: { kind: 'succeeded' } } })
    expect(winner.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 })
    expect(service.requests).toHaveLength(1); expect(service.lookups).toEqual(service.requests); expect(service.executions).toBe(1)
    expect(JSON.stringify(service.requests[0])).toBe(request)
    const originalInputs = checkpoint.metadata.state.inputs.map(({ ref, input }) => ({ ref, input }))
    expect(winner.getState().inputs.map(({ ref, input }) => ({ ref, input }))).toEqual(expect.arrayContaining(originalInputs))
    const reopened = await restore()
    expect(reopened.getState().tasks.find(entry => entry.id === task.taskId)).toEqual(consumed)
    expect(reopened.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 })
    const retained = reopened.getResource(file.id) as File
    expect(retained.name).toBe('原始输入.bin'); expect(retained.lastModified).toBe(71)
    expect(new Uint8Array(await retained.arrayBuffer())).toEqual(bytes)
    expect(reopened.getState().inputs.map(({ ref, input }) => ({ ref, input }))).toEqual(expect.arrayContaining(originalInputs))
    expect(source.requests).toEqual([]); expect(source.writes).toBe(0)
    expect(source.snapshot().rows.map(row => row.document)).toEqual([{ x: 0 }])
    expect(service.requests).toHaveLength(1); expect(service.executions).toBe(1)
  })

  it('activates only the surviving lease when two owners restore the same unknown-save checkpoint', async () => {
    const { workspace, storage, options, source, restore } = await setup(false), fixture = new KernelFixture()
    fixture.state = workspace.getState()
    const prepared = fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 1 })])
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared })).kind).toBe('accepted')
    source.normalize = document => ({ ...document, x: 1.5, hidden: 'canonical' })
    source.submitHook = async (_request, execute) => { execute(); throw new Error('Lost source response') }
    expect((await workspace.save()).kind).toBe('unresolved')
    const checkpoint = await workspace.exportCheckpoint(), request = JSON.stringify(source.requests[0])
    const entered = deferred<void>(), gate = deferred<void>(), session = storage.acquire()
    const first = Workspace.openCheckpoint({ ...options, checkpoint, recovery: 'lookup', session: { ...session,
      load: async () => { entered.resolve(); await gate.promise; return session.load() },
    } }).then(value => ({ value }), error => ({ error }))
    await entered.promise
    const winner = await Workspace.openCheckpoint({ ...options, checkpoint, recovery: 'lookup', session: storage.acquire() })
    gate.resolve()
    expect(await first).toMatchObject({ error: expect.any(Error) })
    expect(workspace.getStorageStatus()?.kind).toBe('fenced')
    expect((await winner.recoverPendingWork()).kind).toBe('completed')
    expect(winner.getState().persistence.kind).toBe('idle')
    expect(winner.getProjection().rows[0]!.preview).toEqual({ x: 1.5, hidden: 'canonical' })
    expect(winner.getState().journal).toEqual(checkpoint.metadata.state.journal)
    expect(winner.getState().inputs.map(({ ref, input }) => ({ ref, input }))).toEqual(checkpoint.metadata.state.inputs.map(({ ref, input }) => ({ ref, input })))
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1); expect(source.lookups).toBe(1)
    expect(JSON.stringify(source.requests[0])).toBe(request)
    const reopened = await restore()
    expect(reopened.getProjection().rows[0]!.preview).toEqual({ x: 1.5, hidden: 'canonical' })
    expect(source.snapshot().rows.map(row => row.document)).toEqual([{ x: 1.5, hidden: 'canonical' }])
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
  })

  for (const editor of [true, false]) it(`installs previously unpersisted ingress and File bytes ${editor ? 'with an editor detach' : 'without an editor'} before ordinary reload`, async () => {
    const { workspace, storage, options, restore } = await setup(editor)
    storage.rejectNext = true
    await expect(workspace.registerResource(new File(['checkpoint input'], 'retained.txt', { lastModified: 71 }))).rejects.toThrow()
    const checkpoint = await workspace.exportCheckpoint(), pending = checkpoint.metadata.ingress.snapshot.pending[0]!
    expect(storage.root!.record.ingress!.snapshot.pending).toEqual([])
    const imported = await Workspace.openCheckpoint({ ...options, session: storage.acquire(), checkpoint })
    expect(imported.getRuntimeIssue()).toBeNull()
    expect(imported.getIngress().pending[0]).toEqual(pending)
    expect(imported.getState().session?.editor ?? null).toBeNull()
    expect(storage.root!.record.event.kind).toBe(editor ? 'session-detached' : 'ingress-checkpointed')
    const reopened = await restore()
    expect(reopened.getIngress().pending[0]).toEqual(pending)
    expect((await reopened.retryIngress(pending.id, reopened.getIngress().generation).completion).kind).toBe('completed')
    if (pending.payload.kind !== 'event' || pending.payload.event.kind !== 'resource-registered') throw new Error('Expected File registration')
    const file = reopened.getResource(pending.payload.event.descriptor.id) as File
    expect(await file.text()).toBe('checkpoint input'); expect(file.name).toBe('retained.txt'); expect(file.lastModified).toBe(71)
  })

  for (const committed of [true, false]) it(`coordinates an original uncertain input as ${committed ? 'committed' : 'not committed'} before detaching its editor`, async () => {
    const { workspace, storage, options, source } = await setup(), lease = workspace.getState().session!.editor!
    storage.loseResponse = true; storage.rejectNext = !committed
    const input = workspace.typeInput(lease, { kind: 'encoded', value: 'retained input' }); await input.completion
    const checkpoint = await workspace.exportCheckpoint()
    const imported = await Workspace.openCheckpoint({ ...options, session: storage.acquire(), checkpoint })
    expect(imported.getState().session?.editor).toBeNull()
    expect(imported.getState().session?.rawInput).toEqual({ kind: 'encoded', value: committed ? 'retained input' : 'original' })
    expect(storage.queries).toHaveLength(1)
    if (checkpoint.metadata.storage.kind !== 'durable') throw new Error('Expected durable checkpoint')
    expect(storage.queries[0]).toEqual(checkpoint.metadata.storage.pending!.commit)
    if (committed) expect(imported.getIngress().receipts.find(receipt => receipt.id === input.id)?.disposition).toBe('accepted')
    else expect(imported.getIngress().pending).toMatchObject([{ id: input.id, phase: 'rejected' }])
    expect(source.writes).toBe(0)
  })

  it('restores a durably registered task without replaying its start effect', async () => {
    const { workspace, storage, options, service } = await setup(), session = workspace.getState().session!
    storage.loseResponse = true
    const task = workspace.runDurableTask({ definition: service.definition.ref, owner: { kind: 'session', sessionId: session.id, input: session.input }, input: { kind: 'encoded', value: 'task input' }, reads: [] })
    expect((await task.result).kind).toBe('unresolved')
    const checkpoint = await workspace.exportCheckpoint()
    const imported = await Workspace.openCheckpoint({ ...options, session: storage.acquire(), checkpoint })
    expect(imported.getState().tasks[0]).toMatchObject({ id: task.taskId, kind: 'queued' })
    expect(service.requests).toEqual([]); expect(service.lookups).toEqual([])
    await imported.recoverTask(task.taskId)
    expect(service.requests).toEqual([]); expect(service.lookups).toHaveLength(1)
  })

  it('leaves an inconclusive original storage lookup unactivated and permits another lookup without rewriting the candidate', async () => {
    const { workspace, storage, options, service, source } = await setup()
    storage.loseResponse = true
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'unknown' }).completion
    const checkpoint = await workspace.exportCheckpoint(), session = storage.acquire(), count = storage.writes.length
    storage.corruptResponse = result => ({ kind: 'unknown', commit: result.commit, issue: { code: 'offline', message: 'Lookup unavailable' } })
    await expect(Workspace.openCheckpoint({ ...options, session, checkpoint })).rejects.toThrow('waiting for the original storage outcome')
    expect(storage.writes).toHaveLength(count); expect(source.writes).toBe(0); expect(service.requests).toEqual([])
    storage.corruptResponse = null
    const imported = await Workspace.openCheckpoint({ ...options, session, checkpoint })
    expect(imported.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'unknown' })
    expect(storage.queries[1]).toEqual(storage.queries[0])
  })

  it('does not invent a submitted operation when the original uncertain freeze is proved not committed', async () => {
    const { workspace, storage, options, source } = await setup(false), fixture = new KernelFixture()
    fixture.state = workspace.getState()
    const prepared = fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 3 })])
    await workspace.dispatch({ kind: 'prepared-action', prepared })
    storage.beforeCommit = async write => {
      if (write.record.event.kind === 'freeze-submission') { storage.rejectNext = true; storage.loseResponse = true }
    }
    expect((await workspace.save()).kind).toBe('blocked')
    storage.beforeCommit = null
    const checkpoint = await workspace.exportCheckpoint()
    const imported = await Workspace.openCheckpoint({ ...options, session: storage.acquire(), checkpoint })
    expect(imported.getRecoveryPlan().candidates.some(candidate => candidate.kind === 'submission')).toBe(false)
    expect((await imported.recover()).kind).toBe('not-started')
    expect(source.writes).toBe(0); expect(source.lookups).toBe(0)
    expect((await imported.save()).kind).toBe('committed')
    expect(source.writes).toBe(1)
  })

  it('retains a failed installation attempt in the returned runtime instead of claiming its checkpoint is persisted', async () => {
    const { workspace, storage, options, restore } = await setup(false)
    await workspace.dispatch({ kind: 'view-query-set', expectedVersion: -1, filters: [], sort: [] })
    const checkpoint = await workspace.exportCheckpoint()
    storage.rejectNext = true
    const imported = await Workspace.openCheckpoint({ ...options, session: storage.acquire(), checkpoint })
    expect(imported.getRuntimeIssue()).not.toBeNull()
    expect(imported.getIngress().pending).toHaveLength(2)
    const install = imported.getIngress().pending.find(entry => entry.payload.kind === 'event' && entry.payload.event.kind === 'ingress-checkpointed')!
    expect(install.phase).toBe('rejected')
    await imported.retryIngress(install.id, imported.getIngress().generation).completion
    expect((await restore()).getIngress().pending).toEqual(checkpoint.metadata.ingress.snapshot.pending)
  })

  it('recovers the original saved operation without rolling back an edit authored after checkpoint import', async () => {
    const { workspace, storage, options, source, restore } = await setup(false), fixture = new KernelFixture()
    const edit = async (target: Workspace, value: number) => {
      fixture.state = target.getState()
      const prepared = fixture.prepare([fixture.write(target.getProjection().rows[0]!.entityId, { x: value })])
      expect((await target.dispatch({ kind: 'prepared-action', prepared })).kind).toBe('accepted')
      return prepared
    }
    await edit(workspace, 1)
    source.normalize = document => ({ ...document, canonical: true })
    source.submitHook = async (_request, execute) => { execute(); throw new Error('Response lost after commit') }
    expect((await workspace.save()).kind).toBe('unresolved')
    const checkpoint = await workspace.exportCheckpoint(), original = source.requests[0]!
    const imported = await Workspace.openCheckpoint({ ...options, session: storage.acquire(), checkpoint })
    expect(source.lookups).toBe(0)
    await edit(imported, 2)
    expect((await imported.recover()).kind).toBe('committed')
    expect(source.writes).toBe(1); expect(source.requests).toEqual([original])
    expect(imported.getProjection().rows[0]!.preview).toEqual({ x: 2, canonical: true })
    source.submitHook = null
    expect((await imported.save()).kind).toBe('committed')
    expect(source.writes).toBe(2)
    const reopened = await restore()
    expect(reopened.getProjection().rows[0]!.preview).toEqual({ x: 2, canonical: true })
    expect(reopened.getProjection().changes).toEqual([])
  })
})
