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
  /** After a write, changed authority must prove afterOperationId; async reads use beginRead. */
  publish: (snapshot: GridDataSourceSnapshot<Row>) => void
  /** Capture BEFORE an external async read. False means a write/read superseded it; refetch. */
  beginRead: () => Readonly<{
    afterOperationId: string | undefined
    publish: (snapshot: GridDataSourceSnapshot<Row>) => boolean
  }>
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
  let readGeneration = 0
  let confirmedOperationId: string | undefined
  let confirmedSourceVersion: GridSourceVersion | undefined
  let pendingAuthorityOperationId: string | undefined
  let activeRefresh: Readonly<{
    id: number
    before: GridDataSourceSnapshot<Row>
    startingAuthorityRevision: number
  }> | null = null
  validateSnapshot(snapshot, options.getRowKey)

  const prepareSnapshot = (
    next: GridDataSourceSnapshot<Row>,
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
    return Object.freeze({ normalized, sameVersion })
  }
  const publishPreparedSnapshot = (
    prepared: ReturnType<typeof prepareSnapshot>,
    authoritative: boolean | 'when-changed',
  ) => {
    snapshot = prepared.normalized
    const { sameVersion } = prepared
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
  const publishSnapshot = (
    next: GridDataSourceSnapshot<Row>,
    authoritative: boolean | 'when-changed',
  ) => {
    publishPreparedSnapshot(prepareSnapshot(next), authoritative)
  }
  const publish = (next: GridDataSourceSnapshot<Row>) => {
    const prepared = prepareSnapshot(next)
    if (confirmedOperationId !== undefined && next.afterOperationId === confirmedOperationId
      && Object.is(next.version, confirmedSourceVersion) && next.status === 'ready') {
      throw new Error('The authority read still exposes the base of a confirmed write. Read authority again before publishing it.')
    }
    if (activeCommits === 0 && confirmedOperationId !== undefined
      && !prepared.sameVersion && next.afterOperationId !== confirmedOperationId) {
      throw new Error('An external publication after a write must include afterOperationId. Use beginRead() before fetching, or refresh through the data source.')
    }
    refreshSequence += 1
    activeRefresh = null
    readGeneration += 1
    publishPreparedSnapshot(prepared, 'when-changed')
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
    if (operationId === confirmedOperationId && confirmedOperationId !== undefined
      && Object.is(authority.version, confirmedSourceVersion)) {
      throw new Error('The authority read still exposes the base of a confirmed write. Read authority again before publishing it.')
    }
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
    beginRead() {
      const generation = ++readGeneration
      const duringCommit = activeCommits > 0
      const operationId = confirmedOperationId
      return Object.freeze({
        afterOperationId: operationId,
        publish(next: GridDataSourceSnapshot<Row>) {
          if (duringCommit || activeCommits > 0 || generation !== readGeneration) return false
          publish(operationId === undefined ? next : { ...next, afterOperationId: operationId })
          return true
        },
      })
    },
    ...(options.cloneRow ? { cloneRow: options.cloneRow } : {}),
    ...(options.rows ? { rows: options.rows } : {}),
    ...(options.load ? {
      async refresh({ signal }: Readonly<{ signal: AbortSignal }>) {
        while (activeCommits > 0) {
          await waitForCommits(signal)
          if (signal.aborted) return
        }
        if (signal.aborted) return
        readGeneration += 1
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
          ...(before.afterOperationId === undefined ? {} : { afterOperationId: before.afterOperationId }),
          status: before.status === 'loading' ? 'loading' : 'refreshing',
        }), false)
        try {
          const operationId = pendingAuthorityOperationId ?? confirmedOperationId
          const refreshed = await load(pendingAuthorityOperationId ? 'after-mutation' : 'refresh', signal, operationId)
          if (!isCurrent()) return
          activeRefresh = null
          publishSnapshot(operationId ? { ...refreshed, afterOperationId: operationId } : refreshed, true)
          pendingAuthorityOperationId = undefined
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
            ...(snapshot.afterOperationId === undefined ? {} : { afterOperationId: snapshot.afterOperationId }),
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
        readGeneration += 1
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
          const result = await options.persistence.mutate(request)
          confirmedOperationId = request.operationId
          confirmedSourceVersion = request.sourceVersion
          // Once mutate resolves, read/publication failures must never resend it.
          let confirmation: Readonly<{ operationId: string; keyRemap?: readonly GridRowKeyRemap<RowKey>[] }> = { operationId: request.operationId }
          let applied: GridReadyDataSourceSnapshot<Row> | null = null
          pendingAuthorityOperationId = request.operationId
          try {
            confirmation = {
              ...confirmation,
              ...(result.keyRemap === undefined ? {} : { keyRemap: Object.freeze([...result.keyRemap]) }),
            }
            const received = result.kind === 'applied'
              ? readySnapshot(result.authority)
              : await load('after-mutation', new AbortController().signal, request.operationId)
            validateSnapshot(received, options.getRowKey)
            if (Object.is(received.version, request.sourceVersion)) {
              throw new Error('The authority read did not include the confirmed write. Refresh from a source that provides read-after-write consistency.')
            }
            applied = received
            const sameApplied = Object.is(snapshot.version, applied.version)
            if (sameApplied && !areGridAuthorityRowsEqual(snapshot.rows, applied.rows, options.getRowKey)) {
              throw new Error('The data source reused one version for different authoritative snapshots.')
            }
            const provenLater = snapshot.afterOperationId === request.operationId
            const ambiguous = !sameApplied && !Object.is(snapshot.version, request.sourceVersion) && !provenLater
            if (result.kind === 'reload' || !provenLater) {
              if (ambiguous && result.kind === 'applied' && !options.load) {
                throw new Error('The write was applied, but concurrent authority could not be ordered. Publish authority read after this operation or configure an authority loader and refresh.')
              }
              const latest = ambiguous && result.kind === 'applied'
                ? await load('after-mutation', new AbortController().signal, request.operationId)
                : applied
              if (Object.is(latest.version, request.sourceVersion)) {
                throw new Error('The authority read did not include the confirmed write. Refresh from a source that provides read-after-write consistency.')
              }
              // The loader must read after this write, including on replicas.
              // External reads crossing this interval need beginRead fencing.
              if (snapshot.afterOperationId !== request.operationId) {
                publishSnapshot({ ...latest, afterOperationId: request.operationId }, true)
              }
            }
            pendingAuthorityOperationId = undefined
            return Object.freeze({ ...confirmation, applied })
          } catch (error) {
            const reconciliationError = error instanceof Error ? error.message : String(error)
            return Object.freeze({ ...confirmation, applied, reconciliationError })
          }
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
          readGeneration += 1
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
    ...(snapshot.afterOperationId === undefined ? {} : { afterOperationId: snapshot.afterOperationId }),
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
