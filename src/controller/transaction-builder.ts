import type { GridCellTypeSchema, GridColumnForCellTypes } from '../cell-types/contracts.js'
import type { GridRowCapabilities } from '../data/data-source.js'
import type { GridCellMutation } from '../data/command-planner.js'
import { sameGridRowKeyOrder } from '../data/row-order.js'
import { cloneGridRow, invokeGridCallback } from '../data/safe-callback.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import type { GridControllerSnapshot, GridPoint, GridRowKey } from '../model/grid-model.js'
import type { GridIssueCode } from '../model/grid-result.js'
import type { GridTransactionBuilder, GridTransactionIssue, GridTransactionRowPosition } from './controller-contracts.js'

export type GridLocalTransactionPlan<Row, RowKey extends GridRowKey> = Readonly<{
  createdRows: readonly Row[]
  removedRowKeys: readonly RowKey[]
  movedRowKeys: readonly RowKey[]
  rowOrder?: readonly RowKey[]
  mutations: readonly GridCellMutation<RowKey>[]
}>

type GridTransactionPlanResult<Row, RowKey extends GridRowKey> =
  | Readonly<{ ok: true; plan: GridLocalTransactionPlan<Row, RowKey> }>
  | Readonly<{ ok: false; issue: GridTransactionIssue<RowKey> }>

/** Runs the synchronous public builder once, without publishing state or history. */
export function buildGridTransaction<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema>({
  base, commandRows, build, getRowKey, cloneRow, rows, configuredColumns, maxMutations,
}: Readonly<{
  base: GridControllerSnapshot<Row, RowKey>
  /** Logical command membership/order from the kernel, excluding review-only deletions. */
  commandRows: Readonly<{ keys: readonly RowKey[]; read: (key: RowKey) => Row }>
  build: GridTransactionBuilder<Row, RowKey, Schema>
  getRowKey: (row: Row) => RowKey
  cloneRow?: (row: Row) => Row
  rows?: GridRowCapabilities<Row>
  configuredColumns: ReadonlySet<object>
  maxMutations: number
}>): GridTransactionPlanResult<Row, RowKey> {
  const reject = (issue: GridTransactionIssue<RowKey>): GridTransactionPlanResult<Row, RowKey> =>
    Object.freeze({ ok: false, issue })
  const createdRows: Row[] = []
  const mutations: GridCellMutation<RowKey>[] = []
  const targets = new Set<string>()
  const removedRowKeys = new Set<RowKey>()
  const movedRowKeys = new Set<RowKey>()
  const reservedKeys = new Set<RowKey>([
    ...base.draft.baselineRows.map(getRowKey),
    ...base.draft.rows.map(getRowKey),
  ])
  const initialRowKeys = commandRows.keys
  const targetKeys = new Set(initialRowKeys)
  const stagedRowKeys = [...initialRowKeys]
  const createdInTransaction = new Map<RowKey, Row>()
  const abortToken = Object.freeze({})
  let transactionOpen = true,
    operationCost = 0
  const abort = (issue: GridTransactionIssue<RowKey> | string): never => {
    throw Object.freeze({
      token: abortToken,
      issue: typeof issue === 'string'
        ? createGridTransactionIssue<RowKey>('aborted', issue)
        : freezeTransactionIssue(issue),
    })
  }
  const assertOpen = () => {
    if (!transactionOpen) {
      abort(createGridTransactionIssue(
        'transaction-closed',
        'The transaction builder is no longer active.',
      ))
    }
  }
  const reserveMutation = (count = 1) => {
    assertOpen()
    const issue = operationCost + count > maxMutations ? 'This operation exceeds the mutation limit.' : null
    if (issue) abort(createGridTransactionIssue('mutation-limit', issue))
    operationCost += count
  }
  const positionBefore = (
    position: GridTransactionRowPosition<RowKey> | undefined,
  ) => {
    const beforeRowKey = position?.beforeRowKey ?? null
    if (beforeRowKey !== null) {
      if (rows?.ordering !== 'mutable') {
        abort(createGridTransactionIssue(
          'row-order-unavailable',
          'This data source does not allow row ordering.',
        ))
      }
      if (!targetKeys.has(beforeRowKey)) {
        abort(createGridTransactionIssue(
          'unknown-row',
          'The row-order anchor does not exist.',
        ))
      }
    }
    return beforeRowKey
  }
  const stageCreatedRow = (
    create: () => Row,
    failureCode: string,
    position: GridTransactionRowPosition<RowKey> | undefined,
  ) => {
    const beforeRowKey = positionBefore(position)
    reserveMutation()
    const created = invokeGridCallback(create)
    if (!created.ok) {
      return abort(createGridTransactionIssue(failureCode, created.message))
    }
    const keyed = invokeGridCallback(() => ({
      row: created.value,
      key: getRowKey(created.value),
    }))
    if (!keyed.ok) {
      return abort(createGridTransactionIssue('invalid-row-key', keyed.message))
    }
    if (reservedKeys.has(keyed.value.key)) {
      return abort(createGridTransactionIssue(
        'duplicate-row-key',
        'A created row must have a unique key.',
      ))
    }
    reservedKeys.add(keyed.value.key)
    targetKeys.add(keyed.value.key)
    createdInTransaction.set(keyed.value.key, keyed.value.row)
    createdRows.push(keyed.value.row)
    const insertion = beforeRowKey === null
      ? stagedRowKeys.length
      : stagedRowKeys.findIndex((rowKey) =>
          gridRowKeysEqual(rowKey, beforeRowKey),
        )
    stagedRowKeys.splice(insertion, 0, keyed.value.key)
    return keyed.value.key
  }
  const assertUniqueRowTargets = (rowKeys: readonly RowKey[]) => {
    const unique = new Set(rowKeys)
    if (unique.size !== rowKeys.length) {
      abort(createGridTransactionIssue(
        'duplicate-row-target',
        'A row operation cannot contain the same row more than once.',
      ))
    }
    for (const rowKey of rowKeys) {
      if (!targetKeys.has(rowKey)) {
        abort(createGridTransactionIssue(
          'unknown-row',
          'A row operation target does not exist.',
        ))
      }
    }
    return unique
  }
  const rowHasMutation = (rowKey: RowKey) => mutations.some((mutation) =>
    gridRowKeysEqual(mutation.cell.rowKey, rowKey),
  )
  const transaction = Object.freeze({
    base,
    createRow: (position?: GridTransactionRowPosition<RowKey>) => {
      assertOpen()
      const create = rows?.create
      if (!create) {
        return abort(createGridTransactionIssue(
          'row-create-unavailable',
          'Creating rows is unavailable.',
        ))
      }
      return stageCreatedRow(create, 'row-create-failed', position)
    },
    duplicateRow: (
      sourceRowKey: RowKey,
      position?: GridTransactionRowPosition<RowKey>,
    ) => {
      assertOpen()
      const duplicate = rows?.duplicate
      if (!duplicate) {
        return abort(createGridTransactionIssue(
          'row-duplicate-unavailable',
          'Duplicating rows is unavailable.',
        ))
      }
      if (!targetKeys.has(sourceRowKey)) {
        return abort(createGridTransactionIssue(
          'unknown-row',
          'The row selected for duplication does not exist.',
        ))
      }
      if (rowHasMutation(sourceRowKey)) {
        return abort(createGridTransactionIssue(
          'duplicate-after-set',
          'Duplicate a row before staging cell changes to that source row.',
        ))
      }
      const row = createdInTransaction.has(sourceRowKey) ? createdInTransaction.get(sourceRowKey)! : commandRows.read(sourceRowKey)
      const cloned = cloneGridRow(row, cloneRow)
      if (!cloned.ok) {
        return abort(createGridTransactionIssue('row-clone-failed', cloned.message))
      }
      return stageCreatedRow(
        () => duplicate(cloned.value),
        'row-duplicate-failed',
        position,
      )
    },
    moveRows: (
      requestedRowKeys: readonly RowKey[],
      position?: GridTransactionRowPosition<RowKey>,
    ) => {
      assertOpen()
      const rowKeys = [...requestedRowKeys]
      const chosen = assertUniqueRowTargets(rowKeys)
      if (rowKeys.length === 0) return
      if (rows?.ordering !== 'mutable') {
        abort(createGridTransactionIssue(
          'row-order-unavailable',
          'This data source does not allow row ordering.',
        ))
      }
      const beforeRowKey = positionBefore(position)
      if (beforeRowKey !== null && chosen.has(beforeRowKey)) return
      const moving = stagedRowKeys.filter((rowKey) => chosen.has(rowKey))
      const remaining = stagedRowKeys.filter((rowKey) => !chosen.has(rowKey))
      const insertion = beforeRowKey === null
        ? remaining.length
        : remaining.findIndex((rowKey) =>
            gridRowKeysEqual(rowKey, beforeRowKey),
          )
      const next = [
        ...remaining.slice(0, insertion),
        ...moving,
        ...remaining.slice(insertion),
      ]
      if (sameGridRowKeyOrder(stagedRowKeys, next)) return
      reserveMutation(moving.length)
      stagedRowKeys.splice(0, stagedRowKeys.length, ...next)
      moving.forEach((rowKey) => movedRowKeys.add(rowKey))
    },
    deleteRows: (requestedRowKeys: readonly RowKey[]) => {
      assertOpen()
      const rowKeys = [...requestedRowKeys]
      assertUniqueRowTargets(rowKeys)
      if (rowKeys.length === 0) return
      reserveMutation(rowKeys.length)
      const canDelete = rows?.canDelete
      for (const rowKey of rowKeys) {
        if (rowHasMutation(rowKey)) {
          abort(createGridTransactionIssue(
            'delete-after-set',
            'Delete a row before staging cell changes to that row.',
          ))
        }
        if (createdInTransaction.has(rowKey)) continue
        if (!canDelete) {
          return abort(createGridTransactionIssue(
            'row-delete-unavailable',
            'Deleting rows is unavailable.',
          ))
        }
        const cloned = cloneGridRow(
          commandRows.read(rowKey),
          cloneRow,
        )
        if (!cloned.ok) {
          return abort(createGridTransactionIssue('row-clone-failed', cloned.message))
        }
        const eligible = invokeGridCallback(() => canDelete(cloned.value))
        if (!eligible.ok) {
          return abort(createGridTransactionIssue(
            'row-delete-check-failed',
            eligible.message,
          ))
        }
        if (!eligible.value) {
          return abort(createGridTransactionIssue(
            'row-delete-blocked',
            'A row is not eligible for deletion.',
          ))
        }
      }
      rowKeys.forEach((rowKey) => {
        targetKeys.delete(rowKey)
        removedRowKeys.add(rowKey)
        const index = stagedRowKeys.findIndex((candidate) =>
          gridRowKeysEqual(candidate, rowKey),
        )
        if (index >= 0) stagedRowKeys.splice(index, 1)
      })
    },
    set: (
      column: GridColumnForCellTypes<Row, Schema>,
      rowKey: RowKey,
      value: unknown,
    ) => {
      assertOpen()
      if (!configuredColumns.has(column))
        abort(createGridTransactionIssue(
          'unknown-column',
          'The transaction column is not configured by this data source.',
        ))
      if (!targetKeys.has(rowKey))
        abort(createGridTransactionIssue(
          'unknown-row',
          'The transaction row does not exist.',
          { rowKey, columnKey: column.key },
        ))
      const cell = Object.freeze({ rowKey, columnKey: column.key })
      const identity = encodeCellIdentity(cell)
      if (targets.has(identity))
        abort(createGridTransactionIssue(
          'duplicate-cell',
          'A transaction cannot set the same cell more than once.',
          cell,
        ))
      reserveMutation()
      targets.add(identity)
      mutations.push(Object.freeze({ cell, value }))
    },
    abort,
  })

  try {
    let returned: unknown
    try {
      returned = (
        build as (value: typeof transaction) => unknown
      )(transaction)
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'token' in error &&
        error.token === abortToken &&
        'issue' in error
      ) {
        return reject(error.issue as GridTransactionIssue<RowKey>)
      }
      return reject(createGridTransactionIssue(
        'builder-exception',
        `The transaction builder failed: ${message(error)}`,
      ))
    }
    if (isThenable(returned)) {
      void Promise.resolve(returned).catch(() => undefined)
      return reject(createGridTransactionIssue(
        'async-builder',
        'Grid transactions must be built synchronously.',
      ))
    }
    // Creation appends and deletion removes members by themselves. A complete
    // order command is needed only when the builder explicitly changes that
    // natural order; content-only transactions must not acquire order dependencies.
    const naturalOrder = [...initialRowKeys, ...createdRows.map(getRowKey)]
      .filter(key => !removedRowKeys.has(key))
    return Object.freeze({
      ok: true,
      plan: Object.freeze({
        createdRows: Object.freeze(createdRows),
        removedRowKeys: Object.freeze([...removedRowKeys]),
        movedRowKeys: Object.freeze([...movedRowKeys]),
        ...(sameGridRowKeyOrder(naturalOrder, stagedRowKeys) ? {} : { rowOrder: Object.freeze(stagedRowKeys) }),
        mutations: Object.freeze(mutations),
      }),
    })
  } finally {
    transactionOpen = false
  }
}

const transactionIssueCategories: Readonly<Record<string, GridIssueCode>> = Object.freeze({
  'aborted': 'invalid-input', 'transaction-closed': 'stale-target', 'mutation-limit': 'limit-exceeded',
  'row-order-unavailable': 'permission-denied', 'unknown-row': 'stale-target', 'invalid-row-key': 'adapter-error',
  'duplicate-row-key': 'invalid-input', 'duplicate-row-target': 'invalid-input',
  'row-create-unavailable': 'permission-denied', 'row-duplicate-unavailable': 'permission-denied',
  'row-delete-unavailable': 'permission-denied', 'row-delete-blocked': 'permission-denied',
  'row-create-failed': 'adapter-error', 'row-duplicate-failed': 'adapter-error',
  'row-clone-failed': 'adapter-error', 'row-delete-check-failed': 'adapter-error',
  'duplicate-after-set': 'invalid-input', 'delete-after-set': 'invalid-input',
  'unknown-column': 'invalid-input', 'duplicate-cell': 'invalid-input', 'builder-exception': 'adapter-error',
  'async-builder': 'invalid-input', 'session-active': 'session-open', 'destroyed': 'closed',
  'stale-base': 'stale-target', 'transaction-active': 'busy', 'transaction-exception': 'adapter-error',
})

export function createGridTransactionIssue<RowKey extends GridRowKey>(
  domainCode: string,
  message: string,
  cell?: GridPoint<RowKey>,
): GridTransactionIssue<RowKey> {
  return freezeTransactionIssue({ code: transactionIssueCategories[domainCode] ?? 'invalid-input', message, domainCode,
    ...(cell ? { cell } : {}),
  })
}

function freezeTransactionIssue<RowKey extends GridRowKey>(issue: GridTransactionIssue<RowKey>) {
  return Object.freeze({ ...issue, ...(issue.cell ? { cell: Object.freeze({ ...issue.cell }) } : {}) })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function'
  ) && typeof (value as PromiseLike<unknown>).then === 'function'
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
