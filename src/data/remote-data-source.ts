import type { GridCellTypeSchema, GridColumnForCellTypes } from '../cell-types/contracts.js'
import type { StandardGridCellTypeSchema } from '../cell-types/standard-contracts.js'
import type {
  GridPersistenceMode,
  GridRowKey,
  GridSourceVersion,
} from '../model/grid-model.js'
import { areGridAuthorityRowsEqual } from './authority-snapshot.js'
import {
  assertCompleteDataSourceSnapshot,
  assertUniqueDataSourceRowKeys,
  type GridCommitRequest,
  type GridDataSource,
  type GridDataSourceSnapshot,
  type GridReadyDataSourceSnapshot,
  type GridRowCapabilities,
  type GridRowKeyRemap,
} from './data-source.js'

export type GridRemoteAuthority<Row> = Readonly<{
  rows: readonly Row[]
  version: GridSourceVersion
}>

export type GridRemoteLoadContext<Row> = Readonly<{
  reason: 'refresh' | 'after-mutation'
  current: GridDataSourceSnapshot<Row>
  signal: AbortSignal
  operationId?: string
}>

export type GridRemoteMutationResult<Row, RowKey extends GridRowKey> =
  | Readonly<{
      kind: 'applied'
      /** Exact rows and version returned by the successful authority write. */
      authority: GridRemoteAuthority<Row>
      keyRemap?: readonly GridRowKeyRemap<RowKey>[]
    }>
  | Readonly<{
      kind: 'reload'
      /** Reload authority after the mutation confirms success. */
      keyRemap?: readonly GridRowKeyRemap<RowKey>[]
    }>

export type CreateRemoteGridDataSourceOptions<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
> = Readonly<{
  columns: readonly GridColumnForCellTypes<Row, Schema>[]
  getRowKey: (row: Row) => RowKey
  initialSnapshot: GridDataSourceSnapshot<Row>
  cloneRow?: (row: Row) => Row
  rows?: GridRowCapabilities<Row>
  /**
   * Reads the complete authority. Required for refresh support and for
   * mutations that return `{ kind: 'reload' }`.
   */
  load?: (context: GridRemoteLoadContext<Row>) => Promise<GridRemoteAuthority<Row>>
  persistence: Readonly<{
    mode: GridPersistenceMode
    debounceMs?: number
    /**
     * Persist request.changes in one authoritative operation. Forward
     * request.operationId through the API and enforce its uniqueness at the
     * database boundary so retrying an unknown outcome cannot duplicate work.
     */
    mutate: (
      request: GridCommitRequest<Row, RowKey>,
    ) => Promise<GridRemoteMutationResult<Row, RowKey>>
  }>
}>

export type RemoteGridDataSource<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
> = GridDataSource<Row, RowKey, Schema> & Readonly<{
  /** Publish query/cache state without recreating the data-source identity. */
  publish: (snapshot: GridDataSourceSnapshot<Row>) => void
}>

/**
 * Creates a stable external store for API/database-backed grids. It keeps
 * loading, refresh, mutation, publication, and commit-receipt semantics in one
 * reusable adapter without depending on a particular query or backend client.
 * Standard columns use the standard cell-type schema when Schema is omitted.
 */
export function createRemoteGridDataSource<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema = StandardGridCellTypeSchema,
>(
  options: CreateRemoteGridDataSourceOptions<Row, RowKey, NoInfer<Schema>>,
): RemoteGridDataSource<Row, RowKey, Schema> {
  const listeners = new Set<() => void>()
  let snapshot = freezeSnapshot(options.initialSnapshot)
  let publicationRevision = 0
  validateSnapshot(snapshot, options.getRowKey)

  const publish = (next: GridDataSourceSnapshot<Row>) => {
    const normalized = freezeSnapshot(next)
    validateSnapshot(normalized, options.getRowKey)
    if (
      Object.is(snapshot.version, normalized.version) &&
      !areGridAuthorityRowsEqual(
        snapshot.rows,
        normalized.rows,
        options.getRowKey,
      )
    ) {
      throw new Error(
        'A remote data source cannot reuse one version for different authoritative rows.',
      )
    }
    snapshot = normalized
    publicationRevision += 1
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // One subscriber cannot prevent the authority publication from
        // reaching the remaining subscribers.
      }
    }
  }

  const load = async (
    reason: GridRemoteLoadContext<Row>['reason'],
    signal: AbortSignal,
    operationId?: string,
  ) => {
    if (!options.load) {
      throw new Error(
        reason === 'refresh'
          ? 'This remote data source does not define an authority loader.'
          : 'This mutation requires an authority reload, but no loader is configured.',
      )
    }
    const authority = await options.load({
      reason,
      current: snapshot,
      signal,
      ...(operationId === undefined ? {} : { operationId }),
    })
    if (signal.aborted) throw signal.reason
    return readySnapshot(authority)
  }

  const dataSource: RemoteGridDataSource<Row, RowKey, Schema> = {
    columns: options.columns,
    getRowKey: options.getRowKey,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish,
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
    ...(options.rows ? { rows: options.rows } : {}),
    ...(options.load ? {
      async refresh({ signal }: Readonly<{ signal: AbortSignal }>) {
        const before = snapshot
        publish(Object.freeze({
          rows: before.rows,
          version: before.version,
          scope: before.scope,
          status: before.status === 'loading' ? 'loading' : 'refreshing',
        }))
        const refreshingRevision = publicationRevision
        try {
          publish(await load('refresh', signal))
        } catch (error) {
          if (signal.aborted) return
          if (publicationRevision !== refreshingRevision) return
          publish(Object.freeze({
            rows: snapshot.rows,
            version: snapshot.version,
            scope: snapshot.scope,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }))
          throw error
        }
      },
    } : {}),
    persistence: {
      mode: options.persistence.mode,
      ...(options.persistence.debounceMs === undefined
        ? {}
        : { debounceMs: options.persistence.debounceMs }),
      async commit(request) {
        const result = await options.persistence.mutate(request)
        const applied = result.kind === 'applied'
          ? readySnapshot(result.authority)
          : await load(
              'after-mutation',
              new AbortController().signal,
              request.operationId,
            )
        publish(applied)
        return Object.freeze({
          operationId: request.operationId,
          applied,
          ...(result.keyRemap === undefined
            ? {}
            : { keyRemap: Object.freeze([...result.keyRemap]) }),
        })
      },
    },
  }
  return Object.freeze(dataSource)
}

/** Standard HTTP idempotency header for request.operationId. */
export function createGridIdempotencyHeaders(
  operationId: string,
  headerName = 'Idempotency-Key',
): Readonly<Record<string, string>> {
  if (!operationId) throw new Error('A grid operation ID cannot be empty.')
  if (!headerName) throw new Error('An idempotency header name cannot be empty.')
  return Object.freeze({ [headerName]: operationId })
}

function readySnapshot<Row>(
  authority: GridRemoteAuthority<Row>,
): GridReadyDataSourceSnapshot<Row> {
  return Object.freeze({
    rows: Object.freeze([...authority.rows]),
    version: authority.version,
    scope: Object.freeze({ kind: 'complete' as const }),
    status: 'ready' as const,
  })
}

function freezeSnapshot<Row>(
  snapshot: GridDataSourceSnapshot<Row>,
): GridDataSourceSnapshot<Row> {
  const base = {
    rows: Object.freeze([...snapshot.rows]),
    version: snapshot.version,
    scope: Object.freeze({ kind: 'complete' as const }),
  }
  return snapshot.status === 'error'
    ? Object.freeze({ ...base, status: 'error' as const, error: snapshot.error })
    : Object.freeze({ ...base, status: snapshot.status })
}

function validateSnapshot<Row, RowKey extends GridRowKey>(
  snapshot: GridDataSourceSnapshot<Row>,
  getRowKey: (row: Row) => RowKey,
) {
  assertCompleteDataSourceSnapshot(snapshot)
  assertUniqueDataSourceRowKeys(snapshot, getRowKey)
}
