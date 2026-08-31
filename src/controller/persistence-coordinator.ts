import {
  assertCompleteDataSourceSnapshot,
  isGridCommitError,
  type GridCommitRequest,
  type GridCommitReceipt,
  type GridDataSourceSnapshot,
  type GridReadyDataSourceSnapshot,
} from '../data/data-source.js'
import type {
  GridCompiledColumn,
  GridControllerSnapshot,
  GridPersistenceMode,
  GridPersistenceState,
  GridRowKey,
} from '../model/grid-model.js'
import type { GridDispatchResult } from './controller-contracts.js'
import { selectGridSavePlan } from './grid-selectors.js'
import { areGridAuthorityRowsEqual } from '../data/authority-snapshot.js'
import { gridRowKeysEqual } from '../model/row-key.js'

type CommitProposal<Row, RowKey extends GridRowKey> = Readonly<{
  request: GridCommitRequest<Row, RowKey>
  id: string
}>

export type GridPersistenceCoordinatorOptions<
  Row,
  RowKey extends GridRowKey,
> = Readonly<{
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  getControllerSnapshot: () => GridControllerSnapshot<Row, RowKey>
  getPublishedSnapshot: () => GridDataSourceSnapshot<Row>
  commit: (
    request: GridCommitRequest<Row, RowKey>,
  ) => Promise<GridCommitReceipt<Row>>
  requestRefresh?: (context: Readonly<{ signal: AbortSignal }>) =>
    | Promise<void>
    | void
  reportRefreshError: (message: string) => void
  debounceMs?: number
  publish: (persistence: GridPersistenceState) => void
  applyRemote: (remote: GridDataSourceSnapshot<Row>) => void
  applyCommitted: (
    applied: GridReadyDataSourceSnapshot<Row>,
    latest: GridDataSourceSnapshot<Row>,
    committedRows: readonly Row[],
    committedDraftRevision: number,
  ) => void
  isDestroyed: () => boolean
  ok: (payload?: unknown) => GridDispatchResult
  no: (reason: string) => GridDispatchResult
}>

export class GridPersistenceCoordinator<Row, RowKey extends GridRowKey> {
  readonly #options: GridPersistenceCoordinatorOptions<Row, RowKey>
  #timer: ReturnType<typeof setTimeout> | null = null
  #inFlight: CommitProposal<Row, RowKey> | null = null
  #retry: CommitProposal<Row, RowKey> | null = null
  #refresh: AbortController | null = null
  #requiresRefresh = false

  constructor(options: GridPersistenceCoordinatorOptions<Row, RowKey>) {
    this.#options = options
  }

  setMode(mode: GridPersistenceMode) {
    this.#clearTimer()
    const current = this.#snapshot().persistence
    this.#publish({
      ...current,
      mode,
      status: this.#inFlight ? 'saving' : current.status === 'failed' ? 'failed' : 'idle',
    })
    this.schedule()
    return this.#options.ok()
  }

  schedule() {
    const snapshot = this.#snapshot()
    if (this.#requiresRefresh) {
      this.#clearTimer()
      return
    }
    if (this.#retry) {
      this.#scheduleRetry(snapshot.persistence.mode)
      return
    }
    if (!isDraftDirty(snapshot)) {
      this.#clearTimer()
      if (!this.#inFlight && (
        snapshot.persistence.status !== 'idle'
        || snapshot.persistence.pendingDraftRevision !== null
        || snapshot.persistence.error !== null
        || snapshot.persistence.retryOperationId !== null
      )) {
        this.#publish({
          ...snapshot.persistence,
          status: 'idle',
          pendingDraftRevision: null,
          error: null,
          retryOperationId: null,
        })
      }
      return
    }
    if (
      !this.#inFlight &&
      !this.#retry &&
      !selectGridSavePlan(snapshot).canSave
    ) {
      this.#clearTimer()
      if (
        snapshot.persistence.status !== 'idle' ||
        snapshot.persistence.pendingDraftRevision !== null
      ) {
        this.#publish({
          ...snapshot.persistence,
          status: 'idle',
          pendingDraftRevision: null,
        })
      }
      return
    }
    if (snapshot.persistence.mode === 'manual-save' || this.#inFlight) {
      this.#publish({
        ...snapshot.persistence,
        pendingDraftRevision: snapshot.draft.revision,
      })
      return
    }
    if (snapshot.persistence.mode === 'immediate') {
      queueMicrotask(() => {
        if (!this.#options.isDestroyed()) this.save()
      })
      return
    }
    this.#clearTimer()
    this.#publish({
      ...snapshot.persistence,
      status: 'scheduled',
      pendingDraftRevision: snapshot.draft.revision,
    })
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (!this.#options.isDestroyed()) this.save()
    }, this.#options.debounceMs ?? 800)
  }

  save(next = this.#proposal()) {
    if (this.#requiresRefresh) {
      return this.#options.no(
        'The previous save was applied, but the latest authority could not be reconciled. Refresh before saving again.',
      )
    }
    if (this.#inFlight) {
      this.schedule()
      return this.#options.ok({ queued: true })
    }
    if (!next) {
      this.schedule()
      return isDraftDirty(this.#snapshot())
        ? this.#options.no(
            'No changes can be saved until validation errors or conflicts are resolved.',
          )
        : this.#options.ok({ saved: false })
    }

    this.#clearTimer()
    this.#inFlight = next
    this.#retry = null
    this.#publish({
      ...this.#snapshot().persistence,
      status: 'saving',
      inFlightOperationId: next.id,
      pendingDraftRevision: null,
      error: null,
      retryOperationId: null,
    })

    void Promise.resolve()
      .then(() => this.#options.commit(next.request))
      .then(
        (receipt) => {
          if (this.#options.isDestroyed() || this.#inFlight?.id !== next.id)
            return
          try {
            this.#settleReceipt(next, receipt)
          } catch (error) {
            // A receipt confirms that the authority applied this operation.
            // Local reconciliation failure must never resubmit that operation.
            this.#inFlight = null
            this.#retry = null
            this.#requiresRefresh = true
            this.#publish({
              ...this.#snapshot().persistence,
              status: 'failed',
              inFlightOperationId: null,
              pendingDraftRevision: this.#snapshot().draft.revision,
              error: error instanceof Error ? error.message : String(error),
              retryOperationId: null,
            })
          }
        },
        (error: unknown) => this.#settleCommitFailure(next, error),
      )
    return this.#options.ok({ operationId: next.id })
  }

  retry() {
    return this.#retry
      ? this.save(this.#retry)
      : this.#options.no(
          'This save was definitively rejected. Refresh or resolve conflicts, then save a new proposal.',
        )
  }

  refresh() {
    if (!this.#options.requestRefresh) {
      return this.#options.no('This data source does not support refresh requests.')
    }
    this.#refresh?.abort()
    const active = new AbortController()
    this.#refresh = active
    void Promise.resolve()
      .then(() => this.#options.requestRefresh?.({ signal: active.signal }))
      .then(() => {
        if (active.signal.aborted || this.#options.isDestroyed()) return
        this.#refresh = null
        const remote = this.#options.getPublishedSnapshot()
        assertCompleteDataSourceSnapshot(remote)
        this.#applyRemoteIfChanged(remote)
        this.#requiresRefresh = false
        this.schedule()
      })
      .catch((error: unknown) => {
        if (active.signal.aborted || this.#options.isDestroyed()) return
        this.#refresh = null
        try {
          const remote = this.#options.getPublishedSnapshot()
          if (remote.status === 'error') this.#applyRemoteIfChanged(remote)
          else {
            this.#options.reportRefreshError(
              error instanceof Error ? error.message : String(error),
            )
          }
        } catch (readError) {
          this.#options.reportRefreshError(
            readError instanceof Error
              ? readError.message
              : String(readError),
          )
        }
      })
    return this.#options.ok({ refreshing: true })
  }

  syncPublished() {
    try {
      const remote = this.#options.getPublishedSnapshot()
      assertCompleteDataSourceSnapshot(remote)
      this.#applyRemoteIfChanged(remote)
      if (this.#requiresRefresh) this.#requiresRefresh = false
      this.schedule()
      return this.#options.ok()
    } catch (error) {
      this.#options.reportRefreshError(
        'Rows could not be reconciled with the current draft.',
      )
      return this.#options.no(
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  destroy() {
    this.#clearTimer()
    this.#inFlight = null
    this.#retry = null
    this.#requiresRefresh = false
    this.#refresh?.abort()
    this.#refresh = null
  }

  #proposal(): CommitProposal<Row, RowKey> | null {
    const snapshot = this.#snapshot()
    if (!isDraftDirty(snapshot)) return null
    const blockedRows = new Set<RowKey>([
      ...snapshot.draft.conflicts.map((item) => item.rowKey),
      ...snapshot.draft.validationIssues.map((item) => item.rowKey),
    ])
    const savePlan = selectGridSavePlan(snapshot)
    const acceptedRowKeys = savePlan.saveableRowKeys
    const deletedRowKeys = savePlan.saveableDeletedRowKeys
    if (
      acceptedRowKeys.length === 0 &&
      deletedRowKeys.length === 0 &&
      !savePlan.orderChanged
    ) return null
    const id = crypto.randomUUID()
    const request: GridCommitRequest<Row, RowKey> = Object.freeze({
      rows: savePlan.proposedRows,
      acceptedRowKeys: Object.freeze(acceptedRowKeys),
      deletedRowKeys: Object.freeze(deletedRowKeys),
      orderChanged: savePlan.orderChanged,
      dirtyOriginals: Object.freeze(
        snapshot.draft.dirtyCells
          .filter((item) => !blockedRows.has(item.rowKey))
          .map((item) => ({
            rowKey: item.rowKey,
            columnKey: item.columnKey,
            originalValue: item.originalValue,
          })),
      ),
      draftRevision: snapshot.draft.revision,
      sourceVersion: snapshot.source.version,
      operationId: id,
    })
    return { request, id }
  }

  #snapshot() {
    return this.#options.getControllerSnapshot()
  }

  #settleReceipt(
    proposal: CommitProposal<Row, RowKey>,
    receipt: GridCommitReceipt<Row>,
  ) {
    if (receipt.operationId !== proposal.id) {
      throw new Error('The commit receipt operation ID does not match the request.')
    }
    assertCompleteDataSourceSnapshot(receipt.applied)
    if (receipt.applied.status !== 'ready') {
      throw new Error('A commit receipt must contain a ready applied snapshot.')
    }
    if (Object.is(receipt.applied.version, proposal.request.sourceVersion)) {
      throw new Error(
        'A committed authority must publish a new opaque source version.',
      )
    }
    const published = this.#options.getPublishedSnapshot()
    assertCompleteDataSourceSnapshot(published)
    if (
      Object.is(published.version, receipt.applied.version) &&
      !areGridAuthorityRowsEqual(
        published.rows,
        receipt.applied.rows,
        this.#options.getRowKey,
      )
    ) {
      throw new Error(
        'The data source reused one version for different authoritative snapshots.',
      )
    }
    if (Object.is(published.version, proposal.request.sourceVersion)) {
      const requestBase = this.#snapshot().source
      if (
        !Object.is(requestBase.version, proposal.request.sourceVersion) ||
        !areGridAuthorityRowsEqual(
          published.rows,
          requestBase.rows,
          this.#options.getRowKey,
        )
      ) {
        throw new Error(
          'The data source reused the request source version for different authoritative rows.',
        )
      }
    }
    // Some data sources resolve the commit promise before their subscription
    // publishes the applied snapshot. In that interval getSnapshot() still
    // returns the request base; it is stale, not a newer authority. Opaque
    // versions cannot be ordered, so only this exact base token is ignored.
    // Any third token is accepted under the data-source contract that it is a
    // causally later publication than the receipt's applied snapshot.
    const latest = Object.is(
      published.version,
      proposal.request.sourceVersion,
    )
      ? receipt.applied
      : published
    this.#options.applyCommitted(
      receipt.applied,
      latest,
      proposal.request.rows,
      proposal.request.draftRevision,
    )
    this.#inFlight = null
    this.#retry = null
    this.#publish({
      ...this.#snapshot().persistence,
      status: 'idle',
      inFlightOperationId: null,
      error: null,
      retryOperationId: null,
    })
    this.schedule()
  }

  #settleCommitFailure(
    proposal: CommitProposal<Row, RowKey>,
    error: unknown,
  ) {
    if (
      this.#options.isDestroyed() ||
      this.#inFlight?.id !== proposal.id
    ) return
    this.#inFlight = null
    const definitive =
      isGridCommitError(error) &&
      (error.kind === 'source-version-conflict' ||
        error.kind === 'not-applied')
    this.#retry = definitive ? null : proposal
    if (definitive) {
      try {
        const remote = this.#options.getPublishedSnapshot()
        assertCompleteDataSourceSnapshot(remote)
        this.#applyRemoteIfChanged(remote)
      } catch {
        // Preserve the commit error. A later explicit refresh can recover.
      }
      const recovered = this.#snapshot()
      const sourceAdvanced = !Object.is(
        recovered.source.version,
        proposal.request.sourceVersion,
      )
      if (
        sourceAdvanced &&
        recovered.draft.conflicts.length === 0 &&
        recovered.draft.validationIssues.length === 0
      ) {
        this.#publish({
          ...recovered.persistence,
          status: 'idle',
          inFlightOperationId: null,
          error: null,
          retryOperationId: null,
        })
        this.schedule()
        return
      }
    }
    this.#publish({
      ...this.#snapshot().persistence,
      status: 'failed',
      inFlightOperationId: null,
      pendingDraftRevision: this.#snapshot().draft.revision,
      error: error instanceof Error ? error.message : String(error),
      retryOperationId: definitive ? null : proposal.id,
    })
  }

  #applyRemoteIfChanged(remote: GridDataSourceSnapshot<Row>) {
    if (this.#inFlight || this.#retry) {
      return
    }
    const source = this.#snapshot().source
    if (
      source.status === remote.status &&
      source.error === (remote.error ?? null) &&
      Object.is(source.version, remote.version) &&
      source.rows.length === remote.rows.length &&
      source.rows.every((row, index) => {
        const candidate = remote.rows[index]
        return (
          candidate !== undefined &&
          gridRowKeysEqual(
            this.#options.getRowKey(row),
            this.#options.getRowKey(candidate),
          ) &&
          areGridAuthorityRowsEqual(
            [row],
            [candidate],
            this.#options.getRowKey,
          )
        )
      })
    ) {
      return
    }
    this.#options.applyRemote(remote)
  }

  #publish(
    state: Omit<GridPersistenceState, 'revision'> & { revision?: number },
  ) {
    const current = this.#snapshot().persistence
    this.#options.publish(
      Object.freeze({
        ...state,
        revision: current.revision + 1,
      }),
    )
  }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #scheduleRetry(mode: GridPersistenceMode) {
    const snapshot = this.#snapshot()
    if (mode === 'manual-save') {
      this.#publish({
        ...snapshot.persistence,
        pendingDraftRevision: snapshot.draft.revision,
      })
      return
    }
    if (mode === 'immediate') {
      queueMicrotask(() => {
        if (!this.#options.isDestroyed()) this.retry()
      })
      return
    }
    this.#clearTimer()
    this.#publish({
      ...snapshot.persistence,
      status: 'scheduled',
      pendingDraftRevision: snapshot.draft.revision,
    })
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (!this.#options.isDestroyed()) this.retry()
    }, this.#options.debounceMs ?? 800)
  }
}

function isDraftDirty<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
) {
  return (
    snapshot.draft.dirtyCells.length > 0 ||
    snapshot.draft.insertedRowKeys.length > 0 ||
    snapshot.draft.deletedRowKeys.length > 0 ||
    snapshot.draft.orderDirty
  )
}
