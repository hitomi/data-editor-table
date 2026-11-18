import { canonicalEncodedValue, ownEncodedValue } from './document.js'
import { recordIntentSettlements } from './journal.js'
import type { CloseTicket, ResourceId } from './model.js'
import { nextSchedule } from './save-schedule.js'
import type { KernelState } from './state.js'

export type DiscardEvent = Readonly<{ kind: 'workspace-discarded'; ticket: CloseTicket }>

/** Local disposition is never evidence that a remote operation did not run.
 * The runtime additionally checks the complete close ticket and live workers. */
export function discardWorkspace(state: KernelState, event: DiscardEvent): KernelState {
  const ticket = ownEncodedValue(event.ticket) as unknown as CloseTicket
  if (ticket.workspaceId !== state.workspace.id || ticket.semanticRevision !== state.revision
    || !ticket.leaseEpoch || !Number.isSafeInteger(ticket.ingressGeneration) || ticket.ingressGeneration < 0
    || !Number.isSafeInteger(ticket.runtimeGeneration) || ticket.runtimeGeneration < 0)
    throw new Error('Workspace discard requires the exact reviewed semantic revision and ownership ticket.')
  if (state.persistence.kind !== 'idle' || state.authority.read.kind === 'loading')
    throw new Error('Workspace discard cannot erase an unresolved source operation.')
  if (state.tasks.some(task => task.execution
    ? task.execution.outcome?.kind !== 'succeeded' && task.execution.outcome?.kind !== 'failed'
    : task.kind === 'queued' || task.kind === 'running'))
    throw new Error('Workspace discard requires exact terminal task outcomes.')
  const settled = new Set(state.settlements.map(proof => proof.intentId))
  const candidate = recordIntentSettlements(state, state.journal.intents.filter(intent => !settled.has(intent.id))
    .map(intent => ({ kind: 'workspace-discarded', intentId: intent.id, ticket })))
  const inputs = candidate.inputs.map(input => ['session', 'task', 'recovery'].includes(input.disposition.kind)
    ? { ...input, disposition: { kind: 'workspace-discarded' as const, ticket } } : input)
  // Keep original inputs, terminal receipts and returned task results as audit
  // material. Disposition ends active ownership; it does not delete history.
  const tasks = candidate.tasks.map(task => task.kind === 'cancelled' || task.kind === 'consumed'
    ? task : { ...task, kind: 'cancelled' as const })
  return ownEncodedValue({ ...candidate, session: null, inputs, tasks,
    recoveries: candidate.recoveries.map(entry => entry.state === 'available' ? { ...entry, state: 'discarded' } : entry),
    discards: [...state.discards, { ticket, applicationCount: state.journal.actions.length, resources: state.resources.filter(resource => resource.status === 'available').map(resource => resource.descriptor.id) }],
    schedule: nextSchedule(state.schedule, false),
  }) as unknown as KernelState
}

/** Recovery must preserve the history boundary; accepting an old state with
 * no discard ledger could make previously discarded edits undoable again. */
export function assertDiscardLedger(state: KernelState): void {
  if (!Array.isArray(state.discards)) throw new Error('Workspace recovery requires its discard ledger.')
  let revision = -1, applications = 0
  for (const fact of state.discards) {
    const ticket = fact.ticket
    if (!ticket || ticket.workspaceId !== state.workspace.id || !ticket.leaseEpoch
      || !Number.isSafeInteger(ticket.semanticRevision) || ticket.semanticRevision <= revision || ticket.semanticRevision >= state.revision
      || !Number.isSafeInteger(ticket.ingressGeneration) || ticket.ingressGeneration < 0
      || !Number.isSafeInteger(ticket.runtimeGeneration) || ticket.runtimeGeneration < 0
      || !Number.isSafeInteger(fact.applicationCount) || fact.applicationCount < applications || fact.applicationCount > state.journal.actions.length)
      throw new Error('Invalid Workspace discard history boundary.')
    if (!Array.isArray(fact.resources) || new Set(fact.resources).size !== fact.resources.length
      || fact.resources.some((id: ResourceId) => !state.resources.some(resource => resource.descriptor.id === id)))
      throw new Error('Workspace discard must retain its exact resource identities.')
    revision = ticket.semanticRevision; applications = fact.applicationCount
  }
  const tickets = new Set(state.discards.map(fact => canonicalEncodedValue(ownEncodedValue(fact.ticket))))
  for (const proof of [...state.settlements, ...state.inputs.map(input => input.disposition)])
    if (proof.kind === 'workspace-discarded' && !tickets.has(canonicalEncodedValue(ownEncodedValue(proof.ticket))))
      throw new Error('A Workspace discard disposition requires its exact recorded ticket.')
}
