import { describe, expect, it } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { DurableTaskFixture } from '../../tests/kernel/durable-task-fixture.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { deferred, SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId, type DurableTaskOutcome, type TaskId } from './model.js'
import { Workspace } from './workspace.js'
import { defineKernelSchema } from './schema.js'
import { prepareRowAction } from './prepare.js'
import type { DurableTaskDefinition } from './durable-task.js'
import { fieldGeneration, taskInputRecords } from './task.js'
import { reduceKernel } from './transition.js'

let serial = 0
async function setup(definition?: DurableTaskDefinition, validate: typeof permissiveSchema.validate = permissiveSchema.validate, restoreDeleted = false) {
  const scope = { sourceId: `durable-task:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { value: 0, hidden: 7 } }, restoreDeleted), service = new DurableTaskFixture()
  const schema = defineKernelSchema({ ...permissiveSchema, validate, fields: [{ id: kernelId<'field'>('value'), path: ['value'], readonly: false }] })
  const options = { scope, source, schema, policy: permissivePolicy, tasks: [definition ?? service.definition] }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`workspace:${serial}`), scope, schema: schema.version, codec: schema.codec })
  const workspace = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })
  await workspace.refresh()
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('editor'), inputId: kernelId<'input'>('editor'), viewId: kernelId<'view'>('view'),
    target: { kind: 'cell', field: { entityId: workspace.getProjection().rows[0]!.entityId, fieldId: kernelId<'field'>('value') } }, input: { kind: 'encoded', value: 'original' }, reads: [] })
  const owner = { kind: 'session' as const, sessionId: workspace.getState().session!.id, input: workspace.getState().session!.input }
  return { workspace, options, storage, source, service, owner }
}
function run(workspace: Workspace, owner: Awaited<ReturnType<typeof setup>>['owner']) {
  return workspace.runDurableTask({ definition: { id: 'upload', version: 'v1' }, owner, input: { kind: 'encoded', value: 'original task request' }, reads: [] })
}
const task = (workspace: Workspace, id: TaskId) => workspace.getState().tasks.find(task => task.id === id)!

describe('durable task execution and recovery', () => {
  it('does not start external work when session cancellation queues behind pending durable registration', async () => {
    const { workspace, owner, service, storage } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async write => { if (write.record.event.kind === 'task-registered') { entered.resolve(); await gate.promise } }
    const execution = run(workspace, owner); await entered.promise
    const session = workspace.getState().session!
    const cancelling = workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
    gate.resolve()
    expect((await execution.result).kind).toBe('accepted'); expect((await cancelling).kind).toBe('accepted')
    await workspace.waitForTask(execution.taskId)
    expect(task(workspace, execution.taskId).kind).toBe('cancelled'); expect(service.requests).toEqual([])
  })

  it('owns and pins a file registration in ingress before asynchronous request hashing starts', async () => {
    const { workspace, owner, service } = await setup()
    const input = await workspace.registerResource(new File(['body'], 'pending.txt'))
    const generation = workspace.getIngress().generation
    const execution = workspace.runDurableTask({ definition: service.definition.ref, owner, input, reads: [] })
    expect(workspace.getIngress().generation).toBeGreaterThan(generation)
    expect(workspace.getIngress().pending.at(-1)).toMatchObject({ phase: 'committing', payload: { event: { kind: 'task-registered', input, definition: service.definition.ref } } })
    expect(workspace.getState().tasks).toEqual([])
    expect((await workspace.releaseResource(input.id)).kind).toBe('rejected')
    expect((await execution.result).kind).toBe('accepted')
    await workspace.waitForTask(execution.taskId)
    expect(task(workspace, execution.taskId).kind).toBe('consumed')
  })

  it('retains cancelled late file output in durable outcome history and rejects contradictory terminal proofs', async () => {
    const { workspace, service, storage, options, owner } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    const output = await workspace.registerResource(new File(['result body'], 'result.txt'))
    service.result = () => ({ kind: 'session-candidate', sessionId: owner.sessionId, input: output })
    service.beforeStart = async () => { entered.resolve(); await gate.promise }
    const execution = run(workspace, owner); await execution.result; await entered.promise
    const session = workspace.getState().session!
    await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
    gate.resolve(); await workspace.waitForTask(execution.taskId)
    expect(task(workspace, execution.taskId)).toMatchObject({ kind: 'cancelled', execution: { outcome: { kind: 'succeeded', result: { input: output } } } })
    expect((await workspace.releaseResource(output.id)).kind).toBe('rejected')
    const original = task(workspace, execution.taskId).execution!.outcome!, before = workspace.getState()
    const contradicted = reduceKernel(before, { kind: 'task-execution-observed', taskId: execution.taskId, executionId: original.ref.executionId,
      outcome: { kind: 'failed', ref: original.ref, issue: { code: 'contradiction', message: 'Changed terminal proof' } } }, workspace.schema)
    expect(contradicted.result.kind).toBe('rejected'); expect(contradicted.state).toBe(before)
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(task(restored, execution.taskId).execution?.outcome).toEqual(original)
    expect(await restored.getResource(output.id).text()).toBe('result body')
    expect(restored.getState().session).toBeNull()
  })

  it('queries a persisted but never-started task first and retries only the exact original idempotent request', async () => {
    const { workspace, service, storage, owner, options } = await setup()
    storage.beforeCommit = async write => { if (write.record.event.kind === 'task-started') storage.rejectNext = true }
    const execution = run(workspace, owner); await execution.result; await workspace.waitForTask(execution.taskId)
    expect(task(workspace, execution.taskId).kind).toBe('queued'); expect(service.requests).toEqual([])
    storage.beforeCommit = null
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect((await restored.recoverTask(execution.taskId)).kind).toBe('accepted')
    expect(service.requests).toEqual([]); expect(task(restored, execution.taskId).execution?.outcome?.kind).toBe('unknown')
    expect((await restored.recoverTask(execution.taskId, 'retry')).kind).toBe('accepted')
    expect(service.requests).toEqual(service.lookups); expect(service.executions).toBe(1)
    expect(task(restored, execution.taskId).kind).toBe('consumed')
  })

  it('can query a hung start independently and never applies the late duplicate success twice', async () => {
    const service = new DurableTaskFixture(), stored = deferred<void>(), gate = deferred<void>()
    const definition = { ...service.definition, start: async (...args: Parameters<DurableTaskDefinition['start']>) => {
      const outcome = await service.definition.start(...args); stored.resolve(); await gate.promise; return outcome
    } }
    const { workspace, owner } = await setup(definition)
    const execution = run(workspace, owner); await execution.result; await stored.promise
    expect((await workspace.recoverTask(execution.taskId)).kind).toBe('accepted')
    const acceptedVersion = workspace.getState().session!.input.version
    expect(task(workspace, execution.taskId).kind).toBe('consumed')
    gate.resolve(); await workspace.waitForTask(execution.taskId)
    expect(workspace.getState().session?.input.version).toBe(acceptedVersion)
    expect(service.requests).toHaveLength(1); expect(service.executions).toBe(1)
  })

  it('distinguishes an exact failed outcome from a transport error and will not rerun the failed execution', async () => {
    const { workspace, owner, service } = await setup()
    service.fail = true
    const execution = run(workspace, owner); await execution.result; await workspace.waitForTask(execution.taskId)
    expect(task(workspace, execution.taskId)).toMatchObject({ kind: 'failed', execution: { outcome: { kind: 'failed' } } })
    expect((await workspace.recoverTask(execution.taskId, 'retry')).kind).toBe('ignored')
    expect(service.requests).toHaveLength(1); expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
  })

  it('records registration and running before I/O, then atomically persists the exact outcome and complete input handoff', async () => {
    const { workspace, storage, service, owner, source } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async write => { if (write.record.event.kind === 'task-started') { entered.resolve(); await gate.promise } }
    const execution = run(workspace, owner)
    expect((await execution.result).kind).toBe('accepted')
    await entered.promise
    expect(service.requests).toEqual([]); expect(task(workspace, execution.taskId).kind).toBe('queued')
    gate.resolve()
    expect((await workspace.waitForTask(execution.taskId))?.kind).toBe('consumed')
    expect(service.executions).toBe(1)
    expect(storage.root?.record.transition.state.tasks[0]?.execution?.outcome?.kind).toBe('succeeded')
    const session = workspace.getState().session!
    expect(session.rawInput).toEqual({ kind: 'encoded', value: 42 }); expect(session.retainedInputs).toHaveLength(1)
    const inputs = [session.input, ...session.retainedInputs].map(ref => workspace.getState().inputs.find(input => input.ref.id === ref.id && input.ref.version === ref.version)!)
    const prepared = prepareRowAction(workspace.getState(), { cause: 'user', action: { id: kernelId<'action'>('apply'), applicationId: kernelId<'application'>('apply'), label: 'Apply task', saveAtomicity: 'row' }, inputs,
      commands: [{ id: kernelId<'intent'>('apply'), inputs: inputs.map(input => input.ref), dependencies: [], command: { kind: 'write', entityId: workspace.getProjection().rows[0]!.entityId,
        groups: [{ id: kernelId<'write-group'>('apply'), writes: [{ kind: 'set', path: ['value'], value: 42 }], comparison: 'paths', reads: [] }] } }],
    }, workspace.schema)
    expect((await workspace.dispatch({ kind: 'session-apply', lease: session.editor!, inputVersion: session.input.version, prepared })).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.writes).toBe(1); expect(workspace.getProjection().rows[0]?.preview).toEqual({ value: 42, hidden: 7 })
  })

  it('restores a lost successful response by querying the same execution and never reruns the external action', async () => {
    const { workspace, storage, service, owner, options } = await setup()
    service.loseResponse = true
    const execution = run(workspace, owner); await execution.result; await workspace.waitForTask(execution.taskId)
    expect(task(workspace, execution.taskId)).toMatchObject({ kind: 'running', execution: { outcome: { kind: 'unknown' } } })
    const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(service.requests).toHaveLength(1)
    expect((await reopened.recoverTask(execution.taskId)).kind).toBe('accepted')
    expect(reopened.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 })
    expect(task(reopened, execution.taskId).kind).toBe('consumed')
    expect(service.lookups).toEqual(service.requests); expect(service.executions).toBe(1)
  })

  it('keeps a success whose storage receipt is lost out of the editor until original storage reconciliation', async () => {
    const { workspace, storage, service, owner } = await setup()
    storage.beforeCommit = async write => { if (write.record.event.kind === 'task-execution-observed') storage.loseResponse = true }
    const execution = run(workspace, owner); await execution.result; await workspace.waitForTask(execution.taskId)
    expect(workspace.getStorageStatus()?.kind).toBe('unknown')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    storage.beforeCommit = null
    expect((await workspace.reconcileStorage()).kind).toBe('accepted')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 })
    expect((await workspace.recoverTask(execution.taskId)).kind).toBe('ignored')
    expect(service.requests).toHaveLength(1); expect(service.lookups).toEqual([])
  })

  it('retains successful protocol evidence rejected by storage and delivers it without calling the service twice', async () => {
    const { workspace, storage, service, owner } = await setup()
    storage.beforeCommit = async write => { if (write.record.event.kind === 'task-execution-observed') storage.rejectNext = true }
    const execution = run(workspace, owner); await execution.result; await workspace.waitForTask(execution.taskId)
    const retained = workspace.getIngress().pending.find(entry => entry.payload.kind === 'event' && entry.payload.event.kind === 'task-execution-observed')!
    expect(retained.phase).toBe('rejected'); expect(task(workspace, execution.taskId).kind).toBe('running')
    storage.beforeCommit = null
    await workspace.retryIngress(retained.id, workspace.getIngress().generation).completion
    expect(task(workspace, execution.taskId).kind).toBe('consumed'); expect(service.requests).toHaveLength(1)
  })

  it('keeps late success after supersession for explicit reapplication and after cancellation only as outcome evidence', async () => {
    for (const cancel of [false, true]) {
      const { workspace, service, owner } = await setup(), entered = deferred<void>(), gate = deferred<void>()
      service.beforeStart = async () => { entered.resolve(); await gate.promise }
      const execution = run(workspace, owner); await execution.result; await entered.promise
      const session = workspace.getState().session!
      if (cancel) await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
      else await workspace.typeInput(session.editor!, { kind: 'encoded', value: 'new text' }).completion
      gate.resolve(); await workspace.waitForTask(execution.taskId)
      expect(task(workspace, execution.taskId).execution?.outcome?.kind).toBe('succeeded')
      expect(task(workspace, execution.taskId).kind).toBe(cancel ? 'cancelled' : 'superseded')
      if (cancel) expect(workspace.getState().session).toBeNull()
      else {
        expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'new text' })
        expect((await workspace.dispatch({ kind: 'task-reapply', taskId: execution.taskId, executionId: task(workspace, execution.taskId).executionId,
          revision: workspace.getState().revision, owner: { ...owner, input: workspace.getState().session!.input } })).kind).toBe('accepted')
        expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 })
      }
      expect(service.executions).toBe(1)
    }
  })

  it('allows lookup after a lease handoff while fencing the old completion', async () => {
    const { workspace, service, storage, owner, options } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    service.beforeStart = async () => { entered.resolve(); await gate.promise }
    const execution = run(workspace, owner); await execution.result; await entered.promise
    const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect((await reopened.recoverTask(execution.taskId)).kind).toBe('accepted')
    expect(task(reopened, execution.taskId).execution?.outcome?.kind).toBe('unknown')
    gate.resolve(); await workspace.waitForTask(execution.taskId)
    expect(task(workspace, execution.taskId).execution?.outcome).toBeNull()
    expect((await reopened.recoverTask(execution.taskId)).kind).toBe('accepted')
    expect(task(reopened, execution.taskId).kind).toBe('consumed'); expect(service.requests).toHaveLength(1)
  })

  it('preserves the exact definition version, resource hash and original request across restoration', async () => {
    const { workspace, service, storage, owner, options } = await setup()
    const file = await workspace.registerResource(new File(['body'], 'upload.bin', { type: 'application/octet-stream', lastModified: 123 }))
    service.loseResponse = true
    const execution = workspace.runDurableTask({ definition: service.definition.ref, owner, input: file, reads: [] })
    await execution.result; await workspace.waitForTask(execution.taskId)
    expect(service.requests[0]?.resource?.descriptor).toMatchObject({ name: 'upload.bin', size: 4, lastModified: 123 })
    const missing = await Workspace.openDurable({ ...options, tasks: [], session: storage.acquire(), restore: true })
    expect((await missing.recoverTask(execution.taskId)).kind).toBe('rejected')
    expect(task(missing, execution.taskId).execution?.request).toEqual(service.requests[0])
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect((await restored.recoverTask(execution.taskId)).kind).toBe('accepted')
    expect(service.lookups[0]).toEqual(service.requests[0]); expect(service.executions).toBe(1)
  })

  it('retains wrong-execution success as ingress evidence instead of applying or misreporting a failure', async () => {
    const service = new DurableTaskFixture()
    const definition = { ...service.definition, start: async (...args: Parameters<DurableTaskDefinition['start']>): Promise<DurableTaskOutcome> => {
      const outcome = await service.definition.start(...args)
      return { ...outcome, ref: { ...outcome.ref, payloadHash: `sha256:${'0'.repeat(64)}` } }
    } }
    const { workspace, owner } = await setup(definition)
    const execution = run(workspace, owner); await execution.result; await workspace.waitForTask(execution.taskId)
    expect(task(workspace, execution.taskId).kind).toBe('running')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(workspace.getIngress().pending.at(-1)).toMatchObject({ phase: 'rejected', payload: { event: { outcome: { kind: 'succeeded' } } } })
    expect((await workspace.recoverTask(execution.taskId)).kind).toBe('accepted')
    expect(task(workspace, execution.taskId).kind).toBe('consumed')
  })
})

it('recovers an action candidate by exact lookup and saves reviewed writes plus creation as one action', async () => {
  const { workspace, service, storage, options, source } = await setup()
  const session = workspace.getState().session!
  await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
  const owner = { kind: 'workspace' as const, workspaceId: workspace.getState().workspace.id }
  service.result = () => ({ kind: 'action-candidate', input: { kind: 'encoded', value: { converted: [8, 9] } } })
  service.loseResponse = true
  const execution = workspace.runDurableTask({ definition: service.definition.ref, owner, input: { kind: 'encoded', value: 'original batch' }, reads: [] })
  expect((await execution.result).kind).toBe('accepted')
  await workspace.waitForTask(execution.taskId)
  expect(task(workspace, execution.taskId)).toMatchObject({ kind: 'running', execution: { outcome: { kind: 'unknown' } } })
  const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect((await restored.recoverTask(execution.taskId)).kind).toBe('accepted')
  expect(task(restored, execution.taskId)).toMatchObject({ kind: 'result-ready', result: { kind: 'action-candidate', input: { kind: 'encoded', value: { converted: [8, 9] } } } })
  expect(service.executions).toBe(1)
  expect(service.lookups).toEqual(service.requests)
  expect(source.writes).toBe(0)
  expect(restored.getState().journal.actions).toHaveLength(0)
  const state = restored.getState(), inputs = taskInputRecords(state, execution.taskId)
  const prepared = prepareRowAction(state, { cause: 'task', inputs,
    action: { id: kernelId<'action'>('batch'), applicationId: kernelId<'application'>('batch'), label: 'Reviewed batch', saveAtomicity: 'transaction' },
    commands: [
      { id: kernelId<'intent'>('overwrite'), inputs: inputs.map(input => input.ref), dependencies: [], command: { kind: 'write', entityId: restored.getProjection().rows[0]!.entityId,
        groups: [{ id: kernelId<'write-group'>('value'), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['value'], value: 8 }] }] } },
      { id: kernelId<'intent'>('append'), inputs: inputs.map(input => input.ref), dependencies: [], command: { kind: 'create', entityId: kernelId<'entity'>('new-image'), document: { value: 9 } } },
    ],
  }, restored.schema)
  const current = task(restored, execution.taskId)
  expect((await restored.dispatch({ kind: 'task-reapply', taskId: current.id, executionId: current.executionId, revision: state.revision, owner, prepared })).kind).toBe('accepted')
  expect((await restored.save()).kind).toBe('committed')
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 8, hidden: 7 }, { value: 9 }])
  const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(task(reopened, execution.taskId).kind).toBe('consumed')
  expect(reopened.getProjection().rows.map(row => row.preview)).toEqual([{ value: 8, hidden: 7 }, { value: 9 }])
  expect(service.executions).toBe(1)
})

it('recovers a lost file-task result under revoked permission, retains bytes, and saves only after explicit consumption', async () => {
  const { workspace, storage, service, owner, options, source } = await setup()
  const bytes = new Uint8Array([0, 255, 17, 10, 128]), input = await workspace.registerResource(new File([bytes], '原始上传.bin', { type: 'application/octet-stream', lastModified: 123 }))
  const entered = deferred<void>(), gate = deferred<void>()
  service.beforeStart = async () => { entered.resolve(); await gate.promise }; service.loseResponse = true
  const execution = workspace.runDurableTask({ definition: service.definition.ref, owner, input, reads: [] })
  expect((await execution.result).kind).toBe('accepted'); await entered.promise
  const policy = workspace.getState().policy
  expect((await workspace.dispatch({ kind: 'policy-observed', policy: { ...policy, version: kernelId<'policy-version'>('revoked-file'),
    defaultEntity: { ...policy.defaultEntity, write: false } } })).kind).toBe('accepted')
  gate.resolve(); await workspace.waitForTask(execution.taskId)
  const originalRequest = JSON.stringify(service.requests[0])
  expect(service.requests[0]?.resource?.descriptor).toMatchObject({ name: '原始上传.bin', size: bytes.length, lastModified: 123, mediaType: 'application/octet-stream' })
  expect(task(workspace, execution.taskId).execution?.outcome?.kind).toBe('unknown')
  const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect((await restored.recoverTask(execution.taskId)).kind).toBe('accepted')
  const blocked = task(restored, execution.taskId)
  expect(blocked).toMatchObject({ kind: 'blocked', execution: { outcome: { kind: 'succeeded' } } })
  expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
  expect(restored.getState().inputs.find(record => record.ref.id === blocked.input.id)).toMatchObject({ input, disposition: { kind: 'task', taskId: blocked.id } })
  expect(new Uint8Array(await restored.getResource(input.id).arrayBuffer())).toEqual(bytes)
  expect((await restored.releaseResource(input.id)).kind).toBe('rejected')
  expect((await restored.dispatch({ kind: 'task-consume', taskId: blocked.id, executionId: blocked.executionId })).kind).toBe('rejected')
  expect(restored.getState().journal.intents).toEqual([]); expect(source.writes).toBe(0)
  const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(task(reopened, execution.taskId)).toEqual(blocked)
  expect(new Uint8Array(await reopened.getResource(input.id).arrayBuffer())).toEqual(bytes)
  expect((await reopened.dispatch({ kind: 'policy-observed', policy })).kind).toBe('accepted')
  expect(reopened.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
  expect(reopened.getState().journal.intents).toEqual([])
  expect((await reopened.dispatch({ kind: 'task-consume', taskId: blocked.id, executionId: blocked.executionId })).kind).toBe('accepted')
  const sessionId = reopened.getState().session!.id
  expect((await reopened.dispatch({ kind: 'session-attached', sessionId, viewId: kernelId<'view'>('review-file') })).kind).toBe('accepted')
  const state = reopened.getState(), session = state.session!
  expect(session.rawInput).toEqual({ kind: 'encoded', value: 42 })
  const inputs = [session.input, ...session.retainedInputs].map(ref => state.inputs.find(record => record.ref.id === ref.id && record.ref.version === ref.version)!)
  expect(inputs.some(record => record.input.kind === 'resource' && record.input.id === input.id)).toBe(true)
  const prepared = prepareRowAction(state, { cause: 'user', inputs,
    action: { id: kernelId<'action'>('apply-file'), applicationId: kernelId<'application'>('apply-file'), label: 'Apply retained file result', saveAtomicity: 'row' },
    commands: [{ id: kernelId<'intent'>('apply-file'), inputs: inputs.map(record => record.ref), dependencies: [], command: { kind: 'write', entityId: reopened.getProjection().rows[0]!.entityId,
      groups: [{ id: kernelId<'write-group'>('file-value'), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['value'], value: 42 }] }] } }],
  }, reopened.schema)
  expect((await reopened.dispatch({ kind: 'session-apply', lease: session.editor!, inputVersion: session.input.version, prepared })).kind).toBe('accepted')
  expect((await reopened.save()).kind).toBe('committed')
  const final = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 42, hidden: 7 }])
  expect(source.writes).toBe(1); expect(source.requests).toHaveLength(1)
  expect(service.executions).toBe(1); expect(service.requests).toHaveLength(1)
  expect(JSON.stringify(service.requests[0])).toBe(originalRequest)
  expect(service.lookups).toEqual(service.requests)
  expect(new Uint8Array(await final.getResource(input.id).arrayBuffer())).toEqual(bytes)
  expect(final.getState().inputs.find(record => record.ref.id === blocked.input.id)).toMatchObject({ input, disposition: { kind: 'settled-intents' } })
  expect(task(final, execution.taskId).execution?.outcome).toEqual(blocked.execution?.outcome)

  // An old cancellation remains harmless even after another editor owns new
  // input on the same entity, and after that input itself is restored.
  expect((await final.dispatch({ kind: 'session-opened', revision: final.getState().revision,
    sessionId: kernelId<'session'>('later-edit'), inputId: kernelId<'input'>('later-input'), viewId: kernelId<'view'>('later-view'),
    target: { kind: 'cell', field: { entityId: final.getProjection().rows[0]!.entityId, fieldId: kernelId<'field'>('value') } },
    input: { kind: 'encoded', value: '下一次未提交编辑' }, reads: [] })).kind).toBe('accepted')
  const later = final.getState(), committedTask = task(final, execution.taskId)
  expect((await final.dispatch({ kind: 'task-cancelled', taskId: blocked.id, executionId: blocked.executionId })).kind).toBe('ignored')
  expect(final.getState()).toBe(later)
  expect(task(final, execution.taskId)).toEqual(committedTask)
  const again = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  const restoredLater = again.getState()
  expect(restoredLater.session).toMatchObject({ id: 'later-edit', input: later.session!.input, rawInput: { kind: 'encoded', value: '下一次未提交编辑' } })
  expect((await again.dispatch({ kind: 'task-cancelled', taskId: blocked.id, executionId: blocked.executionId })).kind).toBe('ignored')
  expect(again.getState()).toBe(restoredLater)
  expect(again.getState().inputs).toEqual(later.inputs)
  expect(new Uint8Array(await again.getResource(input.id).arrayBuffer())).toEqual(bytes)
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 42, hidden: 7 }])
  expect(source.writes).toBe(1); expect(service.executions).toBe(1)
})


it('keeps an invalid second task effect atomic across durable reopen and retains the whole file result for correction', async () => {
  const { workspace, options, storage, service, source } = await setup(undefined, document =>
    typeof document.value === 'number' && document.value < 0 ? [{ code: 'negative', message: 'Negative value' }] : [])
  const session = workspace.getState().session!
  expect((await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })).kind).toBe('accepted')
  const owner = { kind: 'workspace' as const, workspaceId: workspace.getState().workspace.id }
  const bytes = new Uint8Array([0, 255, 7, 128]), input = await workspace.registerResource(new File([bytes], '完整批次.bin'))
  const proposal = (active: Workspace, taskId: TaskId, second: number) => {
    const state = active.getState(), inputs = taskInputRecords(state, taskId)
    const id = `batch:${second}`
    return prepareRowAction(state, { cause: 'task', inputs,
      action: { id: kernelId<'action'>(id), applicationId: kernelId<'application'>(id), label: 'Complete file effects', saveAtomicity: 'transaction' },
      commands: [
        { id: kernelId<'intent'>(`${id}:first`), inputs: inputs.map(record => record.ref), dependencies: [], command: { kind: 'write', entityId: active.getProjection().rows[0]!.entityId,
          groups: [{ id: kernelId<'write-group'>(id), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['value'], value: 42 }] }] } },
        { id: kernelId<'intent'>(`${id}:second`), inputs: inputs.map(record => record.ref), dependencies: [], command: { kind: 'create', entityId: kernelId<'entity'>('batch-created'), document: { value: second } } },
      ],
    }, active.schema)
  }
  service.result = request => ({ kind: 'action', action: proposal(workspace, request.ref.taskId, -1) })
  const execution = workspace.runDurableTask({ definition: service.definition.ref, owner, input, reads: [] })
  expect((await execution.result).kind).toBe('accepted'); await workspace.waitForTask(execution.taskId)
  const blocked = task(workspace, execution.taskId)
  expect(blocked).toMatchObject({ kind: 'blocked', result: { kind: 'action' }, execution: { outcome: { kind: 'succeeded' } } })
  expect('result' in blocked ? blocked.result : null).toMatchObject({ kind: 'action', action: { intents: [
    { operation: { kind: 'write', groups: [{ writes: [{ kind: 'set', path: ['value'], value: 42 }] }] } },
    { operation: { kind: 'create', document: { value: -1 } } },
  ] } })
  const before = workspace.getState().inputs.find(record => record.ref.id === blocked.input.id)!
  expect(before).toMatchObject({ input, disposition: { kind: 'task', taskId: blocked.id } })
  expect(workspace.getState().journal.intents).toEqual([])
  expect(workspace.getProjection().changes).toEqual([])
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 0, hidden: 7 }])
  expect(source.requests).toEqual([]); expect(source.writes).toBe(0)
  const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(task(restored, execution.taskId)).toEqual(blocked)
  expect(restored.getState().inputs.find(record => record.ref.id === blocked.input.id)).toEqual(before)
  expect(new Uint8Array(await restored.getResource(input.id).arrayBuffer())).toEqual(bytes)
  expect((await restored.dispatch({ kind: 'task-consume', taskId: blocked.id, executionId: blocked.executionId })).kind).toBe('rejected')
  expect(restored.getState().journal.intents).toEqual([])
  expect(source.requests).toEqual([])
  const prepared = proposal(restored, blocked.id, 9)
  expect((await restored.dispatch({ kind: 'task-reapply', taskId: blocked.id, executionId: blocked.executionId,
    revision: restored.getState().revision, owner, prepared })).kind).toBe('accepted')
  expect((await restored.save()).kind).toBe('committed')
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 42, hidden: 7 }, { value: 9 }])
  expect(source.writes).toBe(1); expect(source.requests).toHaveLength(1); expect(source.requests[0]!.items).toHaveLength(2)
  const final = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  const consumed = task(final, blocked.id)
  expect(consumed).toMatchObject({ kind: 'consumed', result: 'result' in blocked ? blocked.result : null, execution: blocked.execution })
  expect(new Uint8Array(await final.getResource(input.id).arrayBuffer())).toEqual(bytes)
  expect(final.getState().inputs.find(record => record.ref.id === blocked.input.id)).toMatchObject({ input, disposition: { kind: 'settled-intents' } })
  expect(service.requests).toHaveLength(1); expect(service.executions).toBe(1)
})

it('keeps a durable late task on the retired entity across deletion restoration and earlier field undo', async () => {
  const { workspace, storage, options, service, source } = await setup(undefined, permissiveSchema.validate, true)
  const initialSession = workspace.getState().session!
  expect((await workspace.dispatch({ kind: 'session-cancelled', sessionId: initialSession.id, lease: initialSession.editor, inputVersion: initialSession.input.version })).kind).toBe('accepted')
  const fixture = new KernelFixture(undefined, workspace.schema)
  fixture.state = workspace.getState()
  const oldEntity = workspace.getProjection().rows[0]!.entityId
  const original = fixture.prepare([fixture.write(oldEntity, { value: 1 })])
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared: original })).kind).toBe('accepted')
  expect((await workspace.save()).kind).toBe('committed')
  expect((await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision,
    sessionId: kernelId<'session'>('old-entity-editor'), inputId: kernelId<'input'>('old-entity-text'), viewId: kernelId<'view'>('old-entity-view'),
    target: { kind: 'cell', field: { entityId: oldEntity, fieldId: kernelId<'field'>('value') } }, input: { kind: 'encoded', value: '旧实体原文' }, reads: [] })).kind).toBe('accepted')
  const session = workspace.getState().session!, input = await workspace.registerResource(new File(['原文件内容'], '旧实体.txt'))
  const entered = deferred<void>(), gate = deferred<void>()
  service.beforeStart = async () => { entered.resolve(); await gate.promise }
  const execution = workspace.runDurableTask({ definition: service.definition.ref,
    owner: { kind: 'session', sessionId: session.id, input: session.input }, input, reads: [] })
  expect((await execution.result).kind).toBe('accepted'); await entered.promise
  const originalTask = task(workspace, execution.taskId), request = JSON.stringify(service.requests[0])
  fixture.state = workspace.getState()
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([{ kind: 'delete', entityId: oldEntity }]) })).kind).toBe('accepted')
  expect((await workspace.save()).kind).toBe('committed')
  const deleted = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(deleted.getProjection().rows).toEqual([])
  expect((await deleted.undo()).kind).toBe('accepted')
  expect((await deleted.undo()).kind).toBe('accepted')
  expect((await deleted.save()).kind).toBe('committed')
  const restoredEntity = deleted.getProjection().rows[0]!.entityId
  expect(restoredEntity).not.toBe(oldEntity)
  gate.resolve(); await workspace.waitForTask(execution.taskId)
  const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect((await restored.recoverTask(execution.taskId)).kind).toBe('accepted')
  const blocked = task(restored, execution.taskId)
  expect(blocked).toMatchObject({ kind: 'blocked', owner: originalTask.owner, input: originalTask.input, execution: { outcome: { kind: 'succeeded' } } })
  expect((await restored.dispatch({ kind: 'task-consume', taskId: blocked.id, executionId: blocked.executionId })).kind).toBe('rejected')
  expect(restored.getState().session?.target).toEqual(session.target)
  expect(restored.getState().session?.rawInput).toEqual(session.rawInput)
  const final = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(task(final, execution.taskId)).toEqual(blocked)
  expect(final.getState().entities.find(entity => entity.entityId === oldEntity)?.kind).toBe('retired')
  expect(final.getProjection().rows[0]).toMatchObject({ entityId: restoredEntity, preview: { value: 0, hidden: 7 } })
  expect(final.getProjection().changes).toEqual([])
  expect(final.getState().journal.intents.find(intent => intent.id === original.intents[0]!.id)).toEqual(original.intents[0])
  expect(final.getState().inputs.find(record => record.ref.id === blocked.input.id)).toMatchObject({ input, disposition: { kind: 'task', taskId: blocked.id } })
  const file = final.getResource(input.id) as File
  expect(file.name).toBe('旧实体.txt'); expect(await file.text()).toBe('原文件内容')
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 0, hidden: 7 }])
  expect(source.requests).toHaveLength(3); expect(source.writes).toBe(3)
  expect(source.requests[2]!.items[0]).toMatchObject({ kind: 'create', entityId: restoredEntity,
    restores: { operationId: source.requests[1]!.operationId, itemId: source.requests[1]!.items[0]!.id } })
  expect(service.requests).toHaveLength(1); expect(service.executions).toBe(1); expect(service.lookups).toEqual(service.requests)
  expect(JSON.stringify(service.requests[0])).toBe(request)
})

it('durably reapplies a blocked result to another field once while retaining its original execution', async () => {
  const { workspace, storage, service, source, options } = await setup()
  const session = workspace.getState().session!
  await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
  source.external({ a: { value: 0, hidden: 7 }, b: { value: 0, hidden: 8 } }); await workspace.refresh()
  const field = { entityId: workspace.getProjection().rows[0]!.entityId, fieldId: kernelId<'field'>('value') }
  const owner = { kind: 'field' as const, field, generation: fieldGeneration(workspace.getState(), field) }
  const entered = deferred<void>(), gate = deferred<void>()
  const prepare = (target: Workspace, taskId: TaskId, newOwner: typeof owner, label: string) => {
    const inputs = taskInputRecords(target.getState(), taskId, newOwner)
    return prepareRowAction(target.getState(), { cause: 'task', inputs,
      action: { id: kernelId<'action'>(label), applicationId: kernelId<'application'>(label), label, saveAtomicity: 'row' },
      commands: [{ id: kernelId<'intent'>(label), inputs: inputs.map(input => input.ref), dependencies: [], command: { kind: 'write', entityId: newOwner.field.entityId,
        groups: [{ id: kernelId<'write-group'>(label), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['value'], value: 42 }] }] } }],
    }, target.schema)
  }
  service.beforeStart = async () => { entered.resolve(); await gate.promise }
  const execution = workspace.runDurableTask({ definition: service.definition.ref, owner, input: { kind: 'encoded', value: '原转换输入' }, reads: [] })
  await execution.result; await entered.promise
  const originalAction = prepare(workspace, execution.taskId, { ...owner, generation: fieldGeneration(workspace.getState(), field) }, 'original-conversion')
  service.result = () => ({ kind: 'action', action: originalAction })
  source.external({ a: { value: 9, hidden: 7 }, b: { value: 0, hidden: 8 } }); await workspace.refresh()
  gate.resolve(); await workspace.waitForTask(execution.taskId)
  const blocked = task(workspace, execution.taskId)
  expect(blocked.kind).toBe('blocked')
  const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(task(reopened, execution.taskId)).toEqual(blocked)
  const newField = { entityId: reopened.getProjection().rows[1]!.entityId, fieldId: field.fieldId }
  const newOwner = { kind: 'field' as const, field: newField, generation: fieldGeneration(reopened.getState(), newField) }
  const prepared = prepare(reopened, execution.taskId, newOwner, 'reviewed-conversion')
  const inputs = reopened.getState().inputs
  expect((await reopened.dispatch({ kind: 'task-reapply', taskId: blocked.id, executionId: blocked.executionId,
    revision: reopened.getState().revision - 1, owner: newOwner, prepared })).kind).toBe('rejected')
  expect(reopened.getState().inputs).toEqual(inputs); expect(reopened.getState().journal.intents).toEqual([])
  expect((await reopened.dispatch({ kind: 'task-reapply', taskId: blocked.id, executionId: blocked.executionId,
    revision: reopened.getState().revision, owner: newOwner, prepared })).kind).toBe('accepted')
  expect((await reopened.save()).kind).toBe('committed')
  const final = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  const before = final.getState()
  expect((await final.dispatch({ kind: 'task-reapply', taskId: blocked.id, executionId: blocked.executionId,
    revision: before.revision, owner: newOwner, prepared })).kind).toBe('ignored')
  expect(final.getState()).toBe(before)
  expect(task(final, execution.taskId)).toMatchObject({ kind: 'consumed', owner: blocked.owner, input: blocked.input, execution: blocked.execution })
  const consumed = task(final, execution.taskId)
  expect('result' in consumed && consumed.result).toEqual('result' in blocked && blocked.result)
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 9, hidden: 7 }, { value: 42, hidden: 8 }])
  expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
  expect(source.requests[0]!.items).toHaveLength(1)
  expect(source.requests[0]!.items[0]).toMatchObject({ kind: 'update', entityId: newField.entityId, before: { value: 0, hidden: 8 }, after: { value: 42, hidden: 8 } })
  expect(service.requests).toHaveLength(1); expect(service.executions).toBe(1); expect(service.lookups).toEqual([])
})
