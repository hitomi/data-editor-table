import type {
  GridCompiledColumn,
  GridConflict,
  GridDirtyCell,
  GridDraftState,
  GridHistoryEntry,
  GridPoint,
  GridRowKey,
  GridValidationIssue,
  GridValueResult,
} from '../model/grid-model.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import { collectRowValidationIssues, findRowIdentityIssue } from './row-invariants.js'
import {
  cloneGridRow,
  formatGridOriginalValue,
  invokeGridResult,
} from './safe-callback.js'
import {
  areGridResolvedCellValuesEqual,
  resolveGridCellValue,
} from './runtime-cell-resolver.js'
import {
  isGridRowOrderDirty,
  sameGridRowKeyOrder,
} from './row-order.js'

export type GridCellMutation<RowKey extends GridRowKey> = Readonly<{
  cell: GridPoint<RowKey>
  value: unknown
}>

export type GridDraftTransactionIssue<RowKey extends GridRowKey> =
  GridValidationIssue<RowKey> & Readonly<{ code: string }>

export type GridDraftTransactionResult<Row, RowKey extends GridRowKey> =
  | Readonly<{ ok: false; issues: readonly GridDraftTransactionIssue<RowKey>[] }>
  | Readonly<{ ok: true; draft: GridDraftState<Row, RowKey>; changedCells: readonly GridPoint<RowKey>[] }>

export type GridAtomicDraftTransactionResult<Row, RowKey extends GridRowKey> =
  | Readonly<{ ok: false; issues: readonly GridDraftTransactionIssue<RowKey>[] }>
  | Readonly<{
      ok: true
      draft: GridDraftState<Row, RowKey>
      changedCells: readonly GridPoint<RowKey>[]
      createdRowKeys: readonly RowKey[]
      deletedRowKeys: readonly RowKey[]
      movedRowKeys: readonly RowKey[]
    }>

export function applyCellTransaction<Row, RowKey extends GridRowKey>(options: Readonly<{
  draft: GridDraftState<Row, RowKey>
  mutations: readonly GridCellMutation<RowKey>[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  cloneRow?: (row: Row) => Row
  label: string
  transactionId: string
}>): GridDraftTransactionResult<Row, RowKey> {
  const rows = [...options.draft.rows]
  const rowIndexByKey = new Map(rows.map((row, index) => [options.getRowKey(row), index] as const))
  const baselineByKey = new Map(options.draft.baselineRows.map((row) => [options.getRowKey(row), row] as const))
  const columnByKey = new Map(options.columns.map((column) => [column.key, column] as const))
  const issues: GridDraftTransactionIssue<RowKey>[] = []
  const normalized = new Map<string, GridCellMutation<RowKey>>()

  for (const mutation of options.mutations)
    normalized.set(encodeCellIdentity(mutation.cell), mutation)
  for (const mutation of normalized.values()) {
    const rowIndex = rowIndexByKey.get(mutation.cell.rowKey)
    const column = columnByKey.get(mutation.cell.columnKey)
    const row = rowIndex === undefined ? undefined : rows[rowIndex]
    if (rowIndex === undefined || !row || !column) {
      issues.push(issue(mutation.cell, 'unknown-cell', 'The target cell no longer exists.'))
      continue
    }
    if (!column.setValue || !column.isEditable(row)) {
      issues.push(issue(mutation.cell, 'read-only', 'This cell is read-only.'))
      continue
    }
    const typeValidation = invokeGridResult(() =>
      column.behavior.value.validate(mutation.value, {
        row,
        columnKey: column.key,
        typeOptions: column.typeOptions,
      }),
    )
    if (!typeValidation.ok) {
      issues.push(issue(
        mutation.cell,
        typeValidation.issue.code,
        typeValidation.issue.message,
      ))
      continue
    }
    const validation = validateValue(column, typeValidation.value, row)
    if (!validation.ok) {
      issues.push(issue(
        mutation.cell,
        validation.issue.code,
        validation.issue.message,
      ))
      continue
    }
    try {
      const cloned = cloneGridRow(row, options.cloneRow)
      if (!cloned.ok) {
        issues.push(
          issue(
            mutation.cell,
            'row-clone-failed',
            'This row cannot be cloned safely before editing.',
          ),
        )
        continue
      }
      const nextRow = column.setValue(cloned.value, validation.value)
      if (!gridRowKeysEqual(options.getRowKey(nextRow), mutation.cell.rowKey)) {
        issues.push(issue(
          mutation.cell,
          'row-key-changed',
          'A cell setter cannot change its row key.',
        ))
        continue
      }
      rows[rowIndex] = nextRow
    } catch (error) {
      issues.push(issue(
        mutation.cell,
        'setter-exception',
        error instanceof Error ? error.message : String(error),
      ))
    }
  }

  if (issues.length > 0) return Object.freeze({ ok: false, issues: Object.freeze(issues) })
  const identityIssue = findRowIdentityIssue(rows, options.getRowKey)
  if (identityIssue) {
    const first = normalized.values().next().value as GridCellMutation<RowKey> | undefined
    const target = first?.cell ?? {
      rowKey: options.getRowKey(rows[0]!),
      columnKey: options.columns[0]?.key ?? '',
    }
    return Object.freeze({
      ok: false,
      issues: Object.freeze([
        issue(target, 'duplicate-row-key', identityIssue),
      ]),
    })
  }

  const dirty = new Map(
    options.draft.dirtyCells.map(
      (cell) => [encodeCellIdentity(cell), cell] as const,
    ),
  )
  const changedCells: GridPoint<RowKey>[] = []
  const affectedRowKeys = new Set(
    [...normalized.values()].map((mutation) => mutation.cell.rowKey),
  )
  for (const rowKey of affectedRowKeys) {
    const rowIndex = rowIndexByKey.get(rowKey)
    const row = rowIndex === undefined ? undefined : rows[rowIndex]
    const beforeRow = rowIndex === undefined ? undefined : options.draft.rows[rowIndex]
    if (!row || !beforeRow) continue
    for (const column of options.columns) {
      const cell = { rowKey, columnKey: column.key }
      const beforeValue = resolveGridCellValue(beforeRow, column)
      const afterValue = resolveGridCellValue(row, column)
      if (areGridResolvedCellValuesEqual(beforeValue, afterValue)) continue
      changedCells.push(Object.freeze(cell))

      const baselineRow = baselineByKey.get(rowKey)
      const baselineValue = baselineRow
        ? resolveGridCellValue(baselineRow, column)
        : undefined
      const identity = encodeCellIdentity(cell)
      if (
        baselineValue &&
        areGridResolvedCellValuesEqual(afterValue, baselineValue)
      ) {
        dirty.delete(identity)
      } else if (!dirty.has(identity)) {
        const originalValue = baselineValue?.rawValue
        dirty.set(
          identity,
          Object.freeze({
            ...cell,
            originalValue,
            formattedOriginalValue: baselineRow && baselineValue
              ? baselineValue.valid
                ? formatOriginal(column, baselineValue.value, baselineRow)
                : baselineValue.fallbackText
              : '',
          }),
        )
      }
    }
  }

  if (changedCells.length === 0) return Object.freeze({ ok: true, draft: options.draft, changedCells: Object.freeze([]) })
  const frozenRows = Object.freeze(rows)
  const frozenDirty = Object.freeze([...dirty.values()])
  const frozenValidation = collectRowValidationIssues(rows, options.columns, options.getRowKey)
  const priorValidation = new Set(
    options.draft.validationIssues.map(
      (item) => `${encodeCellIdentity(item)}\u0000${item.message}`,
    ),
  )
  const introducedValidation = frozenValidation.filter(
    (item) =>
      !priorValidation.has(`${encodeCellIdentity(item)}\u0000${item.message}`),
  )
  if (introducedValidation.length > 0) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze(introducedValidation.map((item) =>
        issue(item, 'invalid-value', item.message),
      )),
    })
  }
  const revision = options.draft.revision + 1
  const history: GridHistoryEntry<Row, RowKey> = Object.freeze({
    id: options.transactionId,
    label: options.label,
    revision,
    beforeRows: options.draft.rows,
    afterRows: frozenRows,
    beforeDirtyCells: options.draft.dirtyCells,
    afterDirtyCells: frozenDirty,
    beforeInsertedRowKeys: options.draft.insertedRowKeys,
    afterInsertedRowKeys: options.draft.insertedRowKeys,
    beforeDeletedRowKeys: options.draft.deletedRowKeys,
    afterDeletedRowKeys: options.draft.deletedRowKeys,
    beforeOrderDirty: options.draft.orderDirty,
    afterOrderDirty: options.draft.orderDirty,
    beforeConflicts: options.draft.conflicts,
    afterConflicts: options.draft.conflicts,
    beforeValidationIssues: options.draft.validationIssues,
    afterValidationIssues: frozenValidation,
  })
  return Object.freeze({
    ok: true,
    changedCells: Object.freeze(changedCells),
    draft: Object.freeze({
      ...options.draft,
      revision,
      rows: frozenRows,
      dirtyCells: frozenDirty,
      validationIssues: frozenValidation,
      redoStack: Object.freeze([]),
      undoStack: Object.freeze([...options.draft.undoStack, history]),
    }),
  })
}

/**
 * Applies structural row operations and cell writes as one draft transaction.
 * The staged state is used only for validation and mutation planning; callers
 * publish the returned draft once, after their command boundary is rechecked.
 */
export function applyAtomicDraftTransaction<
  Row,
  RowKey extends GridRowKey,
>(options: Readonly<{
  draft: GridDraftState<Row, RowKey>
  createdRows: readonly Row[]
  removedRowKeys?: readonly RowKey[]
  rowOrder?: readonly RowKey[]
  movedRowKeys?: readonly RowKey[]
  mutations: readonly GridCellMutation<RowKey>[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  cloneRow?: (row: Row) => Row
  label: string
  transactionId: string
}>): GridAtomicDraftTransactionResult<Row, RowKey> {
  const createdRowKeys = options.createdRows.map(options.getRowKey)
  const created = new Set(createdRowKeys)
  const allRows = [...options.draft.rows, ...options.createdRows]
  const rowByKey = new Map(
    allRows.map((row) => [options.getRowKey(row), row] as const),
  )
  const allRowKeys = allRows.map(options.getRowKey)
  const identityIssue = findRowIdentityIssue(allRows, options.getRowKey)
  if (identityIssue) {
    const target = options.mutations[0]?.cell ?? {
      rowKey: createdRowKeys[0] ?? options.getRowKey(allRows[0]!),
      columnKey: options.columns[0]?.key ?? '',
    }
    return Object.freeze({
      ok: false,
      issues: Object.freeze([
        issue(target, 'duplicate-row-key', identityIssue),
      ]),
    })
  }

  const removed = new Set(options.removedRowKeys ?? [])
  const unknownRemoved = [...removed].find((rowKey) => !rowByKey.has(rowKey))
  if (unknownRemoved !== undefined) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([issue(
        { rowKey: unknownRemoved, columnKey: options.columns[0]?.key ?? '' },
        'unknown-row',
        'A row selected for deletion no longer exists.',
      )]),
    })
  }
  const expectedRowKeys = allRowKeys.filter((rowKey) => !removed.has(rowKey))
  const finalRowKeys = options.rowOrder
    ? [...options.rowOrder]
    : expectedRowKeys
  if (
    new Set(finalRowKeys).size !== finalRowKeys.length ||
    !sameGridRowKeySet(finalRowKeys, expectedRowKeys)
  ) {
    const rowKey = finalRowKeys.find((key) => !rowByKey.has(key)) ??
      expectedRowKeys[0] ?? allRowKeys[0]!
    return Object.freeze({
      ok: false,
      issues: Object.freeze([issue(
        { rowKey, columnKey: options.columns[0]?.key ?? '' },
        'invalid-row-order',
        'The staged row order must contain every surviving row exactly once.',
      )]),
    })
  }
  const rows = Object.freeze(
    finalRowKeys.map((rowKey) => rowByKey.get(rowKey)!),
  )
  const inserted = new Set(options.draft.insertedRowKeys)
  const deleted = new Set(options.draft.deletedRowKeys)
  const baseline = new Set(options.draft.baselineRows.map(options.getRowKey))
  for (const rowKey of createdRowKeys) {
    if (!removed.has(rowKey)) inserted.add(rowKey)
  }
  for (const rowKey of removed) {
    if (inserted.has(rowKey)) inserted.delete(rowKey)
    else if (baseline.has(rowKey)) deleted.add(rowKey)
  }
  const insertedRowKeys = Object.freeze([...inserted])
  const deletedRowKeys = Object.freeze([...deleted])
  const structuralChanged =
    !sameGridRowKeyOrder(
      options.draft.rows.map(options.getRowKey),
      finalRowKeys,
    ) ||
    !sameGridRowKeySet(options.draft.insertedRowKeys, insertedRowKeys) ||
    !sameGridRowKeySet(options.draft.deletedRowKeys, deletedRowKeys)

  const prepared = structuralChanged
    ? createRowTransaction({
        draft: options.draft,
        rows,
        insertedRowKeys,
        deletedRowKeys,
        columns: options.columns,
        getRowKey: options.getRowKey,
        label: options.label,
        transactionId: options.transactionId,
      })
    : options.draft
  const mutated = applyCellTransaction({
    draft: prepared,
    mutations: options.mutations,
    columns: options.columns,
    getRowKey: options.getRowKey,
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
    label: options.label,
    transactionId: options.transactionId,
  })
  if (!mutated.ok) return mutated

  const priorValidation = new Set(
    options.draft.validationIssues.map(
      (item) => `${encodeCellIdentity(item)}\u0000${item.message}`,
    ),
  )
  const introducedValidation = mutated.draft.validationIssues.filter(
    (item) =>
      !priorValidation.has(`${encodeCellIdentity(item)}\u0000${item.message}`),
  )
  if (introducedValidation.length > 0) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze(introducedValidation.map((item) =>
        issue(item, 'invalid-value', item.message),
      )),
    })
  }

  let draft = mutated.draft
  if (structuralChanged && draft !== prepared) {
    const revision = options.draft.revision + 1
    const finalEntry = draft.undoStack.at(-1)!
    const combined = Object.freeze({
      ...finalEntry,
      id: options.transactionId,
      label: options.label,
      revision,
      beforeRows: options.draft.rows,
      beforeDirtyCells: options.draft.dirtyCells,
      beforeInsertedRowKeys: options.draft.insertedRowKeys,
      beforeDeletedRowKeys: options.draft.deletedRowKeys,
      beforeOrderDirty: options.draft.orderDirty,
      beforeConflicts: options.draft.conflicts,
      beforeValidationIssues: options.draft.validationIssues,
    })
    draft = Object.freeze({
      ...draft,
      revision,
      undoStack: Object.freeze([...options.draft.undoStack, combined]),
    })
  }
  return Object.freeze({
    ok: true,
    draft,
    changedCells: mutated.changedCells,
    createdRowKeys: Object.freeze(
      createdRowKeys.filter((rowKey) => !removed.has(rowKey)),
    ),
    deletedRowKeys: Object.freeze(
      [...removed].filter((rowKey) => !created.has(rowKey)),
    ),
    movedRowKeys: Object.freeze(
      structuralChanged
        ? (options.movedRowKeys ?? []).filter((rowKey) => !removed.has(rowKey))
        : [],
    ),
  })
}

export function restoreHistory<Row, RowKey extends GridRowKey>(
  draft: GridDraftState<Row, RowKey>,
  direction: 'undo' | 'redo',
): GridDraftState<Row, RowKey> | null {
  const source = direction === 'undo' ? draft.undoStack : draft.redoStack
  const entry = source.at(-1)
  if (!entry) return null
  const undoStack = direction === 'undo' ? source.slice(0, -1) : [...draft.undoStack, entry]
  const redoStack = direction === 'undo' ? [...draft.redoStack, entry] : source.slice(0, -1)
  return Object.freeze({
    ...draft,
    revision: draft.revision + 1,
    rows: direction === 'undo' ? entry.beforeRows : entry.afterRows,
    dirtyCells: direction === 'undo' ? entry.beforeDirtyCells : entry.afterDirtyCells,
    insertedRowKeys: direction === 'undo' ? entry.beforeInsertedRowKeys : entry.afterInsertedRowKeys,
    deletedRowKeys: direction === 'undo' ? entry.beforeDeletedRowKeys : entry.afterDeletedRowKeys,
    orderDirty: direction === 'undo' ? entry.beforeOrderDirty : entry.afterOrderDirty,
    conflicts: direction === 'undo' ? entry.beforeConflicts : entry.afterConflicts,
    undoStack: Object.freeze(undoStack),
    redoStack: Object.freeze(redoStack),
    validationIssues: direction === 'undo' ? entry.beforeValidationIssues : entry.afterValidationIssues,
  })
}

export function createRowTransaction<Row, RowKey extends GridRowKey>(options: Readonly<{
  draft: GridDraftState<Row, RowKey>
  rows: readonly Row[]
  insertedRowKeys: readonly RowKey[]
  deletedRowKeys: readonly RowKey[]
  orderDirty?: boolean
  conflicts?: readonly GridConflict<RowKey>[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  label: string
  transactionId: string
}>): GridDraftState<Row, RowKey> {
  const dirty = rebuildDirty(options.draft, options.rows, options.columns, options.getRowKey, options.insertedRowKeys)
  const validationIssues = collectRowValidationIssues(options.rows, options.columns, options.getRowKey)
  const revision = options.draft.revision + 1
  const orderDirty = options.orderDirty ?? isGridRowOrderDirty(
    options.draft.baselineRows,
    options.rows,
    options.getRowKey,
  )
  const history = Object.freeze({
    id: options.transactionId,
    label: options.label,
    revision,
    beforeRows: options.draft.rows,
    afterRows: Object.freeze([...options.rows]),
    beforeDirtyCells: options.draft.dirtyCells,
    afterDirtyCells: dirty,
    beforeInsertedRowKeys: options.draft.insertedRowKeys,
    afterInsertedRowKeys: Object.freeze([...options.insertedRowKeys]),
    beforeDeletedRowKeys: options.draft.deletedRowKeys,
    afterDeletedRowKeys: Object.freeze([...options.deletedRowKeys]),
    beforeOrderDirty: options.draft.orderDirty,
    afterOrderDirty: orderDirty,
    beforeConflicts: options.draft.conflicts,
    afterConflicts: Object.freeze([...(options.conflicts ?? options.draft.conflicts)]),
    beforeValidationIssues: options.draft.validationIssues,
    afterValidationIssues: validationIssues,
  }) satisfies GridHistoryEntry<Row, RowKey>
  return Object.freeze({
    ...options.draft,
    revision,
    rows: history.afterRows,
    dirtyCells: dirty,
    insertedRowKeys: history.afterInsertedRowKeys,
    deletedRowKeys: history.afterDeletedRowKeys,
    orderDirty,
    conflicts: history.afterConflicts,
    undoStack: Object.freeze([...options.draft.undoStack, history]),
    redoStack: Object.freeze([]),
    validationIssues: history.afterValidationIssues,
  })
}

export function describeGridRowsAgainstBaseline<
  Row,
  RowKey extends GridRowKey,
>(options: Readonly<{
  baselineRows: readonly Row[]
  rows: readonly Row[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
}>) {
  const baselineKeys = new Set(options.baselineRows.map(options.getRowKey))
  const rowKeys = new Set(options.rows.map(options.getRowKey))
  const template: GridDraftState<Row, RowKey> = {
    revision: 0,
    baselineVersion: 0,
    baselineRows: options.baselineRows,
    rows: options.baselineRows,
    dirtyCells: [],
    validationIssues: [],
    conflicts: [],
    insertedRowKeys: [],
    deletedRowKeys: [],
    orderDirty: false,
    undoStack: [],
    redoStack: [],
  }
  const insertedRowKeys = options.rows
    .map(options.getRowKey)
    .filter((rowKey) => !baselineKeys.has(rowKey))
  return Object.freeze({
    dirtyCells: rebuildDirty(
      template,
      options.rows,
      options.columns,
      options.getRowKey,
      insertedRowKeys,
    ),
    validationIssues: collectRowValidationIssues(
      options.rows,
      options.columns,
      options.getRowKey,
    ),
    insertedRowKeys: Object.freeze(insertedRowKeys),
    deletedRowKeys: Object.freeze(
      options.baselineRows
        .map(options.getRowKey)
        .filter((rowKey) => !rowKeys.has(rowKey)),
    ),
    orderDirty: isGridRowOrderDirty(
      options.baselineRows,
      options.rows,
      options.getRowKey,
    ),
  })
}

function rebuildDirty<Row, RowKey extends GridRowKey>(
  draft: GridDraftState<Row, RowKey>,
  rows: readonly Row[],
  columns: readonly GridCompiledColumn<Row>[],
  getRowKey: (row: Row) => RowKey,
  insertedRowKeys: readonly RowKey[],
) {
  const baseline = new Map(draft.baselineRows.map((row) => [getRowKey(row), row] as const))
  const inserted = new Set(insertedRowKeys)
  const dirty: GridDirtyCell<RowKey>[] = []
  for (const row of rows) {
    const rowKey = getRowKey(row)
    const original = baseline.get(rowKey)
    for (const column of columns) {
      const value = resolveGridCellValue(row, column)
      const originalValue = original
        ? resolveGridCellValue(original, column)
        : undefined
      if (
        originalValue &&
        areGridResolvedCellValuesEqual(value, originalValue) &&
        !inserted.has(rowKey)
      ) continue
      dirty.push(Object.freeze({
        rowKey,
        columnKey: column.key,
        originalValue: originalValue?.rawValue,
        formattedOriginalValue: original && originalValue
          ? originalValue.valid
            ? formatOriginal(column, originalValue.value, original)
            : originalValue.fallbackText
          : '',
      }))
    }
  }
  return Object.freeze(dirty)
}

function validateValue<Row>(column: GridCompiledColumn<Row>, value: unknown, row: Row): GridValueResult<unknown> {
  return column.validate?.(value, row) ?? Object.freeze({ ok: true, value })
}

function formatOriginal<Row>(column: GridCompiledColumn<Row>, value: unknown, row: Row) {
  return formatGridOriginalValue(column, value, row)
}

function issue<RowKey extends GridRowKey>(
  cell: GridPoint<RowKey>,
  code: string,
  message: string,
): GridDraftTransactionIssue<RowKey> {
  return Object.freeze({ ...cell, code, message })
}

function sameGridRowKeySet<RowKey extends GridRowKey>(
  left: readonly RowKey[],
  right: readonly RowKey[],
) {
  if (left.length !== right.length) return false
  const values = new Set(right)
  return left.every((rowKey) => values.has(rowKey))
}
