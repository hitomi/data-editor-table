import { ownEncodedValue } from './document.js'
import type { DurableStatus } from './durable-commit.js'
import type { CloseAssessment } from './lifecycle.js'
import type { DurableTaskRef, FrozenSubmission, PreparedStorageCommit, TaskDefinitionRef } from './model.js'
import type { KernelState } from './state.js'

export type RecoveryReservation = Readonly<{ kind: 'submission'; submission: FrozenSubmission }>
  | Readonly<{ kind: 'gateway-wait'; ticket: string }>
export type RecoveryCandidate = Readonly<{ kind: 'storage'; commit: PreparedStorageCommit }>
  | RecoveryReservation
  | Readonly<{ kind: 'task'; ref: DurableTaskRef; definitionAvailable: boolean }>
export type RecoveryPlan = Readonly<{
  assessment: CloseAssessment
  candidates: readonly RecoveryCandidate[]
}>

/** Whole-root recovery inventory. The last record's effects are insufficient:
 * later input can supersede the outbox record without resolving its operation.
 * Queries preserve exact request identity; all manual work stays in assessment. */
export function planRecovery(state: KernelState, assessment: CloseAssessment, storage: DurableStatus | null,
  reservation: RecoveryReservation | null, hasDefinition: (ref: TaskDefinitionRef) => boolean): RecoveryPlan {
  const candidates: RecoveryCandidate[] = []
  if (storage?.kind === 'unknown') candidates.push({ kind: 'storage', commit: storage.record.commit })
  if ('submission' in state.persistence) candidates.push({ kind: 'submission', submission: state.persistence.submission })
  else if (reservation) candidates.push(reservation)
  else if (state.persistence.kind === 'waiting-for-gateway') candidates.push({ kind: 'gateway-wait', ticket: state.persistence.ticket })
  for (const task of state.tasks) {
    if (!task.execution || task.execution.outcome?.kind === 'succeeded' || task.execution.outcome?.kind === 'failed') continue
    candidates.push({ kind: 'task', ref: task.execution.request.ref, definitionAvailable: hasDefinition(task.execution.request.ref.definition) })
  }
  return ownEncodedValue({ assessment, candidates }) as unknown as RecoveryPlan
}
