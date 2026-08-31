import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'

import type { DataGridDirtyByRow } from '../core/field-definition.js'
import { createDataGridDirtyStore, type DataGridDirtyStore } from '../core/dirty-store.js'
import type { GridRowKey } from '../core/types.js'

export function useDataGridDirtyStore<RowKey extends GridRowKey>(dirtyByRow: DataGridDirtyByRow<RowKey>) {
  const store = useMemo(() => createDataGridDirtyStore<RowKey>(), [])
  useLayoutEffect(() => store.setSnapshot(dirtyByRow), [dirtyByRow, store])
  return store
}

export function useDataGridColumnDirty<RowKey extends GridRowKey>(store: DataGridDirtyStore<RowKey>, field: string) {
  const subscribe = useCallback((listener: () => void) => store.subscribeColumn(field, listener), [field, store])
  const getSnapshot = useCallback(() => store.getColumnDirty(field), [field, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useDataGridOriginalValue<RowKey extends GridRowKey>(store: DataGridDirtyStore<RowKey>, rowKey: RowKey, field: string) {
  const subscribe = useCallback((listener: () => void) => store.subscribeField(rowKey, field, listener), [field, rowKey, store])
  const getSnapshot = useCallback(() => store.getOriginalValue(rowKey, field), [field, rowKey, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useDataGridRowDirty<RowKey extends GridRowKey>(store: DataGridDirtyStore<RowKey>, rowKey: RowKey) {
  const subscribe = useCallback((listener: () => void) => store.subscribeRow(rowKey, listener), [rowKey, store])
  const getSnapshot = useCallback(() => store.getRowDirty(rowKey), [rowKey, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
