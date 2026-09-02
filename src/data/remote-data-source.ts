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
  const commitWaiters = new Set<() => void>()
  let snapshot = freezeSnapshot(options.initialSnapshot)
  let activeCommits = 0
  let commitTail: Promise<void> = Promise.resolve()
  let authorityRevision = 0
  let commitSequence = 0
  let refreshSequence = 0
  let activeRefresh: Readonly<{
    id: number
    before: GridDataSourceSnapshot<Row>
    startingAuthorityRevision: number
  }> | null = null
  validateSnapshot(snapshot, options.getRowKey)

  const publishSnapshot = (
    next: GridDataSourceSnapshot<Row>,
    authoritative: boolean | 'when-changed',
  ) => {
    const normalized = freezeSnapshot(next)
    validateSnapshot(normalized, options.getRowKey)
    const sameVersion = Object.is(snapshot.version, normalized.version)
    if (sameVersion) {
      const sameRows = areGridAuthorityRowsEqual(
        snapshot.rows,
        normalized.rows,
        options.getRowKey,
      )
      if (!sameRows) {
        throw new Error(
          'A remote data source cannot reuse one version for different authoritative rows.',
        )
      }
    }
    snapshot = normalized
    if (authoritative === true || authoritative === 'when-changed' && !sameVersion) {
      authorityRevision += 1
    }
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // One subscriber cannot prevent the authority publication from
        // reaching the remaining subscribers.
      }
    }
  }
  const publish = (next: GridDataSourceSnapshot<Row>) => {
    refreshSequence += 1
    activeRefresh = null
    publishSnapshot(next, 'when-changed')
  }
  const waitForCommits = (signal: AbortSignal) =>
    activeCommits === 0 || signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const settled = () => {
          signal.removeEventListener('abort', settled)
          commitWaiters.delete(settled)
          resolve()
        }
        commitWaiters.add(settled)
        signal.addEventListener('abort', settled, { once: true })
      })
  const settleCommit = () => {
    activeCommits -= 1
    if (activeCommits !== 0) return
    for (const resolve of commitWaiters) resolve()
    commitWaiters.clear()
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
        while (activeCommits > 0) {
          await waitForCommits(signal)
          if (signal.aborted) return
        }
        if (signal.aborted) return
        const before = activeRefresh?.before ?? snapshot
        const refreshId = ++refreshSequence
        const startingAuthorityRevision = authorityRevision
        const startingCommitSequence = commitSequence
        activeRefresh = Object.freeze({
          id: refreshId,
          before,
          startingAuthorityRevision,
        })
        const isCurrent = () =>
          refreshId === refreshSequence &&
          authorityRevision === startingAuthorityRevision &&
          commitSequence === startingCommitSequence
        publishSnapshot(Object.freeze({
          rows: before.rows,
          version: before.version,
          scope: before.scope,
          status: before.status === 'loading' ? 'loading' : 'refreshing',
        }), false)
        try {
          const refreshed = await load('refresh', signal)
          if (!isCurrent()) return
          activeRefresh = null
          publishSnapshot(refreshed, true)
        } catch (error) {
          if (!isCurrent()) return
          activeRefresh = null
          if (signal.aborted) {
            publishSnapshot(before, false)
            return
          }
          publishSnapshot(Object.freeze({
            rows: snapshot.rows,
            version: snapshot.version,
            scope: snapshot.scope,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }), true)
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
        const pendingRefresh = activeRefresh
        refreshSequence += 1
        activeRefresh = null
        if (
          pendingRefresh &&
          authorityRevision === pendingRefresh.startingAuthorityRevision
        ) {
          publishSnapshot(pendingRefresh.before, false)
        }
        commitSequence += 1
        const hasEarlierCommit = activeCommits > 0
        activeCommits += 1
        const execute = async () => {
          const startingAuthorityRevision = authorityRevision
          const result = await options.persistence.mutate(request)
          const applied = result.kind === 'applied'
            ? readySnapshot(result.authority)
            : await load(
                'after-mutation',
                new AbortController().signal,
                request.operationId,
              )
          if (authorityRevision === startingAuthorityRevision) {
            publishSnapshot(applied, true)
          }
          return Object.freeze({
            operationId: request.operationId,
            applied,
            ...(result.keyRemap === undefined
              ? {}
              : { keyRemap: Object.freeze([...result.keyRemap]) }),
          })
        }
        const committing = hasEarlierCommit
          ? commitTail.then(execute)
          : execute()
        commitTail = committing.then(
          () => undefined,
          () => undefined,
        )
        try {
          return await committing
        } finally {
          settleCommit()
        }
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
