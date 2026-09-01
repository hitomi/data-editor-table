import type {
  GridCompiledColumn,
  GridDraftState,
  GridHistoryEntry,
  GridRowKey,
  GridSourceVersion,
} from '../model/grid-model.js'
import { rebaseGridDraft } from './rebase-draft.js'
import { describeGridRowsAgainstBaseline } from './draft-transactions.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import {
  cloneGridRow,
  invokeGridCallback,
} from './safe-callback.js'
import {
  areGridResolvedCellValuesEqual,
  resolveGridCellValue,
} from './runtime-cell-resolver.js'
import {
  applyGridRowOrder,
  isGridRowOrderDirty,
} from './row-order.js'
import type { GridRowKeyRemap } from './data-source.js'

type ReplayDraftAfterCommitOptions<Row, RowKey extends GridRowKey> = Readonly<{
  current: GridDraftState<Row, RowKey>
  committedRows: readonly Row[]
  committedDraftRevision: number
  publishedRows: readonly Row[]
  publishedVersion: GridSourceVersion
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  cloneRow?: (row: Row) => Row
  keyRemap?: readonly GridRowKeyRemap<RowKey>[]
}>

export function replayDraftAfterCommit<Row, RowKey extends GridRowKey>(
  options: ReplayDraftAfterCommitOptions<Row, RowKey>,
): GridDraftState<Row, RowKey> {
  if (options.keyRemap?.length) return replayDraftAfterKeyRemap(options)
  const relative = describeGridRowsAgainstBaseline({
    baselineRows: options.committedRows,
    rows: options.current.rows,
    columns: options.columns,
    getRowKey: options.getRowKey,
  })
  const relativeDraft: GridDraftState<Row, RowKey> = Object.freeze({
    ...options.current,
    baselineRows: Object.freeze([...options.committedRows]),
    rows: Object.freeze([...options.current.rows]),
    dirtyCells: relative.dirtyCells,
    insertedRowKeys: relative.insertedRowKeys,
    deletedRowKeys: relative.deletedRowKeys,
    orderDirty: relative.orderDirty,
    validationIssues: relative.validationIssues,
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
  })
  const rebased = rebaseGridDraft({
    draft: relativeDraft,
    remoteRows: options.publishedRows,
    remoteVersion: options.publishedVersion,
    columns: options.columns,
    getRowKey: options.getRowKey,
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
  })
  return Object.freeze({
    ...rebased,
    undoStack: Object.freeze(
      options.current.undoStack.map((entry) =>
        replayHistoryEntryAfterCommit(entry, options),
      ),
    ),
    redoStack: Object.freeze(
      options.current.redoStack.map((entry) =>
        replayHistoryEntryAfterCommit(entry, options),
      ),
    ),
  })
}

function replayDraftAfterKeyRemap<Row, RowKey extends GridRowKey>(
  options: ReplayDraftAfterCommitOptions<Row, RowKey>,
) {
  const rows = replayRowsOntoApplied({
    committedRows: options.committedRows,
    intendedRows: options.current.rows,
    appliedRows: options.publishedRows,
    columns: options.columns,
    getRowKey: options.getRowKey,
    keyRemap: options.keyRemap ?? [],
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
  })
  const rebased = rebaseRowsAgainstApplied({
    revision: options.current.revision,
    rows,
    conflicts: remapConflicts(options.current.conflicts, options.keyRemap ?? []),
    options,
  })
  return Object.freeze({
    ...rebased,
    undoStack: Object.freeze(
      options.current.undoStack.map((entry) =>
        replayHistoryEntryAfterCommit(entry, options),
      ),
    ),
    redoStack: Object.freeze(
      options.current.redoStack.map((entry) =>
        replayHistoryEntryAfterCommit(entry, options),
      ),
    ),
  })
}

function replayHistorySideAfterKeyRemap<Row, RowKey extends GridRowKey>(
  entry: GridHistoryEntry<Row, RowKey>,
  side: 'before' | 'after',
  options: ReplayDraftAfterCommitOptions<Row, RowKey>,
) {
  const prefix = side === 'before' ? 'before' : 'after'
  const rows = replayRowsOntoApplied({
    committedRows: options.committedRows,
    intendedRows: entry[`${prefix}Rows`],
    appliedRows: options.publishedRows,
    columns: options.columns,
    getRowKey: options.getRowKey,
    keyRemap: options.keyRemap ?? [],
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
  })
  return rebaseRowsAgainstApplied({
    revision: entry.revision,
    rows,
    conflicts: remapConflicts(
      entry[`${prefix}Conflicts`],
      options.keyRemap ?? [],
    ),
    options,
  })
}

function rebaseRowsAgainstApplied<Row, RowKey extends GridRowKey>(input: Readonly<{
  revision: number
  rows: readonly Row[]
  conflicts: GridDraftState<Row, RowKey>['conflicts']
  options: ReplayDraftAfterCommitOptions<Row, RowKey>
}>) {
  const relative = describeGridRowsAgainstBaseline({
    baselineRows: input.options.publishedRows,
    rows: input.rows,
    columns: input.options.columns,
    getRowKey: input.options.getRowKey,
  })
  const draft: GridDraftState<Row, RowKey> = Object.freeze({
    revision: input.revision,
    baselineVersion: input.options.publishedVersion,
    baselineRows: Object.freeze([...input.options.publishedRows]),
    rows: input.rows,
    dirtyCells: relative.dirtyCells,
    insertedRowKeys: relative.insertedRowKeys,
    deletedRowKeys: relative.deletedRowKeys,
    orderDirty: relative.orderDirty,
    conflicts: input.conflicts,
    validationIssues: relative.validationIssues,
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
  })
  return rebaseGridDraft({
    draft,
    remoteRows: input.options.publishedRows,
    remoteVersion: input.options.publishedVersion,
    columns: input.options.columns,
    getRowKey: input.options.getRowKey,
    ...(input.options.cloneRow ? { cloneRow: input.options.cloneRow } : {}),
    rebaseHistory: false,
  })
}

function remapConflicts<RowKey extends GridRowKey>(
  conflicts: GridDraftState<unknown, RowKey>['conflicts'],
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  if (remap.length === 0) return conflicts
  return Object.freeze(conflicts.map((conflict) => {
    const rowKey = remapRowKey(conflict.rowKey, remap)
    return gridRowKeysEqual(rowKey, conflict.rowKey)
      ? conflict
      : Object.freeze({ ...conflict, rowKey })
  }))
}

function remapRowKey<RowKey extends GridRowKey>(
  rowKey: RowKey,
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  return remap.find((item) => gridRowKeysEqual(item.from, rowKey))?.to ?? rowKey
}

function replayHistoryEntryAfterCommit<
  Row,
  RowKey extends GridRowKey,
>(
  entry: GridHistoryEntry<Row, RowKey>,
  options: ReplayDraftAfterCommitOptions<Row, RowKey>,
): GridHistoryEntry<Row, RowKey> {
  if (options.keyRemap?.length) {
    const before = replayHistorySideAfterKeyRemap(entry, 'before', options)
    const after = replayHistorySideAfterKeyRemap(entry, 'after', options)
    return replaceHistorySides(entry, before, after)
  }
  const replay = entry.revision <= options.committedDraftRevision
    ? replayCommittedHistorySide
    : rebasePostCommitHistorySide
  const before = replay(entry, 'before', options)
  const after = replay(entry, 'after', options)
  return replaceHistorySides(entry, before, after)
}

function replaceHistorySides<Row, RowKey extends GridRowKey>(
  entry: GridHistoryEntry<Row, RowKey>,
  before: GridDraftState<Row, RowKey>,
  after: GridDraftState<Row, RowKey>,
) {
  return Object.freeze({
    ...entry,
    beforeRows: before.rows,
    afterRows: after.rows,
    beforeDirtyCells: before.dirtyCells,
    afterDirtyCells: after.dirtyCells,
    beforeInsertedRowKeys: before.insertedRowKeys,
    afterInsertedRowKeys: after.insertedRowKeys,
    beforeDeletedRowKeys: before.deletedRowKeys,
    afterDeletedRowKeys: after.deletedRowKeys,
    beforeOrderDirty: before.orderDirty,
    afterOrderDirty: after.orderDirty,
    beforeConflicts: before.conflicts,
    afterConflicts: after.conflicts,
    beforeValidationIssues: before.validationIssues,
    afterValidationIssues: after.validationIssues,
  })
}

function rebasePostCommitHistorySide<Row, RowKey extends GridRowKey>(
  entry: GridHistoryEntry<Row, RowKey>,
  side: 'before' | 'after',
  options: ReplayDraftAfterCommitOptions<Row, RowKey>,
) {
  const prefix = side === 'before' ? 'before' : 'after'
  const rows = entry[`${prefix}Rows`]
  const relative = describeGridRowsAgainstBaseline({
    baselineRows: options.committedRows,
    rows,
    columns: options.columns,
    getRowKey: options.getRowKey,
  })
  const relativeDraft: GridDraftState<Row, RowKey> = Object.freeze({
    revision: entry.revision,
    baselineVersion: options.current.baselineVersion,
    baselineRows: Object.freeze([...options.committedRows]),
    rows: Object.freeze([...rows]),
    dirtyCells: relative.dirtyCells,
    insertedRowKeys: relative.insertedRowKeys,
    deletedRowKeys: relative.deletedRowKeys,
    orderDirty: relative.orderDirty,
    conflicts: entry[`${prefix}Conflicts`],
    validationIssues: relative.validationIssues,
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
  })
  return rebaseGridDraft({
    draft: relativeDraft,
    remoteRows: options.publishedRows,
    remoteVersion: options.publishedVersion,
    columns: options.columns,
    getRowKey: options.getRowKey,
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
    rebaseHistory: false,
  })
}

function replayCommittedHistorySide<Row, RowKey extends GridRowKey>(
  entry: GridHistoryEntry<Row, RowKey>,
  side: 'before' | 'after',
  options: ReplayDraftAfterCommitOptions<Row, RowKey>,
) {
  const prefix = side === 'before' ? 'before' : 'after'
  const intendedRows = entry[`${prefix}Rows`]
  const relative = describeGridRowsAgainstBaseline({
    baselineRows: options.committedRows,
    rows: intendedRows,
    columns: options.columns,
    getRowKey: options.getRowKey,
  })
  const rows = replayRowsOntoApplied({
    committedRows: options.committedRows,
    intendedRows,
    appliedRows: options.publishedRows,
    columns: options.columns,
    getRowKey: options.getRowKey,
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
  })
  const againstApplied = describeGridRowsAgainstBaseline({
    baselineRows: options.publishedRows,
    rows,
    columns: options.columns,
    getRowKey: options.getRowKey,
  })
  const draft: GridDraftState<Row, RowKey> = Object.freeze({
    revision: entry.revision,
    baselineVersion: options.publishedVersion,
    baselineRows: Object.freeze([...options.publishedRows]),
    rows,
    dirtyCells: againstApplied.dirtyCells,
    // Preserve structural intent relative to the proposal. This lets a redo
    // of an insertion detect a key that the authority created in the receipt,
    // while a saved insert can still be undone as a deletion from applied.
    insertedRowKeys: relative.insertedRowKeys,
    deletedRowKeys: relative.deletedRowKeys,
    orderDirty: againstApplied.orderDirty,
    conflicts: entry[`${prefix}Conflicts`],
    validationIssues: againstApplied.validationIssues,
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
  })
  return rebaseGridDraft({
    draft,
    remoteRows: options.publishedRows,
    remoteVersion: options.publishedVersion,
    columns: options.columns,
    getRowKey: options.getRowKey,
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
    rebaseHistory: false,
  })
}

function replayRowsOntoApplied<Row, RowKey extends GridRowKey>(options: Readonly<{
  committedRows: readonly Row[]
  intendedRows: readonly Row[]
  appliedRows: readonly Row[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  cloneRow?: (row: Row) => Row
  keyRemap?: readonly GridRowKeyRemap<RowKey>[]
}>): readonly Row[] {
  const logicalKey = (row: Row) => remapRowKey(
    options.getRowKey(row),
    options.keyRemap ?? [],
  )
  const committed = new Map(
    options.committedRows.map((row) => [logicalKey(row), row] as const),
  )
  const intended = new Map(
    options.intendedRows.map((row) => [logicalKey(row), row] as const),
  )
  const rows = [...options.appliedRows]

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    const rowKey = logicalKey(row)
    if (committed.has(rowKey) && !intended.has(rowKey)) rows.splice(index, 1)
  }

  for (const intendedRow of options.intendedRows) {
    const originalRowKey = options.getRowKey(intendedRow)
    const rowKey = logicalKey(intendedRow)
    const wasRemapped = !gridRowKeysEqual(originalRowKey, rowKey)
    const committedRow = committed.get(rowKey)
    const appliedIndex = rows.findIndex((row) =>
      gridRowKeysEqual(logicalKey(row), rowKey),
    )
    if (appliedIndex < 0) {
      insertRelativeToIntendedOrder(
        rows,
        options.intendedRows,
        intendedRow,
        logicalKey,
      )
      continue
    }
    if (!committedRow) {
      rows[appliedIndex] = intendedRow
      continue
    }
    let merged: Row = rows[appliedIndex] as Row
    for (const column of options.columns) {
      const committedValue = resolveGridCellValue(committedRow, column)
      const intendedValue = resolveGridCellValue(intendedRow, column)
      if (
        areGridResolvedCellValuesEqual(committedValue, intendedValue)
      ) continue
      if (!intendedValue.valid || !column.setValue) {
        if (wasRemapped) {
          throw new Error(
            `Local changes could not be replayed onto server row key "${String(rowKey)}".`,
          )
        }
        merged = intendedRow
        break
      }
      const cloned = cloneGridRow(merged, options.cloneRow)
      if (!cloned.ok) {
        if (wasRemapped) throw new Error(cloned.message)
        merged = intendedRow
        break
      }
      const set = invokeGridCallback(() =>
        column.setValue!(cloned.value, intendedValue.value),
      )
      if (
        !set.ok ||
        !gridRowKeysEqual(logicalKey(set.value), rowKey)
      ) {
        if (wasRemapped) {
          throw new Error(
            `A cell setter changed server row key "${String(rowKey)}" while replaying local changes.`,
          )
        }
        merged = intendedRow
        break
      }
      merged = set.value
    }
    rows[appliedIndex] = merged
  }
  if (isGridRowOrderDirty(
    options.committedRows,
    options.intendedRows,
    logicalKey,
  )) {
    applyGridRowOrder(rows, options.intendedRows, logicalKey)
  }
  return Object.freeze(rows)
}

function insertRelativeToIntendedOrder<Row, RowKey extends GridRowKey>(
  rows: Row[],
  intendedRows: readonly Row[],
  row: Row,
  getRowKey: (row: Row) => RowKey,
) {
  const rowKey = getRowKey(row)
  const intendedIndex = intendedRows.findIndex((candidate) =>
    gridRowKeysEqual(getRowKey(candidate), rowKey),
  )
  const next = intendedRows.slice(intendedIndex + 1).find((candidate) =>
    rows.some((existing) =>
      gridRowKeysEqual(getRowKey(existing), getRowKey(candidate)),
    ),
  )
  if (!next) rows.push(row)
  else {
    const nextIndex = rows.findIndex((candidate) =>
      gridRowKeysEqual(getRowKey(candidate), getRowKey(next)),
    )
    rows.splice(nextIndex, 0, row)
  }
}
