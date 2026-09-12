import { describe, expect, it } from 'vitest'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { DurableCommitBarrier } from './durable-commit.js'
import { Workspace } from './workspace.js'
import { createKernelState } from './state.js'
import { IngressQueue } from './ingress.js'
import { ResourceStore } from './resource-store.js'
import { createWorkspaceCheckpoint, type WorkspaceCheckpoint } from './checkpoint.js'
import { kernelId } from './model.js'

let serial = 0
async function setup() {
  const scope = { sourceId: `checkpoint-restore:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0 } })
  const initialState = createKernelState({ id: kernelId<'workspace'>(`workspace:${serial}`), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec }, permissivePolicy)
  const storage = new RecoveryFixture(initialState.workspace), session = storage.acquire()
  const workspace = await Workspace.openDurable({ scope, source, schema: permissiveSchema, policy: permissivePolicy, session, restore: false })
  await workspace.refresh()
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('input'), viewId: kernelId<'view'>('view'),
    target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'original' }, reads: [] })
  return { workspace, storage, session, initialState, schema: permissiveSchema }
}
function queueFor(restored: Awaited<ReturnType<typeof DurableCommitBarrier.restoreCheckpoint>>) {
  return IngressQueue.restore(restored.metadata.ingress, () => restored.barrier.getState(), event => restored.barrier.commit(event))
}

describe('checkpoint activation under a new durable lease', () => {
  it.each(['root', 'checkpoint-head'] as const)('rejects a delayed %s verification result after another lease takes ownership', async phase => {
    const { workspace, storage, initialState, schema } = await setup()
    const checkpoint = await workspace.exportCheckpoint(), original = JSON.stringify(checkpoint.metadata)
    const session = storage.acquire(), entered = deferred<void>(), gate = deferred<void>(), root = storage.root, writes = storage.writes.length
    const delayed = async <T>(load: () => Promise<T>) => {
      const value = await load(); entered.resolve(); await gate.promise; return value
    }
    const delayedSession: typeof session = {
      ...session,
      load: phase === 'root' ? () => delayed(() => session.load()) : session.load,
      checkpoints: { ...session.checkpoints, load: phase === 'checkpoint-head' ? () => delayed(() => session.checkpoints.load()) : session.checkpoints.load },
    }
    const restoring = DurableCommitBarrier.restoreCheckpoint({ initialState, schema, checkpoint, session: delayedSession }).then(value => ({ value }), error => ({ error }))
    await entered.promise
    const winner = storage.acquire()
    gate.resolve()
    expect(await restoring).toMatchObject({ error: { message: 'Checkpoint lease was lost during storage verification.' } })
    expect(storage.root).toEqual(root)
    expect(storage.writes).toHaveLength(writes)
    expect(JSON.stringify(checkpoint.metadata)).toBe(original)
    const recovered = await DurableCommitBarrier.restoreCheckpoint({ initialState, schema, checkpoint, session: winner })
    expect(recovered.barrier.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(recovered.barrier.getState()).toEqual(checkpoint.metadata.state)
    expect(storage.writes).toHaveLength(writes)
  })

  it('rejects missing checkpoint file bytes without altering the archive and restores the intact original', async () => {
    const { workspace, storage, initialState, schema } = await setup()
    await workspace.registerResource(new File(['原始文件'], 'input.txt', { lastModified: 17 }))
    const checkpoint = await workspace.exportCheckpoint(), original = JSON.stringify(checkpoint.metadata), root = storage.root, writes = storage.writes.length
    const session = storage.acquire()
    await expect(DurableCommitBarrier.restoreCheckpoint({ initialState, schema, session, checkpoint: { ...checkpoint, contents: [] } })).rejects.toThrow('Resource manifest and content must cover all available resources exactly once.')
    expect(storage.root).toEqual(root)
    expect(storage.writes).toHaveLength(writes)
    expect(JSON.stringify(checkpoint.metadata)).toBe(original)
    expect(await checkpoint.contents[0]!.blob.text()).toBe('原始文件')
    const restored = await DurableCommitBarrier.restoreCheckpoint({ initialState, schema, session, checkpoint })
    const file = restored.barrier.resources.get(checkpoint.contents[0]!.resourceId) as File
    expect(await file.text()).toBe('原始文件')
    expect(file.name).toBe('input.txt'); expect(file.lastModified).toBe(17)
    expect(restored.barrier.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(storage.writes).toHaveLength(writes)
  })

  it('preserves staged File bytes and retries a rejected registration using the new lease', async () => {
    const { workspace, storage, initialState, schema } = await setup()
    storage.rejectNext = true
    await expect(workspace.registerResource(new File(['body'], 'staged.txt', { lastModified: 9 }))).rejects.toThrow()
    const checkpoint = await workspace.exportCheckpoint(), session = storage.acquire()
    const restored = await DurableCommitBarrier.restoreCheckpoint({ initialState, schema, session, checkpoint }), ingress = queueFor(restored)
    const entry = ingress.getSnapshot().pending[0]!
    if (entry.payload.kind !== 'event' || entry.payload.event.kind !== 'resource-registered') throw new Error('Expected retained registration')
    expect(restored.barrier.getState().resources).toEqual([])
    expect(await restored.barrier.resources.get(entry.payload.event.descriptor.id).text()).toBe('body')
    ingress.resume()
    expect((await ingress.retry(entry.id, ingress.getSnapshot().generation).completion).kind).toBe('completed')
    expect(restored.barrier.getState().resources).toHaveLength(1)
    expect(storage.root!.record.commit.token.leaseEpoch).toBe(session.lease.epoch)
    expect(storage.root!.record.commit.token.sequence).toBe(1)
  })

  for (const committed of [true, false]) it(`resolves the original unknown token as ${committed ? 'committed' : 'not committed'} without speculative replay`, async () => {
    const { workspace, storage, initialState, schema } = await setup()
    storage.rejectNext = !committed; storage.loseResponse = true
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'retained' }).completion
    const checkpoint = await workspace.exportCheckpoint()
    const restored = await DurableCommitBarrier.restoreCheckpoint({ initialState, schema, session: storage.acquire(), checkpoint }), ingress = queueFor(restored)
    expect(restored.barrier.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(restored.barrier.getStatus().kind).toBe('unknown')
    const entry = ingress.getSnapshot().pending[0]!
    if (entry.phase !== 'uncertain') throw new Error('Expected original attempt')
    const transition = await restored.barrier.reconcile()
    expect(transition.result.kind).toBe(committed ? 'accepted' : 'rejected')
    ingress.resolveUncertain(entry.attempt, transition); ingress.resume()
    if (!committed) await ingress.retry(entry.id, ingress.getSnapshot().generation).completion
    expect(restored.barrier.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'retained' })
    expect(restored.barrier.getState().inputs).toHaveLength(2)
    expect(storage.queries).toHaveLength(1)
    if (checkpoint.metadata.storage.kind !== 'durable') throw new Error('Expected durable checkpoint')
    expect(storage.queries[0]).toEqual(checkpoint.metadata.storage.pending!.commit)
  })

  it('refuses an older checkpoint after a later authoritative local root was committed', async () => {
    const { workspace, storage, initialState, schema } = await setup(), checkpoint = await workspace.exportCheckpoint()
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'newer' }).completion
    const latest = storage.root, session = storage.acquire()
    await expect(DurableCommitBarrier.restoreCheckpoint({ initialState, schema, session, checkpoint })).rejects.toThrow('current storage root')
    expect(storage.root).toEqual(latest)
    const ordinary = await DurableCommitBarrier.restore({ initialState, schema, session })
    expect(ordinary.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'newer' })
  })

  it('rejects same-epoch activation and never installs an archived root into an unrelated empty store', async () => {
    const { workspace, initialState, schema, session } = await setup(), checkpoint = await workspace.exportCheckpoint()
    await expect(DurableCommitBarrier.restoreCheckpoint({ initialState, schema, session, checkpoint })).rejects.toThrow('newly acquired lease')
    const empty = new RecoveryFixture(initialState.workspace)
    empty.acquire()
    await expect(DurableCommitBarrier.restoreCheckpoint({ initialState, schema, session: empty.acquire(), checkpoint })).rejects.toThrow('current storage root')
    expect(empty.root).toBeNull(); expect(empty.writes).toEqual([])
  })

  it('rejects a lease lost while checking the current durable root', async () => {
    const { workspace, storage, initialState, schema } = await setup(), checkpoint = await workspace.exportCheckpoint(), session = storage.acquire()
    const entered = deferred<void>(), gate = deferred<void>()
    const restoring = DurableCommitBarrier.restoreCheckpoint({ initialState, schema, checkpoint, session: { ...session, load: async () => {
      const current = await session.load(); entered.resolve(); await gate.promise; return current
    } } })
    await entered.promise; storage.acquire(); gate.resolve()
    await expect(restoring).rejects.toThrow('lease was lost')
  })

  it('finishes an ingress receipt from a previously published exact root without creating another semantic commit', async () => {
    const { initialState, schema } = await setup(), storage = new RecoveryFixture(initialState.workspace), session = storage.acquire()
    const barrier = new DurableCommitBarrier({ state: initialState, schema, session, resources: new ResourceStore() })
    let exporting: Promise<WorkspaceCheckpoint> | null = null
    const queue = new IngressQueue(() => barrier.getState(), async event => {
      const transition = await barrier.commit(event), state = barrier.getState(), ingress = queue.exportCheckpoint()
      exporting = createWorkspaceCheckpoint({ state, ingress, storage: barrier.getCheckpointEvidence(), reservation: null,
        ticket: { workspaceId: state.workspace.id, semanticRevision: state.revision, ingressGeneration: ingress.snapshot.generation, runtimeGeneration: 0, leaseEpoch: session.lease.epoch },
      }, barrier.resources.exportCheckpoint(state), schema)
      return transition
    })
    await queue.event(kernelId<'ingress'>('read'), { kind: 'read-started', ticket: 'read' }).completion
    const checkpoint = await exporting!
    const restored = await DurableCommitBarrier.restoreCheckpoint({ initialState, schema, session: storage.acquire(), checkpoint }), ingress = queueFor(restored)
    const active = ingress.getSnapshot().pending[0]!
    if (active.phase !== 'uncertain' || !restored.publishedTransition) throw new Error('Expected published receipt proof')
    ingress.resolveUncertain(active.attempt, restored.publishedTransition); ingress.resume()
    expect(ingress.getSnapshot().pending).toEqual([])
    expect(ingress.getSnapshot().receipts[0]?.disposition).toBe('accepted')
    expect(storage.writes).toHaveLength(1)
    expect(restored.barrier.getState().revision).toBe(1)
  })
})
