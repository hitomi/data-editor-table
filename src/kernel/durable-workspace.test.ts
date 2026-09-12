import { describe, expect, it, vi } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { deferred, SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId } from './model.js'
import { Workspace } from './workspace.js'

let serial = 0
async function setup() {
  const scope = { sourceId: `durable-workspace:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { value: 0, hidden: 'preserved' } })
  const options = { scope, schema: permissiveSchema, policy: permissivePolicy, source }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`workspace:${serial}`), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })
  expect((await workspace.refresh()).kind).toBe('accepted')
  return { workspace, storage, source, options }
}
function prepared(workspace: Workspace, value: number) {
  const fixture = new KernelFixture(undefined, workspace.schema); fixture.state = workspace.getState()
  // Fresh fixtures still require fresh action IDs across the whole history.
  const offset = ++serial
  for (let index = 0; index < offset; index++) fixture.next()
  return fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { value })])
}
async function edit(workspace: Workspace, value: number) {
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared: prepared(workspace, value) })).kind).toBe('accepted')
}
const preview = (workspace: Workspace) => workspace.getProjection().rows[0]?.preview

describe('unified durable Workspace execution', () => {
  it('does not release a new source request on a positive storage receipt from an earlier semantic commit', async () => {
    const { workspace, storage, source } = await setup()
    await edit(workspace, 1)
    const earlier = storage.root!.record.commit
    storage.beforeCommit = async write => {
      if (write.record.event.kind === 'freeze-submission') storage.corruptResponse = result => ({ ...result, commit: earlier })
    }
    expect((await workspace.save()).kind).toBe('blocked')
    expect(workspace.getStorageStatus()?.kind).toBe('unknown')
    const reserved = storage.root!.record.transition.state.persistence
    if (!('submission' in reserved)) throw new Error('Expected durable reservation')
    const original = JSON.stringify(reserved.submission)
    expect((await workspace.reconcileStorage()).kind).toBe('unresolved')
    expect(source.requests).toEqual([]); expect(source.writes).toBe(0)
    expect(workspace.getState().persistence.kind).toBe('idle')
    storage.corruptResponse = null; storage.beforeCommit = null
    expect((await workspace.reconcileStorage()).kind).toBe('accepted')
    expect((await workspace.recover()).kind).toBe('unresolved')
    expect(source.requests).toEqual([])
    expect((await workspace.recover('retry')).kind).toBe('committed')
    expect(source.requests).toEqual([reserved.submission]); expect(source.writes).toBe(1)
    expect(JSON.stringify(source.requests[0])).toBe(original)
    expect(preview(workspace)).toEqual({ value: 1, hidden: 'preserved' })
  })

  it('restores an in-flight undo without compensating a definitively rejected save or overwriting remote changes', async () => {
    const { workspace, storage, source, options } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    await edit(workspace, 1)
    source.submitHook = async (_submission, execute) => { entered.resolve(); await gate.promise; return execute() }
    const saving = workspace.save(); await entered.promise
    const request = JSON.stringify(source.requests[0])
    expect((await workspace.undo()).kind).toBe('accepted')
    const undone = workspace.getState()
    const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(reopened.getState().journal).toEqual(undone.journal)
    expect(reopened.getState().inputs).toEqual(undone.inputs)
    source.external({ a: { value: 9, hidden: 'remote' } })
    gate.resolve(); expect((await saving).kind).toBe('unresolved')
    expect((await reopened.recover()).kind).toBe('not-applied')
    expect((await reopened.refresh()).kind).toBe('accepted')
    expect(preview(reopened)).toEqual({ value: 9, hidden: 'remote' })
    expect(reopened.getProjection().changes).toEqual([])
    expect(await reopened.save()).toEqual({ kind: 'blocked', issue: { code: 'workspace-runtime', message: 'There are no saveable intent groups.' } })
    const final = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(preview(final)).toEqual({ value: 9, hidden: 'remote' })
    expect(final.getState().journal).toEqual(undone.journal)
    expect(final.getState().inputs.map(({ ref, input }) => ({ ref, input }))).toEqual(undone.inputs.map(({ ref, input }) => ({ ref, input })))
    expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 9, hidden: 'remote' }])
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(0)
    expect(JSON.stringify(source.requests[0])).toBe(request)
  })

  it('restores an accepted undo during an in-flight save and compensates only the exact committed document', async () => {
    const { workspace, storage, source, options } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    source.normalize = document => ({ ...document, value: Number(document.value) + 0.5, hidden: 'canonical' })
    await edit(workspace, 1)
    source.submitHook = async (_submission, execute) => { entered.resolve(); await gate.promise; return execute() }
    const saving = workspace.save(); await entered.promise
    const request = JSON.stringify(source.requests[0])
    expect((await workspace.undo()).kind).toBe('accepted')
    const undone = workspace.getState()
    expect(storage.root?.record.transition.state).toEqual(undone)
    const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(reopened.getState().journal).toEqual(undone.journal)
    expect(reopened.getState().inputs).toEqual(undone.inputs)
    expect((await reopened.recover()).kind).toBe('unresolved')
    expect(source.writes).toBe(0); expect(source.requests).toHaveLength(1)
    gate.resolve()
    expect((await saving).kind).toBe('unresolved')
    expect(workspace.getState()).toBe(undone)
    expect((await reopened.recover()).kind).toBe('committed')
    expect(preview(reopened)).toEqual({ value: 0, hidden: 'canonical' })
    expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 1.5, hidden: 'canonical' }])
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
    expect(JSON.stringify(source.requests[0])).toBe(request)
    source.submitHook = null; source.normalize = document => document
    expect((await reopened.save()).kind).toBe('committed')
    expect(source.requests[1]?.items[0]).toMatchObject({ kind: 'update', before: { value: 1.5, hidden: 'canonical' }, after: { value: 0, hidden: 'canonical' } })
    const final = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(preview(final)).toEqual({ value: 0, hidden: 'canonical' })
    expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 0, hidden: 'canonical' }])
    expect(final.getState().journal).toEqual(undone.journal)
    expect(final.getState().inputs.map(({ ref, input }) => ({ ref, input }))).toEqual(undone.inputs.map(({ ref, input }) => ({ ref, input })))
    expect(source.requests).toHaveLength(2); expect(source.writes).toBe(2)
    expect(JSON.stringify(source.requests[0])).toBe(request)
  })

  it('refuses to expose an empty new workspace over an existing durable root', async () => {
    const { workspace, storage, options } = await setup()
    await edit(workspace, 1)
    await expect(Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })).rejects.toThrow('explicit restoration')
    const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(preview(restored)?.value).toBe(1)
    expect(restored.getState().inputs[0]?.disposition.kind).toBe('intents')
  })

  it('persists a reservation before source I/O and commits canonical authority before reporting save success', async () => {
    const { workspace, storage, source, options } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    await edit(workspace, 1)
    source.normalize = document => ({ ...document, value: 10 })
    storage.beforeCommit = async write => { if (write.record.event.kind === 'freeze-submission') { entered.resolve(); await gate.promise } }
    source.submitHook = async (submission, execute) => {
      expect(storage.root?.record.transition.state.persistence).toMatchObject({ kind: 'sending', submission })
      expect(workspace.getState().persistence).toMatchObject({ kind: 'sending', submission })
      return execute()
    }
    const saving = workspace.save()
    await entered.promise
    expect(source.requests).toHaveLength(0); expect(workspace.getState().persistence.kind).toBe('idle')
    gate.resolve()
    expect((await saving).kind).toBe('committed')
    expect(preview(workspace)).toEqual({ value: 10, hidden: 'preserved' })
    expect(storage.root?.record.transition.state).toEqual(workspace.getState())
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('settled-intents')
    source.submitHook = null
    const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(preview(reopened)).toEqual(preview(workspace))
    await edit(reopened, 11)
    source.normalize = document => document
    expect((await reopened.save()).kind).toBe('committed')
    expect(preview(reopened)).toEqual({ value: 11, hidden: 'preserved' })
    expect(source.requests).toHaveLength(2)
  })

  it('keeps a lost freeze acknowledgement unsent until storage lookup and then coordinates the exact original request', async () => {
    const { workspace, storage, source } = await setup()
    await edit(workspace, 1)
    storage.beforeCommit = async write => { if (write.record.event.kind === 'freeze-submission') storage.loseResponse = true }
    expect((await workspace.save()).kind).toBe('blocked')
    expect(workspace.getStorageStatus()?.kind).toBe('unknown'); expect(source.requests).toEqual([])
    expect(workspace.getState().persistence.kind).toBe('idle')
    expect((await workspace.recover()).kind).toBe('blocked')
    storage.beforeCommit = null
    expect((await workspace.reconcileStorage()).kind).toBe('accepted')
    const state = workspace.getState().persistence
    if (!('submission' in state)) throw new Error('Expected original reservation')
    expect((await workspace.recover()).kind).toBe('unresolved')
    expect(source.lookups).toBe(1); expect(source.requests).toEqual([])
    expect((await workspace.recover('retry')).kind).toBe('committed')
    expect(source.requests).toEqual([state.submission]); expect(preview(workspace)?.value).toBe(1)
  })

  it('releases only an unused gateway permit after a lost definitive storage rejection is reconciled', async () => {
    const { workspace, storage, source } = await setup()
    await edit(workspace, 1)
    storage.beforeCommit = async write => {
      if (write.record.event.kind === 'freeze-submission') { storage.rejectNext = true; storage.loseResponse = true }
    }
    expect((await workspace.save()).kind).toBe('blocked')
    expect(source.requests).toEqual([])
    storage.beforeCommit = null
    expect((await workspace.reconcileStorage()).kind).toBe('rejected')
    expect(preview(workspace)?.value).toBe(1)
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.requests).toHaveLength(1)
  })

  it('retains an exact source receipt rejected by storage and retries its admission without another source write', async () => {
    const { workspace, storage, source } = await setup()
    await edit(workspace, 1)
    storage.beforeCommit = async write => { if (write.record.event.kind === 'exact-receipt') storage.rejectNext = true }
    expect((await workspace.save()).kind).toBe('unresolved')
    expect(source.writes).toBe(1)
    const retained = workspace.getIngress().pending.find(entry => entry.payload.kind === 'event' && entry.payload.event.kind === 'exact-receipt')!
    expect(retained.phase).toBe('rejected')
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('intents')
    storage.beforeCommit = null
    expect(await workspace.retryIngress(retained.id, workspace.getIngress().generation).completion).toMatchObject({ kind: 'completed', transition: { result: { kind: 'accepted' } } })
    expect((await workspace.recover()).kind).toBe('committed')
    expect(source.requests).toHaveLength(1); expect(workspace.getState().inputs[0]?.disposition.kind).toBe('settled-intents')
  })

  it('hands an in-flight operation to a restored lease and keeps late work from the fenced runtime out of published state', async () => {
    const { workspace, storage, source, options } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    await edit(workspace, 1)
    source.submitHook = async (_submission, execute) => { entered.resolve(); await gate.promise; return execute() }
    const saving = workspace.save(); await entered.promise
    const before = workspace.getState()
    const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(workspace.getStorageStatus()?.kind).toBe('fenced')
    expect((await reopened.recover()).kind).toBe('unresolved')
    expect(source.requests).toHaveLength(1)
    gate.resolve()
    expect((await saving).kind).toBe('unresolved')
    expect(workspace.getState()).toBe(before)
    expect((await reopened.recover()).kind).toBe('committed')
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
    expect(preview(reopened)).toEqual({ value: 1, hidden: 'preserved' })
    expect(storage.root?.record.transition.state).toEqual(reopened.getState())
  })

  it('recovers a committed receipt with lost local acknowledgement even when the restored kernel is already idle', async () => {
    const { workspace, storage, source, options } = await setup()
    await edit(workspace, 1)
    storage.beforeCommit = async write => {
      if (write.record.event.kind === 'server-authority-received' && write.record.transition.state.commits.length) storage.loseResponse = true
    }
    expect((await workspace.save()).kind).toBe('unresolved')
    expect(storage.root?.record.transition.state.persistence.kind).toBe('idle')
    storage.beforeCommit = null
    const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(reopened.getState().persistence.kind).toBe('idle')
    expect((await reopened.recover()).kind).toBe('committed')
    expect(source.requests).toHaveLength(1)
    await edit(reopened, 2)
    expect((await reopened.save()).kind).toBe('committed')
  })

  it('retains rejected resource registration bytes, detaches restored editors durably, and rejects nonrecoverable task callbacks', async () => {
    const { workspace, storage, options } = await setup()
    storage.rejectNext = true
    await expect(workspace.registerResource(new File(['body'], 'retained.txt', { lastModified: 7 }))).rejects.toThrow('not committed')
    const rejected = workspace.getIngress().pending.at(-1)!
    if (rejected.payload.kind !== 'event' || rejected.payload.event.kind !== 'resource-registered') throw new Error('Expected retained registration')
    const resourceId = rejected.payload.event.descriptor.id
    await workspace.retryIngress(rejected.id, workspace.getIngress().generation).completion
    expect(await workspace.getResource(resourceId).text()).toBe('body')
    await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('editor'), inputId: kernelId<'input'>('editor'), viewId: kernelId<'view'>('old'),
      target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'resource', id: resourceId }, reads: [] })
    const execute = vi.fn(), task = workspace.runTask({ owner: { kind: 'workspace', workspaceId: workspace.getState().workspace.id }, input: { kind: 'resource', id: resourceId }, reads: [] }, execute)
    expect((await task.result).kind).toBe('rejected'); expect(execute).not.toHaveBeenCalled()
    const reopened = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
    expect(reopened.getState().session?.editor).toBeNull()
    expect(reopened.getState().session?.rawInput).toEqual({ kind: 'resource', id: resourceId })
    expect(storage.root?.record.transition.state.session?.editor).toBeNull()
    expect((reopened.getResource(resourceId) as File).name).toBe('retained.txt')
  })
})

it('retains exact-commit display and successor input through failed authority reads and durable reopening', async () => {
  const { workspace, storage, source, options } = await setup()
  source.normalize = document => ({ ...document, value: Number(document.value) + 0.5, hidden: 'canonical' })
  source.submitHook = async (_request, execute) => {
    const result = execute()
    source.readHook = async () => { throw new Error('Post-commit authority unavailable') }
    return result
  }
  await edit(workspace, 1)
  const first = workspace.getState().journal.intents[0]!
  expect((await workspace.save()).kind).toBe('unresolved')
  expect(workspace.getState().persistence.kind).toBe('committed-awaiting-authority')
  expect(workspace.getState().settlements).toEqual([])
  expect(preview(workspace)).toEqual({ value: 1, hidden: 'preserved' })
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 1.5, hidden: 'canonical' }])
  const request = JSON.stringify(source.requests[0]), commits = workspace.getState().commits
  expect(commits).toHaveLength(1)
  await edit(workspace, 2)
  const original = workspace.getState().journal.intents, inputs = workspace.getState().inputs
  expect(preview(workspace)).toEqual({ value: 2, hidden: 'preserved' })
  const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(preview(restored)).toEqual({ value: 2, hidden: 'preserved' })
  expect(restored.getState().commits).toEqual(commits)
  expect((await restored.recover()).kind).toBe('unresolved')
  expect(preview(restored)).toEqual({ value: 2, hidden: 'preserved' })
  expect(restored.getState().settlements).toEqual([])
  expect(restored.getState().journal.intents).toEqual(original)
  expect(restored.getState().inputs).toEqual(inputs)
  expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1); expect(source.lookups).toBe(0)
  expect(JSON.stringify(source.requests[0])).toBe(request)
  source.readHook = null; source.submitHook = null
  expect((await restored.recover()).kind).toBe('committed')
  expect(preview(restored)).toEqual({ value: 2, hidden: 'canonical' })
  expect(restored.getState().settlements.map(proof => proof.intentId)).toEqual([first.id])
  expect(restored.getState().inputs.map(input => input.disposition.kind)).toEqual(['settled-intents', 'intents'])
  expect(restored.getState().journal.intents).toEqual(original)
  expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
  expect((await restored.save()).kind).toBe('committed')
  expect(source.requests[1]!.items[0]).toMatchObject({ kind: 'update', before: { value: 1.5, hidden: 'canonical' }, after: { value: 2, hidden: 'canonical' } })
  expect(source.writes).toBe(2)
  const final = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(preview(final)).toEqual({ value: 2.5, hidden: 'canonical' })
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 2.5, hidden: 'canonical' }])
  expect(final.getState().journal.intents).toEqual(original)
})
