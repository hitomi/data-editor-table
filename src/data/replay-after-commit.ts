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

export function replayDraftAfterCommit<Row, RowKey extends GridRowKey>(options: Readonly<{
  current: GridDraftState<Row, RowKey>
  committedRows: readonly Row[]
  committedDraftRevision: number
  publishedRows: readonly Row[]
  publishedVersion: GridSourceVersion
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  cloneRow?: (row: Row) => Row
}>): GridDraftState<Row, RowKey> {
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

function replayHistoryEntryAfterCommit<
  Row,
  RowKey extends GridRowKey,
>(
  entry: GridHistoryEntry<Row, RowKey>,
  options: Readonly<{
    current: GridDraftState<Row, RowKey>
    committedRows: readonly Row[]
    committedDraftRevision: number
    publishedRows: readonly Row[]
    publishedVersion: GridSourceVersion
    columns: readonly GridCompiledColumn<Row>[]
    getRowKey: (row: Row) => RowKey
    cloneRow?: (row: Row) => Row
  }>,
): GridHistoryEntry<Row, RowKey> {
  const replay = entry.revision <= options.committedDraftRevision
    ? replayCommittedHistorySide
    : rebasePostCommitHistorySide
  const before = replay(entry, 'before', options)
  const after = replay(entry, 'after', options)
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
  options: Readonly<{
    current: GridDraftState<Row, RowKey>
    committedRows: readonly Row[]
    committedDraftRevision: number
    publishedRows: readonly Row[]
    publishedVersion: GridSourceVersion
    columns: readonly GridCompiledColumn<Row>[]
    getRowKey: (row: Row) => RowKey
    cloneRow?: (row: Row) => Row
  }>,
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
  options: Readonly<{
    current: GridDraftState<Row, RowKey>
    committedRows: readonly Row[]
    committedDraftRevision: number
    publishedRows: readonly Row[]
    publishedVersion: GridSourceVersion
    columns: readonly GridCompiledColumn<Row>[]
    getRowKey: (row: Row) => RowKey
    cloneRow?: (row: Row) => Row
  }>,
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
}>): readonly Row[] {
  const committed = new Map(
    options.committedRows.map((row) => [options.getRowKey(row), row] as const),
  )
  const intended = new Map(
    options.intendedRows.map((row) => [options.getRowKey(row), row] as const),
  )
  const rows = [...options.appliedRows]

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    const rowKey = options.getRowKey(row)
    if (committed.has(rowKey) && !intended.has(rowKey)) rows.splice(index, 1)
  }

  for (const intendedRow of options.intendedRows) {
    const rowKey = options.getRowKey(intendedRow)
    const committedRow = committed.get(rowKey)
    const appliedIndex = rows.findIndex((row) =>
      gridRowKeysEqual(options.getRowKey(row), rowKey),
    )
    if (appliedIndex < 0) {
      insertRelativeToIntendedOrder(
        rows,
        options.intendedRows,
        intendedRow,
        options.getRowKey,
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
        merged = intendedRow
        break
      }
      const cloned = cloneGridRow(merged, options.cloneRow)
      if (!cloned.ok) {
        merged = intendedRow
        break
      }
      const set = invokeGridCallback(() =>
        column.setValue!(cloned.value, intendedValue.value),
      )
      if (
        !set.ok ||
        !gridRowKeysEqual(options.getRowKey(set.value), rowKey)
      ) {
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
    options.getRowKey,
  )) {
    applyGridRowOrder(rows, options.intendedRows, options.getRowKey)
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
