import type { GridPoint, GridRange, GridRowKey } from './grid-model.js'
import { gridRowKeysEqual } from './row-key.js'
import { encodeCellIdentity } from './cell-identity.js'

export type GridRangeBounds = Readonly<{
  minRow: number
  maxRow: number
  minColumn: number
  maxColumn: number
  rowCount: number
  columnCount: number
}>

export function gridRangeBounds<RowKey extends GridRowKey>(
  range: GridRange<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
): GridRangeBounds | null {
  const rowA = rows.findIndex((key) =>
    gridRowKeysEqual(key, range.anchor.rowKey),
  )
  const rowB = rows.findIndex((key) =>
    gridRowKeysEqual(key, range.focus.rowKey),
  )
  const columnA = columns.indexOf(range.anchor.columnKey)
  const columnB = columns.indexOf(range.focus.columnKey)
  if (rowA < 0 || rowB < 0 || columnA < 0 || columnB < 0) return null
  const minRow = Math.min(rowA, rowB)
  const maxRow = Math.max(rowA, rowB)
  const minColumn = Math.min(columnA, columnB)
  const maxColumn = Math.max(columnA, columnB)
  return {
    minRow,
    maxRow,
    minColumn,
    maxColumn,
    rowCount: maxRow - minRow + 1,
    columnCount: maxColumn - minColumn + 1,
  }
}

export function gridFillDirection(
  source: GridRangeBounds,
  target: GridRangeBounds,
) {
  if (target.maxRow < source.minRow) return 'up' as const
  if (target.minRow > source.maxRow) return 'down' as const
  if (target.maxColumn < source.minColumn) return 'left' as const
  if (target.minColumn > source.maxColumn) return 'right' as const
  return null
}

export function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor
}

export function selectedCells<RowKey extends GridRowKey>(
  ranges: readonly GridRange<RowKey>[],
  visibleRowKeys: readonly RowKey[],
  columnKeys: readonly string[],
): readonly GridPoint<RowKey>[] {
  const cells = new Map<string, GridPoint<RowKey>>()
  for (const range of ranges) {
    const rowA = visibleRowKeys.findIndex((key) =>
      gridRowKeysEqual(key, range.anchor.rowKey),
    )
    const rowB = visibleRowKeys.findIndex((key) =>
      gridRowKeysEqual(key, range.focus.rowKey),
    )
    const columnA = columnKeys.indexOf(range.anchor.columnKey)
    const columnB = columnKeys.indexOf(range.focus.columnKey)
    if (rowA < 0 || rowB < 0 || columnA < 0 || columnB < 0) continue
    for (let rowIndex = Math.min(rowA, rowB); rowIndex <= Math.max(rowA, rowB); rowIndex += 1) {
      const rowKey = visibleRowKeys[rowIndex]
      if (rowKey === undefined) continue
      for (let columnIndex = Math.min(columnA, columnB); columnIndex <= Math.max(columnA, columnB); columnIndex += 1) {
        const columnKey = columnKeys[columnIndex]
        if (columnKey === undefined) continue
        const point = Object.freeze({ rowKey, columnKey })
        cells.set(encodeCellIdentity(point), point)
      }
    }
  }
  return Object.freeze([...cells.values()])
}
