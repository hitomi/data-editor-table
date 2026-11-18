import type { GridControllerSnapshot, GridPoint, GridRange, GridRowKey, GridSaveTarget } from '../model/grid-model.js'
import type { GridCommandTarget } from './controller-contracts.js'
import type { GridIssue } from '../model/grid-result.js'
import { decideGridSessionExit } from './session-policy.js'
import { isGridCellSelected, selectedRowKeys } from './selection-model.js'
import { selectedCells } from '../model/range-geometry.js'
import { invokeGridCallback } from '../data/safe-callback.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import {
  accessibleGridCellValue,
  displayGridCellValue,
  resolveGridCellValue,
} from '../data/runtime-cell-resolver.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import { gridSelectorIndex } from './grid-selector-index.js'

export function selectGridCell<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>, point: GridPoint<RowKey>) {
  const index = gridSelectorIndex(snapshot)
  const identity = encodeCellIdentity(point)
  const column = index.columns.get(point.columnKey)
  const entityId = snapshot.draft.entityAt(point.rowKey)
  if (!entityId || !index.rows.has(point.rowKey) || !column) return null
  const row = index.rows.get(point.rowKey) as Row
  const dirty = index.dirtyCells.get(identity) ?? null
  const resolved = resolveGridCellValue(row, column)
  const displayed = displayGridCellValue(resolved)
  const accessible = accessibleGridCellValue(resolved)
  const selected = isGridCellSelected(snapshot, point.rowKey, point.columnKey)
  return Object.freeze({
    entityId, row,
    column,
    resolved,
    valid: resolved.valid,
    value: resolved.valid ? resolved.value : undefined,
    displayText: displayed.ok
      ? displayed.value
      : resolved.valid
        ? 'Invalid value'
        : resolved.fallbackText,
    accessibleText: accessible.ok
      ? accessible.value
      : column.label,
    editable: resolved.valid && column.isEditable(row),
    active: snapshot.interaction.activeCell ? samePoint(snapshot.interaction.activeCell, point) : false,
    selected,
    dirty,
    dirtyOriginalAvailable: dirty !== null
      && !index.insertedRowKeys.has(point.rowKey),
    validation: index.validationIssues.get(identity) ?? (resolved.valid ? null : Object.freeze({ rowKey: point.rowKey, columnKey: point.columnKey, message: resolved.issue.message })),
    conflict: index.cellConflicts.get(identity) ?? null,
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

export type GridActionAvailability<Target> = Readonly<{ target: Target; enabled: boolean; issue: GridIssue | null }>

function availability<Target>(target: Target, issue: GridIssue | null): GridActionAvailability<Target> {
  return Object.freeze({ target, enabled: !issue, issue: issue && Object.freeze(issue) })
}

export function gridTargetIssue<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>,
  target?: GridCommandTarget<RowKey> | GridSaveTarget<RowKey>): GridIssue | null {
  if (!target) return null
  const current = target.kind === 'row' ? snapshot.draft.entityAt(target.rowKey) === target.entityId
    : target.kind === 'save' ? snapshot.persistence.workspaceId === target.workspaceId && snapshot.persistence.generation === target.generation
      && (snapshot.edit?.id ?? null) === target.editId && !gridTargetIssue(snapshot, target.origin)
    : target.kind === 'filter' ? snapshot.filterSession?.id === target.id : snapshot[target.kind]?.id === target.id
  return current ? null : { code: 'stale-target', message: 'The original operation target is no longer current.' }
}

/** Commands recheck these public decisions against the publication on which they execute. */
export function selectGridActions<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>,
  target?: GridCommandTarget<RowKey> | GridSaveTarget<RowKey>) {
  const p = snapshot.persistence, plan = snapshot.draft.savePlan
  const scopeIssue = p.dispute ? { code: 'save-unresolved' as const, message: p.dispute.message } : null
  const startIssue: GridIssue | null = scopeIssue ?? (p.canStartSave ? null : p.status === 'saving'
    ? { code: 'save-in-progress', message: 'The original save is still being processed.' }
    : { code: 'save-unresolved', message: p.error ?? 'A previous save is still awaiting confirmation.' })
  const explicit = snapshot.edit && snapshot.columns.find(c => c.key === snapshot.edit!.cell.columnKey)?.behavior.edit?.exit === 'explicit'
  const session = decideGridSessionExit(snapshot, 'saving changes', !!explicit)
  const stale = gridTargetIssue(snapshot, target)
  const saveIssue: GridIssue | null = stale ?? startIssue ?? (session.kind === 'blocked' ? { code: 'session-open', message: session.reason }
    : plan.canSave || snapshot.edit ? null : plan.excluded[0] ?? { code: 'no-changes', message: 'There are no changes to save.' })
  const origin = target?.kind === 'save' ? target.origin : target
  const saveTarget: GridSaveTarget<RowKey> = Object.freeze({
    ...(target?.kind === 'save' ? target : { kind: 'save' as const, workspaceId: p.workspaceId, generation: p.generation, editId: snapshot.edit?.id ?? null }),
    ...(origin ? { origin: Object.freeze({ ...origin }) } : {}),
  })
  const noRecovery: GridIssue = { code: 'no-recovery', message: 'There is no save to recover.' }
  return Object.freeze({
    target: availability(target ?? null, stale),
    save: availability(saveTarget, saveIssue),
    retrySave: availability(saveTarget, saveIssue ?? (p.canRetrySave ? null : noRecovery)),
    recoverSave: availability(stale ? null : p.recovery, stale ?? (p.recovery ? null : startIssue ?? noRecovery)),
  })
}

export function selectGridToolbar<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  const deletePlan = selectGridRowDeletePlan(snapshot)
  const duplicatePlan = selectGridRowDuplicatePlan(snapshot)
  return Object.freeze({
    canUndo: snapshot.draft.undoStack.length > 0,
    canRedo: snapshot.draft.redoStack.length > 0,
    canAdd: snapshot.rowOperations.canAdd,
    canDuplicate: duplicatePlan.canDuplicate,
    canDelete: deletePlan.canDelete,
    canSave: selectGridActions(snapshot).save.enabled,
    saving: snapshot.persistence.status === 'saving',
  })
}

export function selectGridSavePlan<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
) {
  return snapshot.draft.savePlan
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
    canDuplicate: snapshot.rowOperations.canDuplicate && rowKeys.length > 0
      && !rowKeys.some(key => snapshot.draft.deletedRowKeys.includes(key)),
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
  const deleted = new Set(snapshot.draft.deletedRowKeys)
  for (const row of snapshot.draft.rows) {
    const resolvedKey = invokeGridCallback(() => snapshot.getRowKey(row))
    if (!resolvedKey.ok || availability.has(resolvedKey.value)) continue
    const resolvedAvailability = invokeGridCallback(() => canDelete(row))
    availability.set(
      resolvedKey.value,
      !deleted.has(resolvedKey.value) && resolvedAvailability.ok && resolvedAvailability.value ? 'allowed' : 'blocked',
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
