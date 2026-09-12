import { describe, expect, it } from 'vitest'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { kernelId } from './model.js'
import { defineKernelSchema } from './schema.js'
import { Workspace } from './workspace.js'

async function setup(durable = false) {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0 } }), options = { scope, source, schema: permissiveSchema, policy: permissivePolicy }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>('workspace'), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = durable ? await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false }) : new Workspace(options)
  await workspace.refresh()
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('input'),
    viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'encoded', value: 'original' }, reads: [] })
  return { workspace, storage }
}

describe('Workspace external-store snapshots', () => {
  it('returns stable immutable observations and invalidates synchronous input before notification flush', async () => {
    const { workspace } = await setup(), first = workspace.getSnapshot()
    expect(workspace.getSnapshot()).toBe(first)
    const input = workspace.typeInput(first.state.session!.editor!, { kind: 'encoded', value: 'new' })
    const next = workspace.getSnapshot()
    expect(next).not.toBe(first); expect(next.editorInput?.input).toEqual({ kind: 'encoded', value: 'new' })
    expect(first.editorInput?.input).toEqual({ kind: 'encoded', value: 'original' })
    expect(Object.isFrozen(next)).toBe(true)
    await input.completion
    expect(workspace.getSnapshot()).toBe(workspace.getSnapshot())
  })

  it('publishes retained raw input alongside unchanged authoritative state after a lost storage receipt', async () => {
    const { workspace, storage } = await setup(true), first = workspace.getSnapshot()
    storage.loseResponse = true
    await workspace.typeInput(first.state.session!.editor!, { kind: 'encoded', value: 'retained' }).completion
    const unknown = workspace.getSnapshot()
    expect(unknown.state).toBe(first.state)
    expect(unknown.projection).toBe(first.projection)
    expect(unknown.view).toBe(first.view)
    expect(workspace.getProjection()).toBe(unknown.projection)
    expect(workspace.getView()).toBe(unknown.view)
    expect(unknown.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
    expect(unknown.editorInput?.input).toEqual({ kind: 'encoded', value: 'retained' })
    expect(unknown.storage?.kind).toBe('unknown')
    expect(unknown.recovery.plan.candidates.map(candidate => candidate.kind)).toEqual(['storage'])
    expect(unknown.recovery.running).toBe(false)
    expect(unknown.capabilities.save).toMatchObject({ reason: 'storage-pending' })
    const recovery = workspace.recoverPendingWork()
    expect(workspace.getSnapshot().recovery.running).toBe(true)
    await recovery
    const recovered = workspace.getSnapshot()
    expect(recovered.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'retained' })
    expect(recovered.editorInput?.status).toBe('published')
    expect(recovered.recovery.plan.candidates).toEqual([])
    expect(recovered.recovery.running).toBe(false)
    expect(unknown.storage?.kind).toBe('unknown')
  })

  it('publishes query and rows from one state while retaining complete data in older observations', async () => {
    const fieldId = kernelId<'field'>('x')
    const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: fieldId, path: ['x'], readonly: false }] })
    const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
    const source = new SourceFixture(scope, { a: { x: 1 }, b: { x: 3 }, c: { x: 2 } })
    const workspace = new Workspace({ scope, source, schema, policy: permissivePolicy })
    await workspace.refresh()
    const first = workspace.getSnapshot()
    expect(first.view.rows.map(row => row.preview?.x)).toEqual([1, 3, 2])
    const result = await workspace.dispatch({ kind: 'view-query-set', expectedVersion: 0,
      filters: [{ columnId: 'x', predicate: { kind: 'compare', fieldId, operator: 'greater-than', value: 1 } }],
      sort: [{ fieldId, direction: 'asc' }] })
    expect(result.kind).toBe('accepted')
    const filtered = workspace.getSnapshot()
    expect(filtered.view.query).toBe(filtered.state.view)
    expect(filtered.view.rows.map(row => row.preview?.x)).toEqual([2, 3])
    expect(filtered.view.total).toBe(3)
    expect(filtered.projection.rows).toHaveLength(3)
    for (const row of filtered.view.rows) expect(filtered.projection.rows).toContain(row)
    expect(workspace.getProjection()).toBe(filtered.projection)
    expect(workspace.getView()).toBe(filtered.view)
    expect(workspace.getSnapshot()).toBe(filtered)
    expect(first.view.rows.map(row => row.preview?.x)).toEqual([1, 3, 2])
    expect(first.view.query.version).toBe(0)
  })

  it('keeps input and ownership when all subscribers detach and reflects close without a semantic change', async () => {
    const { workspace } = await setup()
    let calls = 0
    const unsubscribe = workspace.subscribe(() => { calls++; workspace.getSnapshot() })
    unsubscribe()
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'detached input' }).completion
    expect(calls).toBe(0)
    const retained = workspace.getSnapshot()
    expect(retained.editorInput?.input).toEqual({ kind: 'encoded', value: 'detached input' })
    expect(retained.capabilities.close.lifecycle).toBe('open')
    await workspace.close(workspace.requestClose().ticket, 'discard')
    const closed = workspace.getSnapshot()
    expect(closed.capabilities.close.lifecycle).toBe('closed')
    expect(closed.capabilities.save).toMatchObject({ reason: 'inactive' })
    expect(retained.capabilities.close.lifecycle).toBe('open')
  })
})
