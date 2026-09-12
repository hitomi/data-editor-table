import { expect, it } from 'vitest'
import { entityId, KernelFixture } from '../../tests/kernel/fixtures.js'
import { kernelId, type Patch } from './model.js'

it('broadens nested domains, cancels at application boundaries, and preserves all original input', () => {
  const original = { profile: { name: 'old', nullable: null }, hidden: 7 }
  const fixture = new KernelFixture({ a: original })
  const patch = (writes: readonly Patch[]) => fixture.apply([{ kind: 'write', entityId: entityId('a'), groups: [
    { id: kernelId<'write-group'>(`nested:${fixture.next()}`), writes, comparison: 'paths', reads: [] },
  ] }])
  patch([{ kind: 'set', path: ['profile', 'name'], value: 'new' }])
  patch([{ kind: 'remove', path: ['profile', 'nullable'] }])
  fixture.apply([fixture.write('a', { profile: { name: 'new', extra: 1 } })])
  fixture.apply([{ kind: 'replace', entityId: entityId('a'), document: original }])
  const records = fixture.state.journal.intents
  expect(fixture.project().neutralIntentIds).toEqual(records.map(intent => intent.id))
  expect(fixture.project().changes).toEqual([])
  const latest = { profile: null, hidden: 9 }
  fixture.observe({ a: latest }, 1)
  expect(fixture.project().rows[0]?.preview).toEqual(latest)
  expect(fixture.project().changes).toEqual([])
  expect(fixture.state.journal.intents).toEqual(records)
  expect(fixture.state.inputs).toHaveLength(4)
  expect(fixture.state.settlements).toEqual([])
  fixture.apply([fixture.write('a', { profile: { name: 'next' } })])
  expect(fixture.project().changes[0]).toMatchObject({ before: latest, after: { profile: { name: 'next' }, hidden: 9 } })
})

it('does not reset a neutral prefix inside a multi-intent application', () => {
  const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
  const action = fixture.apply([fixture.write('a', { x: 1 }), fixture.write('a', { x: 0 }), fixture.write('a', { x: 2 })])
  expect(fixture.project().neutralIntentIds).toEqual([])
  expect(fixture.project().changes[0]?.intentIds).toEqual(action.action.intentIds)
  fixture.apply([fixture.write('a', { x: 0 })])
  expect(fixture.project().neutralIntentIds).toHaveLength(4)
  expect(fixture.project().changes).toEqual([])
})
