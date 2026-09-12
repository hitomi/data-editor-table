import { ownEncodedValue } from './document.js'
import { orderOperationForIntent, rowOperationForIntent } from './intent.js'
import type { DataOperation, EntityId, IntentId, IntentRecord, IntentSettlement } from './model.js'
import type { ProjectedIssue, RowChange, RowProjection } from './projection.js'
import { serverIdentityKey } from './protocol.js'
import type { KernelState } from './state.js'
import { expandFrontier } from './frontier-table.js'

export type OrderOperation = Extract<DataOperation, { kind: 'order' }>
export type OrderChange = Readonly<{ desired: readonly EntityId[]; intentIds: readonly IntentId[] }>
export type OrderProjection = Readonly<{ authority: readonly EntityId[]; desired: readonly EntityId[]; preview: readonly EntityId[];
  intentIds: readonly IntentId[]; persistence: 'clean' | 'pending' | 'submitted' | 'blocked'; issues: readonly ProjectedIssue[] }>
const same = (left: readonly EntityId[], right: readonly EntityId[]) => left.length === right.length && left.every((id, index) => id === right[index])
export function assertOrderMembers(order: readonly EntityId[], members: Iterable<EntityId>) {
  const expected = new Set(members)
  if (order.length !== expected.size || new Set(order).size !== order.length || order.some(id => !id || !expected.has(id))) throw new Error('Order must name every logical entity exactly once.')
}
function structure(order: readonly EntityId[], operation: DataOperation): EntityId[] {
  if (operation.kind === 'create') return order.includes(operation.entityId) ? [...order] : [...order, operation.entityId]
  if (operation.kind === 'delete') return order.filter(id => id !== operation.entityId)
  return [...order]
}
export function orderPredecessors(intents: readonly IntentRecord[], state: KernelState): readonly IntentId[] {
  return intents.filter(intent => {
    if (orderOperationForIntent(state, intent)) return true
    const operation = rowOperationForIntent(state, intent)
    return operation?.kind === 'create' || operation?.kind === 'delete'
  }).map(intent => intent.id)
}
export function captureOrderBase(state: KernelState) {
  const settled = new Set(state.settlements.map(proof => proof.intentId))
  return { authority: state.authority.content.kind === 'complete' ? state.authority.content.snapshot.order : [],
    frontier: orderPredecessors(state.journal.intents.filter(intent => !settled.has(intent.id)), state) }
}
function resolvedBase(state: KernelState, operation: OrderOperation): readonly EntityId[] {
  const predecessors = operation.anchor.kind === 'authority' ? [] : expandFrontier(state.journal.frontiers, operation.anchor.kind === 'logical-output' ? operation.anchor.predecessor : operation.anchor.frontier)
  let order = [...operation.authorityBase]
  const applied = new Set<string>(), identities = new Map(state.entities.flatMap(binding => binding.kind === 'local' ? [] : [[serverIdentityKey(binding.identity), binding.entityId] as const]))
  for (const id of predecessors) {
    const proof = state.settlements.find(proof => proof.intentId === id)
    if (!proof || proof.kind === 'discarded' || proof.kind === 'workspace-discarded' || proof.kind === 'control-completed') continue
    const intent = state.journal.intents.find(intent => intent.id === id)!
    if (proof.kind === 'committed') {
      const key = JSON.stringify([proof.operationId, proof.itemId])
      if (applied.has(key)) continue
      applied.add(key)
      const result = state.commits.find(fact => fact.submission.operationId === proof.operationId)!.receipt.results.find(result => result.itemId === proof.itemId)!
      if (result.kind === 'ordered') {
        order = result.canonicalOrder.map(identity => {
          const entity = identities.get(serverIdentityKey(identity))
          if (!entity) throw new Error('Canonical order is missing its exact entity binding.')
          return entity
        })
        continue
      }
    }
    const ordering = orderOperationForIntent(state, intent)
    if (ordering) order = [...ordering.desired]
    else { const row = rowOperationForIntent(state, intent); if (row) order = structure(order, row) }
  }
  return order
}

/** One ordered reduction supplies both persistent-order projection and the
 * logical order observed at each active command. Neutral prefixes affect
 * neither later reads nor writes; policy guards still use raw authority. */
export function planOrder(state: KernelState, neutralRows: readonly IntentId[], through = Infinity) {
  const authority = state.authority.content.kind === 'complete' ? state.authority.content.snapshot.order : []
  const settled = new Set(state.settlements.map(proof => proof.intentId))
  const active = state.journal.intents.filter(intent => intent.sequence <= through && !settled.has(intent.id))
  const reserved = new Set('submission' in state.persistence ? state.persistence.submission.coverage.flatMap(item => item.intentIds) : [])
  const structures: DataOperation[] = [], neutral: IntentId[] = []
  let pending: { base: readonly EntityId[]; baseline: EntityId[]; desired: EntityId[]; intents: IntentRecord[] } | null = null
  for (let index = 0; index < active.length; index++) {
    const intent = active[index]!, operation = orderOperationForIntent(state, intent)
    if (operation) {
      if (!pending) {
        const base = resolvedBase(state, operation)
        pending = { base, baseline: structures.reduce< EntityId[]>((order, row) => structure(order, row), [...base]), desired: [], intents: [] }
      }
      pending.desired = [...operation.desired]; pending.intents.push(intent)
    } else {
      const row = rowOperationForIntent(state, intent)
      if (row?.kind === 'create' || row?.kind === 'delete') {
        structures.push(row)
        if (pending) { pending.baseline = structure(pending.baseline, row); pending.desired = structure(pending.desired, row) }
      }
    }
    if (pending && active[index + 1]?.applicationId !== intent.applicationId && !pending.intents.some(intent => reserved.has(intent.id)) && same(pending.baseline, pending.desired)) {
      neutral.push(...pending.intents.map(intent => intent.id)); pending = null
    }
  }
  const logicalDefault = structures.reduce<EntityId[]>((order, row) => structure(order, row), [...authority])
  const desired = pending?.desired ?? logicalDefault, orderIds = pending?.intents.map(intent => intent.id) ?? []
  const inactive = new Set([...neutralRows, ...neutral])
  const before = new Map<IntentId, readonly EntityId[]>()
  let cursor = [...authority]
  for (const intent of active) {
    before.set(intent.id, cursor)
    if (inactive.has(intent.id)) continue
    const ordering = orderOperationForIntent(state, intent)
    if (ordering) {
      const members = new Set(cursor)
      cursor = ordering.desired.filter(id => members.delete(id))
      cursor.push(...members)
    } else {
      const row = rowOperationForIntent(state, intent)
      if (row) cursor = structure(cursor, row)
    }
  }
  return { authority, active, reserved, pending, neutral, logicalDefault, desired, orderIds, before }
}

/** Order owns a separate CAS domain. Row mutations only participate through
 * explicit existence dependencies, never through their display positions. */
export function projectOrder(state: KernelState, sourceRows: readonly RowProjection[], sourceChanges: readonly RowChange[], neutralRows: readonly IntentId[],
  plan = planOrder(state, neutralRows)) {
  const { authority, active, reserved, pending, neutral, logicalDefault, desired, orderIds } = plan
  const issues: ProjectedIssue[] = [], suggestions: IntentSettlement[] = []
  const add = (code: string, message: string) => {
    if (issues.some(issue => issue.code === code)) return
    issues.push({ id: JSON.stringify([state.workspace.scope, state.revision, orderIds, code]), code, message, intentIds: orderIds,
      ...(code === 'order-conflict' && pending ? { comparison: { resources: [{ kind: 'order' as const }], base: [{ kind: 'value' as const, value: pending.base }],
        local: [{ kind: 'value' as const, value: desired }], remote: [{ kind: 'value' as const, value: authority }] } } : {}),
    })
  }
  if (pending) {
    if (!state.policy.order) add('policy-blocked', 'Current policy does not allow changing persistent order.')
    if (!same(authority, pending.base) && !same(authority, desired)) add('order-conflict', 'Authority order differs from the captured base and the complete intended order.')
    try { assertOrderMembers(desired, logicalDefault) } catch { add('order-membership', 'Resolve the order against the current complete entity membership.') }
  }
  const neutralSet = new Set(neutralRows)
  const structuralIds = new Set(active.filter(intent => {
    if (neutralSet.has(intent.id) || intent.operation.kind === 'order') return false
    const row = rowOperationForIntent(state, intent)
    return row?.kind === 'create' || row?.kind === 'delete'
  }).map(intent => intent.id))
  const rows = sourceRows.map(row => ({ ...row, issues: [...row.issues] }))
  if (pending) {
    let changed = true
    while (changed) {
      changed = false
      const blocked = new Set(rows.flatMap(row => row.issues.length ? row.intentIds : []))
      if (issues.length) orderIds.forEach(id => blocked.add(id))
      const needs = new Set([...structuralIds, ...pending.intents.flatMap(intent => expandFrontier(state.journal.frontiers, intent.dependencies))])
      const transaction = state.journal.actions.filter(action => action.saveAtomicity === 'transaction' && action.intentIds.some(id => orderIds.includes(id)))
      transaction.forEach(action => action.intentIds.forEach(id => needs.add(id)))
      if (!issues.length && [...needs].some(id => blocked.has(id))) { add('dependency-blocked', 'Order requires a blocked structural mutation or transaction member.'); changed = true }
      for (const row of rows) {
        if (row.issues.length || !row.intentIds.length) continue
        const coupled = issues.length && (row.intentIds.some(id => structuralIds.has(id)) || transaction.some(action => action.intentIds.some(id => row.intentIds.includes(id))))
        const dependent = active.some(intent => row.intentIds.includes(intent.id) && expandFrontier(state.journal.frontiers, intent.dependencies).some(id => blocked.has(id)))
        const atomic = state.journal.actions.some(action => action.saveAtomicity === 'transaction' && action.intentIds.some(id => row.intentIds.includes(id)) && action.intentIds.some(id => blocked.has(id)))
        if (coupled || dependent || atomic) {
          row.issues.push({ id: JSON.stringify([state.workspace.scope, state.revision, row.entityId, 'order-dependency']), code: 'dependency-blocked',
            message: 'This row and its persistent order dependencies must be saved together.', entityId: row.entityId, intentIds: row.intentIds })
          row.persistence = 'blocked'; changed = true
        }
      }
    }
  }
  const submitted = orderIds.some(id => reserved.has(id))
  const relatedPending = structuralIds.size > 0
  if (pending && !issues.length && !submitted && !relatedPending && same(authority, desired)) {
    const content = state.authority.content
    if (content.kind === 'complete') orderIds.forEach(intentId => suggestions.push({ kind: 'externally-satisfied', intentId, observation: content.snapshot.observation }))
  }
  const visible = new Set(rows.filter(row => row.preview !== null).map(row => row.entityId))
  const preview = desired.filter(id => visible.delete(id))
  for (const row of rows) if (visible.delete(row.entityId)) preview.push(row.entityId)
  const change: OrderChange | null = pending && !issues.length && !submitted && (!same(authority, desired) || relatedPending) ? { desired, intentIds: orderIds } : null
  const blockedRows = new Set(rows.filter(row => row.issues.length).map(row => row.entityId))
  return ownEncodedValue({ rows, changes: sourceChanges.filter(change => !blockedRows.has(change.entityId)), change, neutral, suggestions,
    order: { authority, desired, preview, intentIds: orderIds, issues, persistence: issues.length ? 'blocked' : submitted ? 'submitted' : change ? 'pending' : 'clean' },
  }) as unknown as Readonly<{ rows: readonly RowProjection[]; changes: readonly RowChange[]; change: OrderChange | null; neutral: readonly IntentId[];
    suggestions: readonly IntentSettlement[]; order: OrderProjection }>
}
