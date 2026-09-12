import { describe, expect, it } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { DurableTaskFixture } from '../../tests/kernel/durable-task-fixture.js'
import { Workspace } from './workspace.js'
import { kernelId } from './model.js'
import type { CheckpointRecoverySession } from './checkpoint-store.js'

async function setup(editor = true, wrap: (session: CheckpointRecoverySession) => CheckpointRecoverySession = session => session) {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0 } }), service = new DurableTaskFixture()
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy, tasks: [service.definition] }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>('workspace'), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const session = wrap(storage.acquire()), workspace = await Workspace.openDurable({ ...options, session, restore: false })
  await workspace.refresh()
  if (editor) await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('input'),
    viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'original' }, reads: [] })
  const restore = () => Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  return { workspace, storage, source, service, options, restore }
}

describe('durable checkpoint-close', () => {
  it('keeps an unconfirmed input open until its storage outcome can be transferred in a checkpoint', async () => {
    const { workspace, storage, source, restore } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    const lease = workspace.getState().session!.editor!, before = workspace.getState(), root = storage.root
    storage.beforeCommit = async () => { storage.beforeCommit = null; entered.resolve(); await gate.promise }
    const input = workspace.typeInput(lease, { kind: 'encoded', value: '尚未确认的原文' })
    await entered.promise
    expect((await workspace.close(workspace.requestClose().ticket, 'clean-close')).kind).toBe('blocked')
    expect((await workspace.close(workspace.requestClose().ticket, 'checkpoint-close')).kind).toBe('blocked')
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect(workspace.getState()).toBe(before); expect(storage.root).toEqual(root)
    expect(workspace.getInputProjection(lease)?.input).toEqual({ kind: 'encoded', value: '尚未确认的原文' })
    expect(storage.checkpointWrites).toEqual([]); expect(source.requests).toEqual([])
    storage.loseResponse = true; gate.resolve(); await input.completion
    expect(workspace.getStorageStatus()?.kind).toBe('unknown')
    const originalCommit = storage.root!.record.commit
    expect((await workspace.close(workspace.requestClose().ticket, 'clean-close')).kind).toBe('blocked')
    expect((await workspace.close(workspace.requestClose().ticket, 'checkpoint-close')).kind).toBe('closed')
    expect(workspace.getState()).toBe(before)
    const restored = await restore()
    expect(storage.queries).toEqual([originalCommit])
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: '尚未确认的原文' })
    expect(restored.getState().inputs.filter(record => record.input.kind === 'encoded' && record.input.value === '尚未确认的原文')).toHaveLength(1)
    const again = await restore()
    expect(again.getState().inputs).toEqual(restored.getState().inputs)
    expect(again.getState().session?.rawInput).toEqual({ kind: 'encoded', value: '尚未确认的原文' })
    expect(storage.queries).toEqual([originalCommit]); expect(storage.checkpointWrites).toHaveLength(1)
    expect(source.requests).toEqual([]); expect(source.writes).toBe(0)
  })

  it('closes raw session and rejected File input only after their complete checkpoint is stored', async () => {
    const { workspace, storage, source, restore } = await setup()
    storage.rejectNext = true
    await expect(workspace.registerResource(new File(['raw file'], 'input.txt', { lastModified: 35 }))).rejects.toThrow()
    const before = workspace.getState(), ingress = workspace.getIngress(), ticket = workspace.requestClose().ticket
    const result = await workspace.close(ticket, 'checkpoint-close')
    expect(result.kind).toBe('closed')
    expect(result).toMatchObject({ checkpoint: storage.checkpoint!.commit.token })
    expect(workspace.getState()).toBe(before); expect(workspace.getIngress()).toEqual(ingress)
    expect(source.writes).toBe(0)
    expect((await workspace.close(ticket, 'checkpoint-close')).kind).toBe('closed')
    const restored = await restore()
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(restored.getIngress().pending).toEqual(ingress.pending)
    expect(storage.checkpoint).toBeNull()
  })

  it('preserves unsaved authored changes for saving after reopen without inventing a source receipt', async () => {
    const { workspace, source, restore } = await setup(false), fixture = new KernelFixture()
    fixture.state = workspace.getState()
    await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 4 })]) })
    expect((await workspace.close(workspace.requestClose().ticket, 'checkpoint-close')).kind).toBe('closed')
    expect(source.writes).toBe(0)
    const restored = await restore()
    expect(restored.getProjection().rows[0]!.preview).toEqual({ x: 4 })
    expect((await restored.save()).kind).toBe('committed')
    expect(source.writes).toBe(1)
  })

  it('coordinates a lost checkpoint receipt using the original token and never repeats the write', async () => {
    const { workspace, storage } = await setup(), ticket = workspace.requestClose().ticket
    storage.loseCheckpointResponse = true
    expect(await workspace.close(ticket, 'checkpoint-close')).toMatchObject({ kind: 'blocked', reason: 'checkpoint-failed' })
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect(workspace.getCheckpointStatus().kind).toBe('unknown')
    expect(workspace.getCapabilities().save).toMatchObject({ kind: 'blocked', reason: 'storage-pending' })
    expect((await workspace.close(ticket, 'clean-close')).kind).toBe('blocked')
    expect((await workspace.close(ticket, 'checkpoint-close')).kind).toBe('closed')
    expect(storage.checkpointWrites).toHaveLength(1)
    expect(storage.checkpointQueries).toEqual([storage.checkpointWrites[0]!.commit])
  })

  it('can make a fresh attempt after a definitive checkpoint rejection', async () => {
    const { workspace, storage } = await setup(), ticket = workspace.requestClose().ticket
    storage.rejectNextCheckpoint = true
    expect((await workspace.close(ticket, 'checkpoint-close')).kind).toBe('blocked')
    expect(workspace.getCheckpointStatus().kind).toBe('idle')
    expect(storage.checkpoint).toBeNull()
    expect((await workspace.close(ticket, 'checkpoint-close')).kind).toBe('closed')
    expect(storage.checkpointWrites[0]!.commit.token.id).not.toBe(storage.checkpointWrites[1]!.commit.token.id)
  })

  it('rejects a mismatched receipt without releasing the lease and later queries the exact original result', async () => {
    const { workspace, storage } = await setup(true, session => ({ ...session, checkpoints: { ...session.checkpoints, commit: async write => {
      const result = await session.checkpoints.commit(write)
      return result.kind === 'stored' ? { ...result, head: { ...result.head, id: 'wrong-head' } } : result
    } } }))
    const ticket = workspace.requestClose().ticket
    expect(await workspace.close(ticket, 'checkpoint-close')).toMatchObject({ kind: 'blocked', reason: 'checkpoint-failed' })
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect(workspace.getCheckpointStatus().kind).toBe('unknown')
    expect((await workspace.close(ticket, 'checkpoint-close')).kind).toBe('closed')
    expect(storage.checkpointWrites).toHaveLength(1)
    expect(storage.checkpointQueries).toEqual([storage.checkpointWrites[0]!.commit])
  })

  it('coalesces close calls, rejects a stale ticket and adopts the stored head so later input can commit', async () => {
    const entered = deferred<void>(), gate = deferred<void>()
    const { workspace, storage } = await setup(true, session => ({ ...session, checkpoints: { ...session.checkpoints, commit: async write => {
      const result = await session.checkpoints.commit(write); entered.resolve(); await gate.promise; return result
    } } }))
    const ticket = workspace.requestClose().ticket, closing = workspace.close(ticket, 'checkpoint-close')
    expect(workspace.close(ticket, 'checkpoint-close')).toBe(closing)
    await entered.promise
    const input = workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'later input' })
    await input.completion
    gate.resolve()
    expect(await closing).toMatchObject({ kind: 'blocked', reason: 'stale' })
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect(workspace.getInputProjection(workspace.getState().session!.editor!)?.input).toEqual({ kind: 'encoded', value: 'later input' })
    await workspace.retryIngress(input.id, workspace.getIngress().generation).completion
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'later input' })
    expect(storage.checkpoint).toBeNull()
  })

  it('honors retain while checkpoint persistence is in progress', async () => {
    const { workspace, storage } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    storage.beforeCheckpointCommit = async () => { entered.resolve(); await gate.promise }
    const ticket = workspace.requestClose().ticket, closing = workspace.close(ticket, 'checkpoint-close')
    await entered.promise
    expect((await workspace.close(ticket, 'retain')).kind).toBe('retained')
    gate.resolve()
    expect(await closing).toMatchObject({ kind: 'blocked', reason: 'stale' })
    expect(workspace.requestClose().lifecycle).toBe('open')
  })

  it('keeps a stored checkpoint and the admission fence across release failure', async () => {
    let releases = 0
    const { workspace, storage } = await setup(true, session => ({ ...session, release: async () => {
      if (++releases === 1) throw new Error('Release unavailable')
      await session.release()
    } }))
    const ticket = workspace.requestClose().ticket
    expect(await workspace.close(ticket, 'checkpoint-close')).toMatchObject({ kind: 'blocked', reason: 'release-failed' })
    expect(workspace.requestClose().lifecycle).toBe('closing')
    expect((await workspace.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [], sort: [] })).kind).toBe('rejected')
    expect((await workspace.close(ticket, 'checkpoint-close')).kind).toBe('closed')
    expect(storage.checkpointWrites).toHaveLength(1)
  })

  it('transfers an uncertain semantic commit without falsely publishing its input in the old runtime', async () => {
    const { workspace, storage, restore } = await setup()
    storage.loseResponse = true
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'uncertain input' }).completion
    expect((await workspace.close(workspace.requestClose().ticket, 'checkpoint-close')).kind).toBe('closed')
    expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    const restored = await restore()
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'uncertain input' })
    expect(restored.getState().inputs).toHaveLength(2)
    expect(storage.queries).toHaveLength(1)
  })

  it('can close a durable in-flight task and recover its later result without rerunning the action', async () => {
    const { workspace, service, restore } = await setup(), entered = deferred<void>(), gate = deferred<void>()
    service.beforeStart = async () => { entered.resolve(); await gate.promise }
    const session = workspace.getState().session!
    const task = workspace.runDurableTask({ definition: service.definition.ref, owner: { kind: 'session', sessionId: session.id, input: session.input }, input: { kind: 'encoded', value: 'task input' }, reads: [] })
    await task.result; await entered.promise
    expect((await workspace.close(workspace.requestClose().ticket, 'checkpoint-close')).kind).toBe('closed')
    gate.resolve(); await workspace.waitForTask(task.taskId)
    const restored = await restore()
    await restored.recoverTask(task.taskId)
    expect(service.requests).toHaveLength(1); expect(service.executions).toBe(1); expect(service.lookups).toHaveLength(1)
    expect(restored.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 42 })
  })

  it('rejects stale tickets, memory-only storage and missing checkpoint bytes without releasing input', async () => {
    const { workspace, storage, options } = await setup(), ticket = workspace.requestClose().ticket
    expect(await workspace.close({ ...ticket, ingressGeneration: ticket.ingressGeneration + 1 }, 'checkpoint-close')).toMatchObject({ reason: 'stale' })
    const memory = new Workspace(options)
    expect(await memory.close(memory.requestClose().ticket, 'checkpoint-close')).toMatchObject({ reason: 'checkpoint-failed' })
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'resource', id: kernelId<'resource'>('missing') }).completion
    expect(await workspace.close(workspace.requestClose().ticket, 'checkpoint-close')).toMatchObject({ reason: 'checkpoint-failed' })
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect(storage.checkpointWrites).toEqual([])
  })
})
