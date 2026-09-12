import type { DurableStatus } from './durable-commit.js'
import type { CheckpointToken } from './checkpoint-store.js'
import type { IngressSnapshot } from './ingress.js'
import { ownEncodedValue } from './document.js'
import type { CloseBlocker, CloseTicket, IntentId, KernelIssue } from './model.js'
import type { KernelProjection } from './projection.js'
import type { KernelState } from './state.js'

export type WorkspaceLifecycle = 'open' | 'closing' | 'closed' | 'fenced'
export type CloseAssessment = Readonly<{
  lifecycle: WorkspaceLifecycle
  ticket: CloseTicket
  blockers: readonly CloseBlocker[]
  /** Reversible neutral history requires no source write. Closing it does not
   * turn its inputs into server-confirmed settlements. */
  neutralIntentIds: readonly IntentId[]
}>
export type CloseResult = Readonly<{ kind: 'closed' | 'retained'; assessment: CloseAssessment; checkpoint?: CheckpointToken }>
  | Readonly<{ kind: 'blocked'; reason: 'stale' | 'work' | 'inactive' | 'checkpoint-failed' | 'release-failed'; assessment: CloseAssessment; issue?: KernelIssue }>

/** A projection of semantic AND runtime ownership. It never cancels work or
 * interprets an empty visible grid, AbortSignal, or unknown outcome as proof. */
export function assessClose(state: KernelState, projection: KernelProjection, ingress: IngressSnapshot, runtime: Readonly<{
  lifecycle: WorkspaceLifecycle
  leaseEpoch: string
  generation: number
  activities: readonly string[]
  storage: DurableStatus | null
  reservation: string | null
}>): CloseAssessment {
  const blockers: CloseBlocker[] = []
  const add = (kind: CloseBlocker['kind'], id: string, message: string) => blockers.push({ kind, id, message })
  const settled = new Set(state.settlements.map(proof => proof.intentId)), neutral = new Set(projection.neutralIntentIds)
  for (const intent of state.journal.intents) if (!settled.has(intent.id) && !neutral.has(intent.id))
    add('intent', intent.id, 'An authored contribution still requires settlement or an explicit disposition.')
  if (state.session) add('session', state.session.id, 'The session still owns recoverable input.')
  for (const task of state.tasks) {
    const external = task.execution?.outcome
    if (task.execution && external?.kind !== 'succeeded' && external?.kind !== 'failed')
      add('task', task.id, 'The external execution still requires an exact terminal outcome, including after local cancellation.')
    else if (task.kind === 'queued' || task.kind === 'running') add('task', task.id, 'The task can still produce work.')
    if (task.kind === 'result-ready' || task.kind === 'blocked' || task.kind === 'superseded' || task.kind === 'failed')
      add('task-result', task.id, 'Task input or a result still requires explicit consumption or cancellation.')
  }
  for (const recovery of state.recoveries) if (recovery.state === 'available') add('recovery', recovery.id, 'Recoverable input has not been consumed or discarded.')
  // A freshly registered File may not belong to a semantic input yet.
  const referenced = new Set(state.inputs.flatMap(input => input.input.kind === 'resource' ? [input.input.id] : []))
  const disposedResources = new Set(state.discards.flatMap(fact => fact.resources))
  for (const resource of state.resources) if (resource.status === 'available' && !referenced.has(resource.descriptor.id) && !disposedResources.has(resource.descriptor.id))
    add('resource', resource.descriptor.id, 'A staged resource must be used, transferred or explicitly released.')
  if (state.persistence.kind !== 'idle') add('submission', 'submission' in state.persistence ? state.persistence.submission.operationId : state.persistence.ticket,
    'Persistence has not completed its exact outcome and authority protocol.')
  if (runtime.reservation && state.persistence.kind === 'idle') add('submission', runtime.reservation, 'The runtime still owns a source reservation.')
  for (const entry of ingress.pending) add('ingress', entry.id, 'Unaccepted input or evidence must remain accessible until explicitly resolved.')
  if (runtime.storage && runtime.storage.kind !== 'idle' && runtime.lifecycle !== 'closing' && runtime.lifecycle !== 'closed') add('storage', runtime.storage.kind, 'Storage publication or lease coordination is not complete.')
  for (const activity of runtime.activities) add('runtime', activity, 'Scheduled or running work has not returned to the workspace.')
  return ownEncodedValue({ lifecycle: runtime.lifecycle, ticket: { workspaceId: state.workspace.id, semanticRevision: state.revision,
    ingressGeneration: ingress.generation, runtimeGeneration: runtime.generation, leaseEpoch: runtime.leaseEpoch }, blockers,
    neutralIntentIds: projection.neutralIntentIds }) as unknown as CloseAssessment
}
