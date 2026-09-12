import { compileFrontierTable, expandFrontier } from './frontier-table.js'
import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { ReferenceEditor, ReferenceServer } from '../../tests/kernel/reference-model.js'
import { referenceOrderCompensation } from '../../tests/kernel/order-model.js'
import { ReferenceCausalReads } from '../../tests/kernel/causal-read-model.js'
import { currentHistoryEntity, declaredOrderOperation, declaredRowOperation } from './intent.js'
import { prepareRedo, prepareUndo, projectHistory } from './history.js'
import { kernelId, type ExactReceipt, type FrozenSubmission } from './model.js'
import { bindServerAuthority, unboundServerIdentities } from './source.js'
import { defineKernelSchema } from './schema.js'

function undo(fixture: KernelFixture) {
  const id = fixture.next(), target = projectHistory(fixture.state).undo.at(-1)!
  const entities = [...new Set(target.intentIds.map(id => fixture.state.journal.intents.find(intent => intent.id === id)!)
    .flatMap(intent => 'entityId' in intent.operation ? [intent.operation.entityId] : []))]
  const prepared = prepareUndo(fixture.state, { actionId: kernelId<'action'>(`undo-action:${id}`), applicationId: kernelId<'application'>(`undo-application:${id}`),
    controls: entities.map((entityId, index) => ({ entityId, intentId: kernelId<'intent'>(`undo-intent:${id}:${index}`) })),
    ...(target.intentIds.some(id => declaredOrderOperation(fixture.state.journal.intents.find(intent => intent.id === id)!)) ? { orderIntentId: kernelId<'intent'>(`undo-order:${id}`) } : {}),
  })
  const result = fixture.dispatch({ kind: 'prepared-undo', prepared })
  expect(result.result.kind).toBe('accepted')
  return prepared
}
async function read(fixture: KernelFixture, source: SourceFixture) {
  const raw = await source.readAtLeast()
  const allocations = unboundServerIdentities(fixture.state, raw).map(identity => ({ identity, entityId: kernelId<'entity'>(`read-allocation:${fixture.next()}`) }))
  expect(fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, raw, allocations) }).result.kind).toBe('accepted')
}
async function save(fixture: KernelFixture, source: SourceFixture) {
  const submission = fixture.freeze().submission, result = await source.submit(submission)
  expect(result.kind).toBe('applied')
  if (result.kind !== 'applied') throw new Error('Expected exact application')
  applied(fixture, result.receipt); await read(fixture, source)
  return submission
}
function applied(fixture: KernelFixture, receipt: ExactReceipt) {
  expect(fixture.dispatch({ kind: 'exact-receipt', receipt }).result.kind).toBe('accepted')
}
function uncertain(fixture: KernelFixture, submission: FrozenSubmission) {
  expect(fixture.dispatch({ kind: 'mutation-uncertain', ref: submission, attempt: 1, issue: { code: 'lost', message: 'Response lost' } }).result.kind).toBe('accepted')
}
const preview = (fixture: KernelFixture, entity = 'a') => fixture.project().rows.find(row => row.entityId === entity)?.preview
const order = (...ids: string[]) => ({ kind: 'order' as const, desired: ids.map(id => kernelId<'entity'>(id)) })

function redo(fixture: KernelFixture) {
  const id = fixture.next(), target = projectHistory(fixture.state).redo.at(-1)!
  const records = target.intentIds.map(id => fixture.state.journal.intents.find(intent => intent.id === id)!)
  const prepared = prepareRedo(fixture.state, { applicationId: kernelId<'application'>(`redo-application:${id}`),
    controls: records.map((record, index) => ({ sourceIntentId: record.id, intentId: kernelId<'intent'>(`redo-intent:${id}:${index}`) })),
    creations: records.flatMap((record, index) => { const operation = declaredRowOperation(record)
      return operation?.kind === 'create' ? [{ sourceEntityId: operation.entityId, entityId: kernelId<'entity'>(`redo-entity:${id}:${index}`) }] : []
    }),
  }, fixture.schema)
  return fixture.dispatch({ kind: 'prepared-redo', prepared })
}

describe('conditional order history', () => {
  it('matches an independent compensation oracle across 168 canonical, remote, outcome and timing combinations', async () => {
    const permutations = [['a', 'b', 'c'], ['a', 'c', 'b'], ['b', 'a', 'c'], ['b', 'c', 'a'], ['c', 'a', 'b'], ['c', 'b', 'a']]
    for (const canonical of permutations) for (const remote of [...permutations, ['a', 'new', 'b', 'c']]) for (const appliedOutcome of [false, true]) for (const earlyUndo of [false, true]) {
      const initial = { a: {}, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      source.normalizeOrder = entries => canonical.map(key => entries.find(identity => identity.key === key)!)
      fixture.apply([order('b', 'a', 'c')]); const request = fixture.freeze().submission
      if (!appliedOutcome) source.external(initial)
      const result = await source.submit(request)
      uncertain(fixture, request)
      if (earlyUndo) undo(fixture)
      source.external(Object.fromEntries(remote.map(id => [id, {}])))
      if (result.kind === 'applied') applied(fixture, result.receipt)
      else if (result.kind === 'not-applied') fixture.dispatch({ kind: 'not-applied', proof: result.proof })
      else throw new Error('Expected a definitive source outcome')
      await read(fixture, source)
      if (!earlyUndo) undo(fixture)
      const expected = referenceOrderCompensation(['a', 'b', 'c'], appliedOutcome ? canonical : null, remote), actual = fixture.project()
      const bindings = new Map(fixture.state.entities.flatMap(binding => binding.kind === 'local' ? [] : [[binding.entityId, binding.identity.key] as const]))
      const context = JSON.stringify({ canonical, remote, appliedOutcome, earlyUndo })
      expect(actual.order.preview.map(id => bindings.get(id)), context).toEqual(expected.visible)
      expect(actual.order.persistence === 'blocked', context).toBe(expected.blocked)
      expect(actual.orderChange?.desired.map(id => bindings.get(id)) ?? null, context).toEqual(expected.save)
    }
  })

  it('withdraws unsent and externally satisfied order requirements without undoing remote writers', async () => {
    for (const satisfied of [false, true]) {
      const initial = { a: {}, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      fixture.apply([order('b', 'a', 'c')])
      source.external(satisfied ? { b: {}, a: {}, c: {} } : { c: {}, b: {}, a: {} }); await read(fixture, source)
      undo(fixture)
      expect(fixture.project().order.preview).toEqual(satisfied ? ['b', 'a', 'c'] : ['c', 'b', 'a'])
      expect(fixture.project().orderChange).toBeNull(); expect(source.writes).toBe(0)
    }
  })

  it('waits for unknown order outcomes and conditionally compensates only actual application', async () => {
    for (const outcome of ['applied', 'rejected'] as const) {
      const initial = { a: {}, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      fixture.apply([order('b', 'a', 'c')]); const request = fixture.freeze().submission
      if (outcome === 'rejected') source.external({ c: {}, b: {}, a: {} })
      const result = await source.submit(request)
      uncertain(fixture, request); undo(fixture)
      expect(fixture.state.persistence.kind).toBe('outcome-unknown'); expect(fixture.project().orderChange).toBeNull()
      if (result.kind === 'applied') applied(fixture, result.receipt)
      else if (result.kind === 'not-applied') fixture.dispatch({ kind: 'not-applied', proof: result.proof })
      else throw new Error('Expected a definitive source outcome')
      await read(fixture, source)
      expect(fixture.project().order.preview).toEqual(outcome === 'applied' ? ['a', 'b', 'c'] : ['c', 'b', 'a'])
      if (outcome === 'applied') {
        await save(fixture, source); expect(fixture.project().order.authority).toEqual(['a', 'b', 'c'])
      } else expect(fixture.project().orderChange).toBeNull()
    }
  })

  it('uses exact canonical order for compensation CAS and preserves later remote reorder conflicts', async () => {
    for (const remote of [false, true]) {
      const initial = { a: {}, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      source.normalizeOrder = entries => [entries[2]!, entries[0]!, entries[1]!]
      fixture.apply([order('b', 'a', 'c')]); await save(fixture, source)
      if (remote) { source.external({ a: {}, c: {}, b: {} }); await read(fixture, source) }
      undo(fixture)
      expect(fixture.project().order.desired).toEqual(['a', 'b', 'c'])
      if (remote) {
        expect(fixture.project().orderChange).toBeNull()
        expect(fixture.project().order.issues.find(issue => issue.code === 'order-conflict')?.comparison?.base).toEqual([{ kind: 'value', value: ['c', 'b', 'a'] }])
      } else {
        source.normalizeOrder = entries => entries; await save(fixture, source)
        expect(fixture.project().order.authority).toEqual(['a', 'b', 'c'])
      }
    }
  })

  it('navigates coalesced order applications without inventing intermediate server receipts', async () => {
    const initial = { a: {}, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([order('b', 'a', 'c')]); fixture.apply([order('c', 'b', 'a')]); await save(fixture, source)
    undo(fixture); expect(fixture.project().order.preview).toEqual(['b', 'a', 'c'])
    undo(fixture); expect(fixture.project().order.preview).toEqual(['a', 'b', 'c'])
    expect(fixture.state.commits).toHaveLength(1)
    expect(redo(fixture).result.kind).toBe('accepted'); expect(fixture.project().order.preview).toEqual(['b', 'a', 'c'])
    await save(fixture, source)
    expect(redo(fixture).result.kind).toBe('accepted'); expect(fixture.project().order.preview).toEqual(['c', 'b', 'a'])
    undo(fixture); expect(fixture.project().order.preview).toEqual(['b', 'a', 'c'])
  })

  it('undoes an inserted creation as one action and redoes with a new lifetime at the stored position', async () => {
    const initial = { a: {}, b: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const action = fixture.apply([{ kind: 'create', entityId: kernelId<'entity'>('local'), document: { x: 1 } }, order('a', 'local', 'b')])
    expect(action.action.beforeOrder).toEqual(['a', 'b'])
    await save(fixture, source); undo(fixture)
    expect(fixture.project().order.preview).toEqual(['a', 'b']); await save(fixture, source)
    expect(redo(fixture).result.kind).toBe('accepted')
    const created = fixture.project().rows.find(row => row.existence === 'local-create')!.entityId
    expect(created).not.toBe('local'); expect(fixture.project().order.preview).toEqual(['a', created, 'b'])
    await save(fixture, source); undo(fixture); await save(fixture, source)
    expect(fixture.project().order.authority).toEqual(['a', 'b']); expect(source.rows.size).toBe(2)
  })

  it('restores deleted membership and the complete action order through successive new identities', async () => {
    const initial = { a: {}, b: { hidden: 7 }, c: {} }, fixture = new KernelFixture(initial, undefined, { restoreDeleted: true })
    const source = new SourceFixture(fixture.state.workspace.scope, initial, true)
    const action = fixture.apply([{ kind: 'delete', entityId: kernelId<'entity'>('b') }, order('c', 'a')])
    expect(action.action.beforeOrder).toEqual(['a', 'b', 'c'])
    await save(fixture, source); undo(fixture)
    const first = currentHistoryEntity(fixture.state, kernelId<'entity'>('b'))
    expect(fixture.project().order.preview).toEqual(['a', first, 'c']); expect(preview(fixture, first)).toEqual({ hidden: 7 })
    const restoration = await save(fixture, source)
    expect(restoration.items.map(item => item.kind)).toEqual(['create', 'order'])
    expect(redo(fixture).result.kind).toBe('accepted'); await save(fixture, source)
    expect(fixture.project().order.authority).toEqual(['c', 'a'])
    undo(fixture); const second = currentHistoryEntity(fixture.state, kernelId<'entity'>('b'))
    expect(second).not.toBe(first); expect(fixture.project().order.preview).toEqual(['a', second, 'c'])
    await save(fixture, source); expect(fixture.project().order.authority).toEqual(['a', second, 'c'])
  })

  it('compensates a saved field while withdrawing its unsaved conflicted order in the same action', async () => {
    const initial = { a: { x: 0 }, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 }), order('b', 'a', 'c')])
    source.external({ c: {}, a: { x: 0 }, b: {} }); await read(fixture, source)
    const request = await save(fixture, source); expect(request.items.map(item => item.kind)).toEqual(['update'])
    undo(fixture); expect(preview(fixture)).toEqual({ x: 0 }); expect(fixture.project().order.preview).toEqual(['c', 'a', 'b'])
    await save(fixture, source); expect([...source.rows.values()].find(row => row.identity.key === 'a')?.document).toEqual({ x: 0 })
  })

  it('keeps redo and a second undo conditional while the original order request is unresolved', async () => {
    for (const outcome of ['applied', 'rejected'] as const) for (const undoAgain of [false, true]) {
      const initial = { a: {}, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      fixture.apply([order('b', 'a', 'c')]); const request = fixture.freeze().submission
      if (outcome === 'rejected') source.external(initial)
      const result = await source.submit(request)
      uncertain(fixture, request); undo(fixture); expect(redo(fixture).result.kind).toBe('accepted')
      if (undoAgain) undo(fixture)
      if (result.kind === 'applied') applied(fixture, result.receipt)
      else if (result.kind === 'not-applied') fixture.dispatch({ kind: 'not-applied', proof: result.proof })
      else throw new Error('Expected a definitive source outcome')
      await read(fixture, source)
      expect(fixture.project().order.preview).toEqual(undoAgain ? ['a', 'b', 'c'] : ['b', 'a', 'c'])
      if (fixture.project().orderChange) await save(fixture, source)
      expect(fixture.project().order.authority).toEqual(undoAgain ? ['a', 'b', 'c'] : ['b', 'a', 'c'])
    }
  })

  it('keeps a neutral order prefix reversible after remote refresh and later editing', async () => {
    const initial = { a: {}, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([order('b', 'a', 'c')]); fixture.apply([order('a', 'b', 'c')])
    source.external({ c: {}, b: {}, a: {} }); await read(fixture, source)
    expect(fixture.project().order.preview).toEqual(['c', 'b', 'a']); expect(fixture.project().neutralIntentIds).toHaveLength(2)
    fixture.apply([order('c', 'a', 'b')]); undo(fixture)
    expect(fixture.project().order.preview).toEqual(['c', 'b', 'a'])
    undo(fixture); expect(fixture.project().order.preview).toEqual(['b', 'a', 'c'])
    expect(fixture.project().order.persistence).toBe('blocked')
    expect(fixture.project().orderChange).toBeNull()
  })

  it('saves order compensation independently from a conflicted field compensation', async () => {
    const initial = { a: { x: 0 }, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 }), order('b', 'a', 'c')]); await save(fixture, source)
    source.external({ b: {}, a: { x: 9 }, c: {} }); await read(fixture, source); undo(fixture)
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['order'])
    expect(fixture.project().order.authority).toEqual(['a', 'b', 'c'])
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.persistence).toBe('blocked')
  })
})

describe('conditional journal undo', () => {
  it('matches an independent captured-expression model across 27 nested neutral-reader authority combinations', async () => {
    for (const a of [0, 1, 3]) for (const b of [0, 1, 3]) for (const c of [0, 1, 3]) {
      const initial = { a: { x: 0 }, b: { x: 0 }, c: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      const model = new ReferenceCausalReads({ a: 0, b: 0, c: 0 })
      fixture.apply([fixture.write('a', { x: 1 })]); model.write('a', 1)
      fixture.apply([fixture.write('b', { x: 1 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: kernelId<'entity'>('a'), path: ['x'] } }] })]); model.write('b', 1, ['a'])
      fixture.apply([fixture.write('a', { x: 0 })]); model.write('a', 0)
      fixture.apply([fixture.write('c', { x: 1 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: kernelId<'entity'>('b'), path: ['x'] } }] })]); model.write('c', 1, ['b'])
      fixture.apply([fixture.write('b', { x: 0 })]); model.write('b', 0)
      source.external({ a: { x: a }, b: { x: b }, c: { x: c } }); await read(fixture, source); model.observe({ a, b, c })
      const expected = model.project(), actual = fixture.project(), context = JSON.stringify({ a, b, c })
      for (const name of ['a', 'b', 'c']) {
        const row = actual.rows.find(row => row.entityId === name)!
        expect(row.preview, context).toEqual({ x: expected[name]!.value })
        expect(row.persistence === 'blocked', context).toBe(expected[name]!.blocked)
        expect(actual.changes.find(change => change.entityId === name)?.after?.x ?? null, context).toBe(expected[name]!.save)
      }
    }
  })

  it('validates live readers of a neutral row prefix without submitting or reviving that prefix', async () => {
    for (const remote of [0, 1, 3]) {
      const initial = { a: { x: 0 }, b: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      fixture.apply([fixture.write('a', { x: 1 })])
      const consumer = fixture.apply([fixture.write('b', { x: 1 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: kernelId<'entity'>('a'), path: ['x'] } }] })])
      fixture.apply([fixture.write('a', { x: 0 })])
      source.external({ a: { x: remote }, b: { x: 0 } }); await read(fixture, source)
      expect(preview(fixture, 'a')).toEqual({ x: remote }); expect(preview(fixture, 'b')).toEqual({ x: 1 })
      expect(fixture.project().neutralIntentIds).toHaveLength(2)
      if (remote === 3) {
        expect(fixture.project().changes).toEqual([])
        expect(fixture.project().rows.find(row => row.entityId === 'b')?.issues.some(issue => issue.code === 'dependency-blocked')).toBe(true)
      } else {
        const request = await save(fixture, source)
        expect(request.items).toHaveLength(1); expect(request.coverage[0]?.intentIds).toEqual(consumer.action.intentIds)
      }
    }
  })

  it('evaluates nested historical readers through neutral prefixes without manufacturing intermediate commits', async () => {
    const initial = { a: { x: 0 }, b: { x: 0 }, c: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 })])
    fixture.apply([fixture.write('b', { x: 1 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: kernelId<'entity'>('a'), path: ['x'] } }] })])
    fixture.apply([fixture.write('a', { x: 0 })])
    const consumer = fixture.apply([fixture.write('c', { x: 1 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: kernelId<'entity'>('b'), path: ['x'] } }] })])
    fixture.apply([fixture.write('b', { x: 0 })])
    const request = await save(fixture, source)
    expect(request.items).toHaveLength(1); expect(request.coverage[0]?.intentIds).toEqual(consumer.action.intentIds)
    expect(fixture.state.commits).toHaveLength(1); expect(fixture.project().neutralIntentIds).toHaveLength(4)
    expect([...source.rows.values()].map(row => row.document)).toEqual([{ x: 0 }, { x: 0 }, { x: 1 }])
  })

  it('reverses sequential parent and child groups before removing the newly created parent', async () => {
    const fixture = new KernelFixture({ a: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {} })
    fixture.apply([{ kind: 'write', entityId: kernelId<'entity'>('a'), groups: [
      { id: kernelId<'write-group'>('parent'), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['parent'], value: { x: 1 } }] },
      { id: kernelId<'write-group'>('child'), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['parent', 'x'], value: 2 }] },
    ] }])
    await save(fixture, source); undo(fixture)
    expect(preview(fixture)).toEqual({}); expect(fixture.project().rows[0]?.issues).toEqual([])
    await save(fixture, source); expect(preview(fixture)).toEqual({})
  })

  it('retains a whole-entity comparison domain when compensating a partial field write', async () => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 }, { comparison: 'entity' })]); await save(fixture, source)
    source.external({ a: { x: 1, hidden: 9 } }); await read(fixture, source); undo(fixture)
    expect(preview(fixture)).toEqual({ x: 0, hidden: 9 }); expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows[0]?.issues[0]?.comparison?.resources).toEqual([{ kind: 'entity', entityId: 'a' }])
  })

  it('inverts mixed field writes and replacements to the complete action start document', async () => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1, temporary: null }), { kind: 'replace', entityId: kernelId<'entity'>('a'), document: { y: 2 } }, fixture.write('a', { y: 3 })])
    await save(fixture, source); undo(fixture)
    expect(preview(fixture)).toEqual({ x: 0, hidden: 7 }); await save(fixture, source)
    expect(redo(fixture).result.kind).toBe('accepted'); await save(fixture, source)
    expect(preview(fixture)).toEqual({ y: 3 })
  })

  it('keeps local create-delete cancellation reversible without pretending either action was committed', () => {
    const fixture = new KernelFixture({})
    fixture.apply([{ kind: 'create', entityId: kernelId<'entity'>('local'), document: { x: 1 } }])
    fixture.apply([{ kind: 'delete', entityId: kernelId<'entity'>('local') }])
    expect(fixture.project().changes).toEqual([]); expect(fixture.project().rows).toEqual([])
    expect(fixture.state.settlements).toEqual([])
    undo(fixture); expect(preview(fixture, 'local')).toEqual({ x: 1 })
    expect(fixture.project().changes[0]?.kind).toBe('create')
    undo(fixture); expect(fixture.project().changes).toEqual([])
  })

  it('preserves a neutral prefix through refresh and new editing, then reveals it only through history navigation', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    const reference = new ReferenceEditor({ a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); reference.write('a', { x: 1 })
    fixture.apply([fixture.write('a', { x: 0 })]); const second = reference.write('a', { x: 0 })
    expect(fixture.project().changes).toEqual([])
    source.external({ a: { x: 3 } }); await read(fixture, source); reference.observe({ a: { x: 3 } }, 1)
    expect(preview(fixture)).toEqual(reference.preview().a); expect(preview(fixture)).toEqual({ x: 3 })
    fixture.apply([fixture.write('a', { x: 2 })]); const third = reference.write('a', { x: 2 })
    expect(fixture.project().changes[0]?.after).toEqual({ x: 2 })
    undo(fixture); reference.undo(third)
    expect(preview(fixture)).toEqual(reference.preview().a); expect(preview(fixture)).toEqual({ x: 3 })
    undo(fixture); reference.undo(second)
    expect(preview(fixture)).toEqual(reference.preview().a); expect(preview(fixture)).toEqual({ x: 1 })
    expect(fixture.project().changes).toEqual([])
  })

  it('recognizes a cancelled narrow write followed by restoring its parent document', () => {
    const fixture = new KernelFixture({ a: { profile: { x: 0, y: 8 } } })
    fixture.apply([{ kind: 'write', entityId: kernelId<'entity'>('a'), groups: [{ id: kernelId<'write-group'>('narrow'), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['profile', 'x'], value: 1 }] }] }])
    fixture.apply([fixture.write('a', { profile: { x: 0, y: 8 } })])
    fixture.observe({ a: { profile: { x: 3, y: 9 } } }, 1)
    expect(preview(fixture)).toEqual({ profile: { x: 3, y: 9 } }); expect(fixture.project().neutralIntentIds).toHaveLength(2)
    undo(fixture)
    expect(preview(fixture)).toEqual({ profile: { x: 1, y: 9 } }); expect(fixture.project().changes).toEqual([])
  })

  it('matches the independent reference model across outcome, normalization, later authority and undo timing', async () => {
    for (const outcome of ['applied', 'rejected'] as const) for (const canonical of [1, 1.5]) for (const remote of [null, 0, 3]) for (const earlyUndo of [false, true]) {
      const initial = { a: { x: 0, hidden: 4 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      const oracle = new ReferenceEditor(initial), server = new ReferenceServer(initial)
      fixture.apply([fixture.write('a', { x: 1 })]); const action = oracle.write('a', { x: 1 })
      const submission = fixture.freeze().submission, request = oracle.freeze('original')
      if (outcome === 'rejected') { source.external(initial); server.external(initial) }
      source.normalize = document => ({ ...document, x: canonical })
      const actual = await source.submit(submission)
      let receipt = null
      if (outcome === 'applied') receipt = server.apply(request, (_entity, row) => ({ ...row, x: canonical }))
      else expect(() => server.apply(request)).toThrow('Definitely not applied')
      uncertain(fixture, submission); oracle.unknown()
      if (earlyUndo) { undo(fixture); oracle.undo(action) }
      if (remote !== null) { const rows = { a: { x: remote, hidden: 5 } }; source.external(rows); server.external(rows) }
      if (actual.kind === 'applied' && receipt) { applied(fixture, actual.receipt); oracle.receive(receipt) }
      else if (actual.kind === 'not-applied') { fixture.dispatch({ kind: 'not-applied', proof: actual.proof }); oracle.notApplied() }
      else throw new Error('Unexpected source result')
      await read(fixture, source); oracle.observe(server.rows, server.version)
      if (!earlyUndo) { undo(fixture); oracle.undo(action) }
      const context = JSON.stringify({ outcome, canonical, remote, earlyUndo })
      expect(preview(fixture), context).toEqual(oracle.preview().a)
      expect(fixture.project().rows.filter(row => row.issues.length).map(row => row.entityId), context).toEqual(oracle.blockedEntities())
      if (fixture.project().changes.length) {
        source.normalize = document => document
        const compensation = oracle.freeze('compensation')
        await save(fixture, source); oracle.receive(server.apply(compensation)); oracle.observe(server.rows, server.version)
        expect(preview(fixture), context).toEqual(oracle.preview().a)
      }
      expect(source.writes, context).toBe(server.writes)
    }
  })

  it('suppresses an unsent requirement and preserves current remote data instead of writing the old value', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    const original = fixture.apply([fixture.write('a', { x: 1 })])
    fixture.observe({ a: { x: 3 } }, 1)
    undo(fixture)
    expect(preview(fixture)).toEqual({ x: 3 }); expect(fixture.project().changes).toEqual([])
    expect(fixture.state.settlements.find(proof => proof.intentId === original.intents[0]!.id)?.kind).toBe('discarded')
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('settled-intents')
    expect(projectHistory(fixture.state).undo).toEqual([])
    expect(projectHistory(fixture.state).redo).toEqual([original.action])
  })

  it('undoes only the local requirement when it was satisfied by someone else', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    const original = fixture.apply([fixture.write('a', { x: 1 })])
    fixture.observe({ a: { x: 1 } }, 1); undo(fixture)
    expect(preview(fixture)).toEqual({ x: 1 }); expect(fixture.project().changes).toEqual([])
    expect(fixture.state.settlements.find(proof => proof.intentId === original.intents[0]!.id)?.kind).toBe('externally-satisfied')
  })

  it('compensates declared paths using the exact canonical base while retaining other server fields', async () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: 1 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0, hidden: 1 } })
    source.normalize = document => document.x === 1 ? { ...document, x: 1.5, hidden: 2 } : document
    fixture.apply([fixture.write('a', { x: 1 })]); await save(fixture, source)
    undo(fixture)
    expect(preview(fixture)).toEqual({ x: 0, hidden: 2 })
    expect(fixture.project().changes).toHaveLength(1)
    await save(fixture, source)
    expect(preview(fixture)).toEqual({ x: 0, hidden: 2 }); expect(source.writes).toBe(2)
  })

  it('keeps an unknown request immutable, then compensates only after its exact application barrier', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    source.normalize = document => document.x === 1 ? { ...document, x: 1.5 } : document
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = fixture.freeze().submission
    const result = await source.submit(submission); if (result.kind !== 'applied') throw new Error('Expected applied')
    uncertain(fixture, submission); const control = undo(fixture)
    expect(preview(fixture)).toEqual({ x: 0 }); expect(fixture.project().changes).toEqual([])
    expect('submission' in fixture.state.persistence && fixture.state.persistence.submission).toEqual(submission)
    applied(fixture, result.receipt)
    expect(fixture.project().changes).toEqual([])
    await read(fixture, source)
    expect(fixture.project().changes[0]?.intentIds).toEqual(control.action.intentIds)
    await save(fixture, source); expect(preview(fixture)).toEqual({ x: 0 })
  })

  it('suppresses both conditional control and original input after a definitive non-application', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = fixture.freeze().submission
    uncertain(fixture, submission); const control = undo(fixture)
    source.external({ a: { x: 3 } }); await read(fixture, source)
    const result = await source.submit(submission); if (result.kind !== 'not-applied') throw new Error('Expected fenced rejection')
    expect(fixture.dispatch({ kind: 'not-applied', proof: result.proof }).result.kind).toBe('accepted')
    expect(preview(fixture)).toEqual({ x: 3 }); expect(fixture.project().changes).toEqual([])
    expect(fixture.state.settlements.find(proof => proof.intentId === control.intents[0]!.id)?.kind).toBe('control-completed')
    expect(source.writes).toBe(0)
  })

  it('undoes coalesced actions through compensation provenance without inventing intermediate commits', async () => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    source.normalize = document => document.x === 2 ? { ...document, x: 2.5, hidden: 8 } : document
    const first = fixture.apply([fixture.write('a', { x: 1 })], 'row', 'first original')
    const second = fixture.apply([fixture.write('a', { x: 2 })], 'row', 'second original')
    const merged = await save(fixture, source)
    expect(merged.coverage.flatMap(item => item.intentIds)).toEqual([...first.action.intentIds, ...second.action.intentIds])
    expect(fixture.state.commits[0]?.receipt.results).toEqual([expect.objectContaining({ kind: 'updated', canonical: { x: 2.5, hidden: 8 } })])
    undo(fixture); expect(preview(fixture)).toEqual({ x: 1, hidden: 8 })
    undo(fixture); expect(preview(fixture)).toEqual({ x: 0, hidden: 8 })
    expect(fixture.project().changes).toHaveLength(1)
    await save(fixture, source)
    expect(source.requests.map(request => request.items[0]?.kind === 'update' ? request.items[0].after.x : null)).toEqual([2, 0])
    expect(redo(fixture).result.kind).toBe('accepted'); expect(preview(fixture)).toEqual({ x: 1, hidden: 8 })
    expect(redo(fixture).result.kind).toBe('accepted'); expect(preview(fixture)).toEqual({ x: 2, hidden: 8 })
    await save(fixture, source)
    expect(preview(fixture)).toEqual({ x: 2.5, hidden: 8 })
    undo(fixture); expect(preview(fixture)).toEqual({ x: 1, hidden: 8 })
    undo(fixture); expect(preview(fixture)).toEqual({ x: 0, hidden: 8 })
    await save(fixture, source)
    expect(source.requests.map(request => request.items[0]?.kind === 'update' ? request.items[0].after.x : null)).toEqual([2, 0, 2, 0])
    expect(source.snapshot().rows[0]?.document).toEqual({ x: 0, hidden: 8 })
    expect(source.writes).toBe(4)
    expect(fixture.state.journal.intents.slice(0, 2)).toEqual([...first.intents, ...second.intents])
    expect(fixture.state.inputs.slice(0, 2).map(input => input.input)).toEqual([
      { kind: 'encoded', value: 'first original' }, { kind: 'encoded', value: 'second original' },
    ])
  })

  it('combines suppression and compensation for an action whose rows were only partially saved', async () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 }, b: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 }), fixture.write('b', { x: 1 })])
    source.external({ a: { x: 9 }, b: { x: 0 } }); await read(fixture, source)
    const partial = await save(fixture, source)
    expect(partial.items).toMatchObject([{ kind: 'update', entityId: 'b', before: { x: 0 }, after: { x: 1 } }])
    expect([...source.rows.values()].map(row => row.document)).toEqual([{ x: 9 }, { x: 1 }])
    undo(fixture)
    expect(preview(fixture)).toEqual({ x: 9 }); expect(preview(fixture, 'b')).toEqual({ x: 0 })
    expect(fixture.project().changes.map(change => change.entityId)).toEqual(['b'])
    const compensation = await save(fixture, source)
    expect(compensation.items).toMatchObject([{ kind: 'update', entityId: 'b', before: { x: 1 }, after: { x: 0 } }])
    expect([...source.rows.values()].map(row => row.document)).toEqual([{ x: 9 }, { x: 0 }])
    expect(source.writes).toBe(2)
  })

  it('blocks compensation against later remote changes rather than overwriting them', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); await save(fixture, source)
    source.external({ a: { x: 3 } }); await read(fixture, source); undo(fixture)
    expect(preview(fixture)).toEqual({ x: 0 }); expect(fixture.project().changes).toEqual([])
    const conflict = fixture.project().rows[0]?.issues.find(issue => issue.code === 'write-conflict')
    expect(conflict?.comparison).toMatchObject({ base: [{ kind: 'value', value: 1 }], local: [{ kind: 'value', value: 0 }], remote: [{ kind: 'value', value: 3 }] })
  })

  it('inverts every atomic write group in reverse order, including missing versus null', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1, nullable: null }), fixture.write('a', { x: 2 })]); await save(fixture, source)
    undo(fixture); expect(preview(fixture)).toEqual({ x: 0 })
    expect(fixture.project().changes).toHaveLength(1)
    await save(fixture, source); expect(preview(fixture)).toEqual({ x: 0 })
  })

  it('deletes only the exact created incarnation after an unknown create succeeds', async () => {
    const fixture = new KernelFixture({}), source = new SourceFixture(fixture.state.workspace.scope, {})
    fixture.apply([{ kind: 'create', entityId: kernelId<'entity'>('local'), document: { x: 1 } }])
    const submission = fixture.freeze().submission, result = await source.submit(submission)
    if (result.kind !== 'applied') throw new Error('Expected applied')
    uncertain(fixture, submission); undo(fixture); applied(fixture, result.receipt); await read(fixture, source)
    expect(fixture.project().changes[0]).toMatchObject({ kind: 'delete', entityId: 'local' })
    await save(fixture, source); expect(source.rows.size).toBe(0)
  })

  it('preserves immutable evidence when new user input abandons the redo branch', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); undo(fixture)
    const retained = fixture.state.journal.intents
    fixture.apply([fixture.write('a', { x: 2 })])
    expect(projectHistory(fixture.state).redo).toEqual([])
    expect(fixture.state.journal.intents.slice(0, retained.length)).toEqual(retained)
  })

  it('rejects stale or modified controls atomically', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); await save(fixture, source)
    const prepared = prepareUndo(fixture.state, { actionId: kernelId<'action'>('undo'), applicationId: kernelId<'application'>('undo'),
      controls: [{ entityId: kernelId<'entity'>('a'), intentId: kernelId<'intent'>('undo') }],
    })
    const before = fixture.state
    const changed = { ...prepared, intents: prepared.intents.map(intent => ({ ...intent, operation: intent.operation.kind === 'undo' ? { ...intent.operation, compensation: null } : intent.operation })) }
    expect(fixture.dispatch({ kind: 'prepared-undo', prepared: changed }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    fixture.observe({ a: { x: 1 } }, 1)
    expect(fixture.dispatch({ kind: 'prepared-undo', prepared }).result.kind).toBe('rejected')
  })
})

describe('history replay applications', () => {
  it('maps order read values to the same fresh creation identity used by the replayed order', async () => {
    const initial = { a: { rank: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const local = kernelId<'entity'>('local')
    fixture.apply([{ kind: 'create', entityId: local, document: {} }, order('local', 'a'),
      { kind: 'write', entityId: kernelId<'entity'>('a'), groups: [{ id: kernelId<'write-group'>('order-derived'), comparison: 'paths',
        writes: [{ kind: 'set', path: ['rank'], value: 1 }],
        reads: [{ role: 'semantic-read', resource: { kind: 'order' }, expected: { kind: 'value', value: [local, kernelId<'entity'>('a')] } }],
      }] },
    ])
    await save(fixture, source); undo(fixture); await save(fixture, source)
    expect(redo(fixture).result.kind).toBe('accepted')
    const recreated = fixture.project().rows.find(row => row.existence === 'local-create')!.entityId
    expect(recreated).not.toBe(local)
    const application = projectHistory(fixture.state).undo.at(-1)!
    const read = application.intentIds.flatMap(id => {
      const operation = declaredRowOperation(fixture.state.journal.intents.find(intent => intent.id === id)!)
      return operation?.kind === 'write' ? operation.groups.flatMap(group => group.expectations.filter(expected => expected.role === 'semantic-read')) : []
    })
    expect(read[0]?.expected).toEqual({ kind: 'value', value: [recreated, 'a'] })
    await save(fixture, source); expect(fixture.project().order.authority).toEqual([recreated, 'a'])
  })

  it('replays every original intent in order across repeated rows, semantic reads and an explicit order dependency', async () => {
    const initial = { a: { x: 0 }, b: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const computed = { kind: 'write' as const, entityId: kernelId<'entity'>('b'), groups: [{ id: kernelId<'write-group'>('computed'), comparison: 'paths' as const,
      writes: [{ kind: 'set' as const, path: ['x'] as const, value: 1 }],
      reads: [{ resource: { kind: 'path' as const, entityId: kernelId<'entity'>('a'), path: ['x'] as const }, role: 'semantic-read' as const, expected: { kind: 'value' as const, value: 1 } }],
    }] }
    const prepared = fixture.prepare([fixture.write('a', { x: 1 }), order('b', 'a'), computed, fixture.write('a', { x: 2 })])
    const frontiers = compileFrontierTable(prepared.frontiers, [...fixture.state.journal.intents, ...prepared.intents].map(intent => intent.id))
    const intents = prepared.intents.map((intent, index) => index === 2 ? { ...intent, dependencies: frontiers.intern([...expandFrontier(prepared.frontiers, intent.dependencies), prepared.intents[1]!.id]) } : intent)
    const original = { ...prepared, frontiers: frontiers.snapshot(), intents }
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: original }).result.kind).toBe('accepted')
    await save(fixture, source); undo(fixture); await save(fixture, source)
    expect(redo(fixture).result.kind).toBe('accepted')
    const application = projectHistory(fixture.state).undo.at(-1)!
    const controls = application.intentIds.map(id => fixture.state.journal.intents.find(intent => intent.id === id)!)
    expect(controls.map(intent => declaredRowOperation(intent)?.kind ?? declaredOrderOperation(intent)?.kind)).toEqual(['write', 'order', 'write', 'write'])
    expect(expandFrontier(fixture.state.journal.frontiers, controls[2]!.dependencies)).toEqual(expect.arrayContaining([controls[0]!.id, controls[1]!.id]))
    expect(preview(fixture, 'a')).toEqual({ x: 2 }); expect(preview(fixture, 'b')).toEqual({ x: 1 })
    await save(fixture, source); expect(fixture.project().order.authority).toEqual(['b', 'a'])
    expect([...source.rows.values()].map(row => [row.identity.key, row.document])).toEqual([['b', { x: 1 }], ['a', { x: 2 }]])
  })

  it('replays creation, computed updates and position changes without flattening their original template', async () => {
    const initial = { a: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const local = kernelId<'entity'>('local')
    const original = fixture.apply([{ kind: 'create', entityId: local, document: { x: 1 } }, fixture.write(local, { x: 2 }), order('local', 'a'),
      { kind: 'replace', entityId: local, document: { x: 3, hidden: 7 } }])
    await save(fixture, source); undo(fixture); await save(fixture, source)
    expect(redo(fixture).result.kind).toBe('accepted')
    const application = projectHistory(fixture.state).undo.at(-1)!, controls = application.intentIds.map(id => fixture.state.journal.intents.find(intent => intent.id === id)!)
    expect(controls).toHaveLength(original.intents.length)
    expect(controls.map(record => 'sourceIntentId' in record.operation ? record.operation.sourceIntentId : null)).toEqual(original.action.intentIds)
    const created = fixture.project().rows.find(row => row.existence === 'local-create')!.entityId
    expect(preview(fixture, created)).toEqual({ x: 3, hidden: 7 }); expect(fixture.project().order.preview).toEqual([created, 'a'])
    await save(fixture, source); undo(fixture); await save(fixture, source)
    expect(fixture.project().order.authority).toEqual(['a'])
  })

  it('retains dependencies outside the replayed action so an independently blocked prerequisite still blocks saving', () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } })
    const prerequisite = fixture.apply([fixture.write('b', { x: 1 })])
    const prepared = fixture.prepare([fixture.write('a', { x: 2 })])
    const frontiers = compileFrontierTable(prepared.frontiers, [...fixture.state.journal.intents, ...prepared.intents].map(intent => intent.id))
    const dependencies = frontiers.intern(prerequisite.action.intentIds)
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: { ...prepared, frontiers: frontiers.snapshot(), intents: prepared.intents.map(intent => ({ ...intent, dependencies })) } }).result.kind).toBe('accepted')
    undo(fixture); fixture.observe({ a: { x: 0 }, b: { x: 9 } }, 1)
    expect(redo(fixture).result.kind).toBe('accepted')
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.issues.some(issue => issue.code === 'dependency-blocked')).toBe(true)
  })

  it('reapplies the stored target against current authority with a new application identity', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    const original = fixture.apply([fixture.write('a', { x: 1 })]); undo(fixture)
    source.external({ a: { x: 3 } }); await read(fixture, source)
    expect(redo(fixture).result.kind).toBe('accepted')
    expect(preview(fixture)).toEqual({ x: 1 })
    const replay = projectHistory(fixture.state).undo.at(-1)!
    expect(replay.id).toBe(original.action.id); expect(replay.applicationId).not.toBe(original.action.applicationId)
    expect(replay.intentIds).not.toEqual(original.action.intentIds)
    await save(fixture, source)
    undo(fixture); expect(preview(fixture)).toEqual({ x: 3 })
    await save(fixture, source); expect(preview(fixture)).toEqual({ x: 3 })
  })

  it('navigates repeated undo and redo without creating a new branch or reusing contributions', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); fixture.apply([fixture.write('a', { x: 2 })])
    undo(fixture); undo(fixture)
    expect(redo(fixture).result.kind).toBe('accepted'); expect(preview(fixture)).toEqual({ x: 1 })
    expect(redo(fixture).result.kind).toBe('accepted'); expect(preview(fixture)).toEqual({ x: 2 })
    undo(fixture); expect(preview(fixture)).toEqual({ x: 1 })
    expect(redo(fixture).result.kind).toBe('accepted'); expect(preview(fixture)).toEqual({ x: 2 })
    expect(new Set(fixture.state.journal.intents.map(intent => intent.id)).size).toBe(fixture.state.journal.intents.length)
  })

  it('replays while original execution is unknown and preserves the new requirement after rejection', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = fixture.freeze().submission
    uncertain(fixture, submission); undo(fixture)
    expect(redo(fixture).result.kind).toBe('accepted')
    expect(fixture.project().changes).toEqual([])
    source.external({ a: { x: 0 } })
    const result = await source.submit(submission); if (result.kind !== 'not-applied') throw new Error('Expected fenced rejection')
    fixture.dispatch({ kind: 'not-applied', proof: result.proof }); await read(fixture, source)
    expect(preview(fixture)).toEqual({ x: 1 }); expect(fixture.project().changes).toHaveLength(1)
    await save(fixture, source); expect(source.writes).toBe(1)
  })

  it('can undo the replay while original application and its conditional undo are still unresolved', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = fixture.freeze().submission, result = await source.submit(submission)
    if (result.kind !== 'applied') throw new Error('Expected applied')
    uncertain(fixture, submission); undo(fixture); expect(redo(fixture).result.kind).toBe('accepted'); undo(fixture)
    applied(fixture, result.receipt); await read(fixture, source)
    expect(preview(fixture)).toEqual({ x: 0 }); expect(fixture.project().changes).toHaveLength(1)
    await save(fixture, source); expect(preview(fixture)).toEqual({ x: 0 })
  })

  it('allocates a new entity lifetime when redoing a cancelled local creation', async () => {
    const fixture = new KernelFixture({}), source = new SourceFixture(fixture.state.workspace.scope, {})
    const original = kernelId<'entity'>('original-local')
    fixture.apply([{ kind: 'create', entityId: original, proposedKey: 'new', document: { x: 1 } }]); undo(fixture)
    expect(redo(fixture).result.kind).toBe('accepted')
    const change = fixture.project().changes[0]!
    expect(change.kind).toBe('create'); expect(change.entityId).not.toBe(original)
    await save(fixture, source); undo(fixture)
    expect(fixture.project().changes[0]).toMatchObject({ kind: 'delete', entityId: change.entityId })
    await save(fixture, source); expect(source.rows.size).toBe(0)
  })

  it('rejects replay when the stored business calculation no longer has its semantic prerequisites', () => {
    const fixture = new KernelFixture({ a: { qty: 2, total: 0 } })
    fixture.apply([fixture.write('a', { total: 20 }, { reads: [{ resource: { kind: 'path', entityId: kernelId<'entity'>('a'), path: ['qty'] }, role: 'semantic-read' }] })])
    undo(fixture); fixture.observe({ a: { qty: 3, total: 0 } }, 1)
    const before = fixture.state
    expect(redo(fixture).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before); expect(projectHistory(fixture.state).redo).toHaveLength(1)
  })
})

describe('deletion restoration identity', () => {
  const capable = (initial = { a: { x: 0, hidden: 7 } }) => {
    const fixture = new KernelFixture(initial, undefined, { restoreDeleted: true })
    return { fixture, source: new SourceFixture(fixture.state.workspace.scope, initial, true) }
  }
  const remove = (fixture: KernelFixture, entity = 'a') => fixture.apply([{ kind: 'delete', entityId: kernelId<'entity'>(entity) }])

  it('restores a deleted middle row to its original position without an explicit original order command', async () => {
    const initial = { a: {}, b: { x: 1 }, c: {} }, fixture = new KernelFixture(initial, undefined, { restoreDeleted: true }), source = new SourceFixture(fixture.state.workspace.scope, initial, true)
    remove(fixture, 'b'); await save(fixture, source); undo(fixture)
    const restored = currentHistoryEntity(fixture.state, kernelId<'entity'>('b'))
    expect(fixture.project().order.preview).toEqual(['a', restored, 'c'])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['create', 'order'])
    expect(redo(fixture).result.kind).toBe('accepted'); await save(fixture, source); undo(fixture)
    const next = currentHistoryEntity(fixture.state, kernelId<'entity'>('b'))
    expect(next).not.toBe(restored); expect(fixture.project().order.preview).toEqual(['a', next, 'c'])
    await save(fixture, source)
  })

  it('keeps position restoration and creation blocked together after an independent remote reorder', async () => {
    const initial = { a: {}, b: {}, c: {} }, fixture = new KernelFixture(initial, undefined, { restoreDeleted: true }), source = new SourceFixture(fixture.state.workspace.scope, initial, true)
    remove(fixture, 'b'); await save(fixture, source)
    source.external({ c: {}, a: {} }); await read(fixture, source); undo(fixture)
    expect(fixture.project().order.issues.some(issue => issue.code === 'order-conflict')).toBe(true)
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows.find(row => row.existence === 'local-create')?.issues.some(issue => issue.code === 'dependency-blocked')).toBe(true)
    expect(source.writes).toBe(1)
  })

  it('preserves membership through partially applied deletions and a later unknown application or rejection', async () => {
    for (const appliedOutcome of [false, true]) {
      const initial = { a: {}, b: { x: 0 }, c: { x: 0 }, d: {} }, fixture = new KernelFixture(initial, undefined, { restoreDeleted: true }), source = new SourceFixture(fixture.state.workspace.scope, initial, true)
      fixture.apply([{ kind: 'delete', entityId: kernelId<'entity'>('b') }, { kind: 'delete', entityId: kernelId<'entity'>('c') }])
      source.external({ ...initial, b: { x: 9 } }); await read(fixture, source)
      const first = await save(fixture, source); expect(first.items.map(item => item.kind === 'delete' ? item.entityId : null)).toEqual(['c'])
      source.external({ a: {}, b: { x: 0 }, d: {} }); await read(fixture, source)
      const second = fixture.freeze().submission
      if (!appliedOutcome) source.external({ a: {}, b: { x: 7 }, d: {} })
      const result = await source.submit(second)
      uncertain(fixture, second); undo(fixture)
      if (result.kind === 'applied') applied(fixture, result.receipt)
      else if (result.kind === 'not-applied') fixture.dispatch({ kind: 'not-applied', proof: result.proof })
      else throw new Error('Expected a definitive source outcome')
      await read(fixture, source)
      const b = currentHistoryEntity(fixture.state, kernelId<'entity'>('b')), c = currentHistoryEntity(fixture.state, kernelId<'entity'>('c'))
      expect(fixture.project().order.preview).toEqual(['a', b, c, 'd'])
      expect(preview(fixture, b)).toEqual({ x: appliedOutcome ? 0 : 7 })
      const restoration = await save(fixture, source)
      expect(restoration.items.filter(item => item.kind === 'create')).toHaveLength(appliedOutcome ? 2 : 1)
      expect(fixture.project().order.authority).toEqual(['a', b, c, 'd'])
    }
  })

  it('retains edits to a provisional restoration without attaching them to the old row after deletion rejection', async () => {
    const initial = { a: {}, b: { x: 0 }, c: {} }, fixture = new KernelFixture(initial, undefined, { restoreDeleted: true }), source = new SourceFixture(fixture.state.workspace.scope, initial, true)
    remove(fixture, 'b'); const request = fixture.freeze().submission
    source.external({ a: {}, b: { x: 7 }, c: {} })
    const result = await source.submit(request); if (result.kind !== 'not-applied') throw new Error('Expected rejection')
    uncertain(fixture, request); undo(fixture)
    const provisional = fixture.project().rows.find(row => row.existence === 'local-create')!.entityId
    const edit = fixture.apply([fixture.write(provisional, { x: 9 })])
    fixture.dispatch({ kind: 'not-applied', proof: result.proof }); await read(fixture, source)
    expect(preview(fixture, 'b')).toEqual({ x: 7 })
    expect(fixture.project().rows.find(row => row.entityId === provisional)?.issues.some(issue => issue.code === 'target-deleted')).toBe(true)
    expect(fixture.state.inputs.find(input => input.ref.id === edit.inputs[0]!.ref.id)?.disposition.kind).toBe('intents')
    expect(fixture.project().changes).toEqual([]); expect(source.writes).toBe(0)
  })

  it('recovers earlier absorbed contributions while undoing all writes within a mixed deletion action', async () => {
    const { fixture, source } = capable()
    const earlier = fixture.apply([fixture.write('a', { x: 1 })])
    const deleted = fixture.apply([fixture.write('a', { x: 2 }), { kind: 'delete', entityId: kernelId<'entity'>('a') }])
    const request = await save(fixture, source)
    expect(request.coverage[0]?.intentIds).toEqual([...earlier.action.intentIds, ...deleted.action.intentIds])
    expect(request.items[0]).toMatchObject({ kind: 'delete', before: { x: 0, hidden: 7 } })
    undo(fixture)
    const restored = currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))
    expect(preview(fixture, restored)).toEqual({ x: 1, hidden: 7 }); await save(fixture, source)
    undo(fixture); expect(preview(fixture, restored)).toEqual({ x: 0, hidden: 7 }); await save(fixture, source)
  })

  it('combines late canonical deletion material with only the still-absorbed earlier local target', async () => {
    const { fixture, source } = capable()
    fixture.apply([fixture.write('a', { x: 1 })]); const first = fixture.freeze().submission
    source.normalize = document => ({ ...document, x: 1.5, hidden: 9 })
    const result = await source.submit(first); if (result.kind !== 'applied') throw new Error('Expected applied update')
    fixture.apply([fixture.write('a', { x: 2 })]); remove(fixture)
    applied(fixture, result.receipt); await read(fixture, source)
    source.normalize = document => document
    const deletion = await save(fixture, source)
    expect(deletion.items[0]).toMatchObject({ kind: 'delete', before: { x: 1.5, hidden: 9 } })
    undo(fixture)
    const restored = currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))
    expect(preview(fixture, restored)).toEqual({ x: 2, hidden: 9 }); await save(fixture, source)
  })

  it('keeps an accepted restoration blocked when replacement permission is later revoked', async () => {
    const { fixture, source } = capable()
    remove(fixture); await save(fixture, source); undo(fixture)
    const policy = fixture.state.policy
    fixture.dispatch({ kind: 'policy-observed', policy: { ...policy, version: kernelId<'policy-version'>('no-restore'),
      entities: [{ entityId: kernelId<'entity'>('a'), policy: { ...policy.defaultEntity, replace: false } }],
    } })
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows.some(row => row.issues.some(issue => issue.code === 'policy-blocked'))).toBe(true)
    fixture.dispatch({ kind: 'policy-observed', policy })
    expect(fixture.project().changes).toHaveLength(1)
  })

  it('rejects a restoration receipt that resurrects the retired incarnation and later accepts a corrected receipt', async () => {
    const { fixture, source } = capable()
    remove(fixture); await save(fixture, source); undo(fixture)
    const submission = fixture.freeze().submission, result = await source.submit(submission)
    if (result.kind !== 'applied') throw new Error('Expected applied restore')
    const invalid = { ...result.receipt, results: result.receipt.results.map(item => item.kind === 'created' ? { ...item, identity: { key: 'a', incarnation: 'life:1' } } : item) }
    applied(fixture, invalid)
    expect(fixture.state.persistence.kind).toBe('receipt-blocked')
    applied(fixture, result.receipt); await read(fixture, source)
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(source.writes).toBe(2)
  })

  it('requires explicit source support for a committed deletion while unsent deletion remains undoable', async () => {
    const fixture = new KernelFixture({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    remove(fixture); undo(fixture)
    expect(preview(fixture)).toEqual({ x: 0 })
    remove(fixture); await save(fixture, source)
    const before = fixture.state
    expect(() => undo(fixture)).toThrow('cannot restore')
    expect(fixture.state).toBe(before)
  })

  it('restores the complete deleted document with exact deletion proof and a fresh client/server lifetime', async () => {
    const { fixture, source } = capable()
    remove(fixture); const deletion = await save(fixture, source)
    undo(fixture)
    const restored = currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))
    expect(restored).not.toBe('a'); expect(preview(fixture, restored)).toEqual({ x: 0, hidden: 7 })
    const request = await save(fixture, source), item = request.items[0]
    expect(item).toMatchObject({ kind: 'create', entityId: restored, restores: { operationId: deletion.operationId, itemId: deletion.items[0]!.id, identity: { key: 'a', incarnation: 'life:1' } } })
    expect(fixture.state.entities.find(binding => binding.entityId === 'a')?.kind).toBe('retired')
    const binding = fixture.state.entities.find(binding => binding.entityId === restored)
    expect(binding?.kind).toBe('bound')
    if (binding?.kind === 'bound') expect(binding.identity).not.toEqual({ key: 'a', incarnation: 'life:1' })
  })

  it('lets new compensation follow restoration lineage without rebinding the earlier field intent', async () => {
    const { fixture, source } = capable()
    source.normalize = document => document.x === 1 ? { ...document, x: 1.5 } : document
    const original = fixture.apply([fixture.write('a', { x: 1 })]); await save(fixture, source)
    remove(fixture); await save(fixture, source); undo(fixture)
    const restored = currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))
    undo(fixture)
    expect(preview(fixture, restored)).toEqual({ x: 0, hidden: 7 })
    expect(fixture.project().changes).toHaveLength(1)
    await save(fixture, source)
    expect(preview(fixture, restored)).toEqual({ x: 0, hidden: 7 })
    expect(fixture.state.journal.intents.find(intent => intent.id === original.intents[0]!.id)).toEqual(original.intents[0])
    expect(original.intents[0]?.operation).toMatchObject({ entityId: 'a' })
    expect(source.writes).toBe(3)
  })

  it('keeps a late task on the retired entity while an earlier field undo follows restoration lineage', async () => {
    const { fixture: base, source } = capable()
    const field = { entityId: kernelId<'entity'>('a'), fieldId: kernelId<'field'>('x') }
    const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } }, defineKernelSchema({ ...base.schema,
      fields: [{ id: field.fieldId, path: ['x'], readonly: false }] }), { restoreDeleted: true })
    const original = fixture.apply([fixture.write('a', { x: 1 })]); await save(fixture, source)
    const sessionId = kernelId<'session'>('old-editor')
    expect(fixture.dispatch({ kind: 'session-opened', revision: fixture.state.revision, sessionId,
      inputId: kernelId<'input'>('old-text'), viewId: kernelId<'view'>('old-view'), target: { kind: 'cell', field },
      input: { kind: 'encoded', value: '旧实体原文' }, reads: [] }).result.kind).toBe('accepted')
    const ref = { taskId: kernelId<'task'>('old-task'), executionId: 'old-execution' }
    expect(fixture.dispatch({ kind: 'task-registered', ...ref, revision: fixture.state.revision,
      owner: { kind: 'session', sessionId, input: fixture.state.session!.input }, inputId: kernelId<'input'>('old-upload'),
      input: { kind: 'encoded', value: '原上传' }, reads: [] }).result.kind).toBe('accepted')
    expect(fixture.dispatch({ kind: 'task-started', ...ref }).result.kind).toBe('accepted')
    const oldTask = fixture.state.tasks[0]!, oldSession = fixture.state.session!
    remove(fixture); await save(fixture, source); undo(fixture)
    const restored = currentHistoryEntity(fixture.state, field.entityId)
    undo(fixture); await save(fixture, source)
    expect(restored).not.toBe(field.entityId)
    const result = { kind: 'session-candidate' as const, sessionId, input: { kind: 'encoded' as const, value: '迟到结果' } }
    expect(fixture.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('accepted')
    const before = fixture.state
    const rejected = fixture.dispatch({ kind: 'task-consume', ...ref })
    expect(rejected.result.kind).toBe('rejected'); expect(rejected.effects).toEqual([]); expect(fixture.state).toBe(before)
    expect(fixture.state.tasks[0]).toMatchObject({ owner: oldTask.owner, input: oldTask.input, result })
    expect(fixture.state.session?.target).toEqual(oldSession.target)
    expect(fixture.state.session?.rawInput).toEqual(oldSession.rawInput)
    expect(fixture.state.inputs.find(input => input.ref.id === oldTask.input.id)?.input).toEqual({ kind: 'encoded', value: '原上传' })
    expect(fixture.state.journal.intents.find(intent => intent.id === original.intents[0]!.id)).toEqual(original.intents[0])
    expect(fixture.state.entities.find(entity => entity.entityId === field.entityId)?.kind).toBe('retired')
    expect(preview(fixture, restored)).toEqual({ x: 0, hidden: 7 }); expect(fixture.project().changes).toEqual([])
    expect(source.snapshot().rows.map(row => row.document)).toEqual([{ x: 0, hidden: 7 }]); expect(source.writes).toBe(3)
  })

  it('follows the exact canonical restoration output, not a later remote edit, for an earlier undo', async () => {
    const { fixture, source } = capable()
    fixture.apply([fixture.write('a', { x: 1 })]); await save(fixture, source)
    remove(fixture); await save(fixture, source); undo(fixture)
    source.normalize = document => ({ ...document, x: 1.5 })
    await save(fixture, source)
    const restored = currentHistoryEntity(fixture.state, kernelId<'entity'>('a')), binding = fixture.state.entities.find(entry => entry.entityId === restored)
    if (binding?.kind !== 'bound') throw new Error('Missing restoration binding')
    source.external({ [binding.identity.key]: { x: 3, hidden: 7 } }); await read(fixture, source); undo(fixture)
    expect(preview(fixture, restored)).toEqual({ x: 0, hidden: 7 })
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows.find(row => row.entityId === restored)?.issues[0]?.comparison?.base).toEqual([{ kind: 'value', value: 1.5 }])
  })

  it('redoes deletion against the restored lifetime and supports a second restoration generation', async () => {
    const { fixture, source } = capable()
    fixture.apply([fixture.write('a', { x: 1 })]); await save(fixture, source)
    remove(fixture); await save(fixture, source); undo(fixture); await save(fixture, source)
    const first = currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))
    expect(redo(fixture).result.kind).toBe('accepted')
    expect(fixture.project().changes[0]).toMatchObject({ kind: 'delete', entityId: first })
    await save(fixture, source); undo(fixture)
    const second = currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))
    expect(second).not.toBe(first)
    undo(fixture); expect(preview(fixture, second)).toEqual({ x: 0, hidden: 7 })
    await save(fixture, source); expect(source.rows.size).toBe(1)
  })

  it('keeps restoration conditional when deletion is unknown and suppresses it after definitive rejection', async () => {
    const { fixture, source } = capable()
    remove(fixture); const request = fixture.freeze().submission
    uncertain(fixture, request); undo(fixture)
    expect(() => currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))).toThrow('awaits')
    source.external({ a: { x: 3, hidden: 8 } }); const rejected = await source.submit(request)
    if (rejected.kind !== 'not-applied') throw new Error('Expected rejected deletion')
    fixture.dispatch({ kind: 'not-applied', proof: rejected.proof }); await read(fixture, source)
    expect(currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))).toBe('a')
    expect(preview(fixture)).toEqual({ x: 3, hidden: 8 }); expect(fixture.project().changes).toEqual([])
    expect(source.writes).toBe(0)
  })

  it('retains the actual frozen delete base when a predecessor was normalized after the delete was authored', async () => {
    const { fixture, source } = capable()
    source.normalize = document => ({ ...document, x: 1.5, hidden: 9 })
    fixture.apply([fixture.write('a', { x: 1 })]); const write = fixture.freeze().submission, result = await source.submit(write)
    remove(fixture)
    if (result.kind !== 'applied') throw new Error('Expected applied write')
    applied(fixture, result.receipt); await read(fixture, source)
    await save(fixture, source); undo(fixture)
    const restored = currentHistoryEntity(fixture.state, kernelId<'entity'>('a'))
    expect(preview(fixture, restored)).toEqual({ x: 1.5, hidden: 9 })
  })

  it('blocks following a restored entity after it was externally deleted', async () => {
    const { fixture, source } = capable()
    fixture.apply([fixture.write('a', { x: 1 })]); await save(fixture, source)
    remove(fixture); await save(fixture, source); undo(fixture); await save(fixture, source)
    source.external({}); await read(fixture, source)
    const before = fixture.state
    expect(() => undo(fixture)).toThrow('lineage target was deleted')
    expect(fixture.state).toBe(before)
  })
})
