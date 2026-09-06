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
import { createGridChangeSet } from '../data/change-set.js'
import type { GridPersistenceEffect, GridPersistenceEvent } from './persistence-effects.js'

import {
  initialGridPersistenceOperation,
  transitionGridPersistenceOperation,
  type GridCommitProposal as CommitProposal,
  type GridPersistenceOperationEvent,
  type GridPersistenceMachineState,
} from './persistence-machine.js'

export type GridPersistenceCoordinatorOptions<
  Row,
  RowKey extends GridRowKey,
> = Readonly<{
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  getControllerSnapshot: () => GridControllerSnapshot<Row, RowKey>
  getPublishedSnapshot: () => GridDataSourceSnapshot<Row>
  canRefresh: boolean
  emitEffect: (effect: GridPersistenceEffect<Row, RowKey>) => void
  reportRefreshError: (message: string) => void
  debounceMs?: number
  publish: (persistence: GridPersistenceState) => void
  applyRemote: (remote: GridDataSourceSnapshot<Row>) => void
  applyCommitted: (
    applied: GridReadyDataSourceSnapshot<Row>,
    latest: GridDataSourceSnapshot<Row>,
    committedRows: readonly Row[],
    committedDraftRevision: number,
    keyRemap: NonNullable<GridCommitReceipt<Row, RowKey>['keyRemap']>,
  ) => void
  isDestroyed: () => boolean
  ok: (payload?: unknown) => GridDispatchResult
  no: (reason: string) => GridDispatchResult
}>

export class GridPersistenceCoordinator<Row, RowKey extends GridRowKey> {
  readonly #options: GridPersistenceCoordinatorOptions<Row, RowKey>
  #scheduleToken: number | null = null
  #sequence = 0
  #operation = initialGridPersistenceOperation<Row, RowKey>()
  #refreshToken: number | null = null
  #refreshOperationId: string | null = null
  #awaitingPublication: GridPersistenceMachineState<Row, RowKey>['awaitingPublication'] = null

  constructor(options: GridPersistenceCoordinatorOptions<Row, RowKey>) {
    this.#options = options
  }

  /** Working state is copied in per Runtime input; this coordinator is not its owner. */
  restoreState(state: GridPersistenceMachineState<Row, RowKey>) {
    this.#operation = state.operation
    this.#scheduleToken = state.scheduleToken
    this.#refreshToken = state.refreshToken
    this.#refreshOperationId = state.refreshOperationId
    this.#awaitingPublication = state.awaitingPublication
    this.#sequence = state.sequence
  }

  captureState(): GridPersistenceMachineState<Row, RowKey> {
    return Object.freeze({
      operation: this.#operation,
      scheduleToken: this.#scheduleToken,
      refreshToken: this.#refreshToken,
      refreshOperationId: this.#refreshOperationId,
      awaitingPublication: this.#awaitingPublication,
      sequence: this.#sequence,
    })
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
      this.#scheduleEffect(0, false)
      return
    }
    this.#clearTimer()
    this.#publish({
      ...snapshot.persistence,
      status: 'scheduled',
      pendingDraftRevision: snapshot.draft.revision,
    })
    this.#scheduleEffect(this.#options.debounceMs ?? 800, false)
  }

  save() {
    if (this.#requiresRefresh) {
      return this.#options.no(
        'The previous save was applied, but the latest authority could not be reconciled. Refresh before saving again.',
      )
    }
    if (this.#inFlight) {
      this.schedule()
      return this.#options.ok({ queued: true })
    }
    const next = this.#retry ?? this.#proposal()
    if (!next) {
      this.schedule()
      return isDraftDirty(this.#snapshot())
        ? this.#options.no(
            'No changes can be saved until validation errors or conflicts are resolved.',
          )
        : this.#options.ok({ saved: false })
    }

    this.#clearTimer()
    this.#transition({ type: 'start', proposal: next })
    this.#publish({
      ...this.#snapshot().persistence,
      status: 'saving',
      inFlightOperationId: next.id,
      pendingDraftRevision: null,
      error: null,
      retryOperationId: null,
    })

    this.#options.emitEffect({ type: 'commit', proposal: next })
    return this.#options.ok({ operationId: next.id })
  }

  retry() {
    return this.#retry
      ? this.save()
      : this.#options.no(
          'This save was definitively rejected. Refresh or resolve conflicts, then save a new proposal.',
        )
  }

  refresh() {
    if (!this.#options.canRefresh) {
      return this.#options.no('This data source does not support refresh requests.')
    }
    this.#refreshToken = ++this.#sequence
    this.#refreshOperationId = this.#operation.status === 'applied-unreconciled'
      ? this.#operation.proposal.id : null
    this.#options.emitEffect({ type: 'refresh', token: this.#refreshToken })
    return this.#options.ok({ refreshing: true })
  }

  handleEvent(event: GridPersistenceEvent<Row, RowKey>) {
    if (this.#options.isDestroyed()) return
    switch (event.type) {
      case 'schedule/due':
        if (event.token !== this.#scheduleToken) return
        this.#scheduleToken = null
        if (event.retry) this.retry()
        else this.save()
        return
      case 'commit/failed':
        this.#settleCommitFailure(event.proposal, event.error)
        return
      case 'commit/received': {
        const { proposal, receipt } = event
        if (this.#inFlight?.id !== proposal.id) return
        const committing = this.#operation
        try {
          this.#settleReceipt(proposal, receipt)
        } catch (error) {
          // A receipt confirms application; local failure must never resend it.
          this.#operation = committing
          this.#transition({ type: 'unreconciled', operationId: proposal.id, receipt, error })
          this.#publish({
            ...this.#snapshot().persistence,
            status: 'failed',
            inFlightOperationId: null,
            pendingDraftRevision: this.#snapshot().draft.revision,
            error: error instanceof Error ? error.message : String(error),
            retryOperationId: null,
          })
        }
        return
      }
      case 'refresh/completed':
        if (event.token !== this.#refreshToken) return
        this.#refreshToken = null
        try {
          const remote = this.#options.getPublishedSnapshot()
          assertCompleteDataSourceSnapshot(remote)
          if (this.#requiresRefresh) this.#recoverReceipt(remote, this.#refreshOperationId)
          else {
            this.#applyRemoteIfChanged(remote)
            this.#transition({ type: 'authority-reconciled' })
          }
          this.schedule()
        } catch (error) {
          this.#reportRefreshFailure(error)
        }
        return
      case 'refresh/failed':
        if (event.token !== this.#refreshToken) return
        this.#refreshToken = null
        this.#reportRefreshFailure(event.error)
    }
  }

  #reportRefreshFailure(error: unknown) {
    try {
      const remote = this.#options.getPublishedSnapshot()
      if (remote.status === 'error') this.#applyRemoteIfChanged(remote)
      else this.#options.reportRefreshError(error instanceof Error ? error.message : String(error))
    } catch (readError) {
      this.#options.reportRefreshError(readError instanceof Error ? readError.message : String(readError))
    }
  }

  syncPublished(published?: GridDataSourceSnapshot<Row>) {
    try {
      const remote = published ?? this.#options.getPublishedSnapshot()
      assertCompleteDataSourceSnapshot(remote)
      if (this.#requiresRefresh) this.#recoverReceipt(remote)
      else this.#applyRemoteIfChanged(remote)
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

  #transition(event: GridPersistenceOperationEvent<Row, RowKey>) {
    this.#operation = transitionGridPersistenceOperation(this.#operation, event)
  }

  get #inFlight() {
    return this.#operation.status === 'committing' ? this.#operation.proposal : null
  }

  get #retry() {
    return this.#operation.status === 'outcome-unknown' ? this.#operation.proposal : null
  }

  get #requiresRefresh() {
    return this.#operation.status === 'applied-unreconciled'
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
    const proposal = {
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
    } as const
    const request: GridCommitRequest<Row, RowKey> = Object.freeze({
      ...proposal,
      changes: createGridChangeSet({
        ...proposal,
        sourceRows: snapshot.source.rows,
        columns: this.#options.columns,
        getRowKey: this.#options.getRowKey,
      }),
    })
    return { request, id }
  }

  #snapshot() {
    return this.#options.getControllerSnapshot()
  }

  #settleReceipt(
    proposal: CommitProposal<Row, RowKey>,
    receipt: GridCommitReceipt<Row, RowKey>,
    recovered?: GridReadyDataSourceSnapshot<Row>,
  ) {
    if (receipt.operationId !== proposal.id) {
      throw new Error('The commit receipt operation ID does not match the request.')
    }
    if (!recovered && receipt.reconciliationError !== undefined) throw new Error(receipt.reconciliationError)
    const applied = receipt.applied ?? recovered
    if (!applied) throw new Error('The write was applied, but its authority must be refreshed before saving again.')
    assertCompleteDataSourceSnapshot(applied)
    if (applied.status !== 'ready') {
      throw new Error('A commit receipt must contain a ready applied snapshot.')
    }
    if (Object.is(applied.version, proposal.request.sourceVersion)) {
      throw new Error(
        'A committed authority must publish a new opaque source version.',
      )
    }
    const keyRemap = validateKeyRemap(
      receipt.keyRemap ?? [],
      proposal.request,
      applied,
      this.#options.getRowKey,
    )
    const published = recovered ?? this.#options.getPublishedSnapshot()
    assertCompleteDataSourceSnapshot(published)
    if (
      Object.is(published.version, applied.version) &&
      !areGridAuthorityRowsEqual(
        published.rows,
        applied.rows,
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
    // A third opaque token needs causal evidence, not merely later arrival.
    if (!recovered && !Object.is(published.version, applied.version)
      && !Object.is(published.version, proposal.request.sourceVersion)
      && published.afterOperationId !== proposal.id) {
      throw new Error('The write was applied, but the published authority is not known to include it. Refresh authority before saving again.')
    }
    const latest = Object.is(
      published.version,
      proposal.request.sourceVersion,
    )
      ? applied
      : published
    this.#options.applyCommitted(
      applied,
      latest,
      proposal.request.rows,
      proposal.request.draftRevision,
      keyRemap,
    )
    this.#awaitingPublication = Object.is(published.version, proposal.request.sourceVersion)
      ? { operationId: proposal.id, sourceVersion: proposal.request.sourceVersion, appliedVersion: applied.version }
      : null
    this.#transition({ type: 'acknowledged', operationId: proposal.id })
    this.#publish({
      ...this.#snapshot().persistence,
      status: 'idle',
      inFlightOperationId: null,
      error: null,
      retryOperationId: null,
    })
    this.schedule()
  }

  #recoverReceipt(remote: GridDataSourceSnapshot<Row>, refreshedOperationId: string | null = null) {
    const operation = this.#operation
    if (operation.status !== 'applied-unreconciled' || remote.status !== 'ready') return
    // A status change or a read started before confirmation cannot recover a
    // write. Replay the retained proposal/receipt before accepting new saves.
    if (Object.is(remote.version, operation.proposal.request.sourceVersion)) return
    if (remote.afterOperationId !== operation.proposal.id
      && refreshedOperationId !== operation.proposal.id
      && !Object.is(remote.version, operation.receipt.applied?.version)) return
    this.#settleReceipt(operation.proposal, operation.receipt, { ...remote, status: 'ready' })
  }

  #settleCommitFailure(
    proposal: CommitProposal<Row, RowKey>,
    error: unknown,
  ) {
    if (
      this.#options.isDestroyed() ||
      this.#inFlight?.id !== proposal.id
    ) return
    const definitive =
      isGridCommitError(error) &&
      (error.kind === 'source-version-conflict' ||
        error.kind === 'not-applied')
    this.#transition({ type: 'failed', operationId: proposal.id, error, definitive })
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
    if (this.#inFlight || this.#retry || this.#requiresRefresh) {
      return
    }
    const waiting = this.#awaitingPublication
    if (waiting) {
      if (Object.is(remote.version, waiting.sourceVersion)) return
      if (!Object.is(remote.version, waiting.appliedVersion)
        && remote.afterOperationId !== waiting.operationId) {
        throw new Error('The published authority is not known to include the acknowledged write.')
      }
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
      this.#awaitingPublication = null
      return
    }
    this.#options.applyRemote(remote)
    this.#awaitingPublication = null
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
    this.#scheduleToken = null
    this.#options.emitEffect({ type: 'cancel-schedule' })
  }

  #scheduleEffect(delay: number, retry: boolean) {
    this.#scheduleToken = ++this.#sequence
    this.#options.emitEffect({ type: 'schedule', token: this.#scheduleToken, delay, retry })
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
      this.#scheduleEffect(0, true)
      return
    }
    this.#clearTimer()
    this.#publish({
      ...snapshot.persistence,
      status: 'scheduled',
      pendingDraftRevision: snapshot.draft.revision,
    })
    this.#scheduleEffect(this.#options.debounceMs ?? 800, true)
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

function validateKeyRemap<Row, RowKey extends GridRowKey>(
  remap: NonNullable<GridCommitReceipt<Row, RowKey>['keyRemap']>,
  request: GridCommitRequest<Row, RowKey>,
  applied: GridReadyDataSourceSnapshot<Row>,
  getRowKey: (row: Row) => RowKey,
) {
  const inserted = new Set(request.changes.inserted.map((item) => item.rowKey))
  const appliedKeys = new Set(applied.rows.map(getRowKey))
  const fromKeys = new Set<RowKey>()
  const toKeys = new Set<RowKey>()
  const normalized = remap.map((item) => {
    if (gridRowKeysEqual(item.from, item.to)) {
      throw new Error('A server row-key remap must change the row key.')
    }
    if (!inserted.has(item.from)) {
      throw new Error(
        `A server row-key remap references a row that was not inserted: "${String(item.from)}".`,
      )
    }
    if (fromKeys.has(item.from) || toKeys.has(item.to)) {
      throw new Error('A commit receipt contains duplicate server row-key remaps.')
    }
    if (!appliedKeys.has(item.to)) {
      throw new Error(
        `The applied snapshot does not contain remapped row key "${String(item.to)}".`,
      )
    }
    if (appliedKeys.has(item.from)) {
      throw new Error(
        `The applied snapshot still contains temporary row key "${String(item.from)}".`,
      )
    }
    fromKeys.add(item.from)
    toKeys.add(item.to)
    return Object.freeze({ from: item.from, to: item.to })
  })
  for (const insertedRow of request.changes.inserted) {
    if (
      !appliedKeys.has(insertedRow.rowKey) &&
      !fromKeys.has(insertedRow.rowKey)
    ) {
      throw new Error(
        `The applied snapshot replaced or omitted inserted row key "${String(insertedRow.rowKey)}" without a server row-key remap.`,
      )
    }
  }
  return Object.freeze(normalized)
}
