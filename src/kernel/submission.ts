import { encodedValuesEqual, ownEncodedValue } from './document.js'
import type { EntityId, FrozenMutationItem, FrozenSubmission, ItemId, OperationId, PayloadHash } from './model.js'
import { compileChangePatches, projectKernel } from './projection.js'
import { authorityCoversFrontier, validateFrozenSubmission } from './protocol.js'
import type { KernelSchema } from './schema.js'
import type { KernelState } from './state.js'

export type SubmissionIdentities = Readonly<{
  operationId: OperationId
  payloadHash: PayloadHash
  items: readonly Readonly<{ entityId: EntityId; itemId: ItemId }>[]
  orderItemId?: ItemId
}>
export type PreparedSubmission = Readonly<{ revision: number; submission: FrozenSubmission }>
export type SubmissionDraft = Readonly<{ revision: number; payload: Omit<FrozenSubmission, 'payloadHash'> }>

/** Runtime supplies IDs and the digest of the deterministic gateway payload.
 * The kernel rechecks the complete plan at freeze time. IDs/hashes alone are
 * never authority to replace the planned documents or their exact coverage.
 */
export function draftSubmission(state: KernelState, identities: Omit<SubmissionIdentities, 'payloadHash'>, schema: KernelSchema): SubmissionDraft {
  if (state.persistence.kind !== 'idle') throw new Error('A previous scope write is still unresolved.')
  if (state.protocolFaults.length) throw new Error('Conflicting protocol evidence prevents further writes in this workspace.')
  if (state.authority.content.kind !== 'complete' || !authorityCoversFrontier(state.authority.content.snapshot.version, state.authorityFrontier))
    throw new Error('The complete authority must cover every observed frontier before saving.')
  if (state.commits.some(fact => fact.submission.operationId === identities.operationId) || state.rejections.some(fact => fact.submission.operationId === identities.operationId))
    throw new Error('A terminal operation identity cannot be reused for a new request.')
  const projection = projectKernel(state, schema), changes = projection.changes
  if (!changes.length && !projection.orderChange) throw new Error('There are no saveable intent groups.')
  if (Boolean(projection.orderChange) !== Boolean(identities.orderItemId)) throw new Error('Order item identity must match the current complete order plan.')
  const ids = new Map(identities.items.map(entry => [entry.entityId, entry.itemId] as const))
  if (ids.size !== identities.items.length || ids.size !== changes.length || changes.some(change => !ids.has(change.entityId)))
    throw new Error('Submission identities must match every saveable entity exactly once.')
  const items: FrozenMutationItem[] = changes.map(change => {
    const id = ids.get(change.entityId)!
    if (change.kind === 'create') {
      const creation = change.operations[0]
      if (creation?.kind !== 'create' || !change.after) throw new Error('A creation plan must retain its explicit creation intent.')
      let restores: Extract<FrozenMutationItem, { kind: 'create' }>['restores']
      if (creation.restoresEntity !== undefined) {
        if (!state.sourceCapabilities.restoreDeleted) throw new Error('This source does not support deletion restoration.')
        for (const fact of state.commits) for (const item of fact.submission.items) {
          if (item.kind === 'delete' && item.entityId === creation.restoresEntity) restores = { identity: item.identity, operationId: fact.submission.operationId, itemId: item.id }
        }
        if (!restores) throw new Error('A restoration cannot be sent before exact deletion application is known.')
      }
      return { kind: 'create', id, entityId: change.entityId, document: change.after,
        ...(creation.proposedKey === undefined ? {} : { proposedKey: creation.proposedKey }),
        ...(restores ? { restores } : {}),
      }
    }
    const binding = state.entities.find(entry => entry.entityId === change.entityId)
    if (binding?.kind !== 'bound' || !change.before) throw new Error('An existing-row mutation requires its live incarnation and complete authority base.')
    if (change.kind === 'delete') return { kind: 'delete', id, entityId: change.entityId, identity: binding.identity, before: change.before }
    if (!change.after) throw new Error('An update cannot silently delete an entity.')
    return { kind: 'update', id, entityId: change.entityId, identity: binding.identity, before: change.before, after: change.after, writes: compileChangePatches(change) }
  })
  const payload: Omit<FrozenSubmission, 'payloadHash'> = {
    workspaceId: state.workspace.id, operationId: identities.operationId, scope: state.workspace.scope, schema: state.workspace.schema,
    baseAuthority: state.authority.content.snapshot.version, items,
    coverage: changes.map(change => ({ itemId: ids.get(change.entityId)!, intentIds: change.intentIds })), frontier: changes.flatMap(change => change.intentIds),
  }
  if (projection.orderChange && identities.orderItemId) {
    const authority = state.authority.content.snapshot, bindings = new Map(authority.entities.map(row => [row.entityId, row.identity]))
    const order: FrozenMutationItem = { kind: 'order', id: identities.orderItemId, before: authority.order.map(id => bindings.get(id)!),
      after: projection.orderChange.desired.map(entityId => {
        const created = items.find(item => item.kind === 'create' && item.entityId === entityId)
        if (created) return { kind: 'created-in-submission', itemId: created.id }
        const identity = bindings.get(entityId)
        if (!identity) throw new Error('Order references an entity outside the bound or current creation closure.')
        return { kind: 'bound', identity }
      }),
    }
    return ownEncodedValue({ revision: state.revision, payload: { ...payload, items: [...items, order],
      coverage: [...payload.coverage, { itemId: identities.orderItemId, intentIds: projection.orderChange.intentIds }],
      frontier: [...payload.frontier, ...projection.orderChange.intentIds],
    } }) as unknown as SubmissionDraft
  }
  return ownEncodedValue({ revision: state.revision, payload }) as unknown as SubmissionDraft
}

export function prepareSubmission(state: KernelState, identities: SubmissionIdentities, schema: KernelSchema): PreparedSubmission {
  const draft = draftSubmission(state, identities, schema)
  const submission: FrozenSubmission = { ...draft.payload, payloadHash: identities.payloadHash }
  validateFrozenSubmission(submission)
  return ownEncodedValue({ revision: draft.revision, submission }) as unknown as PreparedSubmission
}

export function freezePreparedSubmission(state: KernelState, prepared: PreparedSubmission, schema: KernelSchema): KernelState {
  if (prepared.revision !== state.revision) throw new Error('The prepared save is stale; acquire the current intent plan before freezing.')
  const submission = prepared.submission
  const expected = prepareSubmission(state, { operationId: submission.operationId, payloadHash: submission.payloadHash,
    items: submission.items.flatMap(item => item.kind === 'order' ? [] : [{ entityId: item.entityId, itemId: item.id }]),
    ...(submission.items.some(item => item.kind === 'order') ? { orderItemId: submission.items.find(item => item.kind === 'order')!.id } : {}),
  }, schema)
  if (!encodedValuesEqual(ownEncodedValue(prepared), ownEncodedValue(expected))) throw new Error('The frozen request must equal the complete current intent plan and coverage.')
  return Object.freeze({ ...state, persistence: Object.freeze({ kind: 'sending', submission: expected.submission, attempt: 1 }) })
}
