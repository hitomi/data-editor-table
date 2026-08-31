// Migrated from Huifan packages/ui/data-grid/range-utils.ts.

import type { GridRowKey } from './types.js'

export type CellCoordinate<RowId extends GridRowKey = string> = {
  rowId: RowId
  columnKey: string
}

export type CellRange<RowId extends GridRowKey = string> = {
  anchor: CellCoordinate<RowId>
  focus: CellCoordinate<RowId>
}

export type RangeBounds = {
  minRowIndex: number
  maxRowIndex: number
  minColumnIndex: number
  maxColumnIndex: number
}

export function resolveBounds<RowId extends GridRowKey>(
  range: CellRange<RowId>,
  rowIndexById: Pick<ReadonlyMap<RowId, number>, 'get'>,
  columnIndexByKey: Pick<ReadonlyMap<string, number>, 'get'>,
): RangeBounds | null {
  const anchorRowIndex = rowIndexById.get(range.anchor.rowId)
  const focusRowIndex = rowIndexById.get(range.focus.rowId)
  const anchorColumnIndex = columnIndexByKey.get(range.anchor.columnKey)
  const focusColumnIndex = columnIndexByKey.get(range.focus.columnKey)
  if (
    anchorRowIndex === undefined ||
    focusRowIndex === undefined ||
    anchorColumnIndex === undefined ||
    focusColumnIndex === undefined
  ) {
    return null
  }
  return {
    minRowIndex: Math.min(anchorRowIndex, focusRowIndex),
    maxRowIndex: Math.max(anchorRowIndex, focusRowIndex),
    minColumnIndex: Math.min(anchorColumnIndex, focusColumnIndex),
    maxColumnIndex: Math.max(anchorColumnIndex, focusColumnIndex),
  }
}

export function rangeCellCount(
  bounds: readonly RangeBounds[],
  selectableColumns: readonly { index: number }[],
): number {
  return bounds.reduce((total, range) => {
    const rowCount = range.maxRowIndex - range.minRowIndex + 1
    const columnCount = selectableColumns.filter(({ index }) => index >= range.minColumnIndex && index <= range.maxColumnIndex).length
    return total + rowCount * columnCount
  }, 0)
}

export function serializeRange<TRow>(
  rows: readonly TRow[],
  bounds: RangeBounds,
  selectableColumns: readonly { key: string; index: number }[],
  getCellText: (
    row: TRow,
    field: string,
  ) => string,
) {
  const columns = columnsInsideBounds(selectableColumns, bounds)
  return rows
    .slice(bounds.minRowIndex, bounds.maxRowIndex + 1)
    .map((row) =>
      columns
        .map(({ key }) =>
          quoteClipboardCell(
            getCellText(row, key),
          ),
        )
        .join('\t'),
    )
    .join('\n')
}

/** Serializes every selected cell and leaves holes blank instead of dropping discontinuous ranges. */
export function serializeSelectedCells<TRow>(
  rows: readonly TRow[],
  selectedCellIndexes: ReadonlyMap<number, ReadonlySet<number>>,
  selectableColumns: readonly { key: string; index: number }[],
  getCellText: (row: TRow, field: string) => string,
) {
  const rowIndexes = [...selectedCellIndexes.keys()].sort((left, right) => left - right)
  const selectedColumnIndexes = new Set([...selectedCellIndexes.values()].flatMap((indexes) => [...indexes]))
  const columns = selectableColumns.filter(({ index }) => selectedColumnIndexes.has(index) || (
    selectedColumnIndexes.size > 0 &&
    index >= Math.min(...selectedColumnIndexes) &&
    index <= Math.max(...selectedColumnIndexes)
  ))
  if (rowIndexes.length === 0 || columns.length === 0) return ''
  const minRow = rowIndexes[0]!
  const maxRow = rowIndexes.at(-1)!
  const lines: string[] = []
  for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
    const row = rows[rowIndex]
    const selectedColumns = selectedCellIndexes.get(rowIndex)
    lines.push(columns.map(({ index, key }) => row && selectedColumns?.has(index)
      ? quoteClipboardCell(getCellText(row, key))
      : '').join('\t'))
  }
  return lines.join('\n')
}

export function updateRange<TRow>(
  rows: readonly TRow[],
  bounds: RangeBounds,
  selectableColumns: readonly { key: string; index: number }[],
  updateCell: (
    row: TRow,
    field: string,
  ) => TRow,
) {
  const columns = columnsInsideBounds(selectableColumns, bounds)
  return rows.map((row, rowIndex) => {
    if (rowIndex < bounds.minRowIndex || rowIndex > bounds.maxRowIndex) {
      return row
    }
    return columns.reduce(
      (nextRow, { key }) =>
        updateCell(nextRow, key),
      row,
    )
  })
}

export function keyboardDirection(key: string) {
  if (key === 'ArrowUp') return { row: -1, column: 0 }
  if (key === 'ArrowDown') return { row: 1, column: 0 }
  if (key === 'ArrowLeft') return { row: 0, column: -1 }
  if (key === 'ArrowRight') return { row: 0, column: 1 }
  return null
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function columnsInsideBounds(
  selectableColumns: readonly { key: string; index: number }[],
  bounds: RangeBounds,
) {
  return selectableColumns.filter(
    ({ index }) =>
      index >= bounds.minColumnIndex && index <= bounds.maxColumnIndex,
  )
}

function quoteClipboardCell(value: string) {
  if (!/["\t\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}
