import type { GridCloseBlocker } from './controller-lifecycle.js'
import type { GridIssue } from '../model/grid-result.js'
import type { ExactReceipt } from '../kernel/model.js'
import { canStartSave } from '../kernel/save-schedule.js'
import { submissionDispute, type KernelState } from '../kernel/state.js'
import type { GridPersistenceState, GridSaveRecovery } from '../model/grid-model.js'
export type { GridSaveRecovery } from '../model/grid-model.js'

export type GridSaveOutcome =
  | Readonly<{ status: 'no-changes' }>
  | Readonly<{ status: 'confirmed'; operationId: string }>
  | Readonly<{ status: 'partial'; operationId: string; excluded: readonly [GridIssue, ...GridIssue[]] }>
  | Readonly<{ status: 'blocked'; issue: GridIssue }>
  | Readonly<{ status: 'failed'; operationId: string | null; issue: GridIssue }>
  | Readonly<{ status: 'recovery-required'; write: 'unknown' | 'applied'; recovery: GridSaveRecovery; issue: GridIssue }>

export type GridSaveResult = GridSaveOutcome & Readonly<{
  remaining: readonly Exclude<GridCloseBlocker, 'command-running'>[]
}>

export type GridRefreshResult =
  | Readonly<{ status: 'refreshed' }>
  | Readonly<{ status: 'superseded' }>
  | Readonly<{ status: 'blocked'; issue: GridIssue }>
  | Readonly<{ status: 'failed'; issue: GridIssue }>

/** Completion correlation only. The kernel still owns the submission and all
 * write evidence. Exclusions are captured at freeze, never from later dirty. */
export type GridSaveAttempt = Readonly<{
  ticket: string | null
  operationId: string | null
  excluded: readonly GridIssue[]
  scheduleToken: number
  reviewedReceipt?: ExactReceipt
  retryAfterLookup: boolean
}>

export type GridPersistenceCompletion =
  | Readonly<{ type: 'persistence/complete'; kind: 'save'; ticket: string; result: GridSaveOutcome }>
  | Readonly<{ type: 'persistence/complete'; kind: 'refresh'; ticket: string; result: GridRefreshResult }>

/** Prepared/gateway failures belong to one generation of authored work.
 * Operation transport feedback belongs to the frozen request across later edits. */
export type GridSaveFeedback = Readonly<
  | { operationId: string; message: string }
  | { scheduleToken: number; message: string }
>

export function projectGridPersistence(data: KernelState, feedback: GridSaveFeedback | null,
  attempt: GridSaveAttempt | null): GridPersistenceState {
  const p = data.persistence, available = canStartSave(data)
  const operationId = 'submission' in p ? p.submission.operationId : null
  const ownFault = submissionDispute(data)
  const sharedFault = ownFault?.disputeId ? ownFault : data.protocolFaults.find(f => f.disputeId)
  const fault = sharedFault?.issue ?? data.protocolFaults[0]?.issue
  const feedbackApplies = feedback && ('operationId' in feedback
    ? feedback.operationId === operationId : p.kind === 'idle' && feedback.scheduleToken === data.schedule.token)
  const error = fault?.message ?? (feedbackApplies ? feedback.message : null) ??
    (p.kind === 'outcome-unknown' || p.kind === 'receipt-blocked' ? p.issue.message :
      p.kind === 'committed-awaiting-receipt' ? 'Saved remotely; waiting for its exact confirmation.' : null)
  let recovery: GridSaveRecovery | null = null
  if (!ownFault && !attempt?.ticket && operationId && p.kind !== 'sending') {
    let action: GridSaveRecovery['action'] = 'confirm'
    if (p.kind === 'committed-awaiting-authority') action = 'refresh'
    if (p.kind === 'receipt-blocked') {
      if (attempt?.reviewedReceipt !== p.receipt) action = 'review'
      else if (data.commits.some(fact => fact.submission.operationId === operationId)) action = 'refresh'
    }
    recovery = Object.freeze({ operationId, action })
  }
  return Object.freeze({
    revision: data.revision,
    mode: data.schedule.mode === 'manual' ? 'manual-save' : data.schedule.mode === 'immediate' ? 'immediate' : 'auto-save',
    status: attempt?.ticket && p.kind !== 'idle' && !fault ? 'saving'
      : error ? 'failed' : p.kind !== 'idle' ? 'saving' : data.schedule.pending ? 'scheduled' : 'idle',
    workspaceId: data.workspace.id, generation: data.schedule.token, inFlightOperationId: operationId,
    pendingDraftRevision: p.kind === 'idle' ? null : data.revision,
    dispute: sharedFault?.disputeId ? Object.freeze({ id: sharedFault.disputeId, operationId: sharedFault.operationId, message: sharedFault.issue.message }) : null,
    error, recovery, canStartSave: available, canRetrySave: available && !!feedbackApplies,
  })
}

export function gridRecoveryOutcome(data: KernelState, view: GridPersistenceState): GridSaveOutcome {
  const recovery = view.recovery
  const p = data.persistence
  if (!recovery) return { status: 'blocked', issue: data.protocolFaults.length
    ? { code: 'save-unresolved', message: data.protocolFaults[0]!.issue.message }
    : { code: 'no-recovery', message: 'There is no unresolved save to recover.' } }
  const reason = p.kind === 'outcome-unknown' || p.kind === 'receipt-blocked' ? p.issue : null
  return { status: 'recovery-required', recovery,
    write: p.kind === 'outcome-unknown' ? 'unknown' : 'applied',
    issue: Object.freeze({ code: 'save-unresolved', message: view.error ?? 'The original save still requires confirmation.',
      ...(reason ? { domainCode: reason.code } : {}) }) }
}
