import { assertDispositionShape, type IngressDispositionEvent } from './ingress-disposition.js'
import { assertDiscardLedger, discardWorkspace, type DiscardEvent } from './discard.js'
import { configureSchedule, hasSaveableChanges, nextSchedule, scheduleAuthoredWork, scheduleNewlyEligible, settleSchedule, type SaveScheduleEvent } from './save-schedule.js'
import { encodedValuesEqual, ownEncodedValue } from './document.js'
import { appendPreparedAction, settleProjectionEvidence } from './journal.js'
import type { CompleteAuthority, ExactReceipt, KernelIssue, NotAppliedProof, PreparedAction } from './model.js'
import { ownPolicy, type KernelState, type PolicySnapshot } from './state.js'
import { assertKernelSchema, type KernelSchema } from './schema.js'
import { acceptExactReceipt, acceptNotApplied, mutationAppliedWithoutReceipt, mutationUncertain, observeAuthority, retryPersistence,
  type KernelEffect, type PersistenceStep, type SubmissionRef } from './persistence.js'
import { freezePreparedSubmission, type PreparedSubmission } from './submission.js'
import { appendPreparedRedo, appendPreparedUndo, type PreparedRedo, type PreparedUndo } from './history.js'
import { appendPreparedResolution, type PreparedResolution } from './resolution.js'
import { reduceSession, refreshSessionContext, type SessionEvent } from './session.js'
import { setViewQuery, type ViewEvent } from './view.js'
import { reconcileTaskOwners, reduceTask, type TaskEffect, type TaskEvent, type TaskStep } from './task.js'
import { assertRegisteredResources, reduceResource, type ResourceEvent } from './resource-ownership.js'
import { bindServerAuthority, unboundServerIdentities, type ServerAuthority } from './source.js'
import { serverIdentityKey } from './protocol.js'
import type { EntityId, IngressId, ServerIdentity } from './model.js'

export type KernelEvent =
  | IngressDispositionEvent
  | DiscardEvent
  | SessionEvent
  | ViewEvent
  | TaskEvent
  | ResourceEvent
  | SaveScheduleEvent
  | Readonly<{ kind: 'ingress-checkpointed'; revision: number }>
  | Readonly<{ kind: 'ingress-declined'; ingressId: IngressId; phase: 'rejected' | 'blocked'; issue: KernelIssue }>
  | Readonly<{ kind: 'prepared-action'; prepared: PreparedAction }>
  | Readonly<{ kind: 'prepared-undo'; prepared: PreparedUndo }>
  | Readonly<{ kind: 'prepared-redo'; prepared: PreparedRedo }>
  | Readonly<{ kind: 'prepared-resolution'; prepared: PreparedResolution }>
  | Readonly<{ kind: 'authority-observed'; snapshot: CompleteAuthority }>
  | Readonly<{ kind: 'server-authority-received'; snapshot: ServerAuthority; candidates: readonly Readonly<{ identity: ServerIdentity; entityId: EntityId }>[] }>
  | Readonly<{ kind: 'read-started'; ticket: string }>
  | Readonly<{ kind: 'read-failed'; ticket: string; issue: KernelIssue }>
  | Readonly<{ kind: 'policy-observed'; policy: PolicySnapshot }>
  | Readonly<{ kind: 'save-requested'; ticket: string; scheduleToken?: number }>
  | Readonly<{ kind: 'save-wait-ended'; ticket: string }>
  | Readonly<{ kind: 'freeze-submission'; prepared: PreparedSubmission }>
  | Readonly<{ kind: 'exact-receipt'; receipt: ExactReceipt }>
  | Readonly<{ kind: 'not-applied'; proof: NotAppliedProof }>
  | Readonly<{ kind: 'mutation-uncertain'; ref: SubmissionRef; attempt: number; issue: KernelIssue }>
  | Readonly<{ kind: 'applied-without-receipt'; ref: SubmissionRef; commitToken: string }>
  | Readonly<{ kind: 'retry-persistence' }>
export type CommandResult = Readonly<{ kind: 'accepted'; revision: number }>
  | Readonly<{ kind: 'ignored'; reason: string }>
  | Readonly<{ kind: 'rejected'; issue: KernelIssue }>
  | Readonly<{ kind: 'unresolved'; issue: KernelIssue }>
export type TransitionEffect = KernelEffect | TaskEffect
export type KernelTransition = Readonly<{ state: KernelState; result: CommandResult; effects: readonly TransitionEffect[] }>

function unsupportedEvent(_event: never): never { throw new Error('Unknown kernel event.') }

/** Pure, atomic fact transition. Runtime ingress retains unaccepted inputs;
 * accepted inputs move together with their entire journal and identity change. */
export function reduceKernel(state: KernelState, event: KernelEvent, schema: KernelSchema): KernelTransition {
  const ignore = (reason: string): KernelTransition => ({ state, result: { kind: 'ignored', reason }, effects: Object.freeze([]) })
  try {
    assertKernelSchema(state.workspace, schema)
    assertDiscardLedger(state)
    let candidate: KernelState
    let effects: readonly TransitionEffect[] = Object.freeze([])
    let persistenceStep: PersistenceStep | undefined
    let taskStep: TaskStep | undefined
    switch (event.kind) {
      case 'ingress-declined':
        return { state, result: { kind: 'rejected', issue: event.issue }, effects }
      case 'workspace-discarded': candidate = discardWorkspace(state, event); break
      case 'ingress-disposed':
        assertDispositionShape(event)
        if (event.revision !== state.revision) throw new Error('Ingress disposition belongs to another revision.')
        candidate = state; break
      case 'ingress-checkpointed':
        if (event.revision !== state.revision) throw new Error('Ingress checkpoint belongs to another semantic revision.')
        candidate = state; break
      case 'save-schedule-configured': candidate = configureSchedule(state, event, schema); break
      case 'resource-registered': case 'resource-released': candidate = reduceResource(state, event); break
      case 'task-registered': case 'task-started': case 'task-completed': case 'task-failed': case 'task-execution-observed': case 'task-cancelled': case 'task-consume': case 'task-reapply':
        taskStep = reduceTask(state, event, schema); candidate = taskStep.state; break
      case 'session-opened': case 'session-attached': case 'session-detached': case 'session-input':
      case 'session-reconfirmed': case 'session-retargeted': case 'session-apply': case 'session-query-apply': case 'session-cancelled':
        candidate = reduceSession(state, event, schema); break
      case 'view-query-set': case 'view-search-set': candidate = setViewQuery(state, event, schema); break
      case 'prepared-action': candidate = appendPreparedAction(state, event.prepared, schema); break
      case 'prepared-undo': candidate = appendPreparedUndo(state, event.prepared); break
      case 'prepared-redo': candidate = appendPreparedRedo(state, event.prepared, schema); break
      case 'prepared-resolution': candidate = appendPreparedResolution(state, event.prepared, schema); break
      case 'authority-observed': persistenceStep = observeAuthority(state, event.snapshot); candidate = persistenceStep.state; break
      case 'server-authority-received': {
        const unknown = new Set(unboundServerIdentities(state, event.snapshot).map(serverIdentityKey))
        const allocations = event.candidates.filter(entry => unknown.has(serverIdentityKey(entry.identity)))
        persistenceStep = observeAuthority(state, bindServerAuthority(state, event.snapshot, allocations)); candidate = persistenceStep.state
        break
      }
      case 'exact-receipt': persistenceStep = acceptExactReceipt(state, event.receipt); candidate = persistenceStep.state; break
      case 'not-applied': persistenceStep = acceptNotApplied(state, event.proof); candidate = persistenceStep.state; break
      case 'mutation-uncertain': persistenceStep = mutationUncertain(state, event.ref, event.attempt, event.issue); candidate = persistenceStep.state; break
      case 'applied-without-receipt': persistenceStep = mutationAppliedWithoutReceipt(state, event.ref, event.commitToken); candidate = persistenceStep.state; break
      case 'retry-persistence': persistenceStep = retryPersistence(state); candidate = persistenceStep.state; break
      case 'save-requested': {
        if (event.scheduleToken !== undefined && (event.scheduleToken !== state.schedule.token || !state.schedule.pending || state.schedule.mode === 'manual'))
          return ignore('The automatic save timer belongs to an inactive schedule.')
        if (!event.ticket || state.persistence.kind !== 'idle') throw new Error('Only an idle workspace can request a gateway ticket.')
        const schedule = nextSchedule(state.schedule, false)
        if (event.scheduleToken !== undefined && !hasSaveableChanges(state, schema)) {
          candidate = Object.freeze({ ...state, schedule }); break
        }
        const settled = new Set(state.settlements.map(proof => proof.intentId))
        candidate = Object.freeze({ ...state, schedule, persistence: Object.freeze({ kind: 'waiting-for-gateway', ticket: event.ticket,
          requestedFrontier: Object.freeze(state.journal.intents.filter(intent => !settled.has(intent.id)).map(intent => intent.id)),
        }) })
        break
      }
      case 'save-wait-ended': {
        if (state.persistence.kind !== 'waiting-for-gateway' || state.persistence.ticket !== event.ticket) return ignore('Gateway completion belongs to an inactive ticket.')
        candidate = Object.freeze({ ...state, persistence: Object.freeze({ kind: 'idle' }) })
        break
      }
      case 'freeze-submission': {
        candidate = freezePreparedSubmission(state, event.prepared, schema)
        if (candidate.persistence.kind !== 'sending') throw new Error('A frozen submission must reserve its outgoing request.')
        effects = Object.freeze([Object.freeze({ kind: 'submit', submission: candidate.persistence.submission, attempt: candidate.persistence.attempt })])
        break
      }
      case 'read-started': {
        if (!event.ticket) throw new Error('A read requires a ticket.')
        candidate = Object.freeze({ ...state, authority: Object.freeze({ ...state.authority, read: Object.freeze({ kind: 'loading', ticket: event.ticket }) }) })
        break
      }
      case 'read-failed': {
        if (state.authority.read.kind !== 'loading' || state.authority.read.ticket !== event.ticket) return ignore('Read failure belongs to an inactive request.')
        const issue = ownEncodedValue(event.issue) as unknown as KernelIssue
        candidate = Object.freeze({ ...state, authority: Object.freeze({ ...state.authority, read: Object.freeze({ kind: 'failed', ticket: event.ticket, issue }) }) })
        break
      }
      case 'policy-observed': {
        const policy = ownPolicy(event.policy)
        const seen = state.policies.find(previous => previous.version === policy.version)
        if (seen && !encodedValuesEqual(ownEncodedValue(policy), ownEncodedValue(seen))) throw new Error('An immutable policy version cannot change capabilities.')
        if (policy.version === state.policy.version) return ignore('Policy is unchanged.')
        candidate = Object.freeze({ ...state, policy, policies: seen ? state.policies : Object.freeze([...state.policies, policy]) }); break
      }
      default: unsupportedEvent(event)
    }
    if (persistenceStep) {
      if (persistenceStep.ignored) return ignore(persistenceStep.ignored)
      effects = persistenceStep.effects
    }
    if (taskStep) {
      if (taskStep.ignored) return ignore(taskStep.ignored)
      effects = taskStep.effects
    }
    // Refresh failure changes no data evidence; do not let a presentation/read
    // lifecycle event acquire authority to terminate any input.
    if (event.kind === 'prepared-action' || event.kind === 'prepared-undo' || event.kind === 'prepared-redo' || event.kind === 'prepared-resolution' || event.kind === 'session-apply' || event.kind === 'authority-observed' || event.kind === 'policy-observed'
      || event.kind === 'server-authority-received' || event.kind === 'exact-receipt' || event.kind === 'not-applied' || event.kind === 'task-completed' || event.kind === 'task-execution-observed' || event.kind === 'task-consume' || event.kind === 'task-reapply') candidate = settleProjectionEvidence(candidate, schema)
    const owners = reconcileTaskOwners(state, candidate, schema, event.kind === 'session-cancelled' ? event.sessionId : null)
    candidate = owners.state
    effects = Object.freeze([...effects, ...owners.effects])
    candidate = refreshSessionContext(candidate, schema)
    candidate = scheduleAuthoredWork(state, candidate)
    if (event.kind === 'policy-observed' || event.kind === 'authority-observed' || event.kind === 'server-authority-received')
      candidate = scheduleNewlyEligible(state, candidate, schema)
    candidate = settleSchedule(candidate, schema)
    assertRegisteredResources(candidate)
    candidate = Object.freeze({ ...candidate, revision: state.revision + 1 })
    return Object.freeze({ state: candidate, result: Object.freeze({ kind: 'accepted', revision: candidate.revision }), effects })
  } catch (error) {
    return Object.freeze({ state, result: Object.freeze({ kind: 'rejected', issue: Object.freeze({ code: 'invalid-transition', message: error instanceof Error ? error.message : 'The complete transition was rejected.' }) }), effects: Object.freeze([]) })
  }
}
