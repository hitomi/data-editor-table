import type { GridRowKey, GridSourceStatus, GridSourceVersion } from '../model/grid-model.js'

/** Presentation snapshot, never accepted as server evidence. */
export type GridCompleteScope = Readonly<{ kind: 'complete' }>
type GridDataSourceSnapshotBase<Row> = Readonly<{
  rows: readonly Row[]
  version: GridSourceVersion
  scope: GridCompleteScope
}>
export type GridDataSourceSnapshot<Row> =
  | (GridDataSourceSnapshotBase<Row> & Readonly<{ status: Exclude<GridSourceStatus, 'error'>; error?: never }>)
  | (GridDataSourceSnapshotBase<Row> & Readonly<{ status: 'error'; error: string }>)

export type GridRowKeyRemap<RowKey extends GridRowKey> = Readonly<{ from: RowKey; to: RowKey }>

export type GridRowCapabilities<Row> = Readonly<{
  create?: () => Row
  duplicate?: (source: Row) => Row
  /** Local admission against the current row, including accepted edits.
   * Server permissions are separately enforced by PersistenceSource.submit. */
  canDelete?: (row: Row) => boolean
  /**
   * Declares that row order is writable through the authority protocol.
   */
  ordering?: 'mutable'
}>
