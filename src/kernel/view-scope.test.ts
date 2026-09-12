import { expect, it } from 'vitest'
import { KernelFixture, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { defineKernelSchema } from './schema.js'
import { kernelId } from './model.js'
import { projectView, scopeView } from './view.js'
import { projectKernel } from './projection.js'

it('partition counts distinguish empty scopes from query misses without changing the complete projection', () => {
  const schema = defineKernelSchema({ ...permissiveSchema, fields: ['side', 'name'].map(name => ({ id: kernelId<'field'>(name), path: [name], readonly: false })) })
  const fixture = new KernelFixture({ a: { side: 'left', name: 'Alpha' }, b: { side: 'right', name: 'Beta' } }, schema)
  fixture.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [{ columnId: 'name', predicate: { kind: 'compare', fieldId: kernelId<'field'>('name'), operator: 'equals', value: 'Alpha' } }], sort: [] })
  const projection = projectKernel(fixture.state, schema), view = projectView(fixture.state, schema, projection)
  const scope = (value: string) => scopeView(view, projection, schema, { kind: 'compare', fieldId: kernelId<'field'>('side'), operator: 'equals', value })
  expect(scope('left').rows.map(row => row.preview?.name)).toEqual(['Alpha'])
  expect(scope('right')).toMatchObject({ rows: [], total: 1 })
  expect(scope('empty')).toMatchObject({ rows: [], total: 0 })
  expect(projection.rows).toHaveLength(2)
  expect(fixture.state.journal.actions).toHaveLength(0)
  expect(() => scopeView(view, projection, schema, { kind: 'missing', fieldId: kernelId<'field'>('unknown') })).toThrow('known storage field')
})
