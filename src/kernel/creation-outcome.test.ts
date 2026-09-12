import { expect, it } from 'vitest'
import { entityId, KernelFixture } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { prepareHistoryCommand } from './history-command.js'
import { bindServerAuthority, unboundServerIdentities } from './source.js'

const cases = (['delete', 'undo'] as const).flatMap(control => (['applied', 'rejected', 'reused-key'] as const).map(outcome => ({ control, outcome })))
it.each(cases)('resolves a pending creation with $control after $outcome without rebinding its lifetime', async ({ control, outcome }) => {
  const fixture = new KernelFixture({}), source = new SourceFixture(fixture.state.workspace.scope, {})
  async function read() {
    const snapshot = source.snapshot()
    const allocations = unboundServerIdentities(fixture.state, snapshot).map(identity => ({ identity, entityId: entityId(`observed:${fixture.next()}`) }))
    expect(fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, snapshot, allocations) }).result.kind).toBe('accepted')
  }
  const creation = fixture.apply([{ kind: 'create', entityId: entityId('local'), document: { x: 1, hidden: 7 } }], 'row', 'original create input')
  const request = fixture.freeze().submission, bytes = JSON.stringify(request)
  expect(fixture.dispatch({ kind: 'mutation-uncertain', ref: request, attempt: 1, issue: { code: 'lost', message: 'No exact outcome yet' } }).result.kind).toBe('accepted')
  if (control === 'delete') fixture.apply([{ kind: 'delete', entityId: entityId('local') }], 'row', 'original delete input')
  else expect(fixture.dispatch(prepareHistoryCommand(fixture.state, fixture.schema, 'undo', () => `undo:${fixture.next()}`)).result.kind).toBe('accepted')
  expect(fixture.project().changes).toEqual([])
  expect(JSON.stringify('submission' in fixture.state.persistence && fixture.state.persistence.submission)).toBe(bytes)
  if (outcome === 'rejected') source.external({})
  source.normalize = document => ({ ...document, x: 1.5, hidden: 9 })
  const result = await source.submit(request)
  if (outcome === 'rejected') {
    expect(result.kind).toBe('not-applied')
    if (result.kind !== 'not-applied') throw new Error('Expected fenced rejection')
    expect(fixture.dispatch({ kind: 'not-applied', proof: result.proof }).result.kind).toBe('accepted')
    await read()
    expect(fixture.project().changes).toEqual([])
    expect(source.snapshot().rows).toEqual([])
    expect(source.writes).toBe(0)
  } else {
    if (result.kind !== 'applied') throw new Error('Expected canonical creation')
    const created = result.receipt.results.find(item => item.kind === 'created')!
    if (created.kind !== 'created') throw new Error('Expected assigned identity')
    if (outcome === 'reused-key') {
      source.external({}); source.external({ [String(created.identity.key)]: { x: 99, hidden: 88 } })
    }
    expect(fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }).result.kind).toBe('accepted')
    await read()
    if (outcome === 'reused-key') {
      expect(fixture.project().changes).toEqual([])
      expect(source.snapshot().rows).toHaveLength(1)
      expect(source.snapshot().rows[0]?.document).toEqual({ x: 99, hidden: 88 })
      expect(source.snapshot().rows[0]?.identity.incarnation).not.toBe(created.identity.incarnation)
      expect(fixture.state.entities.find(entity => entity.entityId === entityId('local'))?.kind).toBe('retired')
      expect(source.writes).toBe(1)
    } else {
      const compensation = fixture.freeze().submission
      expect(compensation.items).toEqual([expect.objectContaining({ kind: 'delete', identity: created.identity, before: { x: 1.5, hidden: 9 } })])
      const removed = await source.submit(compensation)
      if (removed.kind !== 'applied') throw new Error('Expected exact deletion')
      expect(fixture.dispatch({ kind: 'exact-receipt', receipt: removed.receipt }).result.kind).toBe('accepted')
      await read()
      expect(source.snapshot().rows).toEqual([])
      expect(source.writes).toBe(2)
    }
  }
  expect(fixture.state.journal.intents[0]).toEqual(creation.intents[0])
  expect(fixture.state.inputs[0]?.input).toEqual({ kind: 'encoded', value: 'original create input' })
  if (control === 'delete') expect(fixture.state.inputs[1]?.input).toEqual({ kind: 'encoded', value: 'original delete input' })
  expect(JSON.stringify(request)).toBe(bytes)
})
