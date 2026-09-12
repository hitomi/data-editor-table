import { describe, expect, it } from 'vitest'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { Workspace } from './workspace.js'
import { kernelId } from './model.js'
import { assertCheckpointConsumption, prepareCheckpointWrite } from './checkpoint-store.js'
import { validateRecoveryWrite } from './recovery-store.js'

async function setup(store = true) {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const identity = { id: kernelId<'workspace'>('workspace'), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec }
  const storage = new RecoveryFixture(identity), session = storage.acquire()
  const options = { scope, schema: permissiveSchema, policy: permissivePolicy, source: new SourceFixture(scope, {}) }
  const workspace = await Workspace.openDurable({ ...options, session, restore: false })
  await workspace.refresh()
  storage.rejectNext = true
  await expect(workspace.registerResource(new File(['checkpoint input'], 'input.txt', { lastModified: 24 }))).rejects.toThrow()
  const checkpoint = await workspace.exportCheckpoint(), write = await prepareCheckpointWrite(checkpoint, null, 'checkpoint', permissiveSchema)
  if (store) expect((await session.checkpoints.commit(write)).kind).toBe('stored')
  const restore = () => Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  return { options, workspace, storage, session, checkpoint, write, restore }
}

describe('atomic checkpoint head consumption', () => {
  it('selects the stored head on ordinary startup and consumes it with complete ingress and File ownership', async () => {
    const { storage, checkpoint, write, restore } = await setup(), original = checkpoint.metadata.ingress.snapshot.pending[0]!
    const restored = await restore()
    expect(storage.checkpoint).toBeNull()
    expect(storage.root!.record.checkpointParent).toEqual(write.commit.token)
    expect(restored.getIngress().pending).toEqual(checkpoint.metadata.ingress.snapshot.pending)
    const next = await restore()
    await next.retryIngress(original.id, next.getIngress().generation).completion
    if (original.payload.kind !== 'event' || original.payload.event.kind !== 'resource-registered') throw new Error('Expected File registration')
    expect(await next.getResource(original.payload.event.descriptor.id).text()).toBe('checkpoint input')
    expect(storage.root!.record.checkpointParent).toBeNull()
  })

  it('keeps the checkpoint head when installation fails and can restore it again under another lease', async () => {
    const { storage, checkpoint, write, restore } = await setup()
    storage.rejectNext = true
    const failed = await restore()
    expect(failed.getRuntimeIssue()).not.toBeNull()
    expect(storage.checkpoint!.commit).toEqual(write.commit)
    const restored = await restore()
    expect(restored.getIngress().pending).toEqual(checkpoint.metadata.ingress.snapshot.pending)
    expect(storage.checkpoint).toBeNull()
  })

  it('survives loss of the installation receipt with either the checkpoint head or the new complete root', async () => {
    const { storage, checkpoint, restore } = await setup()
    storage.loseResponse = true
    const uncertain = await restore()
    expect(uncertain.getStorageStatus()?.kind).toBe('unknown')
    expect(storage.checkpoint).toBeNull()
    const restored = await restore()
    expect(restored.getIngress().pending).toEqual(checkpoint.metadata.ingress.snapshot.pending)
    expect(restored.getStorageStatus()?.kind).toBe('idle')
  })

  it('rejects a semantic candidate prepared before a checkpoint became the current head', async () => {
    const { workspace, storage, session, write, restore } = await setup(false), entered = deferred<void>(), gate = deferred<void>()
    const root = storage.root
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise }
    const late = workspace.refresh(); await entered.promise
    expect((await session.checkpoints.commit(write)).kind).toBe('stored')
    gate.resolve()
    expect((await late).kind).toBe('rejected')
    expect(storage.root).toEqual(root)
    expect(storage.checkpoint!.commit).toEqual(write.commit)
    storage.beforeCommit = null
    expect((await restore()).getIngress().pending).toEqual(write.checkpoint.metadata.ingress.snapshot.pending)
  })

  it('refuses an older archive while a newer checkpoint head owns additional input', async () => {
    const { workspace, storage, session, options, checkpoint, write } = await setup()
    await workspace.dispatch({ kind: 'view-query-set', expectedVersion: -1, filters: [], sort: [] })
    const newer = await workspace.exportCheckpoint()
    const next = await prepareCheckpointWrite(newer, write.commit.token, 'newer', permissiveSchema)
    expect((await session.checkpoints.commit(next)).kind).toBe('stored')
    const lease = storage.acquire()
    await expect(Workspace.openCheckpoint({ ...options, session: lease, checkpoint })).rejects.toThrow('current checkpoint head')
    const restored = await Workspace.openDurable({ ...options, session: lease, restore: true })
    expect(restored.getIngress().pending).toEqual(newer.metadata.ingress.snapshot.pending)
  })

  it('requires complete pending inputs, previous receipts, bytes and the hashed consumed token', async () => {
    const { storage, write, restore } = await setup()
    await restore()
    const root = storage.root!, record = root.record, ingress = record.ingress!
    expect(() => assertCheckpointConsumption({ ...record, ingress: { ...ingress, snapshot: { ...ingress.snapshot, pending: [] } } }, write)).toThrow('retained input')
    expect(() => assertCheckpointConsumption({ ...record, ingress: { ...ingress, snapshot: { ...ingress.snapshot, receipts: [] } } }, write)).toThrow('receipt')
    const resourceId = write.checkpoint.metadata.resources.manifest.entries[0]!.descriptor.id
    expect(() => assertCheckpointConsumption({ ...record, manifest: { ...record.manifest, entries: [] }, retiredResources: [resourceId] }, write)).toThrow('resource bytes')
    await expect(validateRecoveryWrite({ ...root, record: { ...record, checkpointParent: null } }, record.commit.workspace)).rejects.toThrow('digest')
  })
})
