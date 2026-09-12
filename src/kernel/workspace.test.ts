import { describe, expect, it, vi } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { deferred, SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId, type Document } from './model.js'
import { Workspace } from './workspace.js'
import type { ResolutionChoice, ResolutionRequest } from './resolution.js'
import { prepareRowAction } from './prepare.js'
import { defineKernelSchema } from './schema.js'

let serial = 0
const preparers = new WeakMap<Workspace, KernelFixture>()
async function setup(initial: Readonly<Record<string, Document>>, source?: SourceFixture) {
  const scope = { sourceId: `workspace-test:${++serial}`, id: kernelId<'scope'>('dataset'), epoch: kernelId<'scope-epoch'>('epoch') }
  const backend = source ?? new SourceFixture(scope, initial)
  const workspace = new Workspace({ scope: backend.scope, schema: permissiveSchema, policy: permissivePolicy, source: backend })
  expect((await workspace.refresh()).kind).toBe('accepted')
  return { workspace, source: backend }
}
function prepare(workspace: Workspace, values: Document) {
  const fixture = preparers.get(workspace) ?? new KernelFixture(undefined, workspace.schema)
  preparers.set(workspace, fixture); fixture.state = workspace.getState()
  const entity = fixture.state.entities.find(binding => binding.kind === 'bound' && binding.identity.key === 'a')
  if (!entity) throw new Error('Missing test row')
  return fixture.prepare([fixture.write(entity.entityId, values)], 'row', values)
}
async function edit(workspace: Workspace, values: Document) {
  const prepared = prepare(workspace, values)
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared })).kind).toBe('accepted')
  return prepared
}
const preview = (workspace: Workspace) => workspace.getProjection().rows[0]?.preview
function resolution(workspace: Workspace, choice: ResolutionChoice): ResolutionRequest {
  const state = workspace.getState(), row = workspace.getProjection().rows.find(row => row.issues.length)!
  if (state.authority.content.kind !== 'complete') throw new Error('Expected authority')
  return { revision: state.revision, observation: state.authority.content.snapshot.observation, issueIds: row.issues.map(issue => issue.id), target: { kind: 'row', entityId: row.entityId }, choice }
}

describe('memory workspace execution', () => {
  it('hands off remounted session input, saves canonical data, and reopens against that exact authority', async () => {
    const scope = { sourceId: `session-workspace:${++serial}`, id: kernelId<'scope'>('dataset'), epoch: kernelId<'scope-epoch'>('epoch') }
    const source = new SourceFixture(scope, { a: { x: 0, hidden: 7 } })
    const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: kernelId<'field'>('x'), path: ['x'], readonly: false }] })
    const workspace = new Workspace({ scope, source, schema, policy: permissivePolicy })
    await workspace.refresh()
    const entityId = workspace.getProjection().rows[0]!.entityId, sessionId = kernelId<'session'>('editor')
    const target = { kind: 'cell' as const, field: { entityId, fieldId: kernelId<'field'>('x') } }
    expect((await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId, inputId: kernelId<'input'>('editor'),
      viewId: kernelId<'view'>('first'), target, input: { kind: 'encoded', value: '1' }, reads: [] })).kind).toBe('accepted')
    const old = workspace.getState().session!
    const unsubscribe = workspace.subscribe(() => {}); unsubscribe()
    expect(workspace.getState().session).toBe(old)
    await workspace.dispatch({ kind: 'session-detached', lease: old.editor!, inputVersion: 0 })
    await workspace.dispatch({ kind: 'session-attached', sessionId, viewId: kernelId<'view'>('second') })
    expect((await workspace.dispatch({ kind: 'session-input', lease: old.editor!, inputVersion: 0, input: { kind: 'encoded', value: 'old text' }, composition: 'idle' })).kind).toBe('rejected')
    const session = workspace.getState().session!, state = workspace.getState()
    const prepared = prepareRowAction(state, { action: { id: kernelId<'action'>('apply'), applicationId: kernelId<'application'>('apply'), label: 'Edit x', saveAtomicity: 'row' }, cause: 'user',
      inputs: [{ ref: session.input, input: session.rawInput }], commands: [{ id: kernelId<'intent'>('apply'), inputs: [session.input], dependencies: [], command: {
        kind: 'write', entityId, groups: [{ id: kernelId<'write-group'>('apply'), writes: [{ kind: 'set', path: ['x'], value: 1 }], comparison: 'paths', reads: [] }],
      } }],
    }, schema)
    expect((await workspace.dispatch({ kind: 'session-apply', lease: session.editor!, inputVersion: 0, prepared })).kind).toBe('accepted')
    expect(workspace.getState().session).toBeNull()
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('intents')
    expect((await workspace.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [{ columnId: 'x', predicate: {
      kind: 'compare', fieldId: kernelId<'field'>('x'), operator: 'equals', value: 100,
    } }], sort: [] })).kind).toBe('accepted')
    expect(workspace.getView().rows).toEqual([])
    source.normalize = document => ({ ...document, x: 10 })
    expect((await workspace.save()).kind).toBe('committed')
    expect(preview(workspace)).toEqual({ x: 10, hidden: 7 })
    expect(workspace.getView().rows).toEqual([])
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('settled-intents')
    expect((await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('reopened'), inputId: kernelId<'input'>('reopened'),
      viewId: kernelId<'view'>('second'), target, input: { kind: 'encoded', value: preview(workspace)!.x! }, reads: [] })).kind).toBe('accepted')
    const reopened = workspace.getState().session!
    expect(reopened.rawInput).toEqual({ kind: 'encoded', value: 10 })
    expect(reopened.dependencies[0]?.expected).toEqual({ kind: 'value', value: 10 })
    expect(source.requests).toHaveLength(1)
  })

  it('executes conflict resolution, compensation and input recovery through the Workspace gateway', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    await edit(workspace, { x: 1 }); source.external({ a: { x: 3 } }); await workspace.refresh()
    expect((await workspace.resolve(resolution(workspace, { kind: 'keep-local' }))).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed'); expect(preview(workspace)).toEqual({ x: 1 })
    expect((await workspace.undo()).kind).toBe('accepted')
    expect(workspace.getRecoveryEntries()[0]?.state).toBe('available')
    expect((await workspace.save()).kind).toBe('blocked'); expect(preview(workspace)).toEqual({ x: 1 })
    expect(workspace.getProjection().rows[0]?.issues.length).toBeGreaterThan(0)
    expect(source.writes).toBe(1)
    expect((await workspace.redo()).kind).toBe('accepted')
    expect(workspace.getProjection().rows[0]?.issues).toEqual([])
    expect(preview(workspace)).toEqual({ x: 1 })
    expect(source.writes).toBe(1)
    expect(workspace.getRecoveryEntries()[0]?.state).toBe('discarded')
  })

  it('retains a stale merge input as a rejected resolution without changing the published kernel', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    await edit(workspace, { x: 1 }); source.external({ a: { x: 3 } }); await workspace.refresh()
    const fixture = preparers.get(workspace)!; fixture.state = workspace.getState()
    const target = workspace.getProjection().rows[0]!.entityId
    const request = resolution(workspace, { kind: 'merge', commands: [fixture.write(target, { x: 2 })], input: { kind: 'encoded', value: 'unaccepted merge text' } })
    await workspace.refresh()
    const before = workspace.getState()
    expect((await workspace.resolve(request)).kind).toBe('rejected')
    expect(workspace.getState()).toBe(before)
    expect(workspace.getRejectedResolutions()[0]?.request.choice).toMatchObject({ kind: 'merge', input: { kind: 'encoded', value: 'unaccepted merge text' } })
    expect(source.writes).toBe(0)
  })

  it('undoes and redoes ordered creation through the published Workspace and gateway', async () => {
    const { workspace, source } = await setup({ a: {}, b: {} })
    const fixture = new KernelFixture(undefined, workspace.schema); fixture.state = workspace.getState()
    const [a, b] = workspace.getProjection().order.preview, local = kernelId<'entity'>('new-local')
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([
      { kind: 'create', entityId: local, document: { x: 7 } }, { kind: 'order', desired: [a!, local, b!] },
    ]) })).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed')
    expect((await workspace.undo()).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed')
    expect(workspace.getProjection().order.authority).toEqual([a, b])
    expect((await workspace.redo()).kind).toBe('accepted')
    const recreated = workspace.getProjection().rows.find(row => row.existence === 'local-create')!.entityId
    expect(recreated).not.toBe(local)
    expect((await workspace.save()).kind).toBe('committed')
    expect(workspace.getProjection().order.authority).toEqual([a, recreated, b])
    expect(source.writes).toBe(3)
  })

  it('preserves ordered display through a stale post-commit read and recovers without resending', async () => {
    const { workspace, source } = await setup({ a: {}, b: {} })
    const fixture = new KernelFixture(undefined, workspace.schema); fixture.state = workspace.getState()
    const desired = [...workspace.getProjection().order.preview].reverse()
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([{ kind: 'order', desired }]) })).kind).toBe('accepted')
    const stale = source.snapshot()
    source.submitHook = async (_request, execute) => { const result = execute(); source.readHook = async () => stale; return result }
    expect((await workspace.save()).kind).toBe('unresolved')
    expect(workspace.getProjection().order.preview).toEqual(desired)
    expect(workspace.getState().persistence.kind).toBe('committed-awaiting-authority')
    source.readHook = null
    expect((await workspace.recover()).kind).toBe('committed')
    expect(workspace.getProjection().order.authority).toEqual(desired)
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
  })

  it('preserves neutral history through an unrelated row save without reporting it as a pending write', async () => {
    const { workspace, source } = await setup({ a: { x: 0 }, b: { x: 0 } })
    await edit(workspace, { x: 1 }); await edit(workspace, { x: 0 })
    const fixture = preparers.get(workspace)!; fixture.state = workspace.getState()
    const b = fixture.state.entities.find(entry => entry.kind === 'bound' && entry.identity.key === 'b')!
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([fixture.write(b.entityId, { x: 2 })]) })).kind).toBe('accepted')
    const result = await workspace.save()
    expect(result.kind).toBe('committed')
    if (result.kind === 'committed') { expect(result.remaining).toEqual([]); expect(result.neutral).toHaveLength(2) }
    expect(source.requests[0]?.items).toHaveLength(1)
    expect((await workspace.undo()).kind).toBe('accepted')
    expect((await workspace.undo()).kind).toBe('accepted')
    expect(preview(workspace)).toEqual({ x: 1 })
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.writes).toBe(2)
  })

  it('executes supported deletion restoration and earlier field undo through the same gateway', async () => {
    const scope = { sourceId: `workspace-restore:${++serial}`, id: kernelId<'scope'>('dataset'), epoch: kernelId<'scope-epoch'>('epoch') }
    const source = new SourceFixture(scope, { a: { x: 0 } }, true)
    const { workspace } = await setup({}, source)
    await edit(workspace, { x: 1 }); expect((await workspace.save()).kind).toBe('committed')
    const oldEntity = workspace.getProjection().rows[0]!.entityId
    const fixture = preparers.get(workspace)!
    fixture.state = workspace.getState()
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([{ kind: 'delete', entityId: oldEntity }]) })).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed')
    expect((await workspace.undo()).kind).toBe('accepted')
    expect((await workspace.undo()).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed')
    const restored = workspace.getProjection().rows[0]!
    expect(restored.entityId).not.toBe(oldEntity); expect(restored.preview).toEqual({ x: 0 })
    expect((await workspace.redo()).kind).toBe('accepted')
    expect((await workspace.redo()).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.rows.size).toBe(0); expect(source.writes).toBe(4)
  })

  it('installs a formerly ambiguous creation snapshot after definitive rejection of the undone request', async () => {
    const { workspace, source } = await setup({})
    const fixture = new KernelFixture(undefined, workspace.schema); fixture.state = workspace.getState()
    const local = kernelId<'entity'>('uncommitted-local')
    const prepared = fixture.prepare([{ kind: 'create', entityId: local, proposedKey: 'new', document: { x: 1 } }])
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared })).kind).toBe('accepted')
    source.submitHook = async () => { throw new Error('Request outcome unknown') }
    expect((await workspace.save()).kind).toBe('unresolved')
    expect((await workspace.undo()).kind).toBe('accepted')
    source.external({ new: { x: 3 } })
    await workspace.refresh()
    const held = workspace.getState().authority.content
    expect(held.kind === 'complete' && held.snapshot.entities).toEqual([])
    source.submitHook = null
    expect((await workspace.recover('retry')).kind).toBe('not-applied')
    const external = workspace.getProjection().rows[0]
    expect(external?.preview).toEqual({ x: 3 }); expect(external?.entityId).not.toBe(local)
    expect(workspace.getState().persistence.kind).toBe('idle')
    expect(source.writes).toBe(0)
  })

  it('accepts undo while the mutation response is pending and saves compensation after exact recovery', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    const entered = deferred<void>(), finish = deferred<void>()
    source.submitHook = async (_request, execute) => { const result = execute(); entered.resolve(); await finish.promise; return result }
    await edit(workspace, { x: 1 }); const saving = workspace.save(); await entered.promise
    expect((await workspace.undo()).kind).toBe('accepted')
    expect(preview(workspace)).toEqual({ x: 0 })
    finish.resolve(); const original = await saving
    expect(original.kind).toBe('committed')
    if (original.kind === 'committed') expect(original.remaining).toHaveLength(1)
    source.submitHook = null
    expect((await workspace.save()).kind).toBe('committed')
    expect(preview(workspace)).toEqual({ x: 0 })
    expect((await workspace.redo()).kind).toBe('accepted')
    expect((await workspace.save()).kind).toBe('committed')
    expect(preview(workspace)).toEqual({ x: 1 }); expect(source.writes).toBe(3)
  })

  it('rejects a stale hash candidate without sending or losing the edit made during hashing', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    await edit(workspace, { x: 1 })
    const entered = deferred<void>(), finish = deferred<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      entered.resolve(); await finish.promise; return digest(algorithm, data)
    })
    try {
      const saving = workspace.save(); await entered.promise
      await edit(workspace, { x: 2 }); finish.resolve()
      expect((await saving).kind).toBe('blocked')
      expect(source.requests).toEqual([])
      expect(workspace.getState().inputs.map(input => input.disposition.kind)).toEqual(['intents', 'intents'])
      expect(workspace.getState().persistence.kind).toBe('idle')
      expect(preview(workspace)).toEqual({ x: 2 })
    } finally { finish.resolve(); spy.mockRestore() }
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.writes).toBe(1)
  })

  it('publishes the frozen reservation before I/O and exposes a commit only after complete authority', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    source.submitHook = async (request, execute) => {
      const state = workspace.getState()
      expect(state.persistence.kind).toBe('sending')
      if ('submission' in state.persistence) expect(state.persistence.submission).toEqual(request)
      expect(state.inputs[0]?.disposition.kind).toBe('intents')
      return execute()
    }
    await edit(workspace, { x: 1 })
    const saving = workspace.save()
    expect(workspace.save()).toBe(saving)
    const result = await saving
    expect(result.kind).toBe('committed')
    if (result.kind === 'committed') expect(result.remaining).toEqual([])
    expect(workspace.getState().persistence.kind).toBe('idle')
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('settled-intents')
    expect(preview(workspace)).toEqual({ x: 1 }); expect(source.writes).toBe(1)
    expect((await workspace.save()).kind).toBe('blocked')
    expect(source.writes).toBe(1)
  })

  it('retains successor input during a normalized save and survives detaching every view', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    const entered = deferred<void>(), finish = deferred<void>()
    source.normalize = document => document.x === 1 ? { ...document, x: 1.5 } : document
    source.submitHook = async (_request, execute) => { const result = execute(); entered.resolve(); await finish.promise; return result }
    const detach = workspace.subscribe(() => {})
    await edit(workspace, { x: 1 }); const saving = workspace.save(); await entered.promise
    const successor = await edit(workspace, { x: 2 }); detach()
    expect(preview(workspace)).toEqual({ x: 2 })
    finish.resolve(); const result = await saving
    expect(result.kind).toBe('committed')
    if (result.kind === 'committed') expect(result.remaining).toEqual(successor.action.intentIds)
    expect(preview(workspace)).toEqual({ x: 2 })
    expect(workspace.getState().inputs[1]?.disposition.kind).toBe('intents')
    source.submitHook = null
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.writes).toBe(2)
    expect((await workspace.refresh()).kind).toBe('accepted')
    expect(preview(workspace)).toEqual({ x: 2 })
  })

  it('keeps submitted display through a stale post-commit read and recovers without resending', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    const stale = source.snapshot()
    source.submitHook = async (_request, execute) => { const result = execute(); source.readHook = async () => stale; return result }
    await edit(workspace, { x: 1 })
    expect((await workspace.save()).kind).toBe('unresolved')
    expect(workspace.getState().persistence.kind).toBe('committed-awaiting-authority')
    expect(preview(workspace)).toEqual({ x: 1 })
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('intents')
    source.readHook = null
    expect((await workspace.recover()).kind).toBe('committed')
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
  })

  it('looks up a lost response using the original operation and never starts a replacement save', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    source.submitHook = async (_request, execute) => { execute(); throw new Error('Response lost') }
    await edit(workspace, { x: 1 })
    const result = await workspace.save()
    expect(result.kind).toBe('unresolved')
    expect(workspace.getState().persistence.kind).toBe('outcome-unknown')
    expect((await workspace.save()).kind).toBe('blocked')
    expect((await workspace.recover()).kind).toBe('committed')
    expect(source.requests).toHaveLength(1); expect(source.lookups).toBe(1)
  })

  it('retries an unknown execution with the identical frozen payload only when explicitly requested', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    source.submitHook = async () => { throw new Error('Offline before execution') }
    await edit(workspace, { x: 1 }); expect((await workspace.save()).kind).toBe('unresolved')
    await edit(workspace, { x: 2 })
    expect((await workspace.recover()).kind).toBe('unresolved')
    expect(source.writes).toBe(0)
    source.submitHook = null
    const result = await workspace.recover('retry')
    expect(result.kind).toBe('committed')
    expect(source.requests).toHaveLength(2); expect(source.requests[1]).toEqual(source.requests[0])
    expect(source.writes).toBe(1); expect(preview(workspace)).toEqual({ x: 2 })
  })

  it('rechecks authority after receiving a shared permit and includes edits made while waiting', async () => {
    const { workspace: a, source } = await setup({ a: { x: 0, y: 0 } })
    const { workspace: b } = await setup({}, source)
    const entered = deferred<void>(), finish = deferred<void>(), waiting = deferred<void>()
    source.submitHook = async (_request, execute) => { const result = execute(); entered.resolve(); await finish.promise; return result }
    await edit(a, { x: 1 }); const savingA = a.save(); await entered.promise
    const detach = b.subscribe(() => { if (b.getState().persistence.kind === 'waiting-for-gateway') waiting.resolve() })
    await edit(b, { y: 1 }); const savingB = b.save(); await waiting.promise
    await edit(b, { y: 2 }); finish.resolve()
    expect((await savingA).kind).toBe('committed')
    expect((await savingB).kind).toBe('committed'); detach()
    expect(preview(b)).toEqual({ x: 1, y: 2 }); expect(source.writes).toBe(2)
  })

  it('reports a definitive backend rejection without settling recoverable input', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    source.submitHook = async (_request, execute) => { source.external({ a: { x: 7 } }); return execute() }
    await edit(workspace, { x: 1 })
    expect((await workspace.save()).kind).toBe('not-applied')
    expect(workspace.getState().persistence.kind).toBe('idle')
    expect(workspace.getState().inputs[0]?.disposition.kind).toBe('intents')
    expect((await workspace.refresh()).kind).toBe('accepted')
    expect(workspace.getProjection().rows[0]?.persistence).toBe('blocked')
    expect(source.writes).toBe(0)
  })

  it('stops repeated malformed evidence without a polling loop and later accepts a corrected receipt', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    source.submitHook = async (_request, execute) => {
      const result = execute()
      if (result.kind !== 'applied') throw new Error('Expected applied')
      const malformed = { ...result, receipt: { ...result.receipt, results: [] } }
      source.lookupHook = async () => malformed
      return malformed
    }
    await edit(workspace, { x: 1 }); expect((await workspace.save()).kind).toBe('unresolved')
    expect(workspace.getState().persistence.kind).toBe('receipt-blocked')
    expect(source.requests).toHaveLength(1); expect(source.lookups).toBe(1)
    source.lookupHook = null
    expect((await workspace.recover()).kind).toBe('committed')
    expect(source.requests).toHaveLength(1)
  })

  it('retains rejected prepared input and prevents view exceptions from changing authoritative results', async () => {
    const { workspace, source } = await setup({ a: { x: 0 } })
    const stale = prepare(workspace, { x: 9 })
    await edit(workspace, { x: 1 })
    expect((await workspace.dispatch({ kind: 'prepared-action', prepared: stale })).kind).toBe('rejected')
    expect(workspace.getRejectedActions()[0]?.prepared).toEqual(stale)
    workspace.subscribe(() => { throw new Error('View failed') })
    expect((await workspace.save()).kind).toBe('committed')
    expect(source.writes).toBe(1)
    expect(workspace.getRejectedActions()).toHaveLength(1)
  })
})
