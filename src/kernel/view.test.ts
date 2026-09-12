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

describe('independent named queries', () => {
  const left = kernelId<'view'>('left'), right = kernelId<'view'>('right')
  it('forks the default query, fences versions per view, and leaves hidden edits in the save', () => {
    const fixture = new KernelFixture({ a: { value: 1 }, b: { value: 2 }, c: { value: 3 } }, schema)
    filter(fixture, { kind: 'compare', fieldId, operator: 'greater-than', value: 0 })
    const rows = (viewId: typeof left) => projectView(fixture.state, schema, fixture.project(), viewId).rows.map(row => row.entityId)
    fixture.apply([fixture.write('c', { value: 4 })])
    expect(fixture.dispatch({ kind: 'view-query-set', viewId: left, expectedVersion: 1, filters: [{ columnId: 'value', predicate: equal(1) }], sort: [] }).result.kind).toBe('accepted')
    expect(fixture.dispatch({ kind: 'view-query-set', viewId: right, expectedVersion: 1, filters: [], sort: [{ fieldId, direction: 'desc' }] }).result.kind).toBe('accepted')
    expect(rows(left)).toEqual(['a']); expect(rows(right)).toEqual(['c', 'b', 'a'])
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'view-query-set', viewId: left, expectedVersion: 1, filters: [], sort: [] }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    filter(fixture, equal(2))
    expect(rows(left)).toEqual(['a']); expect(rows(right)).toEqual(['c', 'b', 'a'])
    expect(fixture.freeze().submission.items.flatMap(item => item.kind === 'order' ? [] : [item.entityId])).toEqual(['c'])
  })

  it('keeps the filter destination when another view attaches its editor and changes its own query', () => {
    const fixture = new KernelFixture({ a: { value: 1 }, b: { value: 2 } }, schema)
    expect(fixture.dispatch({ kind: 'session-opened', revision: fixture.state.revision, sessionId: kernelId<'session'>('filter'),
      inputId: kernelId<'input'>('filter-input'), viewId: left, target: { kind: 'filter', viewId: left, columnId: 'value', queryVersion: 0 },
      input: { kind: 'encoded', value: '1' }, reads: [] }).result.kind).toBe('accepted')
    const editor = fixture.state.session!.editor!
    expect(fixture.dispatch({ kind: 'session-detached', lease: editor, inputVersion: 0 }).result.kind).toBe('accepted')
    expect(fixture.dispatch({ kind: 'session-attached', sessionId: editor.sessionId, viewId: right }).result.kind).toBe('accepted')
    expect(fixture.dispatch({ kind: 'view-query-set', viewId: right, expectedVersion: 0, filters: [], sort: [{ fieldId, direction: 'desc' }] }).result.kind).toBe('accepted')
    expect(fixture.state.session!.issues).toEqual([])
    expect(fixture.dispatch({ kind: 'session-query-apply', lease: fixture.state.session!.editor!, inputVersion: 0, queryVersion: 0, predicate: equal(1) }).result.kind).toBe('accepted')
    expect(projectView(fixture.state, schema, fixture.project(), left).rows.map(row => row.entityId)).toEqual(['a'])
    expect(projectView(fixture.state, schema, fixture.project(), right).rows.map(row => row.entityId)).toEqual(['b', 'a'])
    expect(fixture.state.inputs[0]!.disposition).toEqual({ kind: 'applied-to-view', viewId: left, queryVersion: 1 })
    expect(fixture.state.viewHistory.filter(query => query.version === 1).map(query => query.viewId)).toEqual([right, left])
    expect(fixture.state.journal.intents).toHaveLength(0)
  })
})

it('searches typed values and catalog labels without freezing matching row membership', () => {
  const fixture = new KernelFixture({ a: { value: ['code-a', 1] }, b: { value: false }, c: { value: 12 }, d: { value: null } }, schema)
  const viewId = kernelId<'view'>('search')
  const fields = [{ fieldId, labels: [{ value: 'code-a', text: 'Featured' }, { value: false, text: 'Inactive' }] }]
  const search = (text: string) => {
    expect(fixture.dispatch({ kind: 'view-search-set', viewId, search: { text, locale: 'en', fields } }).result.kind).toBe('accepted')
    return projectView(fixture.state, schema, fixture.project(), viewId).rows.map(row => row.entityId)
  }
  expect(search('  FEATURED ')).toEqual(['a'])
  expect(search('code-a')).toEqual(['a'])
  expect(search('FALSE')).toEqual(['b'])
  expect(search('inactive')).toEqual(['b'])
  expect(search('1')).toEqual(['a', 'c'])
  expect(search('null')).toEqual([])
  expect(search('')).toEqual(['a', 'b', 'c', 'd'])
  expect(search('new')).toEqual([])
  fixture.observe({ added: { value: 'NEW RECORD' } }, 1)
  expect(projectView(fixture.state, schema, fixture.project(), viewId).rows.map(row => row.entityId)).toEqual(['added'])
  expect(fixture.state.journal.intents).toEqual([])
})

it('search patches preserve concurrent column filters and sort, and query changes preserve search', () => {
  const fixture = new KernelFixture({ a: { value: 'Alpha' }, b: { value: 'Beta' } }, schema), viewId = kernelId<'view'>('search')
  const dispatch = (text: string) => fixture.dispatch({ kind: 'view-search-set', viewId, search: { text, locale: 'en', fields: [{ fieldId }] } })
  dispatch('a')
  expect(fixture.dispatch({ kind: 'view-query-set', viewId, expectedVersion: 1, filters: [{ columnId: 'value', predicate: equal('Beta') }], sort: [{ fieldId, direction: 'desc' }] }).result.kind).toBe('accepted')
  dispatch('Al')
  expect(projectView(fixture.state, schema, fixture.project(), viewId).rows).toEqual([])
  expect(fixture.dispatch({ kind: 'view-query-set', viewId, expectedVersion: 3, filters: [], sort: [] }).result.kind).toBe('accepted')
  expect(projectView(fixture.state, schema, fixture.project(), viewId).rows.map(row => row.entityId)).toEqual(['a'])
  const before = fixture.state
  expect(fixture.dispatch({ kind: 'view-search-set', viewId, search: { text: 'lost', locale: 'en', fields: [{ fieldId: kernelId<'field'>('unknown') }] } }).result.kind).toBe('rejected')
  expect(fixture.state).toBe(before)
})
