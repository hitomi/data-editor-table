import type { GridRowKey as Key } from './types'

import type { DataGridDirtyByRow } from './field-definition'

type Listener = () => void

const EMPTY_FIELDS: ReadonlyMap<string, string> = new Map()

export type DataGridDirtyStore<RowKey extends Key> = {
  getColumnDirty: (field: string) => boolean
  getOriginalValue: (rowKey: RowKey, field: string) => string | undefined
  getRowDirty: (rowKey: RowKey) => boolean
  setRowSnapshot: (
    rowKey: RowKey,
    fields: ReadonlyMap<string, string> | undefined,
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
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
) {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}

export function createDataGridDirtyStore<RowKey extends Key>(): DataGridDirtyStore<RowKey> {
  let snapshot = new Map<RowKey, ReadonlyMap<string, string>>()
  let columns = new Set<string>()
  const columnCounts = new Map<string, number>()
  const columnListeners = new Map<string, Set<Listener>>()
  const rowListeners = new Map<RowKey, Set<Listener>>()
  const fieldListeners = new Map<RowKey, Map<string, Set<Listener>>>()

  const notifyRowChange = (
    rowKey: RowKey,
    previousFields: ReadonlyMap<string, string>,
    nextFields: ReadonlyMap<string, string>,
  ) => {
    if ((previousFields.size > 0) !== (nextFields.size > 0)) {
      rowListeners.get(rowKey)?.forEach((listener) => listener())
    }
    const rowFieldListeners = fieldListeners.get(rowKey)
    if (!rowFieldListeners) return
    new Set([...previousFields.keys(), ...nextFields.keys()]).forEach(
      (field) => {
        if (previousFields.get(field) !== nextFields.get(field)) {
          rowFieldListeners.get(field)?.forEach((listener) => listener())
        }
      },
    )
  }

  const updateColumnCounts = (
    previousFields: ReadonlyMap<string, string>,
    nextFields: ReadonlyMap<string, string>,
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
    getOriginalValue: (rowKey, field) => snapshot.get(rowKey)?.get(field),
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
