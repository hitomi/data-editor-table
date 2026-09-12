import { describe, expect, it } from 'vitest'
import { KernelFixture, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { kernelId, type ViewPredicate } from './model.js'
import { defineKernelSchema } from './schema.js'
import { projectView } from './view.js'

const fieldId = kernelId<'field'>('value')
const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: fieldId, path: ['value'], readonly: false }] })
const equal = (value: null | number | string): ViewPredicate => ({ kind: 'compare', fieldId, operator: 'equals', value })
function filter(fixture: KernelFixture, predicate: ViewPredicate) {
  const result = fixture.dispatch({ kind: 'view-query-set', expectedVersion: fixture.state.view.version, filters: [{ columnId: 'display', predicate }], sort: fixture.state.view.sort })
  expect(result.result.kind, JSON.stringify(result.result)).toBe('accepted')
  return projectView(fixture.state, schema).rows.map(row => row.entityId)
}

describe('versioned display query', () => {
  it('distinguishes missing, null, text and numeric values, and composes explicit predicates', () => {
    const fixture = new KernelFixture({ missing: {}, nullable: { value: null }, number: { value: 2 }, text: { value: '2' }, phrase: { value: '42 apples' } }, schema)
    expect(filter(fixture, { kind: 'missing', fieldId })).toEqual(['missing'])
    expect(filter(fixture, equal(null))).toEqual(['nullable'])
    expect(filter(fixture, equal(2))).toEqual(['number'])
    expect(filter(fixture, { kind: 'compare', fieldId, operator: 'contains', value: '2' })).toEqual(['text', 'phrase'])
    expect(filter(fixture, { kind: 'compare', fieldId, operator: 'greater-than', value: 1 })).toEqual(['number'])
    expect(filter(fixture, { kind: 'all', predicates: [{ kind: 'not', predicate: { kind: 'missing', fieldId } }, { kind: 'any', predicates: [equal(null), equal('2')] }] })).toEqual(['nullable', 'text'])
    expect(filter(fixture, { kind: 'any', predicates: [] })).toEqual([])
    expect(filter(fixture, { kind: 'all', predicates: [] })).toHaveLength(5)
  })

  it('uses a deterministic stable sort without changing persistent order or save membership', () => {
    const fixture = new KernelFixture({ z: { value: 2 }, a: { value: 2 }, c: { value: 1 }, missing: {}, nullable: { value: null }, text: { value: '10' } }, schema)
    fixture.apply([fixture.write('z', { value: 3 })])
    const journal = fixture.state.journal, order = fixture.project().order.preview, inputs = fixture.state.inputs
    expect(fixture.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [], sort: [{ fieldId, direction: 'asc' }] }).result.kind).toBe('accepted')
    expect(projectView(fixture.state, schema).rows.map(row => row.entityId)).toEqual(['missing', 'nullable', 'c', 'a', 'z', 'text'])
    expect(fixture.dispatch({ kind: 'view-query-set', expectedVersion: 1, filters: [], sort: [{ fieldId, direction: 'desc' }] }).result.kind).toBe('accepted')
    expect(projectView(fixture.state, schema).rows.map(row => row.entityId)).toEqual(['text', 'z', 'a', 'c', 'nullable', 'missing'])
    expect(fixture.state.journal).toBe(journal); expect(fixture.state.inputs).toBe(inputs)
    expect(fixture.project().order.preview).toEqual(order)
    expect(fixture.project().orderChange).toBeNull()
    expect(filter(fixture, equal(1))).toEqual(['c'])
    const submission = fixture.freeze().submission
    expect(submission.items).toHaveLength(1)
    expect(submission.items[0]).toMatchObject({ entityId: 'z' })
  })

  it('retains the persistent relative order for equal sort keys across remote refreshes', () => {
    const fixture = new KernelFixture({ z: { value: 2 }, a: { value: 2 }, c: { value: 1 } }, schema)
    fixture.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [], sort: [{ fieldId, direction: 'desc' }] })
    expect(projectView(fixture.state, schema).rows.map(row => row.entityId)).toEqual(['z', 'a', 'c'])
    fixture.observe({ a: { value: 2 }, c: { value: 1 }, z: { value: 2 } }, 1)
    expect(projectView(fixture.state, schema).rows.map(row => row.entityId)).toEqual(['a', 'z', 'c'])
  })

  it('rejects stale query updates and invalid expressions atomically', () => {
    const fixture = new KernelFixture({ a: { value: 1 } }, schema)
    filter(fixture, equal(1)); const before = fixture.state
    for (const command of [
      { kind: 'view-query-set' as const, expectedVersion: 0, filters: [], sort: [] },
      { kind: 'view-query-set' as const, expectedVersion: 1, filters: [{ columnId: 'bad', predicate: { kind: 'compare' as const, fieldId, operator: 'contains' as const, value: 1 } }], sort: [] },
      { kind: 'view-query-set' as const, expectedVersion: 1, filters: [{ columnId: 'bad', predicate: { kind: 'missing' as const, fieldId: kernelId<'field'>('unknown') } }], sort: [] },
      { kind: 'view-query-set' as const, expectedVersion: 1, filters: [{ columnId: 'duplicate', predicate: equal(1) }, { columnId: 'duplicate', predicate: equal(2) }], sort: [] },
      { kind: 'view-query-set' as const, expectedVersion: 1, filters: [], sort: [{ fieldId, direction: 'asc' as const }, { fieldId, direction: 'desc' as const }] },
    ]) {
      expect(fixture.dispatch(command).result.kind).toBe('rejected')
      expect(fixture.state).toBe(before)
    }
    expect(fixture.state.viewHistory.map(query => query.version)).toEqual([0, 1])
  })
})
