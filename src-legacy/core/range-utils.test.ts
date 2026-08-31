import { describe, expect, it } from 'vitest'
import { parseDataGridClipboard } from './clipboard'
import { rangeCellCount, resolveBounds, serializeRange, serializeSelectedCells, updateRange } from './range-utils'

describe('data-grid range utilities', () => {
  const rows = [
    { id: 'row-a', first: 'A', second: 'line\n1', third: 'ignored' },
    { id: 'row-b', first: 'B', second: 'quoted "value"', third: 'ignored' },
  ]
  const rowIndexes = new Map(rows.map((row, index) => [row.id, index]))
  const columnIndexes = new Map([['rowNumber', 0], ['first', 1], ['second', 2], ['third', 3]])
  const selectable = [{ key: 'first', index: 1 }, { key: 'second', index: 2 }]

  it('normalizes a reversed range against stable row and column identities', () => {
    expect(resolveBounds({ anchor: { rowId: 'row-b', columnKey: 'second' }, focus: { rowId: 'row-a', columnKey: 'first' } }, rowIndexes, columnIndexes)).toEqual({
      minRowIndex: 0,
      maxRowIndex: 1,
      minColumnIndex: 1,
      maxColumnIndex: 2,
    })
  })

  it('keeps numeric and string row keys distinct', () => {
    const indexes = new Map<string | number, number>([[1, 0], ['1', 1]])
    expect(resolveBounds(
      { anchor: { rowId: 1, columnKey: 'first' }, focus: { rowId: '1', columnKey: 'second' } },
      indexes,
      columnIndexes,
    )).toEqual({ minRowIndex: 0, maxRowIndex: 1, minColumnIndex: 1, maxColumnIndex: 2 })
  })

  it('round-trips quoted tabs, newlines and quotes through clipboard matrices', () => {
    const text = serializeRange(rows, { minRowIndex: 0, maxRowIndex: 1, minColumnIndex: 1, maxColumnIndex: 2 }, selectable, (row, field) => String((row as Record<string, string>)[field] ?? ''))
    expect(parseDataGridClipboard(text)).toEqual([['A', 'line\n1'], ['B', 'quoted "value"']])
  })

  it('updates only editable cells inside the selected bounds', () => {
    const updated = updateRange(rows, { minRowIndex: 1, maxRowIndex: 1, minColumnIndex: 1, maxColumnIndex: 2 }, selectable, (row, field) => ({ ...row, [field]: '' }))
    expect(updated[0]).toBe(rows[0])
    expect(updated[1]).toEqual({ id: 'row-b', first: '', second: '', third: 'ignored' })
  })

  it('serializes discontinuous cells with blank holes instead of dropping selections', () => {
    expect(serializeSelectedCells(rows, new Map([
      [0, new Set([1])],
      [1, new Set([2])],
    ]), selectable, (row, field) => String((row as Record<string, string>)[field] ?? ''))).toBe('A\t\n\t"quoted ""value"""')
  })

  it('counts a 100,000-row selection without materializing its cells', () => {
    expect(rangeCellCount([{ minRowIndex: 0, maxRowIndex: 99_999, minColumnIndex: 1, maxColumnIndex: 3 }], [
      { index: 1 }, { index: 2 }, { index: 3 },
    ])).toBe(300_000)
  })
})
