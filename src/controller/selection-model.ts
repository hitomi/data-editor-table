import type {
  GridHitTarget,
  GridInteractionState,
  GridPoint,
  GridRange,
  GridRowKey,
} from '../model/grid-model.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import { gridRowKeysEqual } from '../model/row-key.js'

export function rangeForHitTarget<RowKey extends GridRowKey>(
  target: GridHitTarget<RowKey>,
  visibleRowKeys: readonly RowKey[],
  columnKeys: readonly string[],
): GridRange<RowKey> | null {
  const firstRow = visibleRowKeys[0]
  const lastRow = visibleRowKeys.at(-1)
  const firstColumn = columnKeys[0]
  const lastColumn = columnKeys.at(-1)
  if (target.kind === 'fill-handle' || firstRow === undefined || lastRow === undefined || firstColumn === undefined || lastColumn === undefined) return null
  switch (target.kind) {
    case 'cell': {
      const point = { rowKey: target.rowKey, columnKey: target.columnKey }
      return freezeRange({ anchor: point, focus: point })
    }
    case 'row': return freezeRange({ anchor: { rowKey: target.rowKey, columnKey: firstColumn }, focus: { rowKey: target.rowKey, columnKey: lastColumn } })
    case 'column': return freezeRange({ anchor: { rowKey: firstRow, columnKey: target.columnKey }, focus: { rowKey: lastRow, columnKey: target.columnKey } })
    case 'corner': return freezeRange({ anchor: { rowKey: firstRow, columnKey: firstColumn }, focus: { rowKey: lastRow, columnKey: lastColumn } })
  }
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

export function selectedRowKeys<RowKey extends GridRowKey>(
  ranges: readonly GridRange<RowKey>[],
  visibleRowKeys: readonly RowKey[],
  columnKeys: readonly string[],
): readonly RowKey[] {
  const selected = new Set(selectedCells(ranges, visibleRowKeys, columnKeys).map((cell) => cell.rowKey))
  return Object.freeze(visibleRowKeys.filter((rowKey) => selected.has(rowKey)))
}

export function clearInteraction<RowKey extends GridRowKey>(): GridInteractionState<RowKey> {
  return Object.freeze({
    activeCell: null,
    ranges: Object.freeze([]),
    activeRangeIndex: null,
    gesture: null,
    fillPreview: null,
    actionSession: null,
  })
}

export function freezeRange<RowKey extends GridRowKey>(range: GridRange<RowKey>): GridRange<RowKey> {
  return Object.freeze({ anchor: Object.freeze({ ...range.anchor }), focus: Object.freeze({ ...range.focus }) })
}
