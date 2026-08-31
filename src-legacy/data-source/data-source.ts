import type {
  DataGridBuiltinCellTypes,
  DataGridSourceFieldForTypes,
} from './cell-type-registry.js'
import type { DataGridDirtyByRow } from '../core/field-definition.js'
import type { DataGridCommitRejection, DataGridConflict, DataGridOrderConflict } from '../core/grid-engine.js'
import type { GridRowKey } from '../core/types.js'
import type { DataGridCollectionState } from '../core/view-state.js'
import type { SortColumn } from 'react-data-grid'

export type DataGridSourceVersion = string | number

export type DataGridFilterCondition = {
  operator: string
  value: string
}

export type DataGridColumnFilterGroup = {
  columnKey: string
  match: 'all' | 'any'
  conditions: readonly DataGridFilterCondition[]
}

type DataGridDataSourceSnapshotBase<Row> = {
  rows: readonly Row[]
  /** Controlled query for the turnkey grid's local visible-row filter. */
  filterQuery?: string
  /** Controlled, product-neutral column filters evaluated against complete source rows. */
  columnFilters?: readonly DataGridColumnFilterGroup[]
  sortColumns?: readonly SortColumn[]
  /** Opaque authoritative-store version used for optimistic concurrency. */
  version: DataGridSourceVersion
}

type DataGridFailedCollectionState = Extract<
  DataGridCollectionState,
  'failed-empty' | 'failed-with-data'
>

/**
 * An authoritative external-store snapshot. Failure states always carry an
 * error, while successful/loading states cannot accidentally carry one.
 */
export type DataGridDataSourceSnapshot<Row> =
  | (DataGridDataSourceSnapshotBase<Row> & {
      state: Exclude<DataGridCollectionState, DataGridFailedCollectionState>
      error?: null
    })
  | (DataGridDataSourceSnapshotBase<Row> & {
      state: DataGridFailedCollectionState
      error: string
    })

export type DataGridPersistenceRequest<Row, RowKey extends GridRowKey> = {
  /** Complete proposed authoritative rows after accepted edits and deletions. */
  rows: readonly Row[]
  acceptedKeys: ReadonlySet<RowKey>
  deletedKeys: ReadonlySet<RowKey>
  dirtyByRow: DataGridDirtyByRow<RowKey>
  orderChanged: boolean
  revision: number
  /** Version of the authoritative snapshot this proposal was prepared from. */
  sourceVersion: DataGridSourceVersion
  /** Stable idempotency key. Retries of the same attempt reuse this value. */
  operationId: string
}

export type DataGridPersistenceResult<Row> = {
  /** Complete authoritative rows returned by the persistence boundary. */
  rows: readonly Row[]
  /** New authoritative version after accepting `sourceVersion`. */
  version: DataGridSourceVersion
}

export type DataGridDraftSnapshot<Row, RowKey extends GridRowKey> = {
  rows: readonly Row[]
  dirtyByRow: DataGridDirtyByRow<RowKey>
  dirtyCount: number
  invalidCount: number
  conflictCount: number
  rejected: readonly DataGridCommitRejection<RowKey>[]
  cellErrorsByRow: ReadonlyMap<RowKey, ReadonlyMap<string, string>>
  conflictsByRow: ReadonlyMap<RowKey, ReadonlyMap<string, DataGridConflict<Row>>>
  orderConflict: DataGridOrderConflict<RowKey> | null
}

export type DataGridPersistence<Row, RowKey extends GridRowKey> =
  | { mode: 'update'; update: (request: DataGridPersistenceRequest<Row, RowKey>) => DataGridPersistenceResult<Row> | Promise<DataGridPersistenceResult<Row>> }
  | { mode: 'save-dirty'; saveDirty: (request: DataGridPersistenceRequest<Row, RowKey>) => DataGridPersistenceResult<Row> | Promise<DataGridPersistenceResult<Row>> }
  | { mode: 'auto-save'; debounceMs?: number; saveDirty: (request: DataGridPersistenceRequest<Row, RowKey>) => DataGridPersistenceResult<Row> | Promise<DataGridPersistenceResult<Row>> }

export type DataGridDataSource<
  Row,
  RowKey extends GridRowKey,
  CellTypes extends object = DataGridBuiltinCellTypes,
> = {
  fields: readonly DataGridSourceFieldForTypes<Row, CellTypes>[]
  /** Synchronously publish this exact persistence result and return the new snapshot. */
  commitRows: (result: DataGridPersistenceResult<Row>) => DataGridDataSourceSnapshot<Row>
  getRowKey: (row: Row) => RowKey
  getSnapshot: () => DataGridDataSourceSnapshot<Row>
  subscribe: (listener: () => void) => () => void
  persistence: DataGridPersistence<Row, RowKey>
  observeDraft?: (snapshot: DataGridDraftSnapshot<Row, RowKey>) => void
  capabilities?: {
    rows?: {
      /** Create a new row with a unique key and product-appropriate defaults. */
      create: () => Row
      /** Create a new row with a unique key using an existing row as its template. */
      duplicate?: (source: Row) => Row
    }
    filtering?: {
      /** Synchronously publish `filterQuery` and return that exact snapshot. */
      update: (query: string) => DataGridDataSourceSnapshot<Row>
      /** Synchronously publish `columnFilters` and return that exact snapshot. */
      updateColumnFilters?: (groups: readonly DataGridColumnFilterGroup[]) => DataGridDataSourceSnapshot<Row>
      matches?: (row: Row, query: string) => boolean
      placeholder?: string
    }
    sorting?: {
      /** Synchronously publish `sortColumns` and return that exact snapshot. */
      update: (sortColumns: readonly SortColumn[]) => DataGridDataSourceSnapshot<Row>
      compare?: (left: Row, right: Row, columnKey: string) => number
    }
  }
}
