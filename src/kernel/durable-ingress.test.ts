import { describe, expect, it } from 'vitest'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { DurableTaskFixture } from '../../tests/kernel/durable-task-fixture.js'
import { kernelId } from './model.js'
import { Workspace } from './workspace.js'
import { validateRecoveryWrite } from './recovery-store.js'

let serial = 0
async function setup() {
  const scope = { sourceId: `durable-ingress:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0 } }), service = new DurableTaskFixture()
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy, tasks: [service.definition] }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>(`workspace:${serial}`), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const restore = () => Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  const workspace = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })
  await workspace.refresh()
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('editor'), inputId: kernelId<'input'>('input'),
    viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'original' }, reads: [] })
  return { workspace, storage, service, restore }
}

describe('Workspace ingress in durable roots', () => {
  it('persists the complete IME predecessor chain and isolates late composition from a restored editor', async () => {
    const { workspace, storage, restore } = await setup(), lease = workspace.getState().session!.editor!
    const entered = deferred<void>(), gate = deferred<void>(), start = storage.writes.length
    storage.beforeCommit = async () => { storage.beforeCommit = null; entered.resolve(); await gate.promise }
    const first = workspace.typeInput(lease, { kind: 'encoded', value: 'n' }, 'composing')
    await entered.promise
    const second = workspace.typeInput(lease, { kind: 'encoded', value: 'ni' }, 'composing')
    const third = workspace.typeInput(lease, { kind: 'encoded', value: '你' }, 'idle')
    const pending = workspace.getIngress().pending
    expect(pending.map(entry => entry.payload.kind === 'input' ? entry.payload.envelope : null)).toMatchObject([
      { inputSequence: 1, predecessor: { kind: 'published', inputVersion: 0 }, input: { value: 'n' }, composition: 'composing' },
      { inputSequence: 2, predecessor: { kind: 'ingress', id: first.id }, input: { value: 'ni' }, composition: 'composing' },
      { inputSequence: 3, predecessor: { kind: 'ingress', id: second.id }, input: { value: '你' }, composition: 'idle' },
    ])
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(workspace.getInputProjection(lease)?.input).toEqual({ kind: 'encoded', value: '你' })
    gate.resolve(); await Promise.all([first.completion, second.completion, third.completion])
    expect(storage.writes.slice(start).map(write => [write.record.transition.state.session?.rawInput, write.record.transition.state.session?.composition])).toEqual([
      [{ kind: 'encoded', value: 'n' }, 'composing'], [{ kind: 'encoded', value: 'ni' }, 'composing'], [{ kind: 'encoded', value: '你' }, 'idle'],
    ])
    const originalInputs = workspace.getState().inputs
    const reopened = await restore()
    expect(reopened.getState().inputs).toEqual(originalInputs)
    expect(reopened.getState().session).toMatchObject({ rawInput: { kind: 'encoded', value: '你' }, composition: 'idle', editor: null })
    expect((await reopened.dispatch({ kind: 'session-attached', sessionId: reopened.getState().session!.id, viewId: kernelId<'view'>('new-ime-view') })).kind).toBe('accepted')
    const current = reopened.getState().session!.editor!
    await reopened.typeInput(current, { kind: 'encoded', value: '新的输入' }, 'idle').completion
    const late = reopened.enqueueInput({ ingressId: kernelId<'ingress'>('late-ime'), lease, inputSequence: 4,
      predecessor: { kind: 'ingress', id: third.id }, input: { kind: 'encoded', value: '旧视图的迟到组合输入' }, composition: 'composing' })
    await late.completion
    expect(reopened.getState().session).toMatchObject({ editor: current, rawInput: { value: '新的输入' }, composition: 'idle' })
    const retained = reopened.getIngress().pending.find(entry => entry.id === late.id)!
    expect(retained).toMatchObject({ payload: { kind: 'input', envelope: { lease, input: { value: '旧视图的迟到组合输入' }, composition: 'composing' } } })
    const final = await restore()
    expect(final.getState().session).toMatchObject({ rawInput: { value: '新的输入' }, composition: 'idle', editor: null })
    expect(final.getIngress().pending.find(entry => entry.id === late.id)).toEqual(retained)
    expect(final.getState().inputs.slice(0, originalInputs.length).map(({ ref, input }) => ({ ref, input }))).toEqual(originalInputs.map(({ ref, input }) => ({ ref, input })))
  })

  it('persists a rejected original input before completing without a later successful command', async () => {
    const { workspace, storage, restore } = await setup(), before = workspace.getState()
    const result = await workspace.dispatch({ kind: 'session-opened', revision: before.revision - 1,
      sessionId: kernelId<'session'>('stale-editor'), inputId: kernelId<'input'>('stale-input'), viewId: kernelId<'view'>('view'),
      target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, reads: [], input: { kind: 'encoded', value: 'unsaved original' } })
    expect(result.kind).toBe('rejected')
    expect(workspace.getState()).toBe(before)
    const retained = workspace.getIngress().pending
    expect(retained).toHaveLength(1)
    expect(storage.root!.record.ingress!.snapshot.pending).toEqual(retained)
    const write = storage.root!
    await expect(validateRecoveryWrite({ ...write, record: { ...write.record,
      transition: { ...write.record.transition, result: { kind: 'unresolved', issue: { code: 'unknown', message: 'Not a completed receipt' } } } } }, before.workspace)).rejects.toThrow('terminal transition')
    expect((await restore()).getIngress().pending).toEqual(retained)
  })

  it('chains an ignored receipt and the next accepted input through exact storage roots', async () => {
    const { workspace, storage, restore } = await setup(), before = workspace.getState(), parent = storage.root!.record.commit.token
    expect((await workspace.dispatch({ kind: 'task-cancelled', taskId: kernelId<'task'>('absent'), executionId: 'obsolete' })).kind).toBe('ignored')
    const ignored = storage.root!
    expect(ignored.record.commit.parent?.token).toEqual(parent)
    expect(ignored.record.commit.semanticRevision).toBe(before.revision)
    expect(ignored.record.transition.effects).toEqual([])
    expect(ignored.record.ingress!.snapshot.receipts.at(-1)?.disposition).toBe('ignored')
    expect(workspace.getState()).toBe(before)
    await workspace.typeInput(before.session!.editor!, { kind: 'encoded', value: 'next input' }).completion
    expect(storage.root!.record.commit.parent?.token).toEqual(ignored.record.commit.token)
    expect(storage.root!.record.commit.semanticRevision).toBe(before.revision + 1)
    expect((await restore()).getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'next input' })
  })

  it('keeps a semantic rejection pending until its ownership receipt is durable', async () => {
    const { workspace, storage, restore } = await setup(), before = workspace.getState(), root = storage.root
    const entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async () => { storage.beforeCommit = null; entered.resolve(); await gate.promise }
    let completed = false
    const opening = workspace.dispatch({ kind: 'session-opened', revision: before.revision - 1,
      sessionId: kernelId<'session'>('stale'), inputId: kernelId<'input'>('stale'), viewId: kernelId<'view'>('view'),
      target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, reads: [], input: { kind: 'encoded', value: 'retained' } }).then(result => { completed = true; return result })
    await entered.promise
    expect(completed).toBe(false)
    expect(workspace.getState()).toBe(before)
    expect(storage.root).toEqual(root)
    expect(workspace.getIngress().pending).toMatchObject([{ phase: 'committing' }])
    gate.resolve()
    expect((await opening).kind).toBe('rejected')
    expect(workspace.getState()).toBe(before)
    expect((await restore()).getIngress().pending).toMatchObject([{ phase: 'rejected' }])
  })

  it('recovers the exact ownership receipt after a rejected command loses its storage response', async () => {
    const { workspace, storage, restore } = await setup(), before = workspace.getState()
    storage.loseResponse = true
    expect((await workspace.dispatch({ kind: 'session-opened', revision: before.revision - 1,
      sessionId: kernelId<'session'>('stale'), inputId: kernelId<'input'>('stale'), viewId: kernelId<'view'>('view'),
      target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, reads: [], input: { kind: 'encoded', value: 'retained' } })).kind).toBe('unresolved')
    expect(workspace.getStorageStatus()?.kind).toBe('unknown')
    const checkpoint = await workspace.exportCheckpoint(), count = storage.writes.length, commit = storage.root!.record.commit
    expect(checkpoint.metadata.storage.kind).toBe('durable')
    expect((await workspace.reconcileStorage()).kind).toBe('rejected')
    expect(storage.queries.at(-1)).toEqual(commit)
    expect(storage.writes).toHaveLength(count)
    expect(workspace.getState()).toBe(before)
    expect(workspace.getIngress().pending).toMatchObject([{ phase: 'rejected' }])
    expect((await restore()).getIngress().pending).toMatchObject([{ phase: 'rejected' }])
  })

  it('prepares the input receipt without publishing it before the storage transaction completes', async () => {
    const { workspace, storage } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async write => {
      expect(write.record.ingress!.snapshot.pending).toEqual([])
      expect(write.record.ingress!.snapshot.receipts.at(-1)?.disposition).toBe('accepted')
      entered.resolve(); await gate.promise
    }
    const root = storage.root, typing = workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'new input' })
    await entered.promise
    expect(storage.root).toEqual(root)
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(workspace.getIngress().pending).toMatchObject([{ id: typing.id, phase: 'committing' }])
    expect(workspace.getIngress().receipts.some(receipt => receipt.id === typing.id)).toBe(false)
    gate.resolve(); await typing.completion
    expect(storage.root!.record.ingress!.snapshot).toEqual(workspace.getIngress())
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'new input' })
  })

  it('persists a blocked successor without a refresh after its predecessor was rejected', async () => {
    const { workspace, storage, restore } = await setup(), lease = workspace.getState().session!.editor!
    storage.rejectNext = true
    const first = workspace.typeInput(lease, { kind: 'encoded', value: 'first' }); await first.completion
    const second = workspace.typeInput(lease, { kind: 'encoded', value: 'second' }); await second.completion
    const retained = workspace.getIngress().pending
    expect(retained.map(entry => entry.phase)).toEqual(['rejected', 'blocked'])
    expect(storage.root!.record.ingress!.snapshot.pending).toEqual(retained)
    expect((await restore()).getIngress().pending).toEqual(retained)
  })

  it('persists rejected resolution material and task preparation input before returning', async () => {
    const { workspace, storage, restore, service } = await setup(), before = workspace.getState()
    expect((await workspace.resolve({ revision: before.revision - 1, observation: kernelId<'observation'>('stale'), issueIds: [],
      target: { kind: 'order' }, choice: { kind: 'merge', commands: [], input: { kind: 'encoded', value: 'merge original' } } })).kind).toBe('rejected')
    const session = before.session!
    const task = workspace.runDurableTask({ definition: { id: 'missing', version: 'v1' }, owner: { kind: 'session', sessionId: session.id, input: session.input },
      input: { kind: 'encoded', value: 'task original' }, reads: [] })
    expect((await task.result).kind).toBe('rejected')
    expect(service.requests).toEqual([])
    expect(workspace.getState()).toBe(before)
    const retained = workspace.getIngress().pending
    expect(retained).toHaveLength(2)
    expect(storage.root!.record.ingress!.snapshot.pending).toEqual(retained)
    expect((await restore()).getIngress().pending).toEqual(retained)
  })

  it('retains rejected predecessor chains through detach, new editing, disposition and another restore', async () => {
    const { workspace, storage, restore } = await setup(), lease = workspace.getState().session!.editor!
    storage.rejectNext = true
    const first = workspace.typeInput(lease, { kind: 'encoded', value: 'first rejected' }); await first.completion
    const second = workspace.typeInput(lease, { kind: 'encoded', value: 'second retained' }); await second.completion
    await workspace.refresh()
    const before = workspace.getIngress().pending, restored = await restore()
    expect(restored.getIngress().pending).toEqual(before)
    expect(restored.getState().session?.editor).toBeNull()
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    await restored.dispatch({ kind: 'session-attached', sessionId: restored.getState().session!.id, viewId: kernelId<'view'>('new-view') })
    const newLease = restored.getState().session!.editor!
    await restored.typeInput(newLease, { kind: 'encoded', value: 'new lease input' }).completion
    expect(restored.getInputProjection(newLease)?.input).toEqual({ kind: 'encoded', value: 'new lease input' })
    const returned = await restored.disposeIngress([first.id, second.id], restored.getIngress().generation, 'returned')
    expect(returned).toEqual(before.map(entry => entry.payload))
    await restored.refresh()
    const again = await restore()
    expect(again.getIngress().pending).toEqual([])
    expect(again.getIngress().receipts.filter(receipt => receipt.id === first.id || receipt.id === second.id).map(receipt => receipt.disposition)).toEqual(['returned', 'returned'])
    expect(again.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'new lease input' })
  })

  it('recovers the original rejected File registration and retries it with its retained bytes', async () => {
    const { workspace, storage, restore } = await setup()
    storage.rejectNext = true
    await expect(workspace.registerResource(new File(['retained body'], 'input.txt', { lastModified: 17 }))).rejects.toThrow()
    await workspace.refresh()
    const original = workspace.getIngress().pending[0]!, restored = await restore()
    expect(restored.getIngress().pending[0]).toEqual(original)
    if (original.payload.kind !== 'event' || original.payload.event.kind !== 'resource-registered') throw new Error('Expected registration')
    const resourceId = original.payload.event.descriptor.id
    expect(() => restored.getResource(resourceId)).toThrow('no longer available')
    expect((await restored.retryIngress(original.id, restored.getIngress().generation).completion).kind).toBe('completed')
    expect(await restored.getResource(resourceId).text()).toBe('retained body')
    const again = await restore()
    expect(again.getIngress().pending).toEqual([])
    expect((again.getResource(resourceId) as File).name).toBe('input.txt')
    expect(again.getIngress().receipts.find(receipt => receipt.id === original.id)?.disposition).toBe('accepted')
  })

  it('stores a published receipt atomically and restores queued successors for review without starting a task', async () => {
    const { workspace, storage, service, restore } = await setup(), session = workspace.getState().session!
    storage.loseResponse = true
    const task = workspace.runDurableTask({ definition: service.definition.ref, owner: { kind: 'session', sessionId: session.id, input: session.input }, input: { kind: 'encoded', value: 'task' }, reads: [] })
    const successor = workspace.typeInput(session.editor!, { kind: 'encoded', value: 'queued input' })
    expect((await task.result).kind).toBe('unresolved')
    expect(storage.root!.record.ingress!.snapshot.pending).toMatchObject([{ id: successor.id, phase: 'queued' }])
    const restored = await restore()
    expect(restored.getState().tasks).toHaveLength(1)
    expect(restored.getIngress().pending).toMatchObject([{ id: successor.id, phase: 'blocked', payload: { envelope: { input: { value: 'queued input' } } } }])
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(service.requests).toEqual([])
    expect(restored.getIngress().receipts.filter(receipt => receipt.disposition === 'accepted')).toHaveLength(workspace.getIngress().receipts.length + 2)
    expect((await restore()).getIngress().pending).toEqual(restored.getIngress().pending)
  })

  it('persists cancellation dispositions in the same root as the accepted cancellation', async () => {
    const { workspace, storage, restore } = await setup(), session = workspace.getState().session!
    storage.rejectNext = true
    const rejected = workspace.typeInput(session.editor!, { kind: 'encoded', value: 'cancelled input' }); await rejected.completion
    await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
    expect(storage.root!.record.ingress!.snapshot.pending).toEqual([])
    const restored = await restore()
    expect(restored.getState().session).toBeNull()
    expect(restored.getIngress().pending).toEqual([])
    expect(restored.getIngress().receipts.find(receipt => receipt.id === rejected.id)?.disposition).toBe('discarded')
  })

  it('preserves an invalid raw resource reference without inventing bytes or blocking independent commits', async () => {
    const { workspace, restore } = await setup()
    const missing = kernelId<'resource'>('never-provided')
    const raw = workspace.typeInput(workspace.getState().session!.editor!, { kind: 'resource', id: missing }); await raw.completion
    await workspace.refresh()
    const restored = await restore()
    expect(restored.getIngress().pending).toMatchObject([{ id: raw.id, payload: { envelope: { input: { kind: 'resource', id: missing } } } }])
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(() => restored.getResource(missing)).toThrow('no longer available')
    await expect(restored.exportCheckpoint()).rejects.toThrow('unavailable checkpoint bytes')
  })

  it('rejects ingress corruption even when semantic state and physical content are unchanged', async () => {
    const { workspace, storage } = await setup(), root = storage.root!
    const ingress = root.record.ingress!
    await expect(validateRecoveryWrite({ ...root, record: { ...root.record, ingress: { ...ingress, snapshot: { ...ingress.snapshot, receipts: [] } } } }, workspace.getState().workspace)).rejects.toThrow('digest')
    await expect(validateRecoveryWrite({ ...root, record: { ...root.record, ingress: { ...ingress, revision: ingress.revision - 1 } } }, workspace.getState().workspace)).rejects.toThrow('exact semantic')
  })

  async function retainedWorkspace() {
    const context = await setup(), { workspace } = context
    await workspace.dispatch({ kind: 'view-query-set', expectedVersion: 99, filters: [], sort: [] })
    const session = workspace.getState().session!
    await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
    return { ...context, original: workspace.getIngress().pending[0]! }
  }

  it('persists disposition itself so immediate restoration needs no refresh or clean-close flush', async () => {
    const { workspace, storage, original, restore } = await retainedWorkspace(), before = workspace.getState()
    await workspace.disposeIngress([original.id], workspace.getIngress().generation, 'returned')
    expect(storage.root!.record.event.kind).toBe('ingress-disposed')
    expect(storage.root!.record.ingress!.snapshot.pending).toEqual([])
    const root = storage.root!
    await expect(validateRecoveryWrite({ ...root, record: { ...root.record, ingress: null } }, workspace.getState().workspace)).rejects.toThrow('complete published ingress receipts')
    const ingress = root.record.ingress!
    await expect(validateRecoveryWrite({ ...root, record: { ...root.record, ingress: { ...ingress, snapshot: { ...ingress.snapshot,
      receipts: ingress.snapshot.receipts.filter(receipt => receipt.id !== original.id) } } } }, workspace.getState().workspace)).rejects.toThrow('complete published ingress receipts')
    expect(workspace.getState().inputs).toEqual(before.inputs)
    const restored = await restore()
    expect(restored.getIngress().pending).toEqual([])
    expect(restored.getIngress().receipts.find(receipt => receipt.id === original.id)?.disposition).toBe('returned')
    const writes = storage.writes.length
    expect((await restored.close(restored.requestClose().ticket, 'clean-close')).kind).toBe('closed')
    expect(storage.writes).toHaveLength(writes)
  })

  it('retains requests after a rejected disposition and requires a fresh review rather than replaying the old review', async () => {
    const { workspace, storage, original, restore } = await retainedWorkspace(), root = storage.root
    storage.rejectNext = true
    await expect(workspace.disposeIngress([original.id], workspace.getIngress().generation, 'discarded')).rejects.toThrow()
    expect(storage.root).toEqual(root)
    expect(workspace.getIngress().pending).toContainEqual(original)
    const failed = workspace.getIngress().pending.find(entry => entry.id !== original.id)!
    const retry = await workspace.retryIngress(failed.id, workspace.getIngress().generation).completion
    expect(retry).toMatchObject({ kind: 'completed', transition: { result: { kind: 'rejected' } } })
    await workspace.disposeIngress(workspace.getIngress().pending.map(entry => entry.id), workspace.getIngress().generation, 'discarded')
    expect((await restore()).getIngress().pending).toEqual([])
  })

  it('retains later input while publishing only the disposition set reviewed before the write', async () => {
    const { workspace, storage, original, restore } = await retainedWorkspace(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async () => { storage.beforeCommit = null; entered.resolve(); await gate.promise }
    const disposing = workspace.disposeIngress([original.id], workspace.getIngress().generation, 'returned')
    await entered.promise
    expect(workspace.getIngress().pending).toContainEqual(original)
    const opening = workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('later-editor'), inputId: kernelId<'input'>('later-input'),
      viewId: kernelId<'view'>('later-view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'later input' }, reads: [] })
    gate.resolve(); await disposing
    expect((await opening).kind).toBe('rejected')
    expect(workspace.getIngress().pending.some(entry => entry.id === original.id)).toBe(false)
    await workspace.refresh()
    const restored = await restore()
    expect(restored.getIngress().pending).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ event: expect.objectContaining({ input: { kind: 'encoded', value: 'later input' } }) }) }))
    expect(restored.getIngress().receipts.find(receipt => receipt.id === original.id)?.disposition).toBe('returned')
  })

  it('keeps the reviewed requests visible after a lost receipt until the exact disposition commit is reconciled', async () => {
    const { workspace, storage, original, restore } = await retainedWorkspace()
    storage.loseResponse = true
    await expect(workspace.disposeIngress([original.id], workspace.getIngress().generation, 'discarded')).rejects.toThrow()
    expect(workspace.getStorageStatus()?.kind).toBe('unknown')
    expect(workspace.getIngress().pending).toContainEqual(original)
    const writes = storage.writes.length, commit = storage.root!.record.commit
    expect((await workspace.reconcileStorage()).kind).toBe('accepted')
    expect(storage.queries.at(-1)).toEqual(commit)
    expect(storage.writes).toHaveLength(writes)
    expect(workspace.getIngress().pending).toEqual([])
    expect((await restore()).getIngress().pending).toEqual([])
  })

  it('requires the complete rejected input chain and retains a dependent input arriving after review', async () => {
    const { workspace, storage, restore } = await setup(), lease = workspace.getState().session!.editor!
    storage.rejectNext = true
    const first = workspace.typeInput(lease, { kind: 'encoded', value: 'first' }); await first.completion
    const second = workspace.typeInput(lease, { kind: 'encoded', value: 'second' }); await second.completion
    const before = workspace.getIngress()
    await expect(workspace.disposeIngress([first.id], before.generation, 'discarded')).rejects.toThrow('complete dependent')
    expect(workspace.getIngress()).toBe(before)
    const entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCommit = async () => { storage.beforeCommit = null; entered.resolve(); await gate.promise }
    const disposing = workspace.disposeIngress([first.id, second.id], before.generation, 'discarded')
    await entered.promise
    const late = workspace.typeInput(lease, { kind: 'encoded', value: 'late dependent' })
    gate.resolve(); await disposing; await late.completion
    expect(workspace.getIngress().pending).toMatchObject([{ id: late.id, phase: 'blocked' }])
    expect(workspace.getInputProjection(lease)?.input).toEqual({ kind: 'encoded', value: 'late dependent' })
    await workspace.refresh()
    const reopened = await restore()
    expect(reopened.getIngress().pending).toMatchObject([{ id: late.id, payload: { envelope: { input: { kind: 'encoded', value: 'late dependent' } } } }])
    expect(reopened.getIngress().receipts.filter(receipt => receipt.id === first.id || receipt.id === second.id).map(receipt => receipt.disposition)).toEqual(['discarded', 'discarded'])
  })
})
