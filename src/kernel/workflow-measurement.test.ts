import { expect, it } from 'vitest'
import { saveWorkflowMeasurement } from '../../tests/kernel/workflow-report.mjs'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { deferred, SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId } from './model.js'
import { Workspace } from './workspace.js'
import type { RowCommand } from './prepare.js'

// Measurements describe this process and the independent in-memory storage
// oracle. They are not timing gates or IndexedDB/browser latency claims.
it.each([
  { count: 32, mode: 'batch' }, { count: 128, mode: 'batch' }, { count: 512, mode: 'batch' },
  { count: 32, mode: 'history' }, { count: 128, mode: 'history' },
])('preserves $mode/$count commands through normalized save and two reopenings', async ({ count, mode }) => {
  const ms: Record<string, number> = {}
  const measure = async <T>(phase: string, run: () => T | Promise<T>): Promise<T> => {
    const start = performance.now()
    try { return await run() } finally { ms[phase] = Math.round(((ms[phase] ?? 0) + performance.now() - start) * 100) / 100 }
  }
  const scope = { sourceId: `workflow-measurement:${mode}:${count}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0, hidden: 'original', extra: { keep: 7 } } })
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`workflow:${mode}:${count}`), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = await measure('openRefresh', async () => {
    const value = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })
    expect((await value.refresh()).kind).toBe('accepted')
    return value
  })
  const entityId = workspace.getProjection().rows[0]!.entityId
  const author = new KernelFixture(undefined, permissiveSchema); author.state = workspace.getState()
  const commands: RowCommand[] = Array.from({ length: count }, (_, index) => ({ kind: 'write', entityId,
    groups: [{ id: kernelId<'write-group'>(`bulk:${index}`), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['x'], value: index + 1 }] }] }))
  const batches = mode === 'batch' ? [commands] : commands.map(command => [command])
  const originalIds = []
  for (const group of batches) {
    author.state = workspace.getState()
    const batch = await measure('prepareEdits', () => author.prepare(group, 'row', 'bulk input'))
    expect((await measure('admitEdits', () => workspace.dispatch({ kind: 'prepared-action', prepared: batch }))).kind).toBe('accepted')
    originalIds.push(...batch.action.intentIds)
  }
  const entered = deferred<void>(), release = deferred<void>()
  source.normalize = document => ({ ...document, x: Number(document.x) + 0.5, hidden: 'canonical' })
  source.submitHook = async (_submission, execute) => { entered.resolve(); await release.promise; return execute() }
  const start = performance.now(), saving = workspace.save()
  await entered.promise; ms.freezeToSource = Math.round((performance.now() - start) * 100) / 100
  const firstRequest = JSON.stringify(source.requests[0])
  expect(source.writes).toBe(0)
  expect(source.requests[0]!.coverage.flatMap(item => item.intentIds)).toEqual(originalIds)
  author.state = workspace.getState()
  const successor = await measure('prepareSuccessor', () => author.prepare([author.write(entityId, { x: count + 1 })], 'row', 'successor input'))
  expect((await measure('admitSuccessor', () => workspace.dispatch({ kind: 'prepared-action', prepared: successor }))).kind).toBe('accepted')
  const committed = await measure('receiptAndRefresh', async () => { release.resolve(); return saving })
  expect(committed.kind).toBe('committed')
  const expected = { x: count + 1, hidden: 'canonical', extra: { keep: 7 } }, retained = workspace.getState()
  expect(workspace.getProjection().rows[0]!.preview).toEqual(expected)
  const reopened = await measure('reopenPending', () => Workspace.openDurable({ ...options, session: storage.acquire(), restore: true }))
  expect(reopened.getState().journal).toEqual(retained.journal)
  expect(reopened.getState().inputs).toEqual(retained.inputs)
  expect(reopened.getState().inputs.map(input => input.input)).toEqual([
    ...batches.map(() => ({ kind: 'encoded', value: 'bulk input' })), { kind: 'encoded', value: 'successor input' },
  ])
  expect(reopened.getProjection().rows[0]!.preview).toEqual(expected)
  source.submitHook = null; source.normalize = document => document
  expect((await measure('saveSuccessor', () => reopened.save())).kind).toBe('committed')
  const final = await measure('reopenSaved', () => Workspace.openDurable({ ...options, session: storage.acquire(), restore: true }))
  expect(final.getProjection().rows[0]!.preview).toEqual(expected)
  expect(final.getProjection().changes).toEqual([])
  expect(final.getState().journal.intents).toEqual(retained.journal.intents)
  expect(final.getState().inputs.map(input => input.input)).toEqual(retained.inputs.map(input => input.input))
  expect(source.requests).toHaveLength(2); expect(source.writes).toBe(2)
  expect(source.requests[1]!.coverage.flatMap(item => item.intentIds)).toEqual(successor.action.intentIds)
  expect(JSON.stringify(source.requests[0])).toBe(firstRequest)
  expect(source.snapshot().rows[0]!.document).toEqual(expected)
  const checkpoint = await measure('exportCheckpoint', () => final.exportCheckpoint())
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  const report = { mode, commands: count, actions: batches.length, ms, durableWrites: storage.writes.length,
    journalBytes: bytes(final.getState().journal), recordBytes: bytes(storage.root!.record), checkpointBytes: bytes(checkpoint.metadata),
    frontierNodes: final.getState().journal.frontiers.nodes.length }
  await saveWorkflowMeasurement(report)
}, 30000)
