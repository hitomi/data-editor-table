import type { GridCommitReceipt, GridCommitRequest } from '../data/data-source.js'
import type { GridRowKey } from '../model/grid-model.js'

export type GridCommitProposal<Row, RowKey extends GridRowKey> = Readonly<{
  request: GridCommitRequest<Row, RowKey>
  id: string
}>

/** Mutually exclusive commit outcomes; resource handles do not belong here. */
export type GridPersistenceOperation<Row, RowKey extends GridRowKey> =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'committing'; proposal: GridCommitProposal<Row, RowKey> }>
  | Readonly<{ status: 'outcome-unknown'; proposal: GridCommitProposal<Row, RowKey>; error: unknown }>
  | Readonly<{ status: 'rejected'; proposal: GridCommitProposal<Row, RowKey>; error: unknown }>
  | Readonly<{
      status: 'applied-unreconciled'
      proposal: GridCommitProposal<Row, RowKey>
      receipt: GridCommitReceipt<Row, RowKey>
      error: unknown
    }>

export type GridPersistenceOperationEvent<Row, RowKey extends GridRowKey> =
  | Readonly<{ type: 'start'; proposal: GridCommitProposal<Row, RowKey> }>
  | Readonly<{ type: 'acknowledged'; operationId: string }>
  | Readonly<{ type: 'failed'; operationId: string; error: unknown; definitive: boolean }>
  | Readonly<{ type: 'unreconciled'; operationId: string; receipt: GridCommitReceipt<Row, RowKey>; error: unknown }>
  | Readonly<{ type: 'authority-reconciled' }>

export type GridPersistenceMachineState<Row, RowKey extends GridRowKey> = Readonly<{
  operation: GridPersistenceOperation<Row, RowKey>
  scheduleToken: number | null
  refreshToken: number | null
  sequence: number
}>

export function initialGridPersistenceMachineState<Row, RowKey extends GridRowKey>(): GridPersistenceMachineState<Row, RowKey> {
  return Object.freeze({
    operation: initialGridPersistenceOperation<Row, RowKey>(),
    scheduleToken: null, refreshToken: null, sequence: 0,
  })
}

export function initialGridPersistenceOperation<Row, RowKey extends GridRowKey>(): GridPersistenceOperation<Row, RowKey> {
  return Object.freeze({ status: 'idle' })
}

/** Stale completions and invalid transitions preserve identity. No I/O or publication. */
export function transitionGridPersistenceOperation<Row, RowKey extends GridRowKey>(
  current: GridPersistenceOperation<Row, RowKey>,
  event: GridPersistenceOperationEvent<Row, RowKey>,
): GridPersistenceOperation<Row, RowKey> {
  if (event.type === 'authority-reconciled') {
    // A refresh cannot establish whether an unknown operation was applied.
    return current.status === 'rejected' || current.status === 'applied-unreconciled'
      ? initialGridPersistenceOperation() : current
  }
  if (event.type === 'start') {
    if (current.status === 'committing' || current.status === 'applied-unreconciled') return current
    if (current.status === 'outcome-unknown' && current.proposal !== event.proposal) return current
    return Object.freeze({ status: 'committing', proposal: event.proposal })
  }
  if (current.status !== 'committing' || current.proposal.id !== event.operationId) return current
  switch (event.type) {
    case 'acknowledged': return initialGridPersistenceOperation()
    case 'failed': return Object.freeze({
      status: event.definitive ? 'rejected' : 'outcome-unknown',
      proposal: current.proposal,
      error: event.error,
    })
    case 'unreconciled': return Object.freeze({
      status: 'applied-unreconciled',
      proposal: current.proposal,
      receipt: event.receipt,
      error: event.error,
    })
  }
}
