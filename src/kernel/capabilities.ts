import { ownEncodedValue } from './document.js'
import { prepareHistoryCommand } from './history-command.js'
import { projectHistory } from './history.js'
import { declaredRowOperation } from './intent.js'
import { kernelId, type ApplicationId, type EntityId, type IntentId, type KernelIssue } from './model.js'
import { projectKernel } from './projection.js'
import type { KernelSchema } from './schema.js'
import type { KernelState } from './state.js'
import { draftSubmission } from './submission.js'
import { reduceKernel } from './transition.js'

export type UnavailableCapability = Readonly<{ kind: 'unavailable'; reason: 'no-changes' | 'no-history' }>
export type BlockedCapability = Readonly<{ kind: 'blocked'; reason: 'inactive' | 'storage-pending' | 'source-busy' | 'source-reserved' | 'invalid-command'; issue: KernelIssue }>
export type SaveCapability = UnavailableCapability | BlockedCapability | Readonly<{
  kind: 'available'; intentIds: readonly IntentId[]; remainingIntentIds: readonly IntentId[]; irreversibleDeletes: readonly EntityId[]
}>
export type HistoryCapability = UnavailableCapability | BlockedCapability | Readonly<{
  kind: 'available'; applicationId: ApplicationId
  /** Acceptance can retain conditional or conflicting compensation. Available
   * means the command can be recorded, not that its result is already saved. */
  issues: readonly KernelIssue[]
}>
export type SemanticCapabilities = Readonly<{ revision: number; save: SaveCapability; undo: HistoryCapability; redo: HistoryCapability }>

function invalid(error: unknown): BlockedCapability {
  return { kind: 'blocked', reason: 'invalid-command', issue: { code: 'capability-blocked', message: error instanceof Error ? error.message : 'The command cannot be prepared.' } }
}

function probeAllocator(state: KernelState): () => string {
  // Derived input/recovery/group IDs also start with their control ID. Choose
  // a namespace disjoint from every retained identity, including old branches.
  const used: readonly string[] = [
    ...state.journal.actions.flatMap(action => [action.id, action.applicationId]),
    ...state.journal.intents.flatMap(intent => { const operation = declaredRowOperation(intent)
      return [intent.id, ...(operation?.kind === 'write' ? operation.groups.map(group => group.id) : [])] }),
    ...state.inputs.map(input => input.ref.id), ...state.recoveries.map(entry => entry.id), ...state.entities.map(entity => entity.entityId),
    ...state.commits.map(fact => fact.submission.operationId), ...state.rejections.map(fact => fact.submission.operationId),
  ]
  let prefix = `capability:${state.revision}:`
  while (used.some(value => value.startsWith(prefix))) prefix += ':'
  let serial = 0
  return () => `${prefix}${++serial}`
}

/** Pure advisory projection. Preparation and reducers are the same ones used
 * for commands; hypothetical states/effects and probe IDs never escape. */
export function projectCapabilities(state: KernelState, schema: KernelSchema): SemanticCapabilities {
  const projection = projectKernel(state, schema), history = projectHistory(state), allocate = probeAllocator(state)
  const settled = new Set(state.settlements.map(proof => proof.intentId)), neutral = new Set(projection.neutralIntentIds)
  const active = state.journal.intents.filter(intent => !settled.has(intent.id) && !neutral.has(intent.id)).map(intent => intent.id)
  let save: SaveCapability
  if (!active.length && state.persistence.kind === 'idle' && !state.protocolFaults.length) save = { kind: 'unavailable', reason: 'no-changes' }
  else {
    try {
      const draft = draftSubmission(state, { operationId: kernelId<'operation'>(allocate()),
        items: projection.changes.map(change => ({ entityId: change.entityId, itemId: kernelId<'item'>(allocate()) })),
        ...(projection.orderChange ? { orderItemId: kernelId<'item'>(allocate()) } : {}),
      }, schema)
      const intentIds = draft.payload.coverage.flatMap(item => item.intentIds), covered = new Set(intentIds)
      save = { kind: 'available', intentIds, remainingIntentIds: active.filter(id => !covered.has(id)),
        irreversibleDeletes: state.sourceCapabilities.restoreDeleted ? [] : projection.changes.filter(change => change.kind === 'delete').map(change => change.entityId) }
    } catch (error) { save = invalid(error) }
  }
  const prepare = (kind: 'undo' | 'redo'): HistoryCapability => {
    const target = history[kind].at(-1)
    if (!target) return { kind: 'unavailable', reason: 'no-history' }
    try {
      const event = prepareHistoryCommand(state, schema, kind, allocate), transition = reduceKernel(state, event, schema)
      if (transition.result.kind !== 'accepted') return invalid(new Error('issue' in transition.result ? transition.result.issue.message : transition.result.reason))
      const preview = projectKernel(transition.state, schema), own = new Set(event.prepared.intents.map(intent => intent.id))
      return { kind: 'available', applicationId: target.applicationId,
        issues: [...preview.rows.flatMap(row => row.issues), ...preview.order.issues].filter(issue => issue.intentIds?.some(id => own.has(id)))
          .map(issue => ({ code: issue.code, message: issue.message })) }
    } catch (error) { return invalid(error) }
  }
  return ownEncodedValue({ revision: state.revision, save, undo: prepare('undo'), redo: prepare('redo') }) as unknown as SemanticCapabilities
}
