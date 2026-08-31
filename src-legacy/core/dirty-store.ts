import type { GridRowKey as Key } from './types.js'

import type { DataGridDirtyByRow, DataGridDirtyField } from './field-definition.js'

type Listener = () => void

const EMPTY_FIELDS: ReadonlyMap<string, DataGridDirtyField> = new Map()

export type DataGridDirtyStore<RowKey extends Key> = {
  getColumnDirty: (field: string) => boolean
  getOriginalField: (rowKey: RowKey, field: string) => DataGridDirtyField | undefined
  getOriginalValue: (rowKey: RowKey, field: string) => string | undefined
  getRowDirty: (rowKey: RowKey) => boolean
  setRowSnapshot: (
    rowKey: RowKey,
    fields: ReadonlyMap<string, DataGridDirtyField> | undefined,
  ) => void
  setSnapshot: (next: DataGridDirtyByRow<RowKey>) => void
  subscribeColumn: (field: string, listener: Listener) => () => void
  subscribeField: (
    rowKey: RowKey,
    field: string,
    listener: Listener,
  ) => () => void
  subscribeRow: (rowKey: RowKey, listener: Listener) => () => void
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

function dirtyColumns<RowKey extends Key>(
  snapshot: DataGridDirtyByRow<RowKey>,
) {
  const columns = new Set<string>()
  snapshot.forEach((fields) => {
    fields.forEach((_value, field) => columns.add(field))
  })
  return columns
}

function mapsEqual(
  left: ReadonlyMap<string, DataGridDirtyField>,
  right: ReadonlyMap<string, DataGridDirtyField>,
) {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    const candidate = right.get(key)
    if (!candidate || !Object.is(candidate.originalValue, value.originalValue) || candidate.formattedOriginalValue !== value.formattedOriginalValue) return false
  }
  return true
}

export function createDataGridDirtyStore<RowKey extends Key>(): DataGridDirtyStore<RowKey> {
  let snapshot = new Map<RowKey, ReadonlyMap<string, DataGridDirtyField>>()
  let columns = new Set<string>()
  const columnCounts = new Map<string, number>()
  const columnListeners = new Map<string, Set<Listener>>()
  const rowListeners = new Map<RowKey, Set<Listener>>()
  const fieldListeners = new Map<RowKey, Map<string, Set<Listener>>>()

  const notifyRowChange = (
    rowKey: RowKey,
    previousFields: ReadonlyMap<string, DataGridDirtyField>,
    nextFields: ReadonlyMap<string, DataGridDirtyField>,
  ) => {
    if ((previousFields.size > 0) !== (nextFields.size > 0)) {
      rowListeners.get(rowKey)?.forEach((listener) => listener())
    }
    const rowFieldListeners = fieldListeners.get(rowKey)
    if (!rowFieldListeners) return
    new Set([...previousFields.keys(), ...nextFields.keys()]).forEach(
      (field) => {
        const previous = previousFields.get(field)
        const next = nextFields.get(field)
        if (!previous || !next || !Object.is(previous.originalValue, next.originalValue) || previous.formattedOriginalValue !== next.formattedOriginalValue) {
          rowFieldListeners.get(field)?.forEach((listener) => listener())
        }
      },
    )
  }

  const updateColumnCounts = (
    previousFields: ReadonlyMap<string, DataGridDirtyField>,
    nextFields: ReadonlyMap<string, DataGridDirtyField>,
  ) => {
    new Set([...previousFields.keys(), ...nextFields.keys()]).forEach(
      (field) => {
        const wasDirty = (columnCounts.get(field) ?? 0) > 0
        let count = columnCounts.get(field) ?? 0
        if (previousFields.has(field) && !nextFields.has(field)) count -= 1
        if (!previousFields.has(field) && nextFields.has(field)) count += 1
        if (count > 0) {
          columnCounts.set(field, count)
          columns.add(field)
        } else {
          columnCounts.delete(field)
          columns.delete(field)
        }
        if (wasDirty !== (count > 0)) {
          columnListeners.get(field)?.forEach((listener) => listener())
        }
      },
    )
  }

  return {
    getColumnDirty: (field) => columns.has(field),
    getOriginalField: (rowKey, field) => snapshot.get(rowKey)?.get(field),
    getOriginalValue: (rowKey, field) => snapshot.get(rowKey)?.get(field)?.formattedOriginalValue,
    getRowDirty: (rowKey) => snapshot.has(rowKey),
    setRowSnapshot(rowKey, fields) {
      const previousFields = snapshot.get(rowKey) ?? EMPTY_FIELDS
      const nextFields = fields?.size ? fields : EMPTY_FIELDS
      if (mapsEqual(previousFields, nextFields)) return
      if (nextFields.size > 0) {
        snapshot.set(rowKey, nextFields)
      } else {
        snapshot.delete(rowKey)
      }
      notifyRowChange(rowKey, previousFields, nextFields)
      updateColumnCounts(previousFields, nextFields)
    },
    setSnapshot(next) {
      if (next === snapshot) return
      const previous = snapshot
      const previousColumns = columns
      snapshot = new Map(next)
      columns = dirtyColumns(next)
      columnCounts.clear()
      next.forEach((fields) => {
        fields.forEach((_value, field) => {
          columnCounts.set(field, (columnCounts.get(field) ?? 0) + 1)
        })
      })

      new Set([...previous.keys(), ...next.keys()]).forEach((rowKey) => {
        const previousFields = previous.get(rowKey) ?? EMPTY_FIELDS
        const nextFields = next.get(rowKey) ?? EMPTY_FIELDS
        notifyRowChange(rowKey, previousFields, nextFields)
      })

      new Set([...previousColumns, ...columns]).forEach((field) => {
        if (previousColumns.has(field) !== columns.has(field)) {
          columnListeners.get(field)?.forEach((listener) => listener())
        }
      })
    },
    subscribeColumn: (field, listener) =>
      subscribeInMap(columnListeners, field, listener),
    subscribeField(rowKey, field, listener) {
      const existing = fieldListeners.get(rowKey)
      const rowFields = existing ?? new Map<string, Set<Listener>>()
      if (!existing) fieldListeners.set(rowKey, rowFields)
      const unsubscribe = subscribeInMap(rowFields, field, listener)
      return () => {
        unsubscribe()
        if (rowFields.size === 0) fieldListeners.delete(rowKey)
      }
    },
    subscribeRow: (rowKey, listener) =>
      subscribeInMap(rowListeners, rowKey, listener),
  }
}
