import { expect, test } from 'vitest'
import { KernelFixture, entityId, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { kernelId, type ViewPredicate } from '../kernel/model.js'
import { defineKernelSchema } from '../kernel/schema.js'
import { projectView } from '../kernel/view.js'
import { workspaceChangeCount } from './workspace-summary.js'

const schema = defineKernelSchema({ ...permissiveSchema, fields: ['x', 'y', 'side'].map(id => ({
  id: kernelId<'field'>(id), path: [id], readonly: false,
})) })
const columns = ['x', 'y'].map(id => ({ fieldId: kernelId<'field'>(id) }))
const scope = (side: string): ViewPredicate => ({ kind: 'compare', fieldId: kernelId<'field'>('side'), operator: 'equals', value: side })
const fixture = () => new KernelFixture({ a: { x: 1, y: 2, side: 'left' }, b: { x: 3, y: 4, side: 'right' }, c: { x: 5, y: 6, side: 'left' } }, schema)
const count = (grid: KernelFixture, rowScope?: ViewPredicate) => {
  const projection = grid.project()
  return workspaceChangeCount(projection, schema, columns, projectView(grid.state, schema, projection), rowScope)
}

test('change count compares final fields and includes row creation and deletion separately', () => {
  const grid = fixture()
  expect(count(grid)).toBe(0)
  grid.apply([grid.write('a', { x: 2 })])
  grid.apply([grid.write('a', { x: 3 })])
  expect(count(grid)).toBe(1)
  grid.apply([{ kind: 'create', entityId: entityId('new'), document: { x: 7, y: 8, side: 'left' } }])
  expect(count(grid)).toBe(4)
  grid.apply([{ kind: 'delete', entityId: entityId('new') }])
  expect(count(grid)).toBe(1)
  grid.apply([{ kind: 'delete', entityId: entityId('b') }])
  expect(count(grid)).toBe(2)
  grid.apply([grid.write('a', { x: 1 })])
  expect(count(grid)).toBe(1)
})

test('partition transfer counts departure and arrival without leaking changes to unrelated partitions', () => {
  const grid = fixture()
  grid.apply([grid.write('a', { x: 9 })])
  expect(count(grid, scope('left'))).toBe(1)
  expect(count(grid, scope('right'))).toBe(0)
  grid.apply([grid.write('a', { side: 'right' })])
  expect(count(grid, scope('left'))).toBe(1)
  expect(count(grid, scope('right'))).toBe(3)
})

test('relative ordering is one change in affected partitions', () => {
  const grid = fixture()
  grid.apply([{ kind: 'order', desired: ['c', 'b', 'a'].map(entityId) }])
  expect(count(grid)).toBe(1)
  expect(count(grid, scope('left'))).toBe(1)
  expect(count(grid, scope('right'))).toBe(0)
})
