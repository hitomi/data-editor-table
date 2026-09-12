import { expect, it, vi } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId } from './model.js'
import { projectKernel } from './projection.js'
import type { RowCommand } from './prepare.js'

it.each([8, 16, 32])('indexes committed items once across %i rows and multiple resource domains', async count => {
  const rows = (x: number, y: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`row:${index}`, { x, y, hidden: index }]))
  const fixture = new KernelFixture(rows(0, 0)), source = new SourceFixture(fixture.state.workspace.scope, rows(0, 0))
  const commands = (x: number, y: number) => Array.from({ length: count }, (_, index) => fixture.write(`row:${index}`, { x, y }))
  fixture.apply(commands(1, 2))
  const submission = fixture.freeze().submission
  fixture.apply(commands(3, 4))
  source.normalize = document => ({ ...document, x: Number(document.x) + 0.5, y: Number(document.y) + 0.5 })
  const result = await source.submit(submission)
  if (result.kind !== 'applied') throw new Error('Expected exact save result')
  expect(fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }).result.kind).toBe('accepted')
  fixture.observe(rows(1.5, 2.5), 1)
  const before = JSON.stringify(fixture.state)
  const items = new Set(result.receipt.results.map(item => JSON.stringify([submission.operationId, item.itemId])))
  const set = Map.prototype.set
  let indexedItems = 0
  const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (items.has(key as string) && typeof value === 'number') indexedItems++
    return set.call(this, key, value)
  })
  let projected: ReturnType<typeof projectKernel>
  try { projected = fixture.project() } finally { spy.mockRestore() }
  expect(projected.rows.map(row => row.preview)).toEqual(Object.values(rows(3, 4)))
  expect(projected.changes).toHaveLength(count)
  expect(projected.rows.every(row => row.issues.length === 0)).toBe(true)
  expect(JSON.stringify(fixture.state)).toBe(before)
  expect(source.writes).toBe(1)
  // Counts receipt-item ordinal registration, not total memory or runtime.
  expect(indexedItems).toBe(count)
})

it.each([32, 64, 128, 256])('resolves independent predecessor IDs without repeated journal scans (%i rows)', count => {
  const fixture = new KernelFixture(Object.fromEntries(Array.from({ length: count }, (_, index) => [`row:${index}`, { x: 0, hidden: index }])))
  for (const value of [1, 2]) {
    const commands: RowCommand[] = Array.from({ length: count }, (_, index) => ({ kind: 'write', entityId: kernelId<'entity'>(`row:${index}`),
      groups: [{ id: kernelId<'write-group'>(`group:${value}:${index}`), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['x'], value }] }] }))
    fixture.apply(commands)
  }
  const expected = fixture.project()
  let visits = 0
  const intents = new Proxy(fixture.state.journal.intents, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) visits++
    return Reflect.get(target, key, receiver)
  } })
  const state = { ...fixture.state, journal: { ...fixture.state.journal, intents } }
  const result = projectKernel(state, fixture.schema)
  expect(result).toEqual(expected)
  expect(result.rows.map(row => row.preview)).toEqual(Array.from({ length: count }, (_, index) => ({ x: 2, hidden: index })))
  expect(result.changes).toHaveLength(count)
  expect(visits).toBeLessThanOrEqual(intents.length * 8)
})


it.each([16, 32, 64])('does not copy unrelated step prefixes for %i same-row actions', count => {
  const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
  for (let value = 1; value <= count; value++) fixture.apply([fixture.write('a', { x: value })])
  const before = JSON.stringify(fixture.state), slice = Array.prototype.slice
  let copiedSteps = 0
  const copy = vi.spyOn(Array.prototype, 'slice').mockImplementation(function (this: unknown[], start?: number, end?: number) {
    const result = slice.call(this, start, end)
    if (this[0] && typeof this[0] === 'object' && 'intent' in this[0] && 'operation' in this[0]) copiedSteps += result.length
    return result
  })
  let projected: ReturnType<typeof projectKernel>
  try { projected = fixture.project() } finally { copy.mockRestore() }
  expect(projected.rows[0]?.preview).toEqual({ x: count, hidden: 7 })
  expect(projected.changes[0]?.intentIds).toHaveLength(count)
  expect(fixture.state.inputs).toHaveLength(count)
  expect(JSON.stringify(fixture.state)).toBe(before)
  // Counts copied operation records, not elapsed time or total projection cost.
  expect(copiedSteps).toBeLessThanOrEqual(count * 2)
})

it.each([16, 32, 64])('does not scan dependency owners without a blocked seed (%i actions)', count => {
  const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
  for (let value = 1; value <= count; value++) fixture.apply([fixture.write('a', { x: value })])
  const ids = new Set(fixture.state.journal.intents.map(intent => intent.id)), get = Map.prototype.get
  let ownerLookups = 0
  const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
    const result = get.call(this, key)
    if (ids.has(key as never) && result && typeof result === 'object' && 'issues' in result && 'intents' in result) ownerLookups++
    return result
  })
  let projected: ReturnType<typeof projectKernel>
  try { projected = fixture.project() } finally { spy.mockRestore() }
  expect(projected.rows[0]?.preview).toEqual({ x: count, hidden: 7 })
  expect(projected.changes[0]?.intentIds).toHaveLength(count)
  expect(ownerLookups).toBe(0)
})

it.each([16, 32, 64])('shares resolved intent facts across %i same-row predecessor prefixes', count => {
  const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
  for (let value = 1; value <= count; value++) fixture.apply([fixture.write('a', { x: value })])
  const before = JSON.stringify(fixture.state), get = Map.prototype.get
  let intentFacts = 0
  const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
    const value = get.call(this, key)
    if (value && typeof value === 'object' && 'operation' in value && 'sequence' in value && 'dependencies' in value) intentFacts++
    return value
  })
  let projection: ReturnType<typeof projectKernel>
  try { projection = fixture.project() } finally { spy.mockRestore() }
  expect(projection.rows[0]?.preview).toEqual({ x: count, hidden: 7 })
  expect(projection.changes[0]?.intentIds).toHaveLength(count)
  expect(JSON.stringify(fixture.state)).toBe(before)
  expect(intentFacts).toBeLessThanOrEqual(count * 2)
})
