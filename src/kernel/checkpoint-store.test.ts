import { describe, expect, it } from 'vitest'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { Workspace } from './workspace.js'
import { kernelId } from './model.js'
import { assertCheckpointReplacement, assertCheckpointResult, prepareCheckpointWrite, validateCheckpointWrite } from './checkpoint-store.js'

async function setup() {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const identity = { id: kernelId<'workspace'>('workspace'), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec }
  const storage = new RecoveryFixture(identity), session = storage.acquire()
  const workspace = await Workspace.openDurable({ scope, schema: permissiveSchema, policy: permissivePolicy, source: new SourceFixture(scope, {}), session, restore: false })
  await workspace.refresh()
  storage.rejectNext = true
  await expect(workspace.registerResource(new File(['retained'], 'input.txt', { lastModified: 22 }))).rejects.toThrow()
  const checkpoint = await workspace.exportCheckpoint()
  const write = await prepareCheckpointWrite(checkpoint, null, 'first', permissiveSchema)
  return { workspace, storage, session, checkpoint, write }
}

describe('checkpoint storage contract', () => {
  it('stores full raw ownership without advancing the semantic root and loads it under the next lease', async () => {
    const { storage, session, write } = await setup(), root = storage.root
    expect(await session.checkpoints.commit(write)).toEqual({ kind: 'stored', commit: write.commit, head: write.commit.token })
    expect(storage.root).toEqual(root)
    const loaded = await storage.acquire().checkpoints.load()
    expect(loaded!.checkpoint.metadata).toEqual(write.checkpoint.metadata)
    expect(await loaded!.checkpoint.contents[0]!.blob.text()).toBe('retained')
  })

  it('compares the checkpoint parent and semantic root independently', async () => {
    const { session, checkpoint, write } = await setup()
    const competitor = await prepareCheckpointWrite(checkpoint, null, 'competitor', permissiveSchema)
    const results = await Promise.all([session.checkpoints.commit(write), session.checkpoints.commit(competitor)])
    expect(results.filter(result => result.kind === 'stored')).toHaveLength(1)
    expect(results.filter(result => result.kind === 'not-stored')).toHaveLength(1)
    const head = (await session.checkpoints.load())!
    const changed = await setup()
    await changed.workspace.refresh()
    expect((await changed.session.checkpoints.commit(changed.write)).kind).toBe('not-stored')
    expect((await session.checkpoints.load())!.commit).toEqual(head.commit)
  })

  it('uses the original token after a lost acknowledgement and rejects identity reuse with another parent', async () => {
    const { storage, session, write } = await setup()
    storage.loseCheckpointResponse = true
    await expect(session.checkpoints.commit(write)).rejects.toThrow('acknowledgement lost')
    const receipt = await session.checkpoints.lookup(write.commit)
    expect(receipt.kind).toBe('stored'); assertCheckpointResult(write.commit, receipt)
    expect(await session.checkpoints.commit(write)).toEqual(receipt)
    const changed = { ...write, commit: { ...write.commit, parent: write.commit.token } }
    await expect(session.checkpoints.commit(changed)).rejects.toThrow('identity reused')
    expect(() => assertCheckpointResult(changed.commit, receipt)).toThrow('another attempt or parent')
  })

  it('permanently fences a missing checkpoint token before its delayed write can commit', async () => {
    const { storage, session, write } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCheckpointCommit = async () => { entered.resolve(); await gate.promise }
    const saving = session.checkpoints.commit(write)
    await entered.promise
    const negative = await session.checkpoints.lookup(write.commit)
    expect(negative.kind).toBe('not-stored')
    gate.resolve()
    expect(await saving).toEqual(negative)
    expect(await session.checkpoints.load()).toBeNull()
  })

  it('fences checkpoint writes when the shared storage lease is lost', async () => {
    const { storage, session, write } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCheckpointCommit = async () => { entered.resolve(); await gate.promise }
    const saving = session.checkpoints.commit(write)
    await entered.promise; const next = storage.acquire(); gate.resolve()
    await expect(saving).rejects.toThrow('fenced')
    expect(await next.checkpoints.load()).toBeNull()
  })

  it('binds the snapshot, lease, bytes and workspace before preparing a storage attempt', async () => {
    const { write } = await setup(), workspace = write.commit.workspace
    await expect(validateCheckpointWrite({ ...write, commit: { ...write.commit, token: { ...write.commit.token, sha256: `sha256:${'0'.repeat(64)}` } } }, workspace)).rejects.toThrow('bind')
    await expect(validateCheckpointWrite({ ...write, checkpoint: { ...write.checkpoint, contents: [] } }, workspace)).rejects.toThrow()
    await expect(validateCheckpointWrite(write, { ...workspace, id: kernelId<'workspace'>('other') })).rejects.toThrow('workspace')
    await expect(validateCheckpointWrite({ ...write, commit: { ...write.commit, token: { ...write.commit.token, id: 1 as never } } }, workspace)).rejects.toThrow('identity')
    await expect(validateCheckpointWrite({ ...write, commit: { ...write.commit, parent: false as never } }, workspace)).rejects.toThrow('identity')
  })

  it('can store an uncertain semantic commit whose exact successor is already the durable root', async () => {
    const { workspace, storage, session } = await setup()
    storage.loseResponse = true
    await workspace.refresh()
    const checkpoint = await workspace.exportCheckpoint()
    if (checkpoint.metadata.storage.kind !== 'durable') throw new Error('Expected durable checkpoint')
    const original = checkpoint.metadata.storage.pending!.commit
    expect(storage.root!.record.commit).toEqual(original)
    const write = await prepareCheckpointWrite(checkpoint, null, 'unknown-root', permissiveSchema)
    expect((await session.checkpoints.commit(write)).kind).toBe('stored')
    const loaded = await session.checkpoints.load()
    expect(loaded!.checkpoint.metadata.storage).toEqual(checkpoint.metadata.storage)
    expect(storage.queries).toEqual([])
  })

  it('does not let an older archive replace the latest head even when it names the current parent', async () => {
    const { workspace, session, checkpoint, write } = await setup()
    await session.checkpoints.commit(write)
    await workspace.dispatch({ kind: 'view-query-set', expectedVersion: -1, filters: [], sort: [] })
    const newer = await prepareCheckpointWrite(await workspace.exportCheckpoint(), write.commit.token, 'newer', permissiveSchema)
    expect((await session.checkpoints.commit(newer)).kind).toBe('stored')
    const older = await prepareCheckpointWrite(checkpoint, newer.commit.token, 'older', permissiveSchema)
    expect(() => assertCheckpointReplacement(older, newer)).toThrow('generation')
    await expect(session.checkpoints.commit(older)).rejects.toThrow('ownership')
    expect((await session.checkpoints.load())!.commit).toEqual(newer.commit)
  })
})
