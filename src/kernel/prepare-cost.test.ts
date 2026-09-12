import { expect, it, vi } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { SharedFrontiers } from './shared-frontier.js'
import { expandFrontier } from './frontier-table.js'
import { kernelId } from './model.js'

it('advances row and order frontiers through every command in one action', () => {
  const fixture = new KernelFixture({ a: { x: 0, hidden: 7 }, b: { x: 0, hidden: 8 } })
  const a = kernelId<'entity'>('a'), b = kernelId<'entity'>('b'), c = kernelId<'entity'>('c')
  const prepared = fixture.prepare([
    { kind: 'order', desired: [b, a] },
    { kind: 'create', entityId: c, document: { x: 3, hidden: 9 } },
    { kind: 'write', entityId: a, groups: [{ id: kernelId<'write-group'>('with-order-read'), comparison: 'paths',
      writes: [{ kind: 'set', path: ['x'], value: 2 }],
      reads: [{ resource: { kind: 'order' }, role: 'semantic-read', expected: { kind: 'value', value: [b, a, c] } }] }] },
    { kind: 'delete', entityId: b },
    { kind: 'order', desired: [c, a] },
    fixture.write('a', { x: 4 }),
  ])
  const ids = prepared.intents.map(intent => intent.id)
  expect(expandFrontier(prepared.frontiers, prepared.intents[2]!.dependencies)).toEqual([ids[0], ids[1]])
  expect(expandFrontier(prepared.frontiers, prepared.intents[4]!.dependencies)).toEqual([ids[0], ids[1], ids[3]])
  expect(expandFrontier(prepared.frontiers, prepared.intents[5]!.dependencies)).toEqual([ids[2]])
  expect(fixture.dispatch({ kind: 'prepared-action', prepared }).result.kind).toBe('accepted')
  expect(fixture.project().order.preview).toEqual([c, a])
  expect(fixture.project().rows.find(row => row.entityId === a)?.preview).toEqual({ x: 4, hidden: 7 })
  expect(fixture.project().rows.find(row => row.entityId === c)?.preview).toEqual({ x: 3, hidden: 9 })
})

it.each([16, 32, 64])('shares the %i-intent predecessor when preparing a sixteen-field write', count => {
  const fields = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`field:${index}`, 0]))
  const fixture = new KernelFixture({ a: { x: 0, ...fields, hidden: 7 } })
  for (let value = 1; value <= count; value++) fixture.apply([fixture.write('a', { x: value })])
  const changes = { x: count + 1, ...Object.fromEntries(Object.keys(fields).map(key => [key, 1])) }
  const command = fixture.write('a', changes), before = fixture.state, original = JSON.stringify(before)
  const append = vi.spyOn(SharedFrontiers.prototype, 'append')
  let prepared: ReturnType<KernelFixture['prepare']>, visits: number
  try { prepared = fixture.prepare([command]); visits = append.mock.calls.length } finally { append.mockRestore() }
  expect(fixture.state).toBe(before); expect(JSON.stringify(before)).toBe(original)
  expect(expandFrontier(prepared.frontiers, prepared.intents[0]!.dependencies)).toEqual(before.journal.intents.map(intent => intent.id))
  expect(fixture.dispatch({ kind: 'prepared-action', prepared }).result.kind).toBe('accepted')
  expect(fixture.project().rows[0]!.preview).toEqual({ ...changes, hidden: 7 })
  // Includes restoring both preparation and projection arenas, not just new nodes.
  expect(visits!).toBeLessThanOrEqual(count * 8)
})

it.each([16, 32, 64])('extends one row frontier once per preceding command in a %i-command action', count => {
  const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
  const commands = Array.from({ length: count }, (_, index) => fixture.write('a', { x: index + 1 }))
  const append = vi.spyOn(SharedFrontiers.prototype, 'append')
  let prepared: ReturnType<KernelFixture['prepare']>, visits: number
  try { prepared = fixture.prepare(commands); visits = append.mock.calls.length } finally { append.mockRestore() }
  expect(prepared.frontiers.nodes).toHaveLength(count - 1)
  expect(expandFrontier(prepared.frontiers, prepared.intents.at(-1)!.dependencies)).toEqual(prepared.action.intentIds.slice(0, -1))
  expect(fixture.dispatch({ kind: 'prepared-action', prepared }).result.kind).toBe('accepted')
  expect(fixture.state.inputs).toHaveLength(1)
  expect(fixture.state.inputs[0]!.disposition).toEqual({ kind: 'intents', intentIds: prepared.action.intentIds })
  expect(fixture.project().rows[0]!.preview).toEqual({ x: count, hidden: 7 })
  expect(visits!).toBeLessThanOrEqual(count * 2)
})
