import type {
  GridPersistenceMode,
  GridRowKey,
  GridSourceStatus,
  GridSourceVersion,
} from '../model/grid-model.js'
import type { GridCellTypeSchema, GridColumnForCellTypes } from '../cell-types/contracts.js'

export type GridCompleteScope = Readonly<{ kind: 'complete' }>

type GridDataSourceSnapshotBase<Row> = Readonly<{
  rows: readonly Row[]
  version: GridSourceVersion
  scope: GridCompleteScope
}>

export type GridDataSourceSnapshot<Row> =
  | (GridDataSourceSnapshotBase<Row> & Readonly<{ status: Exclude<GridSourceStatus, 'error'>; error?: never }>)
  | (GridDataSourceSnapshotBase<Row> & Readonly<{ status: 'error'; error: string }>)

export type GridReadyDataSourceSnapshot<Row> = GridDataSourceSnapshotBase<Row> &
  Readonly<{ status: 'ready'; error?: never }>

export type GridCellChange<RowKey extends GridRowKey> = Readonly<{
  rowKey: RowKey
  columnKey: string
  before: unknown
  after: unknown
}>

export type GridInsertedRow<Row, RowKey extends GridRowKey> = Readonly<{
  rowKey: RowKey
  row: Row
}>

export type GridUpdatedRow<Row, RowKey extends GridRowKey> = Readonly<{
  rowKey: RowKey
  before: Row
  after: Row
  cells: readonly GridCellChange<RowKey>[]
}>

export type GridDeletedRow<Row, RowKey extends GridRowKey> = Readonly<{
  rowKey: RowKey
  row: Row
}>

export type GridRowOrderChange<RowKey extends GridRowKey> = Readonly<{
  before: readonly RowKey[]
  after: readonly RowKey[]
}>

/**
 * Persistence-oriented changes derived from one accepted grid proposal.
 * Rows remain available on the request for document-style or replacement
 * APIs, while this change set maps directly to transactional CRUD writes.
 */
export type GridChangeSet<Row, RowKey extends GridRowKey> = Readonly<{
  inserted: readonly GridInsertedRow<Row, RowKey>[]
  updated: readonly GridUpdatedRow<Row, RowKey>[]
  deleted: readonly GridDeletedRow<Row, RowKey>[]
  order: GridRowOrderChange<RowKey> | null
}>

export type GridCommitRequest<Row, RowKey extends GridRowKey> = Readonly<{
  /** Complete proposed authority in its exact persistent row order. */
  rows: readonly Row[]
  /** Typed inserts, updates, deletes, and optional ordering intent. */
  changes: GridChangeSet<Row, RowKey>
  acceptedRowKeys: readonly RowKey[]
  deletedRowKeys: readonly RowKey[]
  /**
   * True when the proposal contains explicit local order intent: surviving
   * rows were reordered or an inserted row was positioned before a survivor.
   * A commit must preserve `rows` order even when this is false; false only
   * means append/delete semantics need no separate ordering operation.
   */
  orderChanged: boolean
  dirtyOriginals: readonly Readonly<{
    rowKey: RowKey
    columnKey: string
    originalValue: unknown
  }>[]
  draftRevision: number
  sourceVersion: GridSourceVersion
  operationId: string
}>

export type GridRowKeyRemap<RowKey extends GridRowKey> = Readonly<{
  /** Client-generated key used in the committed proposal. */
  from: RowKey
  /** Authoritative key assigned by the server. */
  to: RowKey
}>

export type GridCommitReceipt<
  Row,
  RowKey extends GridRowKey = never,
> = Readonly<{
  operationId: string
  applied: GridReadyDataSourceSnapshot<Row>
  /** Maps temporary inserted-row keys to keys assigned by the authority. */
  keyRemap?: readonly GridRowKeyRemap<RowKey>[]
}>

export type GridPersistenceCapability<Row, RowKey extends GridRowKey> = Readonly<{
  mode: GridPersistenceMode
  debounceMs?: number
  /**
   * Resolve with the exact applied authority. At resolution getSnapshot() may
   * still expose the request's sourceVersion, may expose applied, or may expose
   * a causally later snapshot. If it exposes any third opaque version, that
   * snapshot must have been published after applied; opaque versions are not
   * otherwise orderable by the controller. After a stale request base is
   * observed at settlement, the next publication must be applied or later.
   */
  commit: (
    request: GridCommitRequest<Row, RowKey>,
  ) => Promise<GridCommitReceipt<Row, RowKey>>
}>

export type GridCommitFailureKind =
  | 'unknown-outcome'
  | 'transient'
  | 'source-version-conflict'
  | 'not-applied'

export class GridCommitError extends Error {
  readonly kind: GridCommitFailureKind

  constructor(kind: GridCommitFailureKind, message: string) {
    super(message)
    this.name = 'GridCommitError'
    this.kind = kind
  }
}

export function isGridCommitError(error: unknown): error is GridCommitError {
  return error instanceof GridCommitError
}

export type GridRowCapabilities<Row> = Readonly<{
  create?: () => Row
  duplicate?: (source: Row) => Row
  canDelete?: (row: Row) => boolean
  /**
   * Declares that authoritative row order is writable and that commit()
   * persists the exact order of request.rows.
   */
  ordering?: 'mutable'
}>

export type GridDataSource<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema> = Readonly<{
  columns: readonly GridColumnForCellTypes<Row, Schema>[]
  getRowKey: (row: Row) => RowKey
  getSnapshot: () => GridDataSourceSnapshot<Row>
  subscribe: (listener: () => void) => () => void
  /** Required when rows are class instances or otherwise need custom cloning. */
  cloneRow?: (row: Row) => Row
  refresh?: (context: Readonly<{ signal: AbortSignal }>) => Promise<void> | void
  persistence: GridPersistenceCapability<Row, RowKey>
  rows?: GridRowCapabilities<Row>
}>

export function assertCompleteDataSourceSnapshot<Row>(snapshot: GridDataSourceSnapshot<Row>): void {
  if (snapshot.scope.kind !== 'complete') {
    throw new Error('Grid v2 currently accepts only complete data-source snapshots.')
  }

  if (snapshot.status === 'error' && !snapshot.error) {
    throw new Error('An error data-source snapshot must include a user-facing error message.')
  }
}

export function assertUniqueDataSourceRowKeys<Row, RowKey extends GridRowKey>(
  snapshot: GridDataSourceSnapshot<Row>,
  getRowKey: (row: Row) => RowKey,
): void {
  const keys = new Set<RowKey>()
  for (const row of snapshot.rows) {
    const rowKey = getRowKey(row)
    if (keys.has(rowKey)) {
      throw new Error(`The data source contains duplicate row key "${String(rowKey)}".`)
    }
    keys.add(rowKey)
  }
}
