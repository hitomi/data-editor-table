import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId } from './model.js'
import { recoverIntentDocument } from './recovery.js'
import { bindServerAuthority, unboundServerIdentities } from './source.js'

async function read(fixture: KernelFixture, source: SourceFixture) {
  const snapshot = await source.readAtLeast()
  const allocations = unboundServerIdentities(fixture.state, snapshot).map(identity => ({ identity, entityId: kernelId<'entity'>(`new:${fixture.next()}`) }))
  expect(fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, snapshot, allocations) }).result.kind).toBe('accepted')
}

describe('complete intent recovery material', () => {
  it('retains hidden fields and missing/null distinctions after a remote deletion of a partially edited row', () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: { nullable: null, nested: [1, 2] } } })
    const action = fixture.apply([fixture.write('a', { x: 1 })])
    fixture.observe({}, 1)
    expect(fixture.project().rows[0]?.preview).toBeNull()
    const before = fixture.state
    expect(recoverIntentDocument(fixture.state, kernelId<'entity'>('a'), action.action.intentIds)).toEqual({ x: 1, hidden: { nullable: null, nested: [1, 2] } })
    expect(fixture.state).toBe(before)
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
  })

  it('uses late canonical material for a successor without reviving the predecessor payload', async () => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 })]); const request = fixture.freeze().submission
    const successor = fixture.apply([fixture.write('a', { x: 2 })])
    source.normalize = document => ({ ...document, x: 1.5, hidden: 9 })
    const result = await source.submit(request); if (result.kind !== 'applied') throw new Error('Expected canonical application')
    fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }); await read(fixture, source)
    source.external({}); await read(fixture, source)
    expect(recoverIntentDocument(fixture.state, kernelId<'entity'>('a'), successor.action.intentIds)).toEqual({ x: 2, hidden: 9 })
  })

  it('prefers a later captured remote document over an older canonical receipt', async () => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
    fixture.apply([fixture.write('a', { x: 1 })]); const request = fixture.freeze().submission, result = await source.submit(request)
    if (result.kind !== 'applied') throw new Error('Expected application')
    fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }); await read(fixture, source)
    source.external({ a: { x: 3, hidden: 11 } }); await read(fixture, source)
    const successor = fixture.apply([fixture.write('a', { x: 4 })])
    source.external({}); await read(fixture, source)
    expect(recoverIntentDocument(fixture.state, kernelId<'entity'>('a'), successor.action.intentIds)).toEqual({ x: 4, hidden: 11 })
  })

  it('rejects forged recovery documents at the ordinary action boundary', () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } }), prepared = fixture.prepare([fixture.write('a', { x: 1 })])
    const forged = { ...prepared, action: { ...prepared.action, recoveryDocuments: prepared.action.recoveryDocuments.map(row => ({ ...row, document: { x: 0 } })) } }
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: forged }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
  })
})
