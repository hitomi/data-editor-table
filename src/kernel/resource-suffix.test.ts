import { expect, it, vi } from 'vitest'
import { KernelFixture, entityId } from '../../tests/kernel/fixtures.js'
import { kernelId, type Patch, type ResourceValue } from './model.js'
import { createResourceSuffix } from './resource-suffix.js'
import * as resources from './resources.js'
import type { RowOperation, RowResource } from './resources.js'

const write = (patches: readonly Patch[]): RowOperation => ({ kind: 'write', entityId: entityId('a'), groups: [
  { id: kernelId<'write-group'>('test'), expectations: [], writes: patches },
] })
const outcome = (run: () => ResourceValue) => {
  try { return { value: run() } }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

it('matches sequential suffix semantics across overlapping domains, resets and failures', () => {
  const sequences: readonly RowOperation[][] = [
    [write([{ kind: 'set', path: ['profile', 'name'], value: 'new' }]), write([{ kind: 'set', path: ['profile'], value: null }])],
    [write([{ kind: 'set', path: ['profile'], value: null }]), write([{ kind: 'set', path: ['profile', 'name'], value: 'invalid' }])],
    [write([{ kind: 'remove', path: ['profile'] }]), { kind: 'create', entityId: entityId('a'), document: { profile: { name: 'created' } } }],
    [{ kind: 'delete', entityId: entityId('a'), recoveryDocument: {}, expected: { role: 'write-base', resource: { kind: 'entity', entityId: entityId('a') }, expected: { kind: 'missing' }, anchor: { kind: 'authority', observation: kernelId<'observation'>('test') } } },
      write([{ kind: 'set', path: ['profile', 'name'], value: 'invalid' }])],
    [write([{ kind: 'set', path: ['profile'], value: { name: 'first' } }, { kind: 'remove', path: ['profile', 'name'] }]),
      { ...write([{ kind: 'set', path: ['profile'], value: 'other owner' }]), entityId: entityId('b') }],
  ]
  const domains: RowResource[] = [{ kind: 'entity', entityId: entityId('a') }, ...[['profile'], ['profile', 'name'], ['hidden']].map(path =>
    ({ kind: 'path' as const, entityId: entityId('a'), path: path as ['profile'] }))]
  const bases: ResourceValue[] = [{ kind: 'missing' }, { kind: 'value', value: null }, { kind: 'value', value: { profile: { name: 'old' }, name: 'old', hidden: 7 } }]
  for (const operations of sequences) {
    const suffix = createResourceSuffix(operations)
    for (const domain of domains) for (const base of bases) for (let start = 0; start <= operations.length; start++) {
      expect(outcome(() => suffix(domain, start, base))).toEqual(outcome(() => operations.slice(start).reduce((value, operation) => resources.operationResource(domain, value, operation), base)))
    }
  }
  const invalidBeforeReset = createResourceSuffix(sequences[0]!)
  expect(outcome(() => invalidBeforeReset(domains[0]!, 0, { kind: 'value', value: null }))).toHaveProperty('error')
})

it.each([16, 32, 64])('removes repeated suffix replay without dropping %i same-row inputs', count => {
  const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
  for (let value = 1; value <= count; value++) fixture.apply([fixture.write('a', { x: value })])
  const operation = vi.spyOn(resources, 'operationResource')
  try {
    const projected = fixture.project()
    // Prefix domains advance incrementally; suffix resets are shared. This
    // bounds resource operations, not every journal/history bookkeeping cost.
    expect(operation.mock.calls.length).toBeLessThanOrEqual(count * 2)
    expect(projected.rows[0]?.preview).toEqual({ x: count, hidden: 7 })
    expect(projected.changes[0]?.intentIds).toHaveLength(count)
    expect(fixture.state.inputs).toHaveLength(count)
  } finally { operation.mockRestore() }
})
