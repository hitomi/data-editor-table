import type { GridPoint, GridRowKey } from './grid-model.js'

export function encodeCellIdentity<RowKey extends GridRowKey>(
  point: GridPoint<RowKey>,
) {
  const row = String(point.rowKey)
  const rowType = typeof point.rowKey === 'number' ? 'n' : 's'
  return `${rowType}${row.length}:${row}${point.columnKey.length}:${point.columnKey}`
}
