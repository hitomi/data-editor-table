import { describe, expect, it } from 'vitest'
import { createStandardFilterCodec, type FilterDraft } from './filter-codecs.js'
import { createStringCodec, createNumberCodec, createIsoDateCodec, createMultiChoiceCodec } from './value-codecs.js'
import { workspaceEn } from './locales/workspace-en.js'
import { KernelFixture, permissiveSchema } from '../tests/kernel/fixtures.js'
import { defineKernelSchema } from './kernel/schema.js'
import { kernelId } from './kernel/model.js'
import { projectView } from './kernel/view.js'

const fieldId = kernelId<'field'>('value')
const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: fieldId, path: ['value'], readonly: false }] })
const messages = workspaceEn.filter.conditions
function query(codec: NonNullable<ReturnType<typeof createStandardFilterCodec>>, conditions: FilterDraft['conditions'], combine: 'all' | 'any' = 'all') {
  const result = codec.parse(JSON.stringify({ format: 'workspace-filter:1', combine, conditions }))
  if (result.kind !== 'valid') throw new Error(result.message)
  return result.predicate
}
function rows(fixture: KernelFixture, predicate: ReturnType<typeof query>) {
  expect(fixture.dispatch({ kind: 'view-query-set', expectedVersion: fixture.state.view.version, filters: predicate ? [{ columnId: 'value', predicate }] : [], sort: [] }).result.kind).toBe('accepted')
  return projectView(fixture.state, schema).rows.map(row => row.entityId)
}
describe('standard retained filter conditions', () => {
  it('matches localized text and combined conditions without changing authority or freezing matching rows', () => {
    const codec = createStandardFilterCodec(fieldId, createStringCodec({ invalid: 'Required' }), messages)!
    const fixture = new KernelFixture({ a: { value: 'Amber poster' }, b: { value: 'BLUE CARD' }, c: { value: 'Cedar label' } }, schema)
    const predicate = query(codec, [{ operator: 'contains', value: 'AMBER' }, { operator: 'equals', value: 'blue card' }], 'any')
    const journal = fixture.state.journal
    expect(rows(fixture, predicate)).toEqual(['a', 'b'])
    fixture.observe({ a: { value: 'Amber poster' }, b: { value: 'BLUE CARD' }, c: { value: 'Amber label' } }, 1)
    expect(projectView(fixture.state, schema).rows.map(row => row.entityId)).toEqual(['a', 'b', 'c'])
    expect(fixture.state.journal).toEqual(journal)
    expect(codec.parse(codec.format(predicate))).toEqual({ kind: 'valid', predicate })
  })
  it('preserves typed tag identity, empty arrays and exact all/any condition round trips', () => {
    const codec = createStandardFilterCodec(fieldId, createMultiChoiceCodec({ invalid: 'Invalid', placeholder: 'None', options: [{ value: 1, label: 'Number' }, { value: '1', label: 'Text' }] }), messages)!
    const fixture = new KernelFixture({ number: { value: [1] }, text: { value: ['1'] }, empty: { value: [] } }, schema)
    expect(rows(fixture, query(codec, [{ operator: 'contains', value: '"1"' }]))).toEqual(['text'])
    const predicate = query(codec, [{ operator: 'not-contains', value: '1' }, { operator: 'is-not-empty', value: '' }])
    expect(rows(fixture, predicate)).toEqual(['text'])
    expect(codec.parse(codec.format(predicate))).toEqual({ kind: 'valid', predicate })
    expect(rows(fixture, query(codec, [{ operator: 'is-empty', value: '' }]))).toEqual(['empty'])
  })
  it('compiles inclusive numeric comparisons without applying authoring bounds to filter operands', () => {
    const codec = createStandardFilterCodec(fieldId, createNumberCodec({ invalid: 'Invalid', minimum: 0 }), messages)!
    const fixture = new KernelFixture({ missing: {}, nil: { value: null }, zero: { value: 0 }, two: { value: 2 }, text: { value: '2' } }, schema)
    const predicate = query(codec, [{ operator: 'greater-than', value: '-1' }, { operator: 'less-than-or-equal', value: '2' }])
    expect(rows(fixture, predicate)).toEqual(['zero', 'two'])
    expect(codec.parse(codec.format(predicate))).toEqual({ kind: 'valid', predicate })
    expect(codec.parse(JSON.stringify({ ...codec.conditions!.initial, conditions: [{ operator: 'equals', value: '2oops' }] })).kind).toBe('invalid')
  })
  it('validates calendar operands and permits explicit clearing of unrepresentable host queries', () => {
    const codec = createStandardFilterCodec(fieldId, createIsoDateCodec({ invalid: 'Invalid date' }), messages)!
    expect(codec.parse(JSON.stringify({ ...codec.conditions!.initial, conditions: [{ operator: 'on', value: '2026-02-29' }] })).kind).toBe('invalid')
    const fixture = new KernelFixture({ a: { value: '2026-02-28' }, b: { value: '2026-03-01' } }, schema)
    expect(rows(fixture, query(codec, [{ operator: 'before', value: '2026-03-01' }]))).toEqual(['a'])
    const retained = codec.format({ kind: 'compare', fieldId, operator: 'contains', value: '2026' })
    expect(codec.conditions!.read(retained)).toBeNull()
    expect(codec.parse(retained).kind).toBe('invalid')
    expect(query(codec, [])).toBeNull()
    const neverMatches = codec.format({ kind: 'any', predicates: [] })
    expect(codec.parse(neverMatches).kind).toBe('invalid')
    expect(codec.conditions!.read(JSON.stringify({ ...codec.conditions!.initial, combine: ['all'] }))).toBeNull()
  })
})
