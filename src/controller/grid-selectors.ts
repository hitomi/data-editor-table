import type { GridControllerSnapshot, GridPoint, GridRange, GridRowKey } from '../model/grid-model.js'
import { selectedCells, selectedRowKeys } from './selection-model.js'
import { invokeGridCallback } from '../data/safe-callback.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import {
  displayGridCellValue,
  resolveGridCellValue,
} from '../data/runtime-cell-resolver.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import { isGridRowOrderDirty } from '../data/row-order.js'

export function selectGridCell<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>, point: GridPoint<RowKey>) {
  const row = snapshot.draft.rows.find((candidate) => gridRowKeysEqual(snapshot.getRowKey(candidate), point.rowKey))
  const column = snapshot.columns.find((candidate) => candidate.key === point.columnKey)
  if (!row || !column) return null
  const dirty = snapshot.draft.dirtyCells.find((candidate) => samePoint(candidate, point)) ?? null
  const resolved = resolveGridCellValue(row, column)
  const displayed = displayGridCellValue(resolved)
  const selected = selectedCells(snapshot.interaction.ranges, snapshot.view.visibleRowKeys, snapshot.columns.map((candidate) => candidate.key)).some((candidate) => samePoint(candidate, point))
  return Object.freeze({
    row,
    column,
    resolved,
    valid: resolved.valid,
    value: resolved.valid ? resolved.value : undefined,
    displayText: displayed.ok
      ? displayed.value
      : resolved.valid
        ? 'Invalid value'
        : resolved.fallbackText,
    editable: resolved.valid && column.isEditable(row),
    active: snapshot.interaction.activeCell ? samePoint(snapshot.interaction.activeCell, point) : false,
    selected,
    dirty,
    dirtyOriginalAvailable: dirty !== null
      && !snapshot.draft.insertedRowKeys.some((rowKey) => gridRowKeysEqual(rowKey, point.rowKey)),
    validation: snapshot.draft.validationIssues.find((candidate) => samePoint(candidate, point)) ?? (resolved.valid ? null : Object.freeze({ rowKey: point.rowKey, columnKey: point.columnKey, message: resolved.issue.message })),
    conflict: snapshot.draft.conflicts.find((candidate) => candidate.columnKey === point.columnKey && gridRowKeysEqual(candidate.rowKey, point.rowKey)) ?? null,
    tabIndex: snapshot.interaction.activeCell && samePoint(snapshot.interaction.activeCell, point) ? 0 : -1,
  })
}

export function selectGridSelectionSummary<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  const columns = snapshot.columns.map((column) => column.key)
  const cells = selectedCells(snapshot.interaction.ranges, snapshot.view.visibleRowKeys, columns)
  const rows = selectedRowKeys(snapshot.interaction.ranges, snapshot.view.visibleRowKeys, columns)
  const selectedColumns = new Set(cells.map((cell) => cell.columnKey))
  return Object.freeze({ cellCount: cells.length, rowCount: rows.length, columnCount: selectedColumns.size })
}

/**
 * Returns only rows whose every visible grid column is selected. Row keys and
 * rows follow the current visible order and always refer to the current draft.
 * Invalid/stale visible keys and rows whose key callback throws are omitted.
 */
export function selectGridFullySelectedRows<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
) {
  const columnKeys = snapshot.columns.map((column) => column.key)
  if (columnKeys.length === 0 || snapshot.view.visibleRowKeys.length === 0) {
    return Object.freeze({
      rowKeys: Object.freeze([]) as readonly RowKey[],
      rows: Object.freeze([]) as readonly Row[],
    })
  }

  const selected = new Set(
    selectedCells(
      snapshot.interaction.ranges,
      snapshot.view.visibleRowKeys,
      columnKeys,
    ).map(encodeCellIdentity),
  )
  const rowsByKey = new Map<RowKey, Row>()
  for (const row of snapshot.draft.rows) {
    const resolved = invokeGridCallback(() => snapshot.getRowKey(row))
    if (resolved.ok && !rowsByKey.has(resolved.value)) {
      rowsByKey.set(resolved.value, row)
    }
  }

  const rowKeys: RowKey[] = []
  const rows: Row[] = []
  const seen = new Set<RowKey>()
  for (const rowKey of snapshot.view.visibleRowKeys) {
    if (seen.has(rowKey)) continue
    seen.add(rowKey)
    if (!rowsByKey.has(rowKey)) continue
    if (!columnKeys.every((columnKey) =>
      selected.has(encodeCellIdentity({ rowKey, columnKey })))) continue
    rowKeys.push(rowKey)
    rows.push(rowsByKey.get(rowKey)!)
  }
  return Object.freeze({
    rowKeys: Object.freeze(rowKeys),
    rows: Object.freeze(rows),
  })
}

/**
 * Describes whether the current view preserves the draft's natural row order.
 * Positional row operations must not infer a persistent placement from a
 * filtered or sorted view.
 */
export function selectGridNaturalRowOrder<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
) {
  const eligible = snapshot.view.sort.length === 0
    && snapshot.view.columnFilters.length === 0
    && snapshot.view.globalFilter.trim().length === 0
  return Object.freeze({
    eligible,
    rowKeys: eligible
      ? Object.freeze([...snapshot.view.visibleRowKeys])
      : Object.freeze([]) as readonly RowKey[],
  })
}

export function selectGridSelectionLayer<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  const ranges = snapshot.interaction.ranges.map((range) => rangeRect(snapshot, range)).filter(isDefined)
  const active = snapshot.interaction.activeRangeIndex === null ? null : ranges[snapshot.interaction.activeRangeIndex] ?? null
  const preview = snapshot.interaction.fillPreview ? rangeRect(snapshot, snapshot.interaction.fillPreview) : null
  return Object.freeze({
    ranges: Object.freeze(ranges),
    active,
    fillPreview: preview,
    fillHandle: active ? Object.freeze({ x: active.x + active.width, y: active.y + active.height }) : null,
  })
}

export function selectGridToolbar<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  const deletePlan = selectGridRowDeletePlan(snapshot)
  const duplicatePlan = selectGridRowDuplicatePlan(snapshot)
  const savePlan = selectGridSavePlan(snapshot)
  return Object.freeze({
    canUndo: snapshot.draft.undoStack.length > 0,
    canRedo: snapshot.draft.redoStack.length > 0,
    canAdd: snapshot.rowOperations.canAdd,
    canDuplicate: duplicatePlan.canDuplicate,
    canDelete: deletePlan.canDelete,
    canSave: savePlan.canSave,
    saving: snapshot.persistence.status === 'saving',
  })
}

export function selectGridSavePlan<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
) {
  const blocked = new Set<RowKey>([
    ...snapshot.draft.conflicts.map((item) => item.rowKey),
    ...snapshot.draft.validationIssues.map((item) => item.rowKey),
  ])
  const changed = new Set<RowKey>([
    ...snapshot.draft.dirtyCells.map((item) => item.rowKey),
    ...snapshot.draft.insertedRowKeys,
  ])
  const saveableRowKeys = snapshot.draft.rows
    .map(snapshot.getRowKey)
    .filter((rowKey) => changed.has(rowKey) && !blocked.has(rowKey))
  const saveableDeletedRowKeys = snapshot.draft.deletedRowKeys.filter(
    (rowKey) => !blocked.has(rowKey),
  )
  const blockedChangedRowKeys = Object.freeze(
    [...new Set([...changed, ...snapshot.draft.deletedRowKeys])].filter(
      (rowKey) => blocked.has(rowKey),
    ),
  )
  const canonical = new Map(
    snapshot.source.rows.map(
      (row) => [snapshot.getRowKey(row), row] as const,
    ),
  )
  const accepted = new Set(saveableRowKeys)
  const deleted = new Set(saveableDeletedRowKeys)
  const proposedRows = snapshot.draft.rows.flatMap((row) => {
    const rowKey = snapshot.getRowKey(row)
    if (accepted.has(rowKey) || !blocked.has(rowKey)) return [row]
    const sourceRow = canonical.get(rowKey)
    return sourceRow === undefined ? [] : [sourceRow]
  })
  const proposedKeys = new Set(proposedRows.map(snapshot.getRowKey))
  snapshot.source.rows.forEach((row, sourceIndex) => {
    const rowKey = snapshot.getRowKey(row)
    if (proposedKeys.has(rowKey) || deleted.has(rowKey)) return
    proposedRows.splice(Math.min(sourceIndex, proposedRows.length), 0, row)
    proposedKeys.add(rowKey)
  })
  const orderChanged = snapshot.draft.orderDirty && isGridRowOrderDirty(
    snapshot.source.rows,
    proposedRows,
    snapshot.getRowKey,
  )
  return Object.freeze({
    proposedRows: Object.freeze(proposedRows),
    saveableRowKeys: Object.freeze(saveableRowKeys),
    saveableDeletedRowKeys: Object.freeze(saveableDeletedRowKeys),
    blockedChangedRowKeys,
    saveableRowCount: saveableRowKeys.length + saveableDeletedRowKeys.length,
    blockedRowCount: blockedChangedRowKeys.length,
    orderChanged,
    canSave:
      orderChanged ||
      saveableRowKeys.length > 0 ||
      saveableDeletedRowKeys.length > 0,
  })
}

export function selectGridRowDuplicatePlan<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
) {
  const rowKeys = selectedRowKeys(
    snapshot.interaction.ranges,
    snapshot.view.visibleRowKeys,
    snapshot.columns.map((column) => column.key),
  )
  return Object.freeze({
    rowKeys,
    rowCount: rowKeys.length,
    canDuplicate: snapshot.rowOperations.canDuplicate && rowKeys.length > 0,
  })
}

export type GridRowDeleteAvailability = 'unsupported' | 'allowed' | 'blocked'

type GridSupportedRowDeleteAvailability = Exclude<GridRowDeleteAvailability, 'unsupported'>

/**
 * A controller snapshot is one immutable publication, including its row-key
 * and deletion-policy callback identities. Cache only for that publication so
 * all consumers share one linear projection while every later publish
 * reevaluates policies that may close over changing host permissions.
 */
const gridRowDeleteAvailabilityCache = new WeakMap<
  object,
  ReadonlyMap<GridRowKey, GridSupportedRowDeleteAvailability>
>()

/**
 * Resolves the current draft row against the shared deletion policy. Callback
 * failures are conservatively blocked so renderers and commands agree without
 * allowing an unsafe delete.
 */
export function selectGridRowDeleteAvailability<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
  rowKey: RowKey,
): GridRowDeleteAvailability {
  const canDelete = snapshot.rowOperations.canDelete
  if (!canDelete) return 'unsupported'
  return gridRowDeleteAvailabilityIndex(snapshot, canDelete).get(rowKey) ?? 'blocked'
}

function gridRowDeleteAvailabilityIndex<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
  canDelete: (row: Row) => boolean,
): ReadonlyMap<GridRowKey, GridSupportedRowDeleteAvailability> {
  const cached = gridRowDeleteAvailabilityCache.get(snapshot)
  if (cached) return cached

  const availability = new Map<GridRowKey, GridSupportedRowDeleteAvailability>()
  for (const row of snapshot.draft.rows) {
    const resolvedKey = invokeGridCallback(() => snapshot.getRowKey(row))
    if (!resolvedKey.ok || availability.has(resolvedKey.value)) continue
    const resolvedAvailability = invokeGridCallback(() => canDelete(row))
    availability.set(
      resolvedKey.value,
      resolvedAvailability.ok && resolvedAvailability.value ? 'allowed' : 'blocked',
    )
  }
  gridRowDeleteAvailabilityCache.set(snapshot, availability)
  return availability
}

export function selectGridRowDeletePlan<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
) {
  const columns = snapshot.columns.map((column) => column.key)
  const rowKeys = selectedRowKeys(
    snapshot.interaction.ranges,
    snapshot.view.visibleRowKeys,
    columns,
  )
  const blockedRowKeys = rowKeys.filter((rowKey) =>
    selectGridRowDeleteAvailability(snapshot, rowKey) !== 'allowed',
  )
  return Object.freeze({
    rowKeys,
    rowCount: rowKeys.length,
    eligibleCount: rowKeys.length - blockedRowKeys.length,
    blockedRowKeys: Object.freeze(blockedRowKeys),
    blockedCount: blockedRowKeys.length,
    canDelete: rowKeys.length > 0 && blockedRowKeys.length === 0,
  })
}

function rangeRect<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>, range: GridRange<RowKey>) {
  const rowA = snapshot.view.visibleRowKeys.findIndex((key) => gridRowKeysEqual(key, range.anchor.rowKey))
  const rowB = snapshot.view.visibleRowKeys.findIndex((key) => gridRowKeysEqual(key, range.focus.rowKey))
  const columnA = snapshot.layout.columns.find((column) => column.key === range.anchor.columnKey)
  const columnB = snapshot.layout.columns.find((column) => column.key === range.focus.columnKey)
  if (rowA < 0 || rowB < 0 || !columnA || !columnB) return null
  const first = columnA.index < columnB.index ? columnA : columnB
  const last = columnA.index < columnB.index ? columnB : columnA
  return Object.freeze({
    x: snapshot.layout.rowIndicatorWidth + first.offset - snapshot.layout.scrollLeft,
    y: snapshot.layout.headerHeight + Math.min(rowA, rowB) * snapshot.layout.rowHeight - snapshot.layout.scrollTop,
    width: last.offset + last.width - first.offset,
    height: (Math.abs(rowA - rowB) + 1) * snapshot.layout.rowHeight,
  })
}

function samePoint<RowKey extends GridRowKey>(left: GridPoint<RowKey>, right: GridPoint<RowKey>) {
  return gridRowKeysEqual(left.rowKey, right.rowKey) && left.columnKey === right.columnKey
}

function isDefined<Value>(value: Value | null | undefined): value is Value {
  return value !== null && value !== undefined
}
