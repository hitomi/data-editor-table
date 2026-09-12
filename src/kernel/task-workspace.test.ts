import { describe, expect, it, vi } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { deferred, SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId, type TaskId, type TaskOwner, type TaskResult } from './model.js'
import { prepareRowAction } from './prepare.js'
import { defineKernelSchema } from './schema.js'
import { fieldGeneration, taskInputRecords } from './task.js'
import { Workspace } from './workspace.js'
import { ResourceStore } from './resource-store.js'

let serial = 0
const fieldId = kernelId<'field'>('x')
async function setup() {
  const scope = { sourceId: `task-workspace:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0, hidden: 7 }, b: { x: 0 } })
  const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: fieldId, path: ['x'], readonly: false }] })
  const workspace = new Workspace({ scope, source, schema, policy: permissivePolicy })
  await workspace.refresh()
  const field = { entityId: workspace.getProjection().rows[0]!.entityId, fieldId }
  return { workspace, source, field }
}
async function open(workspace: Workspace) {
  const sessionId = kernelId<'session'>(`session:${++serial}`), field = { entityId: workspace.getProjection().rows[0]!.entityId, fieldId }
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId, inputId: kernelId<'input'>(`input:${serial}`), viewId: kernelId<'view'>('view'), target: { kind: 'cell', field }, input: { kind: 'encoded', value: 'file choice' }, reads: [] })
  return { kind: 'session' as const, sessionId, input: workspace.getState().session!.input }
}
function prepare(workspace: Workspace, taskId: TaskId, owner?: TaskOwner, entityId = workspace.getProjection().rows[0]!.entityId) {
  const fixture = new KernelFixture(undefined, workspace.schema); fixture.state = workspace.getState()
  const inputs = taskInputRecords(workspace.getState(), taskId, owner), sequence = ++serial
  return prepareRowAction(workspace.getState(), { action: { id: kernelId<'action'>(`task:${sequence}`), applicationId: kernelId<'application'>(`task:${sequence}`), label: 'Uploaded result', saveAtomicity: 'row' },
    cause: 'task', inputs, commands: [{ id: kernelId<'intent'>(`task:${sequence}`), command: fixture.write(entityId, { x: 8 }), inputs: inputs.map(input => input.ref), dependencies: [] }],
  }, workspace.schema)
}

describe('task execution publication barriers', () => {
  it('retains successful task output behind rejected editor input and retries delivery without rerunning I/O', async () => {
    const { workspace } = await setup(), owner = await open(workspace), started = deferred<void>(), done = deferred<TaskResult>()
    const execute = vi.fn(async () => { started.resolve(); return done.promise })
    const run = workspace.runTask({ owner, input: { kind: 'encoded', value: 'upload request' }, reads: [] }, execute)
    await started.promise
    const lease = workspace.getState().session!.editor!
    const input = workspace.typeInput(lease, { kind: 'resource', id: kernelId<'resource'>('missing') })
    expect(await input.completion).toMatchObject({ kind: 'completed', transition: { result: { kind: 'rejected' } } })
    done.resolve({ kind: 'session-candidate', sessionId: owner.sessionId, input: { kind: 'encoded', value: 'successful URL' } })
    await workspace.waitForTask(run.taskId)
    const pending = workspace.getIngress().pending.find(entry => entry.payload.kind === 'event' && entry.payload.event.kind === 'task-completed')!
    expect(pending).toMatchObject({ phase: 'blocked', payload: { event: { result: { input: { value: 'successful URL' } } } } })
    expect(workspace.getState().tasks[0]?.kind).toBe('running')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'file choice' })
    expect(workspace.getInputProjection(lease)?.input).toEqual({ kind: 'resource', id: 'missing' })
    await workspace.disposeIngress([input.id], workspace.getIngress().generation, 'discarded')
    expect(await workspace.retryIngress(pending.id, workspace.getIngress().generation).completion).toMatchObject({ kind: 'completed', transition: { result: { kind: 'accepted' } } })
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'successful URL' })
    expect(workspace.getState().tasks[0]?.kind).toBe('consumed')
    expect(workspace.getIngress().pending).toEqual([])
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('explicitly cancels a session together with its unpublished input and retained successful task result', async () => {
    const { workspace } = await setup(), owner = await open(workspace), started = deferred<void>(), done = deferred<TaskResult>()
    const run = workspace.runTask({ owner, input: { kind: 'encoded', value: 'upload' }, reads: [] }, async () => { started.resolve(); return done.promise })
    await started.promise
    const session = workspace.getState().session!
    workspace.typeInput(session.editor!, { kind: 'resource', id: kernelId<'resource'>('missing') })
    done.resolve({ kind: 'session-candidate', sessionId: owner.sessionId, input: { kind: 'encoded', value: 'retained success' } })
    await workspace.waitForTask(run.taskId)
    expect(workspace.getIngress().pending).toHaveLength(2)
    expect((await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })).kind).toBe('accepted')
    expect(workspace.getIngress().pending).toEqual([])
    expect(workspace.getState().tasks[0]?.kind).toBe('cancelled')
    expect(workspace.getState().session).toBeNull()
  })

  it('queues reentrant public commands and resolves them only after their actual acceptance', async () => {
    const { workspace } = await setup(), owner = await open(workspace), started = deferred<void>(), done = deferred<TaskResult>()
    let reentrant: ReturnType<Workspace['dispatch']> | undefined
    const run = workspace.runTask({ owner, input: { kind: 'encoded', value: 'upload' }, reads: [] }, async ({ signal }) => {
      signal.addEventListener('abort', () => { reentrant = workspace.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [], sort: [] }) })
      started.resolve(); return done.promise
    })
    await started.promise
    const session = workspace.getState().session!
    await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
    expect(await reentrant).toMatchObject({ kind: 'accepted' })
    done.resolve({ kind: 'session-candidate', sessionId: owner.sessionId, input: { kind: 'encoded', value: 'late' } })
    await workspace.waitForTask(run.taskId)
    expect(workspace.getState().view.version).toBe(1)
    expect(workspace.getIngress().pending).toEqual([])
  })

  it('blocks resource export when a rejected action refers to bytes that were never registered', async () => {
    const { workspace } = await setup(), fixture = new KernelFixture(undefined, workspace.schema)
    fixture.state = workspace.getState()
    const candidate = fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 1 })])
    const prepared = { ...candidate, inputs: candidate.inputs.map(record => ({ ...record, input: { kind: 'resource' as const, id: kernelId<'resource'>('unknown-bytes') } })) }
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared })).kind).toBe('rejected')
    expect(workspace.getState().inputs).toEqual([])
    await expect(workspace.exportResources()).rejects.toThrow('unavailable resource bytes')
  })

  it('owns real File input through task execution, exact save, history retention and resource-bundle recovery', async () => {
    const { workspace, source } = await setup()
    const input = await workspace.registerResource(new File(['file body'], 'upload.txt', { type: 'text/plain', lastModified: 123 }))
    const run = workspace.runTask({ owner: { kind: 'workspace', workspaceId: workspace.getState().workspace.id }, input, reads: [] }, async ({ taskId, input }) => {
      if (input.kind !== 'resource') throw new Error('Expected an owned File resource')
      const file = workspace.getResource(input.id) as File
      expect(file.name).toBe('upload.txt'); expect(file.lastModified).toBe(123); expect(await file.text()).toBe('file body')
      return { kind: 'action', action: prepare(workspace, taskId) }
    })
    expect((await workspace.waitForTask(run.taskId))?.kind).toBe('consumed')
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.requests).toHaveLength(1)
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('settled-intents')
    expect((await workspace.releaseResource(input.id)).kind).toBe('rejected')
    const state = workspace.getState(), bundle = await workspace.exportResources(), restored = await ResourceStore.restore(state, structuredClone(bundle))
    expect(bundle.contents).toHaveLength(1)
    expect((restored.get(input.id) as File).name).toBe('upload.txt')
    expect(await restored.get(input.id).text()).toBe('file body')
  })

  it('retains resource-valued blocked task results through cancellation and export', async () => {
    const { workspace } = await setup(), owner = await open(workspace)
    const output = await workspace.registerResource(new File(['converted content'], 'converted.txt', { type: 'text/plain', lastModified: 5 }))
    const run = workspace.runTask({ owner, input: { kind: 'encoded', value: 'conversion request' }, reads: [] }, () => ({ kind: 'session-candidate', sessionId: kernelId<'session'>('wrong-target'), input: output }))
    const task = (await workspace.waitForTask(run.taskId))!
    expect(task.kind).toBe('blocked')
    expect(workspace.getState().inputs.some(input => input.input.kind === 'resource')).toBe(false)
    expect((await workspace.releaseResource(output.id)).kind).toBe('rejected')
    await workspace.dispatch({ kind: 'task-cancelled', taskId: task.id, executionId: task.executionId })
    expect(workspace.getState().tasks[0]?.kind).toBe('cancelled')
    expect((await workspace.releaseResource(output.id)).kind).toBe('rejected')
    expect(await (await workspace.exportResources()).contents[0]!.blob.text()).toBe('converted content')
  })

  it('keeps rejected action resources pinned outside the input ledger, and explicitly releases unused staging', async () => {
    const { workspace } = await setup(), input = await workspace.registerResource(new Blob(['rejected original']))
    const fixture = new KernelFixture(undefined, workspace.schema); fixture.state = workspace.getState()
    const candidate = fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 1 })])
    const prepared = { ...candidate, inputs: candidate.inputs.map(record => ({ ...record, input })) }
    await workspace.refresh()
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared })).kind).toBe('rejected')
    expect(workspace.getState().inputs).toEqual([])
    expect((await workspace.releaseResource(input.id)).kind).toBe('rejected')
    expect(await (await workspace.exportResources()).contents[0]!.blob.text()).toBe('rejected original')
    const staging = await workspace.registerResource(new Blob(['unused']))
    expect((await workspace.releaseResource(staging.id)).kind).toBe('accepted')
    expect(() => workspace.getResource(staging.id)).toThrow('no longer available')
    expect((await workspace.exportResources()).contents.map(entry => entry.resourceId)).toEqual([input.id])
  })

  it('publishes registration and running before I/O, then publishes cancellation before Abort listeners and ignores late success', async () => {
    const { workspace, source } = await setup(), owner = await open(workspace)
    const started = deferred<void>(), outcome = deferred<TaskResult>(), aborted = vi.fn()
    const execute = vi.fn(async (context) => {
      expect(workspace.getState().tasks.find(task => task.id === context.taskId)?.kind).toBe('running')
      expect(workspace.getState().inputs.some(input => input.disposition.kind === 'task' && input.disposition.taskId === context.taskId)).toBe(true)
      context.signal.addEventListener('abort', () => {
        expect(workspace.getState().tasks.find(task => task.id === context.taskId)?.kind).toBe('cancelled')
        aborted()
      })
      started.resolve(); return outcome.promise
    })
    const run = workspace.runTask({ owner, input: { kind: 'encoded', value: 'upload body' }, reads: [] }, execute)
    expect(workspace.getState().tasks[0]?.kind).toBe('queued')
    expect((await run.result).kind).toBe('accepted')
    await started.promise
    const session = workspace.getState().session!
    await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
    expect(aborted).toHaveBeenCalledTimes(1)
    outcome.resolve({ kind: 'session-candidate', sessionId: owner.sessionId, input: { kind: 'encoded', value: 'late URL' } })
    expect((await workspace.waitForTask(run.taskId))?.kind).toBe('cancelled')
    expect(workspace.getState().session).toBeNull()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(source.requests).toEqual([])
  })

  it('does not execute a queued task cancelled before its microtask starts', async () => {
    const { workspace } = await setup(), execute = vi.fn((): TaskResult => { throw new Error('Should never execute') })
    const run = workspace.runTask({ owner: { kind: 'workspace', workspaceId: workspace.getState().workspace.id }, input: { kind: 'encoded', value: 'raw' }, reads: [] }, execute)
    const task = workspace.getState().tasks[0]!
    await workspace.dispatch({ kind: 'task-cancelled', taskId: run.taskId, executionId: task.executionId })
    expect((await workspace.waitForTask(run.taskId))?.kind).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('cancelled-task')
  })

  it('retains a result after input supersedes an upload and reuses that result without another executor call', async () => {
    const { workspace } = await setup(), owner = await open(workspace), started = deferred<void>(), outcome = deferred<TaskResult>()
    const execute = vi.fn(async () => { started.resolve(); return outcome.promise })
    const run = workspace.runTask({ owner, input: { kind: 'encoded', value: 'upload once' }, reads: [] }, execute)
    await started.promise
    const session = workspace.getState().session!
    await workspace.dispatch({ kind: 'session-input', lease: session.editor!, inputVersion: session.input.version, input: { kind: 'encoded', value: 'new user text' }, composition: 'idle' })
    outcome.resolve({ kind: 'session-candidate', sessionId: session.id, input: { kind: 'encoded', value: 'saved URL' } })
    const retained = (await workspace.waitForTask(run.taskId))!
    expect(retained.kind).toBe('superseded')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'new user text' })
    const current = workspace.getState().session!
    expect((await workspace.dispatch({ kind: 'task-reapply', taskId: retained.id, executionId: retained.executionId, revision: workspace.getState().revision,
      owner: { kind: 'session', sessionId: current.id, input: current.input } })).kind).toBe('accepted')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'saved URL' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('allows refresh during execution and saves a complete task action through the persistence gateway', async () => {
    const { workspace, source, field } = await setup(), started = deferred<void>(), outcome = deferred<void>()
    const execute = vi.fn(async ({ taskId }: { taskId: TaskId }): Promise<TaskResult> => {
      // This proposal precedes an unrelated read; completion revalidates its
      // stored declarations and retains the newer hidden field.
      const action = prepare(workspace, taskId)
      started.resolve(); await outcome.promise; return { kind: 'action', action }
    })
    const run = workspace.runTask({ owner: { kind: 'field', field, generation: fieldGeneration(workspace.getState(), field) }, input: { kind: 'encoded', value: 'upload' }, reads: [] }, execute)
    await started.promise
    source.external({ a: { x: 0, hidden: 11 }, b: { x: 5 } }); await workspace.refresh()
    expect(workspace.getState().tasks[0]?.kind).toBe('running')
    outcome.resolve()
    expect((await workspace.waitForTask(run.taskId))?.kind).toBe('consumed')
    expect(workspace.getProjection().rows[0]?.preview).toEqual({ x: 8, hidden: 11 })
    expect((await workspace.save()).kind).toBe('committed')
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('settled-intents')
    expect(source.requests).toHaveLength(1)
    expect(source.writes).toBe(1)
    expect([...source.rows.values()].map(row => row.document)).toEqual([{ x: 8, hidden: 11 }, { x: 5 }])
    expect(workspace.getState().inputs[0]?.input).toEqual({ kind: 'encoded', value: 'upload' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('retains a permission-blocked result and saves it after explicit consumption without repeating I/O', async () => {
    const { workspace, source, field } = await setup(), started = deferred<void>(), outcome = deferred<void>(), policy = workspace.getState().policy
    const execute = vi.fn(async ({ taskId }: { taskId: TaskId }): Promise<TaskResult> => { const action = prepare(workspace, taskId); started.resolve(); await outcome.promise; return { kind: 'action', action } })
    const run = workspace.runTask({ owner: { kind: 'field', field, generation: 0 }, input: { kind: 'encoded', value: 'file' }, reads: [] }, execute)
    await started.promise
    await workspace.dispatch({ kind: 'policy-observed', policy: { ...policy, version: kernelId<'policy-version'>('revoked'), defaultEntity: { ...policy.defaultEntity, write: false } } })
    outcome.resolve()
    const task = (await workspace.waitForTask(run.taskId))!
    expect(task.kind).toBe('blocked')
    expect(workspace.getProjection().changes).toEqual([])
    expect(source.requests).toEqual([])
    expect(source.writes).toBe(0)
    expect([...source.rows.values()].map(row => row.document)).toEqual([{ x: 0, hidden: 7 }, { x: 0 }])
    const originalResult = JSON.stringify(task), originalInput = workspace.getState().inputs[0]!
    expect(originalInput).toMatchObject({ input: { kind: 'encoded', value: 'file' }, disposition: { kind: 'task', taskId: task.id } })
    expect((await workspace.dispatch({ kind: 'task-consume', taskId: task.id, executionId: task.executionId })).kind).toBe('rejected')
    expect(JSON.stringify(workspace.getState().tasks[0])).toBe(originalResult)
    expect(workspace.getState().journal.intents).toEqual([])
    expect(workspace.getState().inputs[0]).toEqual(originalInput)
    await workspace.dispatch({ kind: 'policy-observed', policy })
    expect(workspace.getState().journal.intents).toEqual([])
    expect(workspace.getState().tasks[0]?.kind).toBe('blocked')
    expect((await workspace.dispatch({ kind: 'task-consume', taskId: task.id, executionId: task.executionId })).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(source.requests).toHaveLength(1)
    expect(source.writes).toBe(1)
    expect([...source.rows.values()].map(row => row.document)).toEqual([{ x: 8, hidden: 7 }, { x: 0 }])
    expect(workspace.getState().inputs[0]).toMatchObject({ input: originalInput.input, disposition: { kind: 'settled-intents' } })
  })

  it('records execution failure with owned input, and rejects public attempts to inject task completions', async () => {
    const { workspace } = await setup()
    const run = workspace.runTask({ owner: { kind: 'workspace', workspaceId: workspace.getState().workspace.id }, input: { kind: 'encoded', value: 'recoverable input' }, reads: [] }, () => { throw new Error('Upload failed') })
    const task = (await workspace.waitForTask(run.taskId))!
    expect(task).toMatchObject({ kind: 'failed', issue: { message: 'Upload failed' } })
    expect(workspace.getState().inputs[0]).toMatchObject({ input: { value: 'recoverable input' }, disposition: { kind: 'task' } })
    const before = workspace.getState()
    // @ts-expect-error Transport events are not public Workspace commands.
    expect((await workspace.dispatch({ kind: 'task-started', taskId: task.id, executionId: task.executionId })).kind).toBe('rejected')
    expect(workspace.getState()).toBe(before)
  })
})

it('retains a changed-target result until a fresh reviewed reapplication saves only the new owner', async () => {
  const { workspace, source, field } = await setup(), started = deferred<void>(), outcome = deferred<void>()
  const owner = { kind: 'field' as const, field, generation: fieldGeneration(workspace.getState(), field) }
  const execute = vi.fn(async ({ taskId }: { taskId: TaskId }): Promise<TaskResult> => {
    const action = prepare(workspace, taskId); started.resolve(); await outcome.promise
    return { kind: 'action', action }
  })
  const run = workspace.runTask({ owner, input: { kind: 'encoded', value: 'original conversion request 原文' }, reads: [] }, execute)
  await started.promise
  source.external({ a: { x: 2, hidden: 9 }, b: { x: 0 } }); await workspace.refresh()
  outcome.resolve()
  const task = (await workspace.waitForTask(run.taskId))!, originalResult = JSON.stringify('result' in task ? task.result : null)
  expect(task.kind).toBe('blocked')
  expect(workspace.getProjection().changes).toEqual([])
  const input = workspace.getState().inputs.find(record => record.ref.id === task.input.id)!
  expect(input).toMatchObject({ input: { kind: 'encoded', value: 'original conversion request 原文' }, disposition: { kind: 'task', taskId: task.id } })
  const newField = { entityId: workspace.getProjection().rows[1]!.entityId, fieldId }
  const newOwner = { kind: 'field' as const, field: newField, generation: fieldGeneration(workspace.getState(), newField) }
  const prepared = prepare(workspace, task.id, newOwner, newField.entityId)
  expect((await workspace.dispatch({ kind: 'task-reapply', taskId: task.id, executionId: task.executionId,
    revision: workspace.getState().revision - 1, owner: newOwner, prepared })).kind).toBe('rejected')
  expect(workspace.getState().journal.intents).toEqual([])
  expect(workspace.getState().inputs.find(record => record.ref.id === task.input.id)).toEqual(input)
  expect(source.writes).toBe(0); expect(source.requests).toEqual([])
  expect((await workspace.dispatch({ kind: 'task-reapply', taskId: task.id, executionId: task.executionId,
    revision: workspace.getState().revision, owner: newOwner, prepared })).kind).toBe('accepted')
  expect((await workspace.save()).kind).toBe('committed')
  expect([...source.rows.values()].map(row => row.document)).toEqual([{ x: 2, hidden: 9 }, { x: 8 }])
  expect(source.writes).toBe(1); expect(source.requests).toHaveLength(1)
  expect(source.requests[0]!.items).toHaveLength(1)
  expect(source.requests[0]!.items[0]).toMatchObject({ kind: 'update', entityId: newField.entityId, before: { x: 0 }, after: { x: 8 } })
  const consumed = workspace.getState().tasks[0]!
  expect(consumed).toMatchObject({ kind: 'consumed', owner: task.owner, input: task.input })
  expect(JSON.stringify('result' in consumed ? consumed.result : null)).toBe(originalResult)
  expect(workspace.getState().inputs.find(record => record.ref.id === task.input.id)).toMatchObject({ input: input.input, disposition: { kind: 'settled-intents' } })
  expect(execute).toHaveBeenCalledTimes(1)
})
