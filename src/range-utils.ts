// Migrated from Huifan packages/ui/data-grid/range-utils.ts.

export type CellCoordinate = {
  rowId: string
  columnKey: string
}

export type CellRange = {
  anchor: CellCoordinate
  focus: CellCoordinate
}

export type RangeBounds = {
  minRowIndex: number
  maxRowIndex: number
  minColumnIndex: number
  maxColumnIndex: number
}

export function resolveBounds(
  range: CellRange,
  rowIndexById: Pick<ReadonlyMap<string, number>, 'get'>,
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
    field: keyof TRow,
  ) => string,
) {
  const columns = columnsInsideBounds(selectableColumns, bounds)
  return rows
    .slice(bounds.minRowIndex, bounds.maxRowIndex + 1)
    .map((row) =>
      columns
        .map(({ key }) =>
          quoteClipboardCell(
            getCellText(row, key as keyof TRow),
          ),
        )
        .join('\t'),
    )
    .join('\n')
}

export function updateRange<TRow>(
  rows: readonly TRow[],
  bounds: RangeBounds,
  selectableColumns: readonly { key: string; index: number }[],
  updateCell: (
    row: TRow,
    field: keyof TRow,
  ) => TRow,
) {
  const columns = columnsInsideBounds(selectableColumns, bounds)
  return rows.map((row, rowIndex) => {
    if (rowIndex < bounds.minRowIndex || rowIndex > bounds.maxRowIndex) {
      return row
    }
    return columns.reduce(
      (nextRow, { key }) =>
        updateCell(nextRow, key as keyof TRow),
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
