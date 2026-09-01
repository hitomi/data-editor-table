import type {
  GridControllerSnapshot,
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

type GridSelectionBounds = Readonly<{
  firstRow: number
  lastRow: number
  firstColumn: number
  lastColumn: number
}>

type GridSelectionIndex = Readonly<{
  columns: readonly Readonly<{ key: string }>[]
  visibleRowKeys: readonly GridRowKey[]
  columnIndexes: ReadonlyMap<string, number>
  rowIndexes: ReadonlyMap<GridRowKey, number>
  ranges: readonly GridSelectionBounds[]
}>

const selectionIndexes = new WeakMap<object, GridSelectionIndex>()

/** Checks range membership without materializing every selected cell. */
export function isGridCellSelected<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
  rowKey: RowKey,
  columnKey: string,
) {
  const index = selectionIndex(snapshot)
  const row = index.rowIndexes.get(rowKey)
  const column = index.columnIndexes.get(columnKey)
  if (row === undefined || column === undefined) return false
  return index.ranges.some((range) => row >= range.firstRow
    && row <= range.lastRow
    && column >= range.firstColumn
    && column <= range.lastColumn)
}

function selectionIndex<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
): GridSelectionIndex {
  const cached = selectionIndexes.get(snapshot.interaction)
  if (cached
    && cached.columns === snapshot.columns
    && cached.visibleRowKeys === snapshot.view.visibleRowKeys) return cached

  const rowIndexes = new Map<GridRowKey, number>()
  snapshot.view.visibleRowKeys.forEach((rowKey, index) => { rowIndexes.set(rowKey, index) })
  const columnIndexes = new Map<string, number>()
  snapshot.columns.forEach((column, index) => { columnIndexes.set(column.key, index) })
  const ranges = snapshot.interaction.ranges.flatMap((range) => {
    const anchorRow = rowIndexes.get(range.anchor.rowKey)
    const focusRow = rowIndexes.get(range.focus.rowKey)
    const anchorColumn = columnIndexes.get(range.anchor.columnKey)
    const focusColumn = columnIndexes.get(range.focus.columnKey)
    if (anchorRow === undefined
      || focusRow === undefined
      || anchorColumn === undefined
      || focusColumn === undefined) return []
    return [Object.freeze({
      firstRow: Math.min(anchorRow, focusRow),
      lastRow: Math.max(anchorRow, focusRow),
      firstColumn: Math.min(anchorColumn, focusColumn),
      lastColumn: Math.max(anchorColumn, focusColumn),
    })]
  })
  const next = Object.freeze({
    columns: snapshot.columns,
    visibleRowKeys: snapshot.view.visibleRowKeys,
    columnIndexes,
    rowIndexes,
    ranges: Object.freeze(ranges),
  })
  selectionIndexes.set(snapshot.interaction, next)
  return next
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
