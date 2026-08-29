import type { DataGridSourceField } from './cell-type-registry'
import type { DataGridDirtyByRow } from './field-definition'
import type { GridRowKey } from './types'
import type { DataGridCollectionState } from './view-state'
import type { SortColumn } from 'react-data-grid'

export type DataGridDataSourceSnapshot<Row> = { rows: readonly Row[]; state?: DataGridCollectionState; error?: string | null; sortColumns?: readonly SortColumn[] }

export type DataGridPersistenceRequest<Row, RowKey extends GridRowKey> = {
  /** Complete proposed authoritative rows after accepted edits and deletions. */
  rows: readonly Row[]
  acceptedKeys: ReadonlySet<RowKey>
  deletedKeys: ReadonlySet<RowKey>
  dirtyByRow: DataGridDirtyByRow<RowKey>
  signal: AbortSignal
}

export type DataGridDraftSnapshot<Row, RowKey extends GridRowKey> = {
  rows: readonly Row[]
  dirtyByRow: DataGridDirtyByRow<RowKey>
  dirtyCount: number
  invalidCount: number
  conflictCount: number
}

export type DataGridPersistence<Row, RowKey extends GridRowKey> =
  | { mode: 'update'; update: (request: DataGridPersistenceRequest<Row, RowKey>) => void | Promise<void> }
  | { mode: 'save-dirty'; saveDirty: (request: DataGridPersistenceRequest<Row, RowKey>) => void | Promise<void> }
  | { mode: 'auto-save'; debounceMs?: number; saveDirty: (request: DataGridPersistenceRequest<Row, RowKey>) => void | Promise<void> }

export type DataGridDataSource<Row, RowKey extends GridRowKey> = {
  fields: readonly DataGridSourceField<Row, unknown>[]
  getRowKey: (row: Row) => RowKey
  getSnapshot: () => DataGridDataSourceSnapshot<Row>
  subscribe: (listener: () => void) => () => void
  persistence: DataGridPersistence<Row, RowKey>
  observeDraft?: (snapshot: DataGridDraftSnapshot<Row, RowKey>) => void
  capabilities?: {
    sorting?: { update: (sortColumns: readonly SortColumn[]) => void | Promise<void> }
  }
}
