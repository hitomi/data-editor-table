import { describe, expect, it, vi } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { DurableTaskFixture } from '../../tests/kernel/durable-task-fixture.js'
import { kernelId, type OperationLookup } from './model.js'
import { Workspace } from './workspace.js'

let serial = 0
async function setup() {
  const scope = { sourceId: `recovery-scan:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0, hidden: 7 } }), service = new DurableTaskFixture()
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy, tasks: [service.definition] }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`workspace:${serial}`), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })
  await workspace.refresh()
  const fixture = new KernelFixture(); fixture.state = workspace.getState()
  const prepared = fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 1 })])
  await workspace.dispatch({ kind: 'prepared-action', prepared })
  source.submitHook = async (_request, execute) => { execute(); throw new Error('Source response lost') }
  expect((await workspace.save()).kind).toBe('unresolved')
  source.submitHook = null
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('filter'), inputId: kernelId<'input'>('filter'),
    viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'x', queryVersion: 0 }, input: { kind: 'encoded', value: 'filter text' }, reads: [] })
  const session = workspace.getState().session!
  const raw = { definition: service.definition.ref, owner: { kind: 'session' as const, sessionId: session.id, input: session.input }, input: { kind: 'encoded' as const, value: 'task input' }, reads: [] }
  async function startLostTask() {
    service.loseResponse = true
    const execution = workspace.runDurableTask(raw)
    expect((await execution.result).kind).toBe('accepted')
    await workspace.waitForTask(execution.taskId)
    return execution
  }
  return { workspace, source, service, storage, options, raw, startLostTask }
}

describe('whole-workspace recovery coordination', () => {
  it('scans full roots after later input and startup queries both original operations without rerunning either', async () => {
    const { workspace, source, service, storage, options, startLostTask } = await setup()
    const execution = await startLostTask(), original = source.requests[0]!, taskRequest = service.requests[0]!
    expect(storage.root!.record.event.kind).toBe('task-execution-observed')
    expect(storage.root!.record.transition.effects).toEqual([])
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true, recovery: 'lookup' })
    const result = await restored.recoverPendingWork()
    expect(result.kind).toBe('completed')
    expect(result.outcomes.map(outcome => outcome.candidate.kind).sort()).toEqual(['submission', 'task'])
    expect(restored.getState().tasks.find(task => task.id === execution.taskId)?.kind).toBe('consumed')
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 })
    expect(restored.getProjection().rows[0]?.preview).toEqual({ x: 1, hidden: 7 })
    expect(result.remaining.candidates).toEqual([])
    expect(result.remaining.assessment.blockers.map(blocker => blocker.kind)).toContain('session')
    expect(source.requests).toEqual([original]); expect(service.requests).toEqual([taskRequest])
    expect(source.lookups).toBe(1); expect(service.lookups).toEqual([taskRequest])
    expect(workspace.getStorageStatus()?.kind).toBe('fenced')
  })

  it('queries every concurrent task while preserving the losing result when one replaces their shared session input', async () => {
    const { workspace, service, startLostTask } = await setup()
    await startLostTask(); await startLostTask()
    expect(workspace.getState().tasks.map(task => task.kind)).toEqual(['running', 'running'])
    const result = await workspace.recoverPendingWork()
    expect(result.kind).toBe('completed')
    expect(workspace.getState().tasks.map(task => task.kind).sort()).toEqual(['consumed', 'superseded'])
    expect(workspace.getState().tasks.every(task => task.execution?.outcome?.kind === 'succeeded' && 'result' in task)).toBe(true)
    const retained = workspace.getState().tasks.find(task => task.kind === 'superseded')!
    expect(workspace.getState().inputs.find(input => input.ref.id === retained.input.id)?.disposition).toEqual({ kind: 'task', taskId: retained.id })
    expect(result.remaining.assessment.blockers).toContainEqual(expect.objectContaining({ kind: 'task-result', id: retained.id }))
    expect(service.lookups).toHaveLength(2); expect(service.executions).toBe(2)
    expect(service.requests).toHaveLength(2)
  })

  it('recovers the source while reporting an unavailable exact task definition without substituting another version', async () => {
    const { source, service, storage, options, startLostTask } = await setup()
    await startLostTask()
    const restored = await Workspace.openDurable({ ...options, tasks: [{ ...service.definition, ref: { id: 'upload', version: 'v2' } }], session: storage.acquire(), restore: true })
    expect(restored.getRecoveryPlan().candidates.find(candidate => candidate.kind === 'task')).toMatchObject({ definitionAvailable: false, ref: { definition: { version: 'v1' } } })
    const result = await restored.recoverPendingWork()
    expect(result.kind).toBe('blocked')
    expect(result.outcomes.find(outcome => outcome.candidate.kind === 'task')?.result).toMatchObject({ kind: 'rejected', issue: { code: 'recovery-definition-missing' } })
    expect(source.lookups).toBe(1); expect(service.lookups).toEqual([]); expect(service.executions).toBe(1)
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'filter text' })
  })

  it('reconciles unknown registration storage first and then only looks up the durable task', async () => {
    const { workspace, service, source, storage, raw } = await setup()
    storage.beforeCommit = async write => { if (write.record.event.kind === 'task-registered') storage.loseResponse = true }
    const execution = workspace.runDurableTask(raw)
    expect((await execution.result).kind).toBe('unresolved')
    expect(service.requests).toEqual([])
    storage.beforeCommit = null
    const result = await workspace.recoverPendingWork()
    expect(result.kind).toBe('blocked')
    expect(result.outcomes[0]!.candidate.kind).toBe('storage')
    expect(result.outcomes.map(outcome => outcome.candidate.kind).sort()).toEqual(['storage', 'submission', 'task'])
    expect(service.requests).toEqual([]); expect(service.lookups).toHaveLength(1)
    expect(workspace.getState().tasks[0]?.execution?.outcome?.kind).toBe('unknown')
    expect(source.writes).toBe(1)
    // A later, explicit retry can still start exactly the registered request.
    expect((await workspace.recoverTask(execution.taskId, 'retry')).kind).toBe('accepted')
    expect(service.executions).toBe(1)
  })

  it('coalesces scans while a source lookup waits, yet publishes an independent task result and progress', async () => {
    const { workspace, source, service, startLostTask } = await setup()
    await startLostTask()
    const entered = deferred<void>(), gate = deferred<void>()
    source.lookupHook = async ref => { entered.resolve(); await gate.promise; return source.records.get(ref.operationId)!.result as OperationLookup }
    const first = workspace.recoverPendingWork(), second = workspace.recoverPendingWork()
    expect(second).toBe(first)
    await entered.promise
    await vi.waitFor(() => expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 }))
    expect(workspace.getRecoveryProgress()).toMatchObject({ running: true, outcomes: [{ candidate: { kind: 'task' } }] })
    expect(service.lookups).toHaveLength(1)
    expect(workspace.getState().persistence.kind).toBe('outcome-unknown')
    gate.resolve()
    expect((await first).kind).toBe('completed')
    expect(workspace.getRecoveryProgress().running).toBe(false)
    expect(source.lookups).toBe(1)
  })

  it('keeps all network queries behind an unresolved storage result and preserves newer text on later recovery', async () => {
    const { workspace, source, service, storage, startLostTask } = await setup()
    await startLostTask()
    storage.loseResponse = true
    const input = workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'newer text' })
    expect((await input.completion).kind).toBe('unresolved')
    storage.corruptResponse = result => ({ kind: 'unknown', commit: result.commit, issue: { code: 'offline', message: 'Storage result unavailable' } })
    const blocked = await workspace.recoverPendingWork()
    expect(blocked.kind).toBe('blocked'); expect(blocked.outcomes).toHaveLength(1)
    expect(source.lookups).toBe(0); expect(service.lookups).toEqual([])
    storage.corruptResponse = null
    const result = await workspace.recoverPendingWork()
    expect(result.kind).toBe('completed')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'newer text' })
    expect(workspace.getState().tasks[0]).toMatchObject({ kind: 'superseded', result: { input: { value: 42 } } })
    expect(result.remaining.assessment.blockers.map(blocker => blocker.kind)).toContain('task-result')
    expect(service.executions).toBe(1)
  })

  it('does not dispose rejected ingress while recovering operations that are independent of it', async () => {
    const { workspace, source } = await setup()
    const input = workspace.typeInput(workspace.getState().session!.editor!, { kind: 'resource', id: kernelId<'resource'>('missing') })
    await input.completion
    const before = workspace.getIngress().pending
    const result = await workspace.recoverPendingWork()
    expect(result.kind).toBe('blocked'); expect(result.remaining.candidates).toEqual([])
    expect(workspace.getIngress().pending).toEqual(before)
    expect(result.remaining.assessment.blockers).toContainEqual(expect.objectContaining({ kind: 'ingress', id: input.id }))
    expect(source.lookups).toBe(1)
  })

  it('fences an old scan before late publication and leaves original request recovery to the new lease', async () => {
    const { workspace, source, storage, options } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    source.lookupHook = async ref => { entered.resolve(); await gate.promise; return source.records.get(ref.operationId)!.result as OperationLookup }
    const scanning = workspace.recoverPendingWork(); await entered.promise
    const state = workspace.getState()
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    gate.resolve()
    expect((await scanning).kind).toBe('blocked')
    expect(workspace.getState()).toBe(state)
    source.lookupHook = null
    expect((await restored.recoverPendingWork()).kind).toBe('completed')
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
  })

  it('includes a previous gateway reservation even when the restored semantic root is idle', async () => {
    const { workspace, source, storage, options } = await setup()
    storage.beforeCommit = async write => {
      if (write.record.event.kind === 'server-authority-received' && write.record.transition.state.persistence.kind === 'idle') storage.loseResponse = true
    }
    expect((await workspace.recover()).kind).toBe('unresolved')
    storage.beforeCommit = null
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(restored.getState().persistence.kind).toBe('idle')
    expect(restored.getRecoveryPlan().candidates).toEqual([{ kind: 'submission', submission: source.requests[0] }])
    const result = await restored.recoverPendingWork()
    expect(result.kind).toBe('completed'); expect(result.remaining.candidates).toEqual([])
    expect(source.requests).toHaveLength(1)
  })
})
