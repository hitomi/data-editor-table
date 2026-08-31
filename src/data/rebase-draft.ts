import type {
  GridCompiledColumn,
  GridConflict,
  GridDirtyCell,
  GridDraftState,
  GridHistoryEntry,
  GridRowKey,
} from '../model/grid-model.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import { collectRowValidationIssues } from './row-invariants.js'
import {
  cloneGridRow,
  formatGridOriginalValue,
  invokeGridCallback,
  invokeGridResult,
} from './safe-callback.js'
import {
  areGridResolvedCellValuesEqual,
  resolveGridCellValue,
} from './runtime-cell-resolver.js'
import {
  applyGridRowOrder,
  isGridRowOrderDirty,
} from './row-order.js'

export function rebaseGridDraft<Row, RowKey extends GridRowKey>(
  options: Readonly<{
    draft: GridDraftState<Row, RowKey>
    remoteRows: readonly Row[]
    remoteVersion: string | number
    columns: readonly GridCompiledColumn<Row>[]
    getRowKey: (row: Row) => RowKey
    cloneRow?: (row: Row) => Row
    rebaseHistory?: boolean
  }>,
): GridDraftState<Row, RowKey> {
  const oldBaseline = new Map(
    options.draft.baselineRows.map(
      (row) => [options.getRowKey(row), row] as const,
    ),
  )
  const local = new Map(
    options.draft.rows.map((row) => [options.getRowKey(row), row] as const),
  )
  const remote = new Map(
    options.remoteRows.map((row) => [options.getRowKey(row), row] as const),
  )
  const dirtyByCell = new Map(
    options.draft.dirtyCells.map(
      (cell) => [encodeCellIdentity(cell), cell] as const,
    ),
  )
  const priorConflictByCell = new Map(
    options.draft.conflicts
      .filter((conflict) => conflict.columnKey !== null)
      .map(
        (conflict) =>
          [
            encodeCellIdentity({
              rowKey: conflict.rowKey,
              columnKey: conflict.columnKey!,
            }),
            conflict,
          ] as const,
      ),
  )
  const priorRowConflicts = new Map(
    options.draft.conflicts
      .filter((conflict) => conflict.columnKey === null)
      .map((conflict) => [conflict.rowKey, conflict] as const),
  )
  const inserted = new Set(options.draft.insertedRowKeys)
  const deleted = new Set(options.draft.deletedRowKeys)
  const conflicts: GridConflict<RowKey>[] = []
  const nextRows: Row[] = []
  const nextDirty: GridDirtyCell<RowKey>[] = []
  const retainedInserted = new Set<RowKey>()

  for (const remoteRow of options.remoteRows) {
    const rowKey = options.getRowKey(remoteRow)
    const oldRow = oldBaseline.get(rowKey)
    const localRow = local.get(rowKey)
    if (deleted.has(rowKey)) {
      const prior = priorRowConflicts.get(rowKey)
      if (prior) {
        conflicts.push(Object.freeze({ ...prior, remoteValue: remoteRow }))
        nextRows.push(remoteRow)
        continue
      }
      if (oldRow && rowEqual(oldRow, remoteRow, options.columns)) continue
      conflicts.push(
        Object.freeze({
          kind: 'local-row-deleted-remote-changed',
          rowKey,
          columnKey: null,
          message: 'This row changed remotely while it was deleted locally.',
        }),
      )
      nextRows.push(remoteRow)
      continue
    }
    if (inserted.has(rowKey) && localRow) {
      if (rowEqual(localRow, remoteRow, options.columns)) {
        nextRows.push(remoteRow)
        continue
      }
      conflicts.push(
        Object.freeze({
          kind: 'inserted-key-collision',
          rowKey,
          columnKey: null,
          message: 'A remote row now uses the key of a row inserted locally.',
          localValue: localRow,
          remoteValue: remoteRow,
        }),
      )
      nextRows.push(localRow)
      retainedInserted.add(rowKey)
      addRowDirtyCells(nextDirty, rowKey, remoteRow, options.columns)
      continue
    }
    if (!localRow || !oldRow) {
      nextRows.push(remoteRow)
      continue
    }

    let merged = remoteRow
    for (const column of options.columns) {
      const cellIdentity = encodeCellIdentity({ rowKey, columnKey: column.key })
      const dirty = dirtyByCell.get(cellIdentity)
      if (!dirty) continue
      const local = resolveGridCellValue(localRow, column)
      const remote = resolveGridCellValue(remoteRow, column)
      const localValue = local.rawValue
      const remoteValue = remote.rawValue
      if (areGridResolvedCellValuesEqual(local, remote)) continue
      const prior = priorConflictByCell.get(cellIdentity)
      const original = invokeGridResult(() =>
        column.behavior.value.validate(dirty.originalValue, {
          row: remoteRow,
          columnKey: column.key,
          typeOptions: column.typeOptions,
        }),
      )
      if (
        prior ||
        !remote.valid ||
        !original.ok ||
        !columnValuesEqual(column, remote.value, original.value)
      ) {
        conflicts.push(
          Object.freeze({
            kind: 'field',
            rowKey,
            columnKey: column.key,
            message: 'This cell changed both locally and remotely.',
            localValue,
            remoteValue,
          }),
        )
      }
      if (!local.valid) {
        conflicts.push(
          Object.freeze({
            kind: 'field',
            rowKey,
            columnKey: column.key,
            message: local.issue.message,
            localValue,
            remoteValue,
          }),
        )
        merged = localRow
      } else if (column.setValue) {
        const cloned = cloneGridRow(merged, options.cloneRow)
        if (!cloned.ok) {
          conflicts.push(
            Object.freeze({
              kind: 'field',
              rowKey,
              columnKey: column.key,
              message: 'This row could not be cloned safely during refresh.',
              localValue,
              remoteValue,
            }),
          )
        } else {
          const set = invokeGridCallback(() =>
            column.setValue!(cloned.value, local.value),
          )
          if (!set.ok) {
            conflicts.push(
              Object.freeze({
                kind: 'field',
                rowKey,
                columnKey: column.key,
                message: set.message,
                localValue,
                remoteValue,
              }),
            )
          } else if (!gridRowKeysEqual(options.getRowKey(set.value), rowKey)) {
            conflicts.push(
              Object.freeze({
                kind: 'field',
                rowKey,
                columnKey: column.key,
                message: 'A cell setter cannot change its row key.',
                localValue,
                remoteValue,
              }),
            )
          } else {
            merged = set.value
          }
        }
      }
      nextDirty.push(
        Object.freeze({
          rowKey,
          columnKey: column.key,
          originalValue: remoteValue,
          formattedOriginalValue: remote.valid
            ? formatOriginal(column, remote.value, remoteRow)
            : remote.fallbackText,
        }),
      )
    }
    nextRows.push(merged)
  }

  for (const localRow of options.draft.rows) {
    const rowKey = options.getRowKey(localRow)
    if (remote.has(rowKey)) continue
    const priorRowConflict = priorRowConflicts.get(rowKey)
    if (priorRowConflict) {
      conflicts.push(Object.freeze({ ...priorRowConflict, localValue: localRow }))
      nextRows.push(localRow)
      addRowDirtyCells(nextDirty, rowKey, undefined, options.columns)
      continue
    }
    if (inserted.has(rowKey)) {
      nextRows.push(localRow)
      retainedInserted.add(rowKey)
      addRowDirtyCells(nextDirty, rowKey, undefined, options.columns)
      continue
    }
    if (
      oldBaseline.has(rowKey) &&
      options.draft.dirtyCells.some((cell) =>
        gridRowKeysEqual(cell.rowKey, rowKey),
      )
    ) {
      conflicts.push(
        Object.freeze({
          kind: 'remote-row-deleted',
          rowKey,
          columnKey: null,
          message: 'This row was deleted remotely while it had local edits.',
          localValue: localRow,
        }),
      )
      nextRows.push(localRow)
      addRowDirtyCells(nextDirty, rowKey, undefined, options.columns)
    }
  }

  if (options.draft.orderDirty) {
    // Row order is one local structural intent. Reapply the local relative
    // order to all surviving known rows; remote-only rows retain their slots.
    applyGridRowOrder(nextRows, options.draft.rows, options.getRowKey)
  }

  const rebased = Object.freeze({
    ...options.draft,
    revision: options.draft.revision + 1,
    baselineVersion: options.remoteVersion,
    baselineRows: Object.freeze([...options.remoteRows]),
    rows: Object.freeze(nextRows),
    dirtyCells: Object.freeze(nextDirty),
    conflicts: Object.freeze(conflicts),
    validationIssues: collectRowValidationIssues(nextRows, options.columns, options.getRowKey),
    insertedRowKeys: Object.freeze([...retainedInserted]),
    deletedRowKeys: Object.freeze(
      [...deleted].filter((rowKey) => remote.has(rowKey)),
    ),
    orderDirty: isGridRowOrderDirty(
      options.remoteRows,
      nextRows,
      options.getRowKey,
    ),
    undoStack: Object.freeze([]) as readonly GridHistoryEntry<Row, RowKey>[],
    redoStack: Object.freeze([]) as readonly GridHistoryEntry<Row, RowKey>[],
  })
  if (options.rebaseHistory === false) return rebased
  return Object.freeze({
    ...rebased,
    undoStack: Object.freeze(
      options.draft.undoStack.map((entry) =>
        rebaseGridHistoryEntry(entry, options),
      ),
    ),
    redoStack: Object.freeze(
      options.draft.redoStack.map((entry) =>
        rebaseGridHistoryEntry(entry, options),
      ),
    ),
  })
}

export function rebaseGridHistoryEntry<Row, RowKey extends GridRowKey>(
  entry: GridHistoryEntry<Row, RowKey>,
  options: Readonly<{
    draft: GridDraftState<Row, RowKey>
    remoteRows: readonly Row[]
    remoteVersion: string | number
    columns: readonly GridCompiledColumn<Row>[]
    getRowKey: (row: Row) => RowKey
    cloneRow?: (row: Row) => Row
  }>,
): GridHistoryEntry<Row, RowKey> {
  // A history side is a complete draft state, not merely the delta introduced
  // by this one entry. Rebasing each side independently preserves edits from
  // earlier transactions and keeps rows and all derived metadata coherent.
  const before = rebaseHistorySide(entry, 'before', options)
  const after = rebaseHistorySide(entry, 'after', options)
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

function rebaseHistorySide<Row, RowKey extends GridRowKey>(
  entry: GridHistoryEntry<Row, RowKey>,
  side: 'before' | 'after',
  options: Readonly<{
    draft: GridDraftState<Row, RowKey>
    remoteRows: readonly Row[]
    remoteVersion: string | number
    columns: readonly GridCompiledColumn<Row>[]
    getRowKey: (row: Row) => RowKey
    cloneRow?: (row: Row) => Row
  }>,
) {
  const prefix = side === 'before' ? 'before' : 'after'
  const draft: GridDraftState<Row, RowKey> = Object.freeze({
    revision: entry.revision,
    baselineVersion: options.draft.baselineVersion,
    baselineRows: options.draft.baselineRows,
    rows: entry[`${prefix}Rows`],
    dirtyCells: entry[`${prefix}DirtyCells`],
    insertedRowKeys: entry[`${prefix}InsertedRowKeys`],
    deletedRowKeys: entry[`${prefix}DeletedRowKeys`],
    orderDirty: entry[`${prefix}OrderDirty`],
    conflicts: entry[`${prefix}Conflicts`],
    validationIssues: entry[`${prefix}ValidationIssues`],
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
  })
  return rebaseGridDraft({
    draft,
    remoteRows: options.remoteRows,
    remoteVersion: options.remoteVersion,
    columns: options.columns,
    getRowKey: options.getRowKey,
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
    rebaseHistory: false,
  })
}

function addRowDirtyCells<Row, RowKey extends GridRowKey>(
  target: GridDirtyCell<RowKey>[],
  rowKey: RowKey,
  remoteRow: Row | undefined,
  columns: readonly GridCompiledColumn<Row>[],
) {
  for (const column of columns) {
    const resolved = remoteRow
      ? resolveGridCellValue(remoteRow, column)
      : undefined
    const originalValue = resolved?.rawValue
    target.push(
      Object.freeze({
        rowKey,
        columnKey: column.key,
        originalValue,
        formattedOriginalValue:
          remoteRow === undefined
            ? ''
            : resolved?.valid
              ? formatOriginal(column, resolved.value, remoteRow)
              : resolved?.fallbackText ?? '',
      }),
    )
  }
}

function rowEqual<Row>(
  left: Row,
  right: Row,
  columns: readonly GridCompiledColumn<Row>[],
) {
  return columns.every((column) =>
    areGridResolvedCellValuesEqual(
      resolveGridCellValue(left, column),
      resolveGridCellValue(right, column),
    ),
  )
}

function columnValuesEqual<Row>(
  column: GridCompiledColumn<Row>,
  left: unknown,
  right: unknown,
) {
  const equals = column.behavior.equals
  if (!equals) return Object.is(left, right)
  const result = invokeGridCallback(() =>
    equals(left, right, {
      columnKey: column.key,
      typeOptions: column.typeOptions,
    }),
  )
  return result.ok ? result.value : Object.is(left, right)
}

function formatOriginal<Row>(
  column: GridCompiledColumn<Row>,
  value: unknown,
  row: Row,
) {
  return formatGridOriginalValue(column, value, row)
}
