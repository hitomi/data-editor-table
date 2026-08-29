import type { GridRowKey as Key } from './types'

import {
  dataGridFieldValuesEqual,
  formatDataGridOriginalValue,
  type DataGridDirtyByRow,
  type DataGridFieldDefinition,
} from './field-definition'
import {
  createDataGridDirtyStore,
  type DataGridDirtyStore,
} from './dirty-store'

type Listener = () => void

export type DataGridEngineChange<RowKey extends Key> = {
  changedKeys: ReadonlySet<RowKey>
  orderChanged: boolean
}

type GridEngineHistoryChange<Row, RowKey extends Key> = {
  key: RowKey
  before: Row | undefined
  after: Row | undefined
  beforeIndex?: number | undefined
  afterIndex?: number | undefined
}

type GridEngineHistoryEntry<Row, RowKey extends Key> = {
  changes: GridEngineHistoryChange<Row, RowKey>[]
  beforeOrder?: readonly RowKey[]
  afterOrder?: readonly RowKey[]
}

export type DataGridEngineMeta = {
  canRedo: boolean
  canUndo: boolean
  cellErrorCount: number
  conflictCount: number
  derivedVersion: number
  dirtyCount: number
  invalidCount: number
}

export type DataGridCellError = { readonly fieldKey: string; readonly message: string }
export type DataGridConflict<Row> = {
  readonly fieldKey: string
  readonly baseline: Row | undefined
  readonly source: Row | undefined
  readonly draft: Row | undefined
}
export type DataGridCommitRejection<RowKey extends Key> = {
  readonly key: RowKey
  readonly reason: 'invalid' | 'conflict'
  readonly fields: readonly string[]
}
export type DataGridCommitPlan<Row, RowKey extends Key> = {
  readonly rows: readonly Row[]
  readonly acceptedKeys: ReadonlySet<RowKey>
  readonly rejected: readonly DataGridCommitRejection<RowKey>[]
}

export type DataGridEngineOptions<Row, RowKey extends Key> = {
  fields: readonly DataGridFieldDefinition<Row>[]
  historyLimit?: number
  isRowInvalid?: (row: Row) => boolean
  rowKeyGetter: (row: Row) => RowKey
  rows: readonly Row[]
}

export type DataGridEngine<Row, RowKey extends Key> = {
  applyRows: (rows: readonly Row[]) => void
  appendRow: (row: Row) => void
  appendRows: (rows: readonly Row[]) => void
  configure: (options: {
    fields: readonly DataGridFieldDefinition<Row>[]
    isRowInvalid: ((row: Row) => boolean) | undefined
  }) => void
  deleteRows: (keys: readonly RowKey[]) => void
  dirtyStore: DataGridDirtyStore<RowKey>
  getCellErrors: (key: RowKey) => ReadonlyMap<string, string> | undefined
  getConflicts: (key: RowKey) => ReadonlyMap<string, DataGridConflict<Row>> | undefined
  getConflictsSnapshot: () => ReadonlyMap<RowKey, ReadonlyMap<string, DataGridConflict<Row>>>
  getBaseline: (key: RowKey) => Row | undefined
  getBaselineById: () => ReadonlyMap<RowKey, Row>
  getDirtyByRow: () => DataGridDirtyByRow<RowKey>
  getDirtyFields: (
    key: RowKey,
  ) => ReadonlyMap<string, string> | undefined
  getDraftById: () => ReadonlyMap<RowKey, Row>
  getInvalidRowKeys: () => ReadonlySet<RowKey>
  getKeyIndex: (key: RowKey) => number | undefined
  getKeysSnapshot: () => readonly RowKey[]
  getMetaSnapshot: () => DataGridEngineMeta
  getRevision: () => number
  getRowSnapshot: (key: RowKey) => Row | undefined
  getRowsSnapshot: () => readonly Row[]
  prepareCommit: (keys?: ReadonlySet<RowKey>) => DataGridCommitPlan<Row, RowKey>
  markCommitted: (rows: readonly Row[]) => void
  rebaseSource: (rows: readonly Row[]) => void
  redo: () => void
  removeRows: (keys: readonly RowKey[]) => void
  reorderRows: (keys: readonly RowKey[], target: RowKey, position: 'before' | 'after') => void
  resolveConflict: (key: RowKey, fieldKey: string, resolution: 'draft' | 'source') => void
  reset: () => void
  subscribeKeys: (listener: Listener) => () => void
  subscribeChanges: (
    listener: (change: DataGridEngineChange<RowKey>) => void,
  ) => () => void
  subscribeMeta: (listener: Listener) => () => void
  subscribeRow: (key: RowKey, listener: Listener) => () => void
  subscribeRows: (listener: Listener) => () => void
  undo: () => void
}

function subscribeInSet(listeners: Set<Listener>, listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function subscribeInMap<KeyType>(
  listeners: Map<KeyType, Set<Listener>>,
  key: KeyType,
  listener: Listener,
) {
  const existing = listeners.get(key)
  const group = existing ?? new Set<Listener>()
  if (!existing) listeners.set(key, group)
  group.add(listener)
  return () => {
    group.delete(listener)
    if (group.size === 0) listeners.delete(key)
  }
}

function mapRows<Row, RowKey extends Key>(
  rows: readonly Row[],
  rowKeyGetter: (row: Row) => RowKey,
) {
  const result = new Map<RowKey, Row>()
  for (const row of rows) {
    const key = rowKeyGetter(row)
    if (result.has(key)) {
      throw new Error(`Grid Engine 收到重复行标识：${String(key)}`)
    }
    result.set(key, row)
  }
  return result
}

function insertKeysAtIndexes<RowKey extends Key>(
  base: readonly RowKey[],
  insertions: readonly { key: RowKey; index: number }[],
): RowKey[] {
  if (insertions.length === 0) return [...base]
  const ordered = [...insertions].sort((left, right) => left.index - right.index)
  const result: RowKey[] = []
  let baseIndex = 0
  for (const insertion of ordered) {
    const requestedIndex = Math.max(0, Math.min(base.length + insertions.length, insertion.index))
    while (result.length < requestedIndex && baseIndex < base.length) {
      result.push(base[baseIndex]!)
      baseIndex += 1
    }
    result.push(insertion.key)
  }
  while (baseIndex < base.length) {
    result.push(base[baseIndex]!)
    baseIndex += 1
  }
  return result
}

function rebaseDirtyFields<Row>(
  sourceRow: Row,
  baselineRow: Row,
  draftRow: Row,
  fields: readonly DataGridFieldDefinition<Row>[],
): Row {
  let rebased = sourceRow
  for (const field of fields) {
    if (field.kind === 'readonly' || dataGridFieldValuesEqual(field, draftRow, baselineRow)) continue
    const editable = field as DataGridFieldDefinition<Row> & { getValue(row: Row): unknown; setValue(row: Row, value: unknown): Row }
    rebased = editable.setValue(rebased, editable.getValue(draftRow))
  }
  return rebased
}

function rebaseNewRow<Row>(sourceRow: Row, draftRow: Row, fields: readonly DataGridFieldDefinition<Row>[]): Row {
  let rebased = sourceRow
  for (const field of fields) {
    if (field.kind === 'readonly') continue
    const editable = field as DataGridFieldDefinition<Row> & { getValue(row: Row): unknown; setValue(row: Row, value: unknown): Row }
    rebased = editable.setValue(rebased, editable.getValue(draftRow))
  }
  return rebased
}

function conflictMapsEqual<Row>(left: ReadonlyMap<string, DataGridConflict<Row>> | undefined, right: ReadonlyMap<string, DataGridConflict<Row>> | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.size !== right.size) return false
  for (const [key, conflict] of left) {
    const candidate = right.get(key)
    if (!candidate || candidate.baseline !== conflict.baseline || candidate.source !== conflict.source || candidate.draft !== conflict.draft) return false
  }
  return true
}

export function createDataGridEngine<Row, RowKey extends Key>({
  fields: initialFields,
  historyLimit = 50,
  isRowInvalid: initialIsRowInvalid,
  rowKeyGetter,
  rows: sourceRows,
}: DataGridEngineOptions<Row, RowKey>): DataGridEngine<Row, RowKey> {
  let fields = initialFields
  let isRowInvalid = initialIsRowInvalid
  let sourceReference = sourceRows
  let baselineById = mapRows(sourceRows, rowKeyGetter)
  let draftById = new Map(baselineById)
  let keysSnapshot = [...baselineById.keys()]
  let rowIndexByKey = new Map(
    keysSnapshot.map((key, index) => [key, index]),
  )
  let rowsSnapshot = keysSnapshot.map((key) => draftById.get(key) as Row)
  let rowsSnapshotDirty = false
  const dirtyByRow = new Map<
    RowKey,
    ReadonlyMap<string, string>
  >()
  const deletedRowKeys = new Set<RowKey>()
  const invalidRowKeys = new Set<RowKey>()
  const cellErrorsByRow = new Map<RowKey, ReadonlyMap<string, string>>()
  const conflictsByRow = new Map<RowKey, ReadonlyMap<string, DataGridConflict<Row>>>()
  let cellErrorCount = 0
  let conflictCount = 0
  const history = {
    redo: [] as GridEngineHistoryEntry<Row, RowKey>[],
    undo: [] as GridEngineHistoryEntry<Row, RowKey>[],
  }
  const dirtyStore = createDataGridDirtyStore<RowKey>()
  const rowsListeners = new Set<Listener>()
  const keysListeners = new Set<Listener>()
  const metaListeners = new Set<Listener>()
  const rowListeners = new Map<RowKey, Set<Listener>>()
  const changeListeners = new Set<
    (change: DataGridEngineChange<RowKey>) => void
  >()
  let derivedVersion = 0
  let revision = 0

  const dirtyFieldsEqual = (
    left: ReadonlyMap<string, string> | undefined,
    right: ReadonlyMap<string, string> | undefined,
  ) => {
    if (left === right) return true
    if (!left || !right || left.size !== right.size) return false
    for (const [field, originalValue] of left) {
      if (right.get(field) !== originalValue) return false
    }
    return true
  }

  const calculateDirtyFields = (
    key: RowKey,
    row: Row,
  ): ReadonlyMap<string, string> | undefined => {
    const baseline = baselineById.get(key)
    if (!baseline) {
      return new Map([['__new_row__', '新建行']])
    }
    const dirtyFields = new Map<string, string>()
    for (const field of fields) {
      if (!dataGridFieldValuesEqual(field, row, baseline)) {
        dirtyFields.set(
          field.key,
          formatDataGridOriginalValue(field, baseline),
        )
      }
    }
    return dirtyFields.size > 0 ? dirtyFields : undefined
  }

  const calculateCellErrors = (row: Row): ReadonlyMap<string, string> | undefined => {
    const errors = new Map<string, string>()
    if (isRowInvalid?.(row)) errors.set('__row__', '这一行包含无法提交的内容。')
    for (const field of fields) {
      const result = field.validate?.(field.getValue(row) as never, row)
      if (result && !result.valid) errors.set(field.key, result.message ?? `“${field.label}”的值无效。`)
    }
    return errors.size > 0 ? errors : undefined
  }

  const reconcileConflicts = (key: RowKey, row: Row) => {
    const previous = conflictsByRow.get(key)
    if (!previous) return false
    const baseline = baselineById.get(key)
    const next = new Map(previous)
    for (const fieldKey of previous.keys()) {
      if (fieldKey === '__row__') {
        if (!baseline) next.delete(fieldKey)
        continue
      }
      const field = fields.find((candidate) => candidate.key === fieldKey)
      if (field && baseline && dataGridFieldValuesEqual(field, row, baseline)) next.delete(fieldKey)
    }
    if (next.size > 0) conflictsByRow.set(key, next)
    else conflictsByRow.delete(key)
    conflictCount += next.size - previous.size
    return next.size !== previous.size
  }

  const hasOrderDraft = () => {
    const expected = [
      ...[...baselineById.keys()].filter((key) => draftById.has(key)),
      ...[...draftById.keys()].filter((key) => !baselineById.has(key)),
    ]
    return expected.length === keysSnapshot.length && expected.some((key, index) => key !== keysSnapshot[index])
  }

  const createMetaSnapshot = (): DataGridEngineMeta => ({
    canRedo: history.redo.length > 0,
    canUndo: history.undo.length > 0,
    cellErrorCount,
    conflictCount,
    derivedVersion,
    dirtyCount: dirtyByRow.size + deletedRowKeys.size + (hasOrderDraft() ? 1 : 0),
    invalidCount: invalidRowKeys.size,
  })
  let metaSnapshot = createMetaSnapshot()

  const updateMetaSnapshot = () => {
    const next = createMetaSnapshot()
    if (
      next.canRedo === metaSnapshot.canRedo &&
      next.canUndo === metaSnapshot.canUndo &&
      next.cellErrorCount === metaSnapshot.cellErrorCount &&
      next.conflictCount === metaSnapshot.conflictCount &&
      next.derivedVersion === metaSnapshot.derivedVersion &&
      next.dirtyCount === metaSnapshot.dirtyCount &&
      next.invalidCount === metaSnapshot.invalidCount
    ) {
      return false
    }
    metaSnapshot = next
    return true
  }

  const refreshDerivedRowState = (key: RowKey, row: Row) => {
    const previousDirtyFields = dirtyByRow.get(key)
    const wasInvalid = invalidRowKeys.has(key)
    const previousErrors = cellErrorsByRow.get(key)
    const dirtyFields = calculateDirtyFields(key, row)
    const cellErrors = calculateCellErrors(row)
    if (dirtyFields) {
      dirtyByRow.set(key, dirtyFields)
    } else {
      dirtyByRow.delete(key)
    }
    if (cellErrors) {
      invalidRowKeys.add(key)
      cellErrorsByRow.set(key, cellErrors)
    } else {
      invalidRowKeys.delete(key)
      cellErrorsByRow.delete(key)
    }
    cellErrorCount += (cellErrors?.size ?? 0) - (previousErrors?.size ?? 0)
    if (
      !dirtyFieldsEqual(previousDirtyFields, dirtyFields) ||
      wasInvalid !== invalidRowKeys.has(key) ||
      !dirtyFieldsEqual(previousErrors, cellErrors) ||
      reconcileConflicts(key, row)
    ) {
      derivedVersion += 1
    }
    dirtyStore.setRowSnapshot(key, dirtyFields)
  }

  const rebuildDerivedState = () => {
    const previousDirtyByRow = new Map(dirtyByRow)
    const previousInvalidRowKeys = new Set(invalidRowKeys)
    const previousCellErrors = new Map(cellErrorsByRow)
    dirtyByRow.clear()
    invalidRowKeys.clear()
    cellErrorsByRow.clear()
    cellErrorCount = 0
    for (const [key, row] of draftById) {
      const dirtyFields = calculateDirtyFields(key, row)
      if (dirtyFields) dirtyByRow.set(key, dirtyFields)
      const errors = calculateCellErrors(row)
      if (errors) { invalidRowKeys.add(key); cellErrorsByRow.set(key, errors); cellErrorCount += errors.size }
    }
    const dirtyChanged =
      previousDirtyByRow.size !== dirtyByRow.size ||
      [...dirtyByRow].some(
        ([key, dirtyFields]) =>
          !dirtyFieldsEqual(previousDirtyByRow.get(key), dirtyFields),
      )
    const invalidChanged =
      previousInvalidRowKeys.size !== invalidRowKeys.size ||
      [...invalidRowKeys].some(
        (key) => !previousInvalidRowKeys.has(key),
      )
    const cellErrorsChanged = previousCellErrors.size !== cellErrorsByRow.size || [...cellErrorsByRow].some(([key, errors]) => !dirtyFieldsEqual(previousCellErrors.get(key), errors))
    if (dirtyChanged || invalidChanged || cellErrorsChanged) derivedVersion += 1
    dirtyStore.setSnapshot(dirtyByRow)
  }

  const notifyRows = (
    changedKeys: ReadonlySet<RowKey>,
    orderChanged = false,
  ) => {
    revision += 1
    rowsListeners.forEach((listener) => listener())
    changedKeys.forEach((key) => {
      rowListeners.get(key)?.forEach((listener) => listener())
    })
    const change = { changedKeys, orderChanged }
    changeListeners.forEach((listener) => listener(change))
  }

  const notifyMetaIfChanged = () => {
    if (!updateMetaSnapshot()) return
    metaListeners.forEach((listener) => listener())
  }

  const rebuildRowsSnapshot = () => {
    rowsSnapshot = keysSnapshot.map((key) => draftById.get(key) as Row)
    rowsSnapshotDirty = false
    rowIndexByKey = new Map(
      keysSnapshot.map((key, index) => [key, index]),
    )
  }

  const replaceRowsInSnapshot = (changedKeys: ReadonlySet<RowKey>) => {
    if (rowsListeners.size === 0) {
      rowsSnapshotDirty = true
      return
    }
    if (rowsSnapshotDirty) rebuildRowsSnapshot()
    const nextRows = rowsSnapshot.slice()
    changedKeys.forEach((key) => {
      const index = rowIndexByKey.get(key)
      const row = draftById.get(key)
      if (index !== undefined && row) nextRows[index] = row
    })
    rowsSnapshot = nextRows
  }

  const pushHistory = (entry: GridEngineHistoryEntry<Row, RowKey>) => {
    history.undo.push(entry)
    if (history.undo.length > historyLimit) history.undo.shift()
    history.redo = []
  }

  const applyRows = (nextRows: readonly Row[]) => {
    const byKey = new Map<RowKey, Row>()
    nextRows.forEach((row) => byKey.set(rowKeyGetter(row), row))
    const changes: GridEngineHistoryChange<Row, RowKey>[] = []
    byKey.forEach((row, key) => {
      const before = draftById.get(key)
      if (!before || before === row) return
      changes.push({ key, before, after: row })
    })
    if (changes.length === 0) return

    pushHistory({ changes })
    const changedKeys = new Set<RowKey>()
    changes.forEach(({ key, after }) => {
      if (!after) return
      draftById.set(key, after)
      changedKeys.add(key)
    })
    replaceRowsInSnapshot(changedKeys)
    changes.forEach(({ key, after }) => {
      if (after) refreshDerivedRowState(key, after)
    })
    notifyRows(changedKeys)
    notifyMetaIfChanged()
  }

  const restoreHistoryEntry = (
    entry: GridEngineHistoryEntry<Row, RowKey>,
    direction: 'undo' | 'redo',
  ) => {
    const changedKeys = new Set<RowKey>()
    const removedKeys = new Set<RowKey>()
    const positionedKeys: Array<{ key: RowKey; index: number }> = []
    entry.changes.forEach((change) => {
      const row = direction === 'undo' ? change.before : change.after
      if (row === undefined) {
        if (draftById.delete(change.key)) {
          removedKeys.add(change.key)
        }
        if (baselineById.has(change.key)) deletedRowKeys.add(change.key)
      } else {
        const requestedIndex = direction === 'undo' ? change.beforeIndex : change.afterIndex
        if (requestedIndex !== undefined) positionedKeys.push({ key: change.key, index: requestedIndex })
        draftById.set(change.key, row)
        deletedRowKeys.delete(change.key)
      }
      changedKeys.add(change.key)
    })
    const restoredOrder = direction === 'undo' ? entry.beforeOrder : entry.afterOrder
    const orderChanged = removedKeys.size > 0 || positionedKeys.length > 0 || restoredOrder !== undefined
    if (orderChanged) {
      const repositioned = new Set(positionedKeys.map(({ key }) => key))
      const retainedKeys = keysSnapshot.filter((key) => !removedKeys.has(key) && !repositioned.has(key))
      keysSnapshot = insertKeysAtIndexes(retainedKeys, positionedKeys)
    }
    if (restoredOrder) {
      const current = new Set(keysSnapshot)
      const restored = new Set(restoredOrder)
      keysSnapshot = [...restoredOrder.filter((key) => current.has(key)), ...keysSnapshot.filter((key) => !restored.has(key))]
    }
    if (orderChanged) {
      rebuildRowsSnapshot()
      keysListeners.forEach((listener) => listener())
    } else {
      replaceRowsInSnapshot(changedKeys)
    }
    changedKeys.forEach((key) => {
      const row = draftById.get(key)
      if (row) {
        refreshDerivedRowState(key, row)
      } else {
        dirtyByRow.delete(key)
        invalidRowKeys.delete(key)
        cellErrorCount -= cellErrorsByRow.get(key)?.size ?? 0
        conflictCount -= conflictsByRow.get(key)?.size ?? 0
        cellErrorsByRow.delete(key)
        conflictsByRow.delete(key)
        dirtyStore.setRowSnapshot(key, deletedRowKeys.has(key) ? new Map([['__deleted_row__', '已删除行']]) : undefined)
      }
    })
    notifyRows(changedKeys, orderChanged)
    notifyMetaIfChanged()
  }

  rebuildDerivedState()
  metaSnapshot = createMetaSnapshot()

  return {
    applyRows,
    appendRow(row) {
      const key = rowKeyGetter(row)
      if (draftById.has(key)) return
      const index = keysSnapshot.length
      pushHistory({ changes: [{ key, before: undefined, after: row, afterIndex: index }] })
      draftById.set(key, row)
      deletedRowKeys.delete(key)
      keysSnapshot = [...keysSnapshot, key]
      rebuildRowsSnapshot()
      refreshDerivedRowState(key, row)
      keysListeners.forEach((listener) => listener())
      notifyRows(new Set([key]), true)
      notifyMetaIfChanged()
    },
    appendRows(rows) {
      const additions: Array<{ key: RowKey; row: Row; index: number }> = []
      const seen = new Set<RowKey>()
      rows.forEach((row) => {
        const key = rowKeyGetter(row)
        if (draftById.has(key) || seen.has(key)) return
        seen.add(key)
        additions.push({ key, row, index: keysSnapshot.length + additions.length })
      })
      if (additions.length === 0) return
      pushHistory({ changes: additions.map(({ key, row, index }) => ({ key, before: undefined, after: row, afterIndex: index })) })
      additions.forEach(({ key, row }) => {
        draftById.set(key, row)
        deletedRowKeys.delete(key)
        refreshDerivedRowState(key, row)
      })
      keysSnapshot = [...keysSnapshot, ...additions.map(({ key }) => key)]
      rebuildRowsSnapshot()
      keysListeners.forEach((listener) => listener())
      notifyRows(new Set(additions.map(({ key }) => key)), true)
      notifyMetaIfChanged()
    },
    configure(next) {
      if (
        fields === next.fields &&
        isRowInvalid === next.isRowInvalid
      ) {
        return
      }
      fields = next.fields
      isRowInvalid = next.isRowInvalid
      rebuildDerivedState()
      notifyMetaIfChanged()
    },
    deleteRows(keys) {
      const changes: GridEngineHistoryChange<Row, RowKey>[] = []
      for (const key of new Set(keys)) {
        const before = draftById.get(key)
        if (before) changes.push({ key, before, after: undefined, beforeIndex: rowIndexByKey.get(key) })
      }
      if (changes.length === 0) return
      pushHistory({ changes })
      const changedKeys = new Set(changes.map(({ key }) => key))
      for (const { key } of changes) {
        draftById.delete(key)
        if (baselineById.has(key)) deletedRowKeys.add(key)
        dirtyByRow.delete(key)
        invalidRowKeys.delete(key)
        cellErrorCount -= cellErrorsByRow.get(key)?.size ?? 0
        conflictCount -= conflictsByRow.get(key)?.size ?? 0
        cellErrorsByRow.delete(key)
        conflictsByRow.delete(key)
        dirtyStore.setRowSnapshot(key, new Map([['__deleted_row__', '已删除行']]))
      }
      keysSnapshot = keysSnapshot.filter((candidate) => !changedKeys.has(candidate))
      rebuildRowsSnapshot()
      keysListeners.forEach((listener) => listener())
      notifyRows(changedKeys, true)
      notifyMetaIfChanged()
    },
    dirtyStore,
    getCellErrors: (key) => cellErrorsByRow.get(key),
    getConflicts: (key) => conflictsByRow.get(key),
    getConflictsSnapshot: () => conflictsByRow,
    getBaseline: (key) => baselineById.get(key),
    getBaselineById: () => baselineById,
    getDirtyByRow: () => dirtyByRow,
    getDirtyFields: (key) => dirtyByRow.get(key),
    getDraftById: () => draftById,
    getInvalidRowKeys: () => invalidRowKeys,
    getKeyIndex: (key) => rowIndexByKey.get(key),
    getKeysSnapshot: () => keysSnapshot,
    getMetaSnapshot: () => metaSnapshot,
    getRevision: () => revision,
    getRowSnapshot: (key) => draftById.get(key),
    getRowsSnapshot() {
      if (rowsSnapshotDirty) rebuildRowsSnapshot()
      return rowsSnapshot
    },
    reorderRows(keys, target, position) {
      const sources = new Set(keys.filter((key) => draftById.has(key)))
      if (sources.size === 0 || sources.has(target) || !draftById.has(target)) return
      const orderedSources = keysSnapshot.filter((key) => sources.has(key))
      const retained = keysSnapshot.filter((key) => !sources.has(key))
      const targetIndex = retained.indexOf(target)
      if (targetIndex < 0) return
      const insertionIndex = targetIndex + (position === 'after' ? 1 : 0)
      const nextKeys = [...retained.slice(0, insertionIndex), ...orderedSources, ...retained.slice(insertionIndex)]
      if (nextKeys.every((key, index) => key === keysSnapshot[index])) return
      pushHistory({ changes: [], beforeOrder: keysSnapshot, afterOrder: nextKeys })
      keysSnapshot = nextKeys
      rebuildRowsSnapshot()
      keysListeners.forEach((listener) => listener())
      notifyRows(new Set(), true)
      notifyMetaIfChanged()
    },
    prepareCommit(requestedKeys) {
      const orderDraft = hasOrderDraft()
      const candidateKeys = new Set<RowKey>(requestedKeys ?? [...dirtyByRow.keys(), ...deletedRowKeys, ...conflictsByRow.keys()])
      if (orderDraft && requestedKeys === undefined) {
        keysSnapshot.forEach((key) => candidateKeys.add(key))
        deletedRowKeys.forEach((key) => candidateKeys.add(key))
      }
      const acceptedKeys = new Set<RowKey>()
      const rejected: DataGridCommitRejection<RowKey>[] = []
      for (const key of candidateKeys) {
        const errors = cellErrorsByRow.get(key)
        const conflicts = conflictsByRow.get(key)
        if (errors?.size) rejected.push({ key, reason: 'invalid', fields: [...errors.keys()] })
        else if (conflicts?.size) rejected.push({ key, reason: 'conflict', fields: [...conflicts.keys()] })
        else if (orderDraft || dirtyByRow.has(key) || deletedRowKeys.has(key)) acceptedKeys.add(key)
      }
      if (orderDraft && rejected.length > 0) return { rows: [...baselineById.values()], acceptedKeys: new Set<RowKey>(), rejected }
      if (orderDraft && requestedKeys === undefined) {
        return { rows: keysSnapshot.flatMap((key) => {
          const row = draftById.get(key)
          return row ? [row] : []
        }), acceptedKeys, rejected }
      }
      const rows: Row[] = []
      for (const [key, baseline] of baselineById) {
        if (acceptedKeys.has(key) && deletedRowKeys.has(key)) continue
        rows.push(acceptedKeys.has(key) ? draftById.get(key) ?? baseline : baseline)
      }
      for (const key of keysSnapshot) {
        if (baselineById.has(key) || !acceptedKeys.has(key)) continue
        const row = draftById.get(key)
        if (row) rows.push(row)
      }
      return { rows, acceptedKeys, rejected }
    },
    markCommitted(committedRows) {
      const changedKeys = new Set<RowKey>()
      let orderChanged = false
      committedRows.forEach((row) => {
        const key = rowKeyGetter(row)
        if (!draftById.has(key)) {
          keysSnapshot = [...keysSnapshot, key]
          orderChanged = true
        }
        baselineById.set(key, row)
        draftById.set(key, row)
        conflictCount -= conflictsByRow.get(key)?.size ?? 0
        conflictsByRow.delete(key)
        changedKeys.add(key)
      })
      history.undo = []
      history.redo = []
      if (orderChanged) {
        rebuildRowsSnapshot()
        keysListeners.forEach((listener) => listener())
      } else if (changedKeys.size > 0) {
        replaceRowsInSnapshot(changedKeys)
      }
      changedKeys.forEach((key) => {
        const row = draftById.get(key)
        if (row) refreshDerivedRowState(key, row)
      })
      if (changedKeys.size > 0) notifyRows(changedKeys, orderChanged)
      notifyMetaIfChanged()
    },
    rebaseSource(nextSourceRows) {
      if (nextSourceRows === sourceReference) return
      const previousOrderDraft = hasOrderDraft()
      sourceReference = nextSourceRows
      const previousBaseline = baselineById
      const previousDraft = draftById
      const previousKeys = keysSnapshot
      const nextBaseline = mapRows(nextSourceRows, rowKeyGetter)
      const nextDraft = new Map<RowKey, Row>()
      const nextKeys = [...nextBaseline.keys()]
      const nextDeleted = new Set<RowKey>()
      const nextConflicts = new Map<RowKey, ReadonlyMap<string, DataGridConflict<Row>>>()

      nextBaseline.forEach((sourceRow, key) => {
        const previousRow = previousDraft.get(key)
        const baselineRow = previousBaseline.get(key)
        if (deletedRowKeys.has(key) && baselineRow) {
          nextDeleted.add(key)
          nextKeys.splice(nextKeys.indexOf(key), 1)
          if (fields.some((field) => !dataGridFieldValuesEqual(field, sourceRow, baselineRow))) {
            nextConflicts.set(key, new Map([['__row__', { fieldKey: '__row__', baseline: baselineRow, source: sourceRow, draft: undefined }]]))
          }
          return
        }
        const rebased = baselineRow && dirtyByRow.has(key) && previousRow
          ? rebaseDirtyFields(sourceRow, baselineRow, previousRow, fields)
          : previousRow && !baselineRow
            ? rebaseNewRow(sourceRow, previousRow, fields)
            : sourceRow
        nextDraft.set(key, rebased)
        const conflicts = new Map(conflictsByRow.get(key) ?? [])
        for (const field of fields) {
          const localChanged = previousRow && baselineRow ? !dataGridFieldValuesEqual(field, previousRow, baselineRow) : Boolean(previousRow && !baselineRow && !dataGridFieldValuesEqual(field, previousRow, sourceRow))
          const sourceChanged = baselineRow ? !dataGridFieldValuesEqual(field, sourceRow, baselineRow) : Boolean(previousRow)
          if (localChanged && sourceChanged && previousRow && !dataGridFieldValuesEqual(field, previousRow, sourceRow)) {
            conflicts.set(field.key, { fieldKey: field.key, baseline: baselineRow, source: sourceRow, draft: previousRow })
          } else if (dataGridFieldValuesEqual(field, rebased, sourceRow)) {
            conflicts.delete(field.key)
          }
        }
        if (conflicts.size > 0) nextConflicts.set(key, conflicts)
      })
      previousKeys.forEach((key) => {
        if (nextBaseline.has(key)) return
        const previousRow = previousDraft.get(key)
        if (!previousRow) return
        if (!previousBaseline.has(key)) {
          nextKeys.push(key)
          nextDraft.set(key, previousRow)
          return
        }
        if (dirtyByRow.has(key)) {
          nextKeys.push(key)
          nextDraft.set(key, previousRow)
          nextConflicts.set(key, new Map([['__row__', { fieldKey: '__row__', baseline: previousBaseline.get(key), source: undefined, draft: previousRow }]]))
        }
      })
      if (previousOrderDraft) {
        const preserved = previousKeys.filter((key) => nextDraft.has(key))
        const preservedSet = new Set(preserved)
        nextKeys.splice(0, nextKeys.length, ...preserved, ...nextKeys.filter((key) => !preservedSet.has(key)))
      }

      const changedKeys = new Set<RowKey>()
      new Set([...previousKeys, ...nextKeys]).forEach((key) => {
        if (previousDraft.get(key) !== nextDraft.get(key)) {
          changedKeys.add(key)
        }
      })
      const orderChanged =
        previousKeys.length !== nextKeys.length ||
        previousKeys.some((key, index) => key !== nextKeys[index])

      baselineById = nextBaseline
      draftById = nextDraft
      keysSnapshot = nextKeys
      deletedRowKeys.clear()
      nextDeleted.forEach((key) => deletedRowKeys.add(key))
      const conflictsChanged = conflictsByRow.size !== nextConflicts.size || [...nextConflicts].some(([key, conflicts]) => !conflictMapsEqual(conflictsByRow.get(key), conflicts))
      conflictsByRow.clear()
      nextConflicts.forEach((conflicts, key) => conflictsByRow.set(key, conflicts))
      conflictCount = [...nextConflicts.values()].reduce((count, conflicts) => count + conflicts.size, 0)
      if (conflictsChanged) derivedVersion += 1
      // Full-row history contains values from the previous authoritative
      // baseline. Replaying it after a rebase can restore deleted rows or
      // overwrite newly replicated fields, so a source boundary invalidates
      // the history as one conservative transaction.
      history.undo = []
      history.redo = []
      rebuildRowsSnapshot()
      rebuildDerivedState()
      if (orderChanged) keysListeners.forEach((listener) => listener())
      notifyRows(changedKeys, orderChanged)
      notifyMetaIfChanged()
    },
    redo() {
      const entry = history.redo.pop()
      if (!entry) return
      history.undo.push(entry)
      restoreHistoryEntry(entry, 'redo')
    },
    resolveConflict(key, fieldKey, resolution) {
      const conflicts = conflictsByRow.get(key)
      if (!conflicts?.has(fieldKey)) return
      const conflict = conflicts.get(fieldKey)!
      const draft = draftById.get(key)
      const baseline = baselineById.get(key)
      const nextConflicts = new Map(conflicts)
      nextConflicts.delete(fieldKey)
      conflictCount -= 1
      if (nextConflicts.size > 0) conflictsByRow.set(key, nextConflicts)
      else conflictsByRow.delete(key)

      if (fieldKey === '__row__' && resolution === 'source') {
        let orderChanged = false
        if (conflict.source) {
          if (!draftById.has(key)) {
            const sourceIndex = [...baselineById.keys()].indexOf(key)
            const insertAt = sourceIndex < 0 ? keysSnapshot.length : Math.min(sourceIndex, keysSnapshot.length)
            keysSnapshot = [...keysSnapshot.slice(0, insertAt), key, ...keysSnapshot.slice(insertAt)]
            orderChanged = true
          }
          draftById.set(key, conflict.source)
          deletedRowKeys.delete(key)
          refreshDerivedRowState(key, conflict.source)
        } else {
          if (draftById.delete(key)) {
            keysSnapshot = keysSnapshot.filter((candidate) => candidate !== key)
            orderChanged = true
          }
          deletedRowKeys.delete(key)
          dirtyByRow.delete(key)
          invalidRowKeys.delete(key)
          cellErrorCount -= cellErrorsByRow.get(key)?.size ?? 0
          cellErrorsByRow.delete(key)
          dirtyStore.setRowSnapshot(key, undefined)
        }
        if (orderChanged) {
          rebuildRowsSnapshot()
          keysListeners.forEach((listener) => listener())
        } else {
          replaceRowsInSnapshot(new Set([key]))
        }
        derivedVersion += 1
        notifyRows(new Set([key]), orderChanged)
        notifyMetaIfChanged()
        return
      }

      if (fieldKey !== '__row__' && resolution === 'source' && draft && baseline) {
        const field = fields.find((candidate) => candidate.key === fieldKey)
        if (field?.kind !== 'readonly') {
          const editable = field as DataGridFieldDefinition<Row> & { getValue(row: Row): unknown; setValue(row: Row, value: unknown): Row }
          const sourceRow = editable.setValue(draft, editable.getValue(baseline))
          draftById.set(key, sourceRow)
          replaceRowsInSnapshot(new Set([key]))
          refreshDerivedRowState(key, sourceRow)
          derivedVersion += 1
          notifyRows(new Set([key]))
          notifyMetaIfChanged()
          return
        }
      }
      derivedVersion += 1
      notifyMetaIfChanged()
    },
    removeRows(keys) {
      if (keys.length === 0) return
      const changedKeys = new Set<RowKey>()
      const removedKeys = new Set<RowKey>()
      keys.forEach((key) => {
        const baseline = baselineById.get(key)
        if (baseline) {
          if (draftById.get(key) !== baseline) {
            draftById.set(key, baseline)
            changedKeys.add(key)
          }
          return
        }
        if (draftById.delete(key)) {
          removedKeys.add(key)
          changedKeys.add(key)
        }
      })
      const orderChanged = removedKeys.size > 0
      if (orderChanged) keysSnapshot = keysSnapshot.filter((candidate) => !removedKeys.has(candidate))
      history.undo = []
      history.redo = []
      if (orderChanged) {
        rebuildRowsSnapshot()
        keysListeners.forEach((listener) => listener())
      } else if (changedKeys.size > 0) {
        replaceRowsInSnapshot(changedKeys)
      }
      changedKeys.forEach((key) => {
        const row = draftById.get(key)
        if (row) {
          refreshDerivedRowState(key, row)
        } else {
          dirtyByRow.delete(key)
          invalidRowKeys.delete(key)
          cellErrorCount -= cellErrorsByRow.get(key)?.size ?? 0
          conflictCount -= conflictsByRow.get(key)?.size ?? 0
          cellErrorsByRow.delete(key)
          conflictsByRow.delete(key)
          dirtyStore.setRowSnapshot(key, undefined)
        }
      })
      if (changedKeys.size > 0) notifyRows(changedKeys, orderChanged)
      notifyMetaIfChanged()
    },
    reset() {
      const previousDraft = draftById
      const previousKeys = keysSnapshot
      draftById = new Map(baselineById)
      keysSnapshot = [...baselineById.keys()]
      deletedRowKeys.clear()
      conflictsByRow.clear()
      conflictCount = 0
      history.undo = []
      history.redo = []
      const changedKeys = new Set<RowKey>()
      new Set([...previousKeys, ...keysSnapshot]).forEach((key) => {
        if (previousDraft.get(key) !== draftById.get(key)) {
          changedKeys.add(key)
        }
      })
      const orderChanged =
        previousKeys.length !== keysSnapshot.length ||
        previousKeys.some((key, index) => key !== keysSnapshot[index])
      rebuildRowsSnapshot()
      rebuildDerivedState()
      if (orderChanged) keysListeners.forEach((listener) => listener())
      notifyRows(changedKeys, orderChanged)
      notifyMetaIfChanged()
    },
    subscribeChanges(listener) {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    subscribeKeys: (listener) => subscribeInSet(keysListeners, listener),
    subscribeMeta: (listener) => subscribeInSet(metaListeners, listener),
    subscribeRow: (key, listener) =>
      subscribeInMap(rowListeners, key, listener),
    subscribeRows: (listener) => subscribeInSet(rowsListeners, listener),
    undo() {
      const entry = history.undo.pop()
      if (!entry) return
      history.redo.push(entry)
      restoreHistoryEntry(entry, 'undo')
    },
  }
}
