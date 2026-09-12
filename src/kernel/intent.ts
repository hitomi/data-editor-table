import type { DataOperation, EntityId, IntentId, IntentRecord, IntentSettlement, ResolutionDecision } from './model.js'
import type { RowOperation } from './resources.js'
import type { KernelState } from './state.js'

export type UndoOperation = Extract<IntentRecord['operation'], { kind: 'undo' | 'undo-order' }>

/** Receipt facts decide whether this workspace actually wrote a contribution.
 * Value equality, projection satisfaction and an HTTP exception never do. */
export function undoBranch(state: KernelState, operation: UndoOperation): 'suppress' | 'unknown' | 'compensate' {
  const applied = operation.targets.filter(id => state.commits.some(fact => fact.submission.coverage.some(item => item.intentIds.includes(id))))
  if (applied.length) {
    if (applied.length !== operation.targets.length) throw new Error('A domain undo must not mix applied and unapplied contributions.')
    return 'compensate'
  }
  if ('submission' in state.persistence && state.persistence.submission.coverage.some(item => item.intentIds.some(id => operation.targets.includes(id)))) return 'unknown'
  if (operation.kind === 'undo-order') {
    const branches = operation.restorations.map(id => undoBranch(state, restorationControl(state, id)))
    if (branches.includes('unknown')) return 'unknown'
    if (branches.includes('compensate')) return 'compensate'
  }
  return 'suppress'
}

function restorationControl(state: KernelState, id: IntentId) {
  const operation = state.journal.intents.find(intent => intent.id === id)?.operation
  if (operation?.kind !== 'undo' || operation.compensation?.kind !== 'create' || !operation.compensation.restoresEntity)
    throw new Error('Order restoration requires a preceding conditional entity restoration.')
  return { ...operation, compensation: operation.compensation }
}

/** Normalization changes the interpretation of immutable control facts, never
 * the original intent or frozen request. IDs remain the control contribution's
 * IDs, so exact coverage settles compensation instead of its historical target. */
export function rowOperationForIntent(state: KernelState, intent: IntentRecord): RowOperation | null {
  const operation = intent.operation
  if (operation.kind === 'order' || operation.kind === 'undo-order' || operation.kind === 'redo-order' || operation.kind === 'resolve' || operation.kind === 'undo-resolution' || operation.kind === 'redo-resolution') return null
  if (operation.kind === 'undo' && undoBranch(state, operation) === 'suppress') return null
  return declaredRowOperation(intent)
}

/** Historical payload identities remain reserved even when a branch is off. */
export function declaredRowOperation(intent: IntentRecord): RowOperation | null {
  const operation = intent.operation
  if (operation.kind === 'order' || operation.kind === 'undo-order' || operation.kind === 'redo-order' || operation.kind === 'resolve' || operation.kind === 'undo-resolution' || operation.kind === 'redo-resolution') return null
  if (operation.kind === 'undo') return operation.compensation
  if (operation.kind === 'redo') return operation.replay
  if (operation.kind === 'create' || operation.kind === 'write' || operation.kind === 'replace' || operation.kind === 'delete') return operation
  throw new Error('This structural/control operation still requires its normalizer.')
}

export function declaredOrderOperation(intent: IntentRecord): Extract<DataOperation, { kind: 'order' }> | null {
  const operation = intent.operation
  if (operation.kind === 'order') return operation
  if (operation.kind === 'undo-order') return operation.compensation
  if (operation.kind === 'redo-order') return operation.replay
  return null
}

export function declaredResolution(intent: IntentRecord): ResolutionDecision | null {
  return intent.operation.kind === 'resolve' || intent.operation.kind === 'redo-resolution' ? intent.operation.decision : null
}

export function orderOperationForIntent(state: KernelState, intent: IntentRecord): Extract<DataOperation, { kind: 'order' }> | null {
  const operation = intent.operation
  if (operation.kind !== 'undo-order') return declaredOrderOperation(intent)
  if (undoBranch(state, operation) === 'suppress' || !operation.compensation) return null
  const identities = new Map(operation.restorations.flatMap(id => {
    const control = restorationControl(state, id)
    return undoBranch(state, control) === 'suppress' ? [] : [[control.compensation.restoresEntity!, control.entityId] as const]
  }))
  return { ...operation.compensation, desired: operation.compensation.desired.map(id => identities.get(id) ?? id) }
}

export function undoSettlementSuggestions(state: KernelState): readonly IntentSettlement[] {
  const settled = new Set(state.settlements.map(proof => proof.intentId)), suggestions: IntentSettlement[] = []
  for (const record of state.journal.intents) {
    if ((record.operation.kind === 'undo-resolution' || record.operation.kind === 'redo-resolution') && !settled.has(record.id)) {
      suggestions.push({ kind: 'control-completed', intentId: record.id }); settled.add(record.id)
    }
    if ((record.operation.kind !== 'undo' && record.operation.kind !== 'undo-order') || settled.has(record.id)) continue
    for (const target of record.operation.targets) if (!settled.has(target)
      && !state.commits.some(fact => fact.submission.coverage.some(item => item.intentIds.includes(target)))
      && !('submission' in state.persistence && state.persistence.submission.coverage.some(item => item.intentIds.includes(target)))) {
      suggestions.push({ kind: 'discarded', intentId: target, by: record.id }); settled.add(target)
    }
    if (undoBranch(state, record.operation) === 'suppress') { suggestions.push({ kind: 'control-completed', intentId: record.id }); settled.add(record.id) }
  }
  return Object.freeze(suggestions)
}

export function intentFrontierForEntity(state: KernelState, entityId: string): readonly IntentId[] {
  return Object.freeze(state.journal.intents.filter(intent => 'entityId' in intent.operation && intent.operation.entityId === entityId
    && !state.settlements.some(proof => proof.intentId === intent.id && (proof.kind === 'discarded' || proof.kind === 'workspace-discarded' || proof.kind === 'control-completed'))).map(intent => intent.id))
}

/** Only newly prepared history commands follow these links. Old data intents,
 * input owners, tasks and receipts keep their original entity identity. */
export function currentHistoryEntity(state: KernelState, original: EntityId): EntityId {
  let current = original
  for (const intent of state.journal.intents) {
    const operation = intent.operation
    if (operation.kind !== 'undo' || operation.compensation?.kind !== 'create' || operation.compensation.restoresEntity !== current) continue
    const branch = undoBranch(state, operation)
    if (branch === 'unknown') throw new Error('Restoration identity awaits the definitive deletion outcome.')
    if (branch === 'compensate') current = operation.compensation.entityId
  }
  if (current !== original && state.entities.find(binding => binding.entityId === current)?.kind === 'retired')
    throw new Error('The restoration lineage target was deleted; explicit recovery is required.')
  return current
}
