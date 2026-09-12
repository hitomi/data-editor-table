import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId, type ExactReceipt } from './model.js'
import { bindServerAuthority, unboundServerIdentities } from './source.js'
import { prepareUndo } from './history.js'
import { ReferenceOrder } from '../../tests/kernel/order-model.js'

const entity = (id: string) => kernelId<'entity'>(id)
const reorder = (ids: string[]) => ({ kind: 'order' as const, desired: ids.map(entity) })
const computedOrder = (ids: string[], role: 'semantic-read' | 'policy-guard' = 'semantic-read') => ({ kind: 'write' as const, entityId: entity('a'), groups: [{
  id: kernelId<'write-group'>('order-read'), comparison: 'paths' as const,
  reads: [{ role, resource: { kind: 'order' as const }, expected: { kind: 'value' as const, value: ids.map(entity) } }],
  writes: [{ kind: 'set' as const, path: ['rank'] as const, value: ids.indexOf('a') }],
}] })
async function read(fixture: KernelFixture, source: SourceFixture) {
  const snapshot = await source.readAtLeast()
  const allocations = unboundServerIdentities(fixture.state, snapshot).map(identity => ({ identity, entityId: entity(`allocated:${fixture.next()}`) }))
  expect(fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, snapshot, allocations) }).result.kind).toBe('accepted')
}
function receipt(fixture: KernelFixture, receipt: ExactReceipt) { expect(fixture.dispatch({ kind: 'exact-receipt', receipt }).result.kind).toBe('accepted') }
async function save(fixture: KernelFixture, source: SourceFixture) {
  const submission = fixture.freeze().submission, result = await source.submit(submission)
  expect(result.kind).toBe('applied')
  if (result.kind !== 'applied') throw new Error('Expected ordered application')
  receipt(fixture, result.receipt); await read(fixture, source)
  expect(fixture.state.persistence.kind).toBe('idle')
  return submission
}

describe('persistent order data domain', () => {
  it('holds an exact order receipt until its commit-version read agrees, retaining later input', async () => {
    const initial = { a: { x: 0 }, b: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const ordered = fixture.apply([reorder(['b', 'a'])])
    const submission = fixture.freeze().submission, frozen = JSON.stringify(submission)
    fixture.apply([fixture.write('a', { x: 2 })], 'row', 'later edit')
    const result = await source.submit(submission)
    if (result.kind !== 'applied') throw new Error('Expected order commit')
    receipt(fixture, result.receipt)
    const inputs = fixture.state.inputs, snapshot = await source.readAtLeast()
    const inconsistent = { ...snapshot, order: [...snapshot.order].reverse() }
    const blocked = fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, inconsistent, []) })
    expect(blocked.result.kind).toBe('accepted')
    expect(blocked.effects.some(effect => effect.kind === 'submit')).toBe(false)
    expect(fixture.state.persistence).toMatchObject({ kind: 'receipt-blocked', issue: { message: 'The commit-version authority contradicts the exact canonical order.' } })
    expect(fixture.state.settlements).toEqual([])
    expect(fixture.state.inputs).toEqual(inputs)
    expect(fixture.project().order.preview).toEqual([entity('b'), entity('a')])
    await read(fixture, source)
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(fixture.state.settlements.map(proof => proof.intentId)).toEqual(ordered.action.intentIds)
    expect(fixture.state.inputs.at(-1)?.input).toEqual({ kind: 'encoded', value: 'later edit' })
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.preview).toEqual({ x: 2 })
    expect(JSON.stringify(submission)).toBe(frozen)
    expect(source.writes).toBe(1)
    expect(source.requests).toHaveLength(1)
  })

  it('saves a reorder and its computed order reader in one request using the logical order at the read', async () => {
    const initial = { a: { rank: 0 }, b: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const action = fixture.apply([reorder(['b', 'a']), computedOrder(['b', 'a'])])
    expect(fixture.project().rows.flatMap(row => row.issues)).toEqual([])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['update', 'order'])
    expect(request.coverage.flatMap(item => item.intentIds)).toEqual(expect.arrayContaining([...action.action.intentIds]))
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('settled-intents')
  })

  it('keeps policy order guards on authority while semantic reads follow preceding structural operations', async () => {
    for (const guard of [false, true]) {
      const initial = { a: { rank: -1 }, b: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      fixture.apply([{ kind: 'create', entityId: entity('local'), document: {} }, reorder(['local', 'b', 'a']),
        computedOrder(guard ? ['a', 'b'] : ['local', 'b', 'a'], guard ? 'policy-guard' : 'semantic-read')])
      expect(fixture.project().rows.flatMap(row => row.issues)).toEqual([])
      const request = await save(fixture, source)
      expect(request.items.map(item => item.kind)).toEqual(['update', 'create', 'order'])
      expect(fixture.project().rows.find(row => row.entityId === 'a')?.preview).toEqual({ rank: guard ? 0 : 2 })
    }
  })

  it('does not apply later order commands before an earlier reader in the same action', async () => {
    const initial = { a: { rank: 0 }, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([reorder(['b', 'a', 'c']), computedOrder(['b', 'a', 'c']), reorder(['c', 'b', 'a'])])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['update', 'order'])
    expect(fixture.project().order.authority).toEqual(['c', 'b', 'a'])
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.preview).toEqual({ rank: 1 })
  })

  it('reads current authority after a neutral prefix and checks historical consumers against their original prerequisites', async () => {
    for (const readBeforeCancellation of [false, true]) {
      const initial = { a: { rank: -1 }, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      fixture.apply([reorder(['b', 'a', 'c'])])
      if (readBeforeCancellation) fixture.apply([computedOrder(['b', 'a', 'c'])])
      fixture.apply([reorder(['a', 'b', 'c'])])
      source.external({ c: {}, a: { rank: -1 }, b: {} }); await read(fixture, source)
      if (!readBeforeCancellation) fixture.apply([computedOrder(['c', 'a', 'b'])])
      if (readBeforeCancellation) {
        expect(fixture.project().changes).toEqual([])
        expect(fixture.project().rows.find(row => row.entityId === 'a')?.issues.some(issue => issue.code === 'dependency-blocked')).toBe(true)
      } else {
        const request = await save(fixture, source)
        expect(request.items.map(item => item.kind)).toEqual(['update'])
        expect(fixture.project().order.authority).toEqual(['c', 'a', 'b'])
      }
      expect(fixture.project().neutralIntentIds).toHaveLength(2)
    }
  })

  it('preserves an intermediate order computation while cancelling the final order effect in the same action', async () => {
    const initial = { a: { rank: 0 }, b: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const action = fixture.apply([reorder(['b', 'a']), computedOrder(['b', 'a']), reorder(['a', 'b'])], 'transaction')
    expect(fixture.project().rows.flatMap(row => row.issues)).toEqual([])
    expect(fixture.project().order.preview).toEqual(['a', 'b'])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['update'])
    expect(request.coverage[0]?.intentIds).toEqual([action.intents[1]!.id])
    expect(fixture.project().neutralIntentIds).toEqual([action.intents[0]!.id, action.intents[2]!.id])
  })

  it('does not rewrite a pending order read when its predecessor receives a different canonical order', async () => {
    const initial = { a: { rank: 0 }, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([reorder(['b', 'a', 'c'])]); const request = fixture.freeze().submission
    fixture.apply([computedOrder(['b', 'a', 'c'])])
    source.normalizeOrder = entries => [entries[2]!, entries[0]!, entries[1]!]
    const result = await source.submit(request); if (result.kind !== 'applied') throw new Error('Expected applied order')
    receipt(fixture, result.receipt); await read(fixture, source)
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.issues[0]?.code).toBe('semantic-read-changed')
    expect(fixture.state.inputs.at(-1)?.disposition.kind).toBe('intents')
  })

  it('does not settle a matching computed target before its conflicted order dependency is resolved', async () => {
    const initial = { a: { rank: 0 }, b: {}, c: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const action = fixture.apply([reorder(['b', 'a', 'c']), computedOrder(['b', 'a', 'c'])])
    source.external({ c: {}, b: {}, a: { rank: 1 } }); await read(fixture, source)
    const computed = action.intents[1]!.id
    expect(fixture.state.settlements.some(proof => proof.intentId === computed)).toBe(false)
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.issues.some(issue => issue.code === 'dependency-blocked')).toBe(true)
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
  })

  it('settles external deletion and its dependent order in the same authority transition', async () => {
    const fixture = new KernelFixture({ a: {}, b: {}, c: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {}, c: {} })
    const prepared = fixture.apply([{ kind: 'delete', entityId: entity('b') }, reorder(['c', 'a'])])
    source.external({ c: {}, a: {} }); await read(fixture, source)
    expect(fixture.project().changes).toEqual([]); expect(fixture.project().orderChange).toBeNull()
    expect(fixture.state.settlements.map(proof => proof.intentId)).toEqual(prepared.action.intentIds)
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('settled-intents')
  })

  it('matches an independent permutation oracle across 252 coalescing and remote-order combinations', async () => {
    const permutations = [['a', 'b', 'c'], ['a', 'c', 'b'], ['b', 'a', 'c'], ['b', 'c', 'a'], ['c', 'a', 'b'], ['c', 'b', 'a']]
    for (const first of permutations) for (const second of permutations) for (const remote of [...permutations, ['a', 'b', 'c', 'new']]) {
      const fixture = new KernelFixture({ a: {}, b: {}, c: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {}, c: {} })
      const reference = new ReferenceOrder(['a', 'b', 'c'])
      fixture.apply([reorder(first)]); reference.request(first)
      fixture.apply([reorder(second)]); reference.request(second)
      source.external(Object.fromEntries(remote.map(id => [id, {}]))); await read(fixture, source); reference.observe(remote)
      const actual = fixture.project(), expected = reference.project(), context = JSON.stringify({ first, second, remote })
      const bindings = new Map(fixture.state.entities.flatMap(binding => binding.kind === 'local' ? [] : [[binding.entityId, binding.identity.key] as const]))
      expect(actual.order.preview.map(id => bindings.get(id)), context).toEqual(expected.visible)
      expect(actual.order.persistence === 'blocked', context).toBe(expected.blocked)
      expect(actual.orderChange?.desired ?? null, context).toEqual(expected.save)
    }
  })

  it('uses canonical order as the successor base and detects a later independent remote reorder', async () => {
    for (const laterRemote of [false, true]) {
      const fixture = new KernelFixture({ a: {}, b: {}, c: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {}, c: {} })
      source.normalizeOrder = order => [order[2]!, order[1]!, order[0]!]
      fixture.apply([reorder(['b', 'a', 'c'])]); const request = fixture.freeze().submission, result = await source.submit(request)
      if (result.kind !== 'applied') throw new Error('Expected canonical order')
      fixture.apply([reorder(['a', 'c', 'b'])])
      if (laterRemote) source.external({ b: {}, c: {}, a: {} })
      receipt(fixture, result.receipt); await read(fixture, source)
      if (laterRemote) {
        expect(fixture.project().orderChange).toBeNull()
        expect(fixture.project().order.issues.find(issue => issue.code === 'order-conflict')?.comparison?.base).toEqual([{ kind: 'value', value: ['c', 'a', 'b'] }])
      } else {
        expect(fixture.project().orderChange?.desired).toEqual(['a', 'c', 'b'])
        source.normalizeOrder = order => order
        await save(fixture, source); expect(fixture.project().order.authority).toEqual(['a', 'c', 'b'])
      }
    }
  })

  it('keeps creation atomic when server order normalization cannot preserve complete membership', async () => {
    const fixture = new KernelFixture({ a: {}, b: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {} })
    fixture.apply([{ kind: 'create', entityId: entity('local'), document: {} }, reorder(['a', 'local', 'b'])])
    source.normalizeOrder = order => order.slice(0, 1)
    const request = fixture.freeze().submission, result = await source.submit(request)
    expect(result.kind).toBe('not-applied'); expect(source.writes).toBe(0); expect(source.rows.size).toBe(2)
    if (result.kind !== 'not-applied') throw new Error('Expected atomic rejection')
    fixture.dispatch({ kind: 'not-applied', proof: result.proof })
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
    expect(fixture.project().orderChange?.desired).toEqual(['a', 'local', 'b'])
  })

  it('allows an independent order write while a bound row field is conflicted', async () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 }, b: {} })
    fixture.apply([fixture.write('a', { x: 1 })]); source.external({ a: { x: 3 }, b: {} }); await read(fixture, source)
    fixture.apply([reorder(['b', 'a'])])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['order'])
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.persistence).toBe('blocked')
  })

  it('commits an order-only request through exact coverage and the complete authority barrier', async () => {
    const fixture = new KernelFixture({ a: {}, b: {}, c: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {}, c: {} })
    const action = fixture.apply([reorder(['c', 'a', 'b'])])
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().order.preview).toEqual(['c', 'a', 'b'])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['order'])
    expect(request.coverage[0]?.intentIds).toEqual(action.action.intentIds)
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('settled-intents')
    expect(fixture.project().order.authority).toEqual(['c', 'a', 'b'])
  })

  it('inserts a server-assigned creation into the middle in one atomic request', async () => {
    const fixture = new KernelFixture({ a: {}, b: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {} })
    fixture.apply([{ kind: 'create', entityId: entity('local'), document: { x: 1 } }, reorder(['a', 'local', 'b'])])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['create', 'order'])
    const order = request.items[1]
    if (order?.kind !== 'order') throw new Error('Expected order')
    expect(order.after[1]).toEqual({ kind: 'created-in-submission', itemId: request.items[0]!.id })
    expect(fixture.project().order.authority).toEqual(['a', 'local', 'b'])
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('settled-intents')
    expect(source.writes).toBe(1)
  })

  it('combines deletion with reordering the survivors against the original complete order', async () => {
    const fixture = new KernelFixture({ a: {}, b: {}, c: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {}, c: {} })
    fixture.apply([{ kind: 'delete', entityId: entity('b') }, reorder(['c', 'a'])])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['delete', 'order'])
    const order = request.items[1]
    expect(order?.kind === 'order' && order.before.map(identity => identity.key)).toEqual(['a', 'b', 'c'])
    expect(fixture.project().order.authority).toEqual(['c', 'a'])
  })

  it.each(['create', 'delete'] as const)('holds %s dependencies on an order conflict while an unrelated field remains saveable', async kind => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: {}, c: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 }, b: {}, c: {} })
    const structural = fixture.apply(kind === 'create'
      ? [{ kind: 'create', entityId: entity('local'), document: {} }, reorder(['a', 'local', 'b', 'c'])]
      : [{ kind: 'delete', entityId: entity('b') }, reorder(['c', 'a'])], 'row', 'original structural input')
    source.external({ b: {}, a: { x: 0 }, c: {} }); await read(fixture, source)
    const independent = fixture.apply([fixture.write('a', { x: 2 })])
    expect(fixture.project().order.issues.some(issue => issue.code === 'order-conflict')).toBe(true)
    expect(fixture.project().changes.map(change => change.entityId)).toEqual(['a'])
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['update'])
    expect(request.coverage.flatMap(item => item.intentIds)).toEqual(independent.action.intentIds)
    expect(fixture.project().rows.find(row => row.entityId === (kind === 'create' ? 'local' : 'b'))?.persistence).toBe('blocked')
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
    await read(fixture, source)
    expect(fixture.state.journal.intents.slice(0, structural.intents.length)).toEqual(structural.intents)
    expect(fixture.state.inputs[0]?.input).toEqual({ kind: 'encoded', value: 'original structural input' })
    expect(fixture.state.settlements.map(proof => proof.intentId)).toEqual(independent.action.intentIds)
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().orderChange).toBeNull()
    expect(source.snapshot().order.map(identity => identity.key)).toEqual(['b', 'a', 'c'])
    expect(source.snapshot().rows.map(row => ({ key: row.identity.key, document: row.document }))).toEqual([
      { key: 'b', document: {} }, { key: 'a', document: { x: 2 } }, { key: 'c', document: {} },
    ])
    expect(source.writes).toBe(1)
  })

  it('retains new remote rows in the presentation when they invalidate the stored order membership', async () => {
    const fixture = new KernelFixture({ a: {}, b: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {} })
    fixture.apply([reorder(['b', 'a'])])
    source.external({ a: {}, b: {}, newcomer: {} }); await read(fixture, source)
    expect(fixture.project().order.desired).toEqual(['b', 'a'])
    expect(fixture.project().order.preview).toHaveLength(3)
    expect(fixture.project().order.issues.some(issue => issue.code === 'order-membership')).toBe(true)
    expect(fixture.project().orderChange).toBeNull()
  })

  it('makes row and order transaction dependencies block together in either direction', async () => {
    for (const conflict of ['row', 'order']) {
      const fixture = new KernelFixture({ a: { x: 0 }, b: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 }, b: {} })
      fixture.apply([fixture.write('a', { x: 1 }), reorder(['b', 'a'])], 'transaction')
      source.external(conflict === 'row' ? { a: { x: 3 }, b: {} } : { b: {}, a: { x: 0 }, c: {} }); await read(fixture, source)
      expect(fixture.project().changes).toEqual([]); expect(fixture.project().orderChange).toBeNull()
      expect(fixture.project().rows.find(row => row.entityId === 'a')?.persistence).toBe('blocked')
      expect(fixture.project().order.persistence).toBe('blocked')
    }
  })

  it('rejects invalid membership or forged authoring bases without accepting half an action', () => {
    const fixture = new KernelFixture({ a: {}, b: {} })
    expect(() => fixture.prepare([reorder(['a', 'a'])])).toThrow('every logical entity')
    expect(() => fixture.prepare([reorder(['a'])])).toThrow('every logical entity')
    const prepared = fixture.prepare([{ kind: 'create', entityId: entity('local'), document: {} }, reorder(['b', 'local', 'a'])])
    const before = fixture.state
    const invalid = { ...prepared, intents: prepared.intents.map(intent => intent.operation.kind === 'order' ? { ...intent, operation: { ...intent.operation, authorityBase: [] } } : intent) }
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: invalid }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
  })

  it('keeps a neutral order prefix inactive across refresh and later ordering', async () => {
    const fixture = new KernelFixture({ a: {}, b: {}, c: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {}, c: {} })
    fixture.apply([reorder(['b', 'a', 'c'])]); fixture.apply([reorder(['a', 'b', 'c'])])
    expect(fixture.project().neutralIntentIds).toHaveLength(2)
    source.external({ c: {}, a: {}, b: {} }); await read(fixture, source)
    expect(fixture.project().order.preview).toEqual(['c', 'a', 'b'])
    expect(fixture.project().orderChange).toBeNull()
    fixture.apply([reorder(['b', 'c', 'a'])])
    expect(fixture.project().orderChange?.intentIds).toHaveLength(1)
    await save(fixture, source); expect(fixture.project().order.authority).toEqual(['b', 'c', 'a'])
  })

  it('keeps neutral create/order/delete history so undoing deletion restores the insertion requirement', async () => {
    const fixture = new KernelFixture({ a: {}, b: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {} })
    fixture.apply([{ kind: 'create', entityId: entity('local'), document: {} }, reorder(['a', 'local', 'b'])])
    fixture.apply([{ kind: 'delete', entityId: entity('local') }])
    expect(fixture.project().changes).toEqual([]); expect(fixture.project().orderChange).toBeNull()
    const prepared = prepareUndo(fixture.state, { actionId: kernelId<'action'>('undo'), applicationId: kernelId<'application'>('undo'), controls: [{ entityId: entity('local'), intentId: kernelId<'intent'>('undo') }] })
    expect(fixture.dispatch({ kind: 'prepared-undo', prepared }).result.kind).toBe('accepted')
    expect(fixture.project().orderChange?.desired).toEqual(['a', 'local', 'b'])
    await save(fixture, source); expect(fixture.project().order.authority).toEqual(['a', 'local', 'b'])
  })

  it('preserves a successor reorder while the original receipt and complete read arrive', async () => {
    const fixture = new KernelFixture({ a: {}, b: {}, c: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {}, c: {} })
    fixture.apply([reorder(['b', 'a', 'c'])]); const original = fixture.freeze().submission, result = await source.submit(original)
    if (result.kind !== 'applied') throw new Error('Expected applied')
    const successor = fixture.apply([reorder(['c', 'b', 'a'])])
    receipt(fixture, result.receipt)
    expect(fixture.project().order.preview).toEqual(['c', 'b', 'a'])
    await read(fixture, source)
    expect(fixture.project().orderChange?.intentIds).toEqual(successor.action.intentIds)
    await save(fixture, source); expect(fixture.project().order.authority).toEqual(['c', 'b', 'a'])
  })

  it('resolves the order base through a predecessor creation committed without an order item', async () => {
    const fixture = new KernelFixture({ a: {}, b: {} }), source = new SourceFixture(fixture.state.workspace.scope, { a: {}, b: {} })
    fixture.apply([{ kind: 'create', entityId: entity('local'), document: {} }]); const original = fixture.freeze().submission, result = await source.submit(original)
    if (result.kind !== 'applied') throw new Error('Expected applied')
    fixture.apply([reorder(['a', 'local', 'b'])]); receipt(fixture, result.receipt); await read(fixture, source)
    expect(fixture.project().orderChange?.desired).toEqual(['a', 'local', 'b'])
    await save(fixture, source); expect(fixture.project().order.authority).toEqual(['a', 'local', 'b'])
  })
})
