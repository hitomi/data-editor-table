import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId, type EntityId } from './model.js'
import { prepareResolution, type ResolutionChoice, type ResolutionRequest } from './resolution.js'
import { bindServerAuthority, unboundServerIdentities } from './source.js'
import { prepareRedo, prepareUndo, projectHistory } from './history.js'
import { declaredRowOperation } from './intent.js'

const entity = (id: string) => kernelId<'entity'>(id)
function review(fixture: KernelFixture, choice: ResolutionChoice, target: EntityId | 'order' = entity('a')): ResolutionRequest {
  const projected = fixture.project(), selected = target === 'order' ? projected.order : projected.rows.find(row => row.entityId === target)!
  if (fixture.state.authority.content.kind !== 'complete') throw new Error('Expected complete authority')
  return { revision: fixture.state.revision, observation: fixture.state.authority.content.snapshot.observation,
    issueIds: selected.issues.map(issue => issue.id), target: target === 'order' ? { kind: 'order' } : { kind: 'row', entityId: target }, choice }
}
function prepare(fixture: KernelFixture, request: ResolutionRequest) {
  const id = fixture.next()
  return prepareResolution(fixture.state, request, { actionId: kernelId<'action'>(`resolution:${id}`), applicationId: kernelId<'application'>(`resolution:${id}`), controlId: kernelId<'intent'>(`resolution:${id}`) }, fixture.schema)
}
function resolve(fixture: KernelFixture, choice: ResolutionChoice, target: EntityId | 'order' = entity('a')) {
  const prepared = prepare(fixture, review(fixture, choice, target))
  const result = fixture.dispatch({ kind: 'prepared-resolution', prepared })
  expect(result.result.kind, JSON.stringify(result.result)).toBe('accepted')
  return prepared
}
async function read(fixture: KernelFixture, source: SourceFixture) {
  const snapshot = await source.readAtLeast()
  const allocations = unboundServerIdentities(fixture.state, snapshot).map(identity => ({ identity, entityId: entity(`allocated:${fixture.next()}`) }))
  expect(fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, snapshot, allocations) }).result.kind).toBe('accepted')
}
async function save(fixture: KernelFixture, source: SourceFixture) {
  const request = fixture.freeze().submission, result = await source.submit(request)
  expect(result.kind).toBe('applied')
  if (result.kind !== 'applied') throw new Error('Expected exact application')
  fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }); await read(fixture, source)
  expect(fixture.state.persistence.kind).toBe('idle')
  return request
}
function undo(fixture: KernelFixture) {
  const id = fixture.next(), target = projectHistory(fixture.state).undo.at(-1)!
  const entities = new Set(target.intentIds.flatMap(id => { const operation = declaredRowOperation(fixture.state.journal.intents.find(intent => intent.id === id)!); return operation ? [operation.entityId] : [] }))
  const prepared = prepareUndo(fixture.state, { actionId: kernelId<'action'>(`undo:${id}`), applicationId: kernelId<'application'>(`undo:${id}`),
    controls: [...entities].map((entityId, index) => ({ entityId, intentId: kernelId<'intent'>(`undo:${id}:${index}`) })),
  })
  expect(fixture.dispatch({ kind: 'prepared-undo', prepared }).result.kind).toBe('accepted')
}
function redo(fixture: KernelFixture, accepted = true) {
  const id = fixture.next(), target = projectHistory(fixture.state).redo.at(-1)!, records = target.intentIds.map(id => fixture.state.journal.intents.find(intent => intent.id === id)!)
  const prepared = prepareRedo(fixture.state, { applicationId: kernelId<'application'>(`redo:${id}`),
    controls: records.map((record, index) => ({ sourceIntentId: record.id, intentId: kernelId<'intent'>(`redo:${id}:${index}`) })),
    creations: records.flatMap((record, index) => { const operation = declaredRowOperation(record); return operation?.kind === 'create'
      ? [{ sourceEntityId: operation.entityId, entityId: entity(`redo:${id}:${index}`) }] : [] }),
  }, fixture.schema)
  const result = fixture.dispatch({ kind: 'prepared-redo', prepared })
  if (accepted) expect(result.result.kind).toBe('accepted')
  return result
}

describe('reviewed conflict resolutions', () => {
  it('does not discard recovered input when current policy rejects replaying the resolution', async () => {
    const initial = { a: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 })]); source.external({ a: { x: 3 } }); await read(fixture, source)
    resolve(fixture, { kind: 'keep-local' }); await save(fixture, source); undo(fixture); await save(fixture, source)
    const policy = fixture.state.policy
    fixture.dispatch({ kind: 'policy-observed', policy: { ...policy, version: kernelId<'policy-version'>('no-replay'), defaultEntity: { ...policy.defaultEntity, write: false } } })
    const before = fixture.state
    expect(redo(fixture, false).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.state.recoveries[0]?.state).toBe('available')
    expect(fixture.state.inputs.find(input => input.ref.id === fixture.state.recoveries[0]!.inputs[0]!.id)?.disposition.kind).toBe('recovery')
  })

  it('keeps recovered input owned while a resolution undo waits for application or rejection', async () => {
    for (const appliedOutcome of [false, true]) {
      const initial = { a: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
      fixture.apply([fixture.write('a', { x: 1 })]); source.external({ a: { x: 3 } }); await read(fixture, source)
      resolve(fixture, { kind: 'keep-local' }); const request = fixture.freeze().submission
      if (!appliedOutcome) source.external({ a: { x: 4 } })
      const result = await source.submit(request)
      fixture.dispatch({ kind: 'mutation-uncertain', ref: request, attempt: 1, issue: { code: 'lost', message: 'lost' } }); undo(fixture)
      if (result.kind === 'applied') fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt })
      else if (result.kind === 'not-applied') fixture.dispatch({ kind: 'not-applied', proof: result.proof })
      else throw new Error('Expected definitive result')
      await read(fixture, source)
      expect(fixture.project().rows[0]?.preview).toEqual({ x: appliedOutcome ? 3 : 4 })
      expect(fixture.state.recoveries[0]?.state).toBe('available')
      expect(fixture.state.inputs.find(input => input.ref.id === fixture.state.recoveries[0]!.inputs[0]!.id)?.disposition.kind).toBe('recovery')
      if (appliedOutcome) await save(fixture, source)
      else expect(fixture.project().changes).toEqual([])
    }
  })

  it('undoes and redoes using authority through explicit recovered input ownership without rewriting old proof', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    const original = fixture.apply([fixture.write('a', { x: 1 })], 'row', 'original text')
    fixture.observe({ a: { x: 3 } }, 1)
    resolve(fixture, { kind: 'use-authority' })
    const proof = fixture.state.settlements.find(proof => proof.intentId === original.intents[0]!.id)
    undo(fixture)
    const recovery = fixture.state.recoveries.at(-1)!
    expect(recovery.state).toBe('available')
    expect(fixture.state.inputs.find(input => input.ref.id === recovery.inputs[0]!.id)).toMatchObject({ input: { kind: 'encoded', value: 'original text' }, disposition: { kind: 'recovery', recoveryId: recovery.id } })
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 3 })
    expect(fixture.state.settlements.find(entry => entry.intentId === original.intents[0]!.id)).toBe(proof)
    redo(fixture)
    expect(fixture.state.recoveries[0]?.state).toBe('discarded')
    expect(fixture.state.inputs.find(input => input.ref.id === recovery.inputs[0]!.id)?.disposition.kind).toBe('discarded')
    undo(fixture)
    expect(fixture.state.recoveries.at(-1)?.state).toBe('available')
    expect(fixture.state.recoveries.at(-1)?.id).not.toBe(recovery.id)
  })

  it('compensates a committed resolution while recovering its original input, then redoes its stored target', async () => {
    const initial = { a: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 })], 'row', 'original one')
    source.external({ a: { x: 3 } }); await read(fixture, source)
    resolve(fixture, { kind: 'keep-local' }); await save(fixture, source)
    undo(fixture)
    expect(fixture.state.recoveries.at(-1)?.state).toBe('available')
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 3 })
    await save(fixture, source)
    redo(fixture); await save(fixture, source)
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 1 })
    expect(fixture.state.recoveries.every(entry => entry.state === 'discarded')).toBe(true)
  })

  it('uses authority for one domain while preserving an unrelated conflicted contribution and shared input', () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } })
    const original = fixture.apply([fixture.write('a', { x: 1 }), fixture.write('b', { x: 1 })], 'row', 'bulk original')
    fixture.observe({ a: { x: 3 }, b: { x: 4 } }, 1)
    const decision = resolve(fixture, { kind: 'use-authority' })
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.preview).toEqual({ x: 3 })
    expect(fixture.project().rows.find(row => row.entityId === 'b')?.persistence).toBe('blocked')
    expect(fixture.state.settlements.find(proof => proof.intentId === original.intents[0]!.id)).toEqual({ kind: 'discarded', intentId: original.intents[0]!.id, by: decision.control.id })
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
    expect(fixture.state.inputs[0]?.input).toEqual({ kind: 'encoded', value: 'bulk original' })
  })

  it('keeps the local payload using a new reviewed base and exact new coverage', async () => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    const original = fixture.apply([fixture.write('a', { x: 1 })], 'row', 'typed one')
    source.external({ a: { x: 3, hidden: 9 } }); await read(fixture, source)
    const decision = resolve(fixture, { kind: 'keep-local' }), request = await save(fixture, source)
    expect(request.coverage[0]?.intentIds).toEqual(decision.replacement!.action.intentIds)
    expect(request.coverage[0]?.intentIds).not.toContain(original.intents[0]!.id)
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 1, hidden: 9 })
    expect(fixture.state.inputs).toHaveLength(2)
    expect(fixture.state.inputs.every(input => input.disposition.kind === 'settled-intents')).toBe(true)
  })

  it('requires another conflict decision if authority changes again after keeping local', async () => {
    const initial = { a: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 })]); source.external({ a: { x: 3 } }); await read(fixture, source)
    resolve(fixture, { kind: 'keep-local' })
    source.external({ a: { x: 4 } }); await read(fixture, source)
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows[0]?.issues[0]?.comparison?.base).toEqual([{ kind: 'value', value: 3 }])
    expect(fixture.state.inputs.at(-1)?.disposition.kind).toBe('intents')
  })

  it('accepts a reviewed merge with its own input and rejects semantic-read rebasing through keep-local', async () => {
    const initial = { a: { qty: 2, total: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { total: 20 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: entity('a'), path: ['qty'] } }] })])
    source.external({ a: { qty: 3, total: 0 } }); await read(fixture, source)
    const before = fixture.state
    expect(() => prepare(fixture, review(fixture, { kind: 'keep-local' }))).toThrow()
    expect(fixture.state).toBe(before)
    resolve(fixture, { kind: 'merge', commands: [fixture.write('a', { total: 30 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: entity('a'), path: ['qty'] } }] })], input: { kind: 'encoded', value: 'recomputed 30' } })
    await save(fixture, source)
    expect(fixture.project().rows[0]?.preview).toEqual({ qty: 3, total: 30 })
    expect(fixture.state.inputs.at(-1)?.input).toEqual({ kind: 'encoded', value: 'recomputed 30' })
  })

  it('recreates a remotely deleted target from complete retained material using a fresh lifetime', async () => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 })]); source.external({}); await read(fixture, source)
    resolve(fixture, { kind: 'recreate', entityId: entity('recreated') })
    const request = await save(fixture, source)
    expect(request.items[0]).toMatchObject({ kind: 'create', entityId: 'recreated', document: { x: 1, hidden: 7 } })
    expect(fixture.state.entities.find(binding => binding.entityId === 'a')?.kind).toBe('retired')
    expect(fixture.state.entities.find(binding => binding.entityId === 'recreated')?.kind).toBe('bound')
  })

  it('adopts an explicitly selected existing lifetime and fully validates read-only hidden fields', async () => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([{ kind: 'create', entityId: entity('local'), proposedKey: 'a', document: { x: 1 } }])
    const policy = fixture.state.policy
    fixture.dispatch({ kind: 'policy-observed', policy: { ...policy, version: kernelId<'policy-version'>('hidden-readonly'), defaultEntity: { ...policy.defaultEntity, readonlyPaths: [['hidden']] } } })
    const before = fixture.state
    expect(() => prepare(fixture, review(fixture, { kind: 'adopt-existing', entityId: entity('a'), document: { x: 1 } }, entity('local')))).toThrow('read-only')
    expect(fixture.state).toBe(before)
    resolve(fixture, { kind: 'adopt-existing', entityId: entity('a'), document: { x: 1, hidden: 7 } }, entity('local'))
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['update'])
    expect(source.rows.size).toBe(1)
    expect(fixture.state.entities.find(binding => binding.entityId === 'local')?.kind).toBe('local')
  })

  it('requires a complete reviewed membership for an order merge after remote insertion', async () => {
    const initial = { a: {}, b: {} }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([{ kind: 'order', desired: [entity('b'), entity('a')] }])
    source.external({ a: {}, new: {}, b: {} }); await read(fixture, source)
    expect(() => prepare(fixture, review(fixture, { kind: 'keep-local' }, 'order'))).toThrow('every logical entity')
    const added = fixture.state.entities.find(binding => binding.kind === 'bound' && binding.identity.key === 'new')!.entityId
    resolve(fixture, { kind: 'merge', commands: [{ kind: 'order', desired: [entity('b'), added, entity('a')] }], input: { kind: 'encoded', value: 'reviewed full order' } }, 'order')
    const request = await save(fixture, source)
    expect(request.items.map(item => item.kind)).toEqual(['order'])
    expect(fixture.project().order.authority).toEqual(['b', added, 'a'])
  })

  it('rejects stale or forged decisions without discarding their original targets', () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: {} })
    fixture.apply([fixture.write('a', { x: 1 })]); fixture.observe({ a: { x: 3 }, b: {} }, 1)
    const prepared = prepare(fixture, review(fixture, { kind: 'keep-local' })), before = fixture.state
    const forged = { ...prepared, control: { ...prepared.control, dependencies: null } }
    expect(fixture.dispatch({ kind: 'prepared-resolution', prepared: forged }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    fixture.apply([fixture.write('b', { x: 1 })])
    expect(fixture.dispatch({ kind: 'prepared-resolution', prepared }).result.kind).toBe('rejected')
    expect(fixture.state.settlements).toEqual([])
  })

  it('can discard an explicit successor while preserving every byte and reservation of the unknown predecessor', async () => {
    const initial = { a: { x: 0 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 })]); const request = fixture.freeze().submission
    fixture.dispatch({ kind: 'mutation-uncertain', ref: request, attempt: 1, issue: { code: 'lost', message: 'lost' } })
    source.external({ a: { x: 3 } }); await read(fixture, source)
    const successor = fixture.apply([fixture.write('a', { x: 2 })])
    const reviewed = review(fixture, { kind: 'use-authority' })
    expect(() => prepare(fixture, reviewed)).toThrow('reserved request')
    const reserved = 'submission' in fixture.state.persistence ? fixture.state.persistence.submission : null
    const prepared = prepare(fixture, { ...reviewed, intentIds: successor.action.intentIds })
    expect(fixture.dispatch({ kind: 'prepared-resolution', prepared }).result.kind).toBe('accepted')
    expect('submission' in fixture.state.persistence && fixture.state.persistence.submission).toBe(reserved)
    expect(reserved).toEqual(request)
    expect(fixture.state.settlements.some(proof => request.coverage[0]!.intentIds.includes(proof.intentId))).toBe(false)
  })
})
