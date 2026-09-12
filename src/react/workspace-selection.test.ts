import { expect, test } from 'vitest'
import { kernelId } from '../kernel/model.js'
import { selectWorkspaceRange, workspaceSelectionSummary } from './workspace-selection.js'

const rows = ['a', 'b', 'c'].map(id => kernelId<'entity'>(id))
const columns = ['first', 'second', 'third']

test('range membership is independent of gesture direction and captures both axes', () => {
  const start = { entityId: rows[0]!, columnId: 'second' }, end = { entityId: rows[2]!, columnId: 'third' }
  const forward = selectWorkspaceRange(rows, columns, end, start)
  const backward = selectWorkspaceRange(rows, columns, start, end)
  expect(forward.rows).toEqual(rows)
  expect(forward.columns).toEqual(['second', 'third'])
  expect(backward.rows).toEqual(forward.rows)
  expect(backward.columns).toEqual(forward.columns)
  expect(forward.anchor).toEqual(start)
  expect(backward.focus).toEqual(start)
})

test('captured membership survives mutation of the view and caller cell objects', () => {
  const visible = [...rows], displayed = [...columns]
  const focus = { entityId: rows[1]!, columnId: 'second' }
  const range = selectWorkspaceRange(visible, displayed, focus, { entityId: rows[0]!, columnId: 'first' })
  visible.reverse(); visible.splice(1, 0, kernelId<'entity'>('new'))
  displayed.reverse(); focus.columnId = 'third'
  expect(range.rows).toEqual(rows.slice(0, 2))
  expect(range.columns).toEqual(['first', 'second'])
  expect(range.focus.columnId).toBe('second')
  for (const value of [range, range.rows, range.columns, range.anchor, range.focus]) expect(Object.isFrozen(value)).toBe(true)
})

test('a new gesture resets an invisible anchor but rejects an invisible focus or ambiguous axes', () => {
  const focus = { entityId: rows[1]!, columnId: 'second' }
  const range = selectWorkspaceRange(rows.slice(1), columns, focus, { entityId: rows[0]!, columnId: 'first' })
  expect(range.anchor).toEqual(focus)
  expect(range.rows).toEqual([rows[1]])
  expect(range.columns).toEqual(['second'])
  expect(() => selectWorkspaceRange([], columns, focus)).toThrow('visible target')
  expect(() => selectWorkspaceRange([...rows, rows[0]!], columns, focus)).toThrow('unique nonempty')
  expect(() => selectWorkspaceRange(rows, ['second', 'second'], focus)).toThrow('unique nonempty')
})

test('display aliases resolve to one write per entity and missing columns cannot narrow a range', async () => {
  const { workspaceSelectionFields } = await import('./workspace-selection.js')
  const x = kernelId<'field'>('x'), y = kernelId<'field'>('y')
  const selection = { rows: rows.slice(0, 2), columns: ['x', 'copy', 'y'] }
  const resolved = workspaceSelectionFields(selection, [{ id: 'x', fieldId: x }, { id: 'copy', fieldId: x }, { id: 'y', fieldId: y }])
  expect(resolved).toEqual([
    { entityId: rows[0], fieldId: x }, { entityId: rows[0], fieldId: y },
    { entityId: rows[1], fieldId: x }, { entityId: rows[1], fieldId: y },
  ])
  expect(workspaceSelectionFields(selection, [{ id: 'x', fieldId: x }, { id: 'y', fieldId: y }])).toBeNull()
})

test('summary counts the visible union with overlap, holes and separate display columns', () => {
  const ranges = [
    { rows: [rows[0]!, rows[2]!], columns: ['first', 'second'] },
    { rows: [rows[2]!], columns: ['second', 'third'] },
  ]
  expect(workspaceSelectionSummary(ranges, rows, columns)).toEqual({ rows: 2, columns: 3, cells: 5 })
  expect(workspaceSelectionSummary(ranges, [rows[2]!], ['second', 'third'])).toEqual({ rows: 1, columns: 2, cells: 2 })
  expect(workspaceSelectionSummary(ranges, [rows[1]!], columns)).toEqual({ rows: 0, columns: 0, cells: 0 })
})
