import { applyDocumentPatches, encodedValuesEqual, isDocument, ownEncodedValue, readDocument } from './document.js'
import { currentHistoryEntity, declaredOrderOperation, declaredResolution, declaredRowOperation, intentFrontierForEntity, rowOperationForIntent, undoBranch } from './intent.js'
import { registerLocalEntity } from './entities.js'
import { prepareRowAction, type RowCommand } from './prepare.js'
import { projectKernel } from './projection.js'
import type { KernelSchema } from './schema.js'
import { kernelId, type ActionId, type ActionRecord, type ApplicationId, type Document, type EntityId, type ExpectedResource,
  type InputRecord, type IntentId, type IntentRecord, type Patch, type RecoveryEntry, type ResourceValue, type StoragePath, type WriteGroup } from './model.js'
import { operationResource, pathContains, resourceAtDocument, type RowOperation } from './resources.js'
import { policyForEntity, type KernelState } from './state.js'
import { captureOrderBase, orderPredecessors, projectOrder, type OrderOperation } from './order.js'
import { prepareDecisionRecovery } from './recovery.js'
import { compileFrontierTable, expandFrontier, frontierScope } from './frontier-table.js'
import type { FrontierTable } from './model.js'

export type UndoIdentities = Readonly<{ actionId: ActionId; applicationId: ApplicationId; controls: readonly Readonly<{ entityId: EntityId; intentId: IntentId }>[]; orderIntentId?: IntentId }>
export type PreparedUndo = Readonly<{ revision: number; frontiers: FrontierTable; target: ApplicationId; action: ActionRecord; intents: readonly IntentRecord[]; inputs: readonly InputRecord[]; recoveries: readonly RecoveryEntry[] }>
export type RedoIdentities = Readonly<{ applicationId: ApplicationId;
  controls: readonly Readonly<{ sourceIntentId: IntentId; intentId: IntentId }>[];
  creations: readonly Readonly<{ sourceEntityId: EntityId; entityId: EntityId }>[] }>
export type PreparedRedo = PreparedUndo
export type HistoryProjection = Readonly<{ undo: readonly ActionRecord[]; redo: readonly ActionRecord[] }>

function assertNewGroupIds(state: KernelState, additions: readonly IntentRecord[]) {
  const used = new Set(state.journal.intents.flatMap(intent => {
    const operation = declaredRowOperation(intent)
    return operation?.kind === 'write' ? operation.groups.map(group => group.id) : []
  }))
  for (const intent of additions) {
    const operation = declaredRowOperation(intent)
    if (operation?.kind === 'write') for (const group of operation.groups) {
      if (used.has(group.id)) throw new Error('History write-group identities must be fresh.')
      used.add(group.id)
    }
  }
}

/** History is an index of the journal. Refreshes and settlement never rewrite
 * navigation or manufacture a server snapshot for an intermediate action. */
export function projectHistory(state: KernelState): HistoryProjection {
  const undo: ActionRecord[] = [], redo: ActionRecord[] = []
  const start = state.discards.at(-1)?.applicationCount ?? 0
  if (start === state.journal.actions.length) return Object.freeze({ undo: Object.freeze(undo), redo: Object.freeze(redo) })
  const records = new Map(state.journal.intents.map(intent => [intent.id, intent] as const))
  for (const action of state.journal.actions.slice(start)) {
    const intents = action.intentIds.map(id => records.get(id)!)
    const first = intents[0]
    if (!first) throw new Error('A history application must retain its journal records.')
    if (first.operation.kind === 'undo' || first.operation.kind === 'undo-order' || first.operation.kind === 'undo-resolution') {
      const target = undo.pop()
      if (!target || target.applicationId !== first.operation.target || intents.some(intent => (intent.operation.kind !== 'undo' && intent.operation.kind !== 'undo-order' && intent.operation.kind !== 'undo-resolution') || intent.operation.target !== target.applicationId))
        throw new Error('Undo must reference the current complete history application.')
      redo.push(target)
    } else if (first.operation.kind === 'redo' || first.operation.kind === 'redo-order' || first.operation.kind === 'redo-resolution') {
      const target = redo.pop()
      if (!target || target.applicationId !== first.operation.target || action.id !== target.id
        || intents.some(intent => (intent.operation.kind !== 'redo' && intent.operation.kind !== 'redo-order' && intent.operation.kind !== 'redo-resolution') || intent.operation.target !== target.applicationId)) throw new Error('Redo must reapply the current complete redo template.')
      undo.push(action)
    } else {
      if (intents.some(intent => intent.cause === 'undo' || intent.cause === 'redo')) throw new Error('History controls require explicit control records.')
      undo.push(action); redo.length = 0
    }
  }
  return Object.freeze({ undo: Object.freeze(undo), redo: Object.freeze(redo) })
}

function originalValue(group: WriteGroup, entityId: EntityId, path: StoragePath): ResourceValue {
  const base = group.expectations.find(expected => expected.role === 'write-base' && expected.resource.kind !== 'order'
    && (expected.resource.kind === 'entity' || pathContains(expected.resource.path, path)))
  if (!base || base.resource.kind === 'order') throw new Error('History requires the original complete write domain.')
  if (base.resource.kind === 'entity') {
    if (base.expected.kind !== 'value' || !isDocument(base.expected.value)) throw new Error('History entity base is not a document.')
    return resourceAtDocument(base.expected.value, { kind: 'path', entityId, path })
  }
  const relative = path.slice(base.resource.path.length)
  if (!relative.length) return base.expected
  if (base.expected.kind !== 'value' || !isDocument(base.expected.value)) throw new Error('History cannot reconstruct a nested resource from a missing parent.')
  return readDocument(base.expected.value, relative as unknown as StoragePath)
}

function inversePatches(group: WriteGroup, entityId: EntityId): readonly Patch[] {
  return group.writes.map(patch => {
    const before = originalValue(group, entityId, patch.path)
    return before.kind === 'missing' ? { kind: 'remove', path: patch.path } : { kind: 'set', path: patch.path, value: before.value }
  })
}

function invertRow(state: KernelState, records: readonly IntentRecord[], controlId: IntentId, entityId: EntityId, frontiers: ReturnType<typeof compileFrontierTable>): RowOperation {
  const operations = records.map(record => rowOperationForIntent(state, record))
  if (operations.some(operation => !operation)) throw new Error('The target has no compensable row operation.')
  const rows = operations as RowOperation[], first = rows[0]!
  const authority = state.authority.content
  if (authority.kind !== 'complete') throw new Error('Undo requires an initialized authority scope.')
  const frontier = intentFrontierForEntity(state, entityId)
  const anchor = { kind: 'logical-output' as const, predecessor: frontiers.intern(frontier), fallback: { kind: 'authority' as const, observation: authority.snapshot.observation } }
  const expectation = (path: StoragePath | null, expected: ResourceValue): ExpectedResource => ({ role: 'write-base',
    resource: path ? { kind: 'path', entityId, path } : { kind: 'entity', entityId }, expected, anchor,
  })
  if (rows.at(-1)?.kind === 'delete' && rows.every(operation => operation.kind === 'write' || operation.kind === 'replace' || operation.kind === 'delete')) {
    if (!state.sourceCapabilities.restoreDeleted) throw new Error('This source cannot restore a committed deletion.')
    if (!state.policy.create || !policyForEntity(state.policy, entityId).replace) throw new Error('Restoration requires current create and replace permission.')
    const submissions = [...('submission' in state.persistence ? [state.persistence.submission] : []), ...state.commits.map(fact => fact.submission)]
    const submission = submissions.find(submission => submission.items.some(item => item.kind === 'delete' && item.entityId === entityId
      && submission.coverage.some(coverage => coverage.itemId === item.id && coverage.intentIds.some(id => records.some(record => record.id === id)))))
    const item = submission?.items.find(item => item.kind === 'delete' && item.entityId === entityId)
    if (item?.kind !== 'delete') throw new Error('Restoration requires the exact reserved or applied deletion payload.')
    const covered = new Set(submission!.coverage.find(coverage => coverage.itemId === item.id)!.intentIds)
    let document = item.before
    // A deletion may absorb earlier, unsaved applications. Its receipt proves
    // absence, not an intermediate document. Restore the actual deleted base,
    // then recover only those earlier contributions from this exact coverage.
    // Late canonical fields survive because unrelated snapshots are never used.
    for (const predecessor of state.journal.intents) {
      if (predecessor.sequence >= records[0]!.sequence || !covered.has(predecessor.id)) continue
      const operation = rowOperationForIntent(state, predecessor)
      if (!operation || operation.entityId !== entityId) continue
      if (operation.kind === 'write') for (const group of operation.groups) document = applyDocumentPatches(document, group.writes)
      else if (operation.kind === 'replace') document = operation.document
      else throw new Error('Deletion provenance contains an incompatible entity lifetime.')
    }
    return { kind: 'create', entityId: kernelId<'entity'>(`${controlId}:restored`), restoresEntity: entityId, document }
  }
  if (rows.every(operation => operation.kind === 'write')) {
    const groups: WriteGroup[] = []
    for (const operation of [...rows].reverse()) if (operation.kind === 'write') for (const group of [...operation.groups].reverse()) {
      groups.push({ id: kernelId<'write-group'>(`${controlId}:inverse:${groups.length}`), writes: inversePatches(group, entityId),
        expectations: group.expectations.filter(expected => expected.role === 'write-base').map(expected => {
          if (expected.resource.kind === 'order') throw new Error('A row inverse requires row comparison domains.')
          const resource = { ...expected.resource, entityId }
          return { ...expected, resource, anchor, expected: operationResource(resource, expected.expected, { kind: 'write', entityId, groups: [group] }) }
        }),
      })
    }
    return { kind: 'write', entityId, groups }
  }
  if (rows.some(operation => operation.kind === 'replace') && rows.every(operation => operation.kind === 'write' || operation.kind === 'replace')) {
    const index = rows.findIndex(operation => operation.kind === 'replace'), replacement = rows[index]!
    if (replacement.kind !== 'replace' || replacement.expected.expected.kind !== 'value' || !isDocument(replacement.expected.expected.value)) throw new Error('Replacement history requires its original document.')
    let original = replacement.expected.expected.value
    for (const operation of rows.slice(0, index).reverse()) if (operation.kind === 'write') for (const group of [...operation.groups].reverse())
      original = applyDocumentPatches(original, inversePatches(group, entityId))
    let document = original
    for (const operation of rows) {
      if (operation.kind === 'write') for (const group of operation.groups) document = applyDocumentPatches(document, group.writes)
      else if (operation.kind === 'replace') document = operation.document
    }
    return { kind: 'replace', entityId, expected: expectation(null, { kind: 'value', value: document }), document: original }
  }
  if (first.kind === 'create' && rows.every(operation => operation.kind === 'create' || operation.kind === 'write' || operation.kind === 'replace')) {
    let document: Document = first.document
    for (const operation of rows.slice(1)) {
      if (operation.kind === 'write') for (const group of operation.groups) document = applyDocumentPatches(document, group.writes)
      else if (operation.kind === 'replace') document = operation.document
      else throw new Error('An action cannot create the same entity twice.')
    }
    return { kind: 'delete', entityId, expected: expectation(null, { kind: 'value', value: document }), recoveryDocument: document }
  }
  throw new Error('The applied row history crosses incompatible entity lifetimes.')
}

export function prepareUndo(state: KernelState, identities: UndoIdentities): PreparedUndo {
  if (state.protocolFaults.length) throw new Error('Resolve protocol disputes before preparing history controls.')
  const target = projectHistory(state).undo.at(-1)
  if (!target) throw new Error('There is no action to undo.')
  const records = target.intentIds.map(id => state.journal.intents.find(intent => intent.id === id)!)
  const orderRecords = records.filter(record => declaredOrderOperation(record))
  const byEntity = new Map<EntityId, IntentRecord[]>()
  for (const record of records) {
    const operation = rowOperationForIntent(state, record)
    if (!operation) {
      if (declaredOrderOperation(record) || declaredResolution(record)) continue
      throw new Error('This action has no history template.')
    }
    const group = byEntity.get(operation.entityId) ?? []; group.push(record); byEntity.set(operation.entityId, group)
  }
  if (!identities.actionId || !identities.applicationId || state.journal.actions.some(action => action.id === identities.actionId || action.applicationId === identities.applicationId))
    throw new Error('Undo requires a fresh action and application identity.')
  const ids = new Map(identities.controls.map(control => [control.entityId, control.intentId]))
  if (ids.size !== identities.controls.length || ids.size !== byEntity.size || [...byEntity.keys()].some(entity => !ids.has(entity))) throw new Error('Undo requires exactly one control identity per target row.')
  const used = new Set(state.journal.intents.map(intent => intent.id))
  const frontiers = compileFrontierTable(state.journal.frontiers, [...new Set([...used, ...identities.controls.map(control => control.intentId), identities.orderIntentId ?? kernelId<'intent'>(`${identities.applicationId}:order`)])], frontierScope(state.workspace))
  const intents: IntentRecord[] = []
  const inputs: InputRecord[] = [], recoveries: RecoveryEntry[] = []
  let sequence = state.journal.intents.at(-1)?.sequence ?? 0
  // Reverse action order so later row contributions are navigated first. A
  // control remains one row contribution, irrespective of its inverse groups.
  for (const [entityId, targets] of [...byEntity].reverse()) {
    const id = ids.get(entityId)!
    if (!id || used.has(id)) throw new Error('Undo intent identities must be fresh and unique.')
    used.add(id)
    const current = currentHistoryEntity(state, entityId)
    const frontier = intentFrontierForEntity(state, current)
    const operation = { kind: 'undo' as const, target: target.applicationId, sourceEntityId: entityId, entityId: current, targets: targets.map(record => record.id), frontier: frontiers.intern(frontier), compensation: null }
    const compensation = undoBranch(state, operation) === 'suppress' ? null : invertRow(state, targets, id, current, frontiers)
    intents.push({ id, actionId: identities.actionId, applicationId: identities.applicationId, sequence: ++sequence, cause: 'undo', inputs: [], dependencies: frontiers.intern(frontier),
      operation: { ...operation, entityId: compensation?.entityId ?? current, compensation },
    })
  }
  const beforeOrder = projectOrder(state, [], [], []).order.desired
  const restorations = intents.filter(intent => intent.operation.kind === 'undo' && intent.operation.compensation?.kind === 'create').map(intent => intent.id)
  const needsOrder = orderRecords.length > 0 || restorations.length > 0
  if (!needsOrder && identities.orderIntentId) throw new Error('An order control requires an order requirement or a conditional restoration.')
  if (needsOrder) {
    const id = identities.orderIntentId ?? kernelId<'intent'>(`${identities.applicationId}:order`)
    if (used.has(id)) throw new Error('Undo intent identities must be fresh and unique.')
    const history = state.journal.intents.filter(intent => !state.settlements.some(proof => proof.intentId === intent.id
      && (proof.kind === 'discarded' || proof.kind === 'workspace-discarded' || proof.kind === 'control-completed')) && (intent.sequence >= records[0]!.sequence || expandFrontier(state.journal.frontiers, target.orderBase.frontier).includes(intent.id)))
    const frontier = orderPredecessors(history, state)
    const operation = { kind: 'undo-order' as const, target: target.applicationId, targets: orderRecords.map(record => record.id), restorations, frontier: frontiers.intern(frontier), compensation: null }
    const controlState = { ...state, journal: { ...state.journal, intents: [...state.journal.intents, ...intents] } }
    let compensation: OrderOperation | null = null
    if (undoBranch(controlState, operation) !== 'suppress') {
      const authority = state.authority.content
      if (authority.kind !== 'complete') throw new Error('Undo requires an initialized authority scope.')
      compensation = { kind: 'order', expectedOrder: beforeOrder, authorityBase: target.orderBase.authority,
        anchor: { kind: 'logical-output', predecessor: frontiers.intern(frontier), fallback: { kind: 'authority', observation: authority.snapshot.observation } },
        desired: target.beforeOrder.map(entityId => currentHistoryEntity(state, entityId)),
      }
    }
    intents.push({ id, actionId: identities.actionId, applicationId: identities.applicationId, sequence: ++sequence, cause: 'undo', inputs: [],
      dependencies: frontiers.intern([...frontier, ...orderPredecessors(intents, state)]), operation: { ...operation, compensation } })
  }
  for (const record of records.filter(record => declaredResolution(record))) {
    const id = kernelId<'intent'>(`${identities.applicationId}:recover:${record.id}`), recoveryId = kernelId<'recovery'>(`${id}:entry`)
    if (used.has(id) || intents.some(intent => intent.id === id)) throw new Error('Resolution undo identities must be fresh.')
    const recovered = prepareDecisionRecovery(state, record.id, id, recoveryId)
    inputs.push(...recovered.inputs); recoveries.push(recovered.entry)
    intents.push({ id, actionId: identities.actionId, applicationId: identities.applicationId, sequence: ++sequence, cause: 'undo',
      inputs: recovered.entry.inputs, dependencies: frontiers.intern([record.id]), operation: { kind: 'undo-resolution', target: target.applicationId, resolution: record.id, recoveryId },
    })
  }
  const capturedOrder = captureOrderBase(state)
  const orderBase = { ...capturedOrder, frontier: frontiers.intern(capturedOrder.frontier) }
  return ownEncodedValue({ revision: state.revision, frontiers: frontiers.snapshot(), target: target.applicationId,
    action: { id: identities.actionId, applicationId: identities.applicationId, label: `Undo ${target.label}`, beforeOrder, orderBase, recoveryDocuments: [], intentIds: intents.map(intent => intent.id), saveAtomicity: target.saveAtomicity }, intents, inputs, recoveries,
  }) as unknown as PreparedUndo
}

export function appendPreparedUndo(state: KernelState, prepared: PreparedUndo): KernelState {
  if (prepared.revision !== state.revision) throw new Error('Prepared undo is stale; preserve its target and prepare against the current history frontier.')
  const expected = prepareUndo(state, { actionId: prepared.action.id, applicationId: prepared.action.applicationId,
    controls: prepared.intents.flatMap(intent => {
      if (intent.operation.kind === 'undo-order' || intent.operation.kind === 'undo-resolution') return []
      if (intent.operation.kind !== 'undo') throw new Error('Prepared undo can only contain undo controls.')
      return [{ entityId: intent.operation.sourceEntityId, intentId: intent.id }]
    }),
    ...(prepared.intents.some(intent => intent.operation.kind === 'undo-order') ? { orderIntentId: prepared.intents.find(intent => intent.operation.kind === 'undo-order')!.id } : {}),
  })
  if (!encodedValuesEqual(ownEncodedValue(prepared), ownEncodedValue(expected))) throw new Error('Undo must equal the complete conditional inverse of the current application.')
  assertNewGroupIds(state, expected.intents)
  let entities = state.entities
  for (const intent of expected.intents) if (intent.operation.kind === 'undo' && intent.operation.compensation?.kind === 'create')
    entities = registerLocalEntity(entities, intent.operation.entityId, intent.id)
  return Object.freeze({ ...state, entities, inputs: Object.freeze([...state.inputs, ...expected.inputs]), recoveries: Object.freeze([...state.recoveries, ...expected.recoveries]),
    journal: Object.freeze({ frontiers: expected.frontiers, intents: Object.freeze([...state.journal.intents, ...expected.intents]), actions: Object.freeze([...state.journal.actions, expected.action]) }) })
}

/** Reapply stored payloads using a new application and current authoring bases.
 * Original semantic reads retain their actual values; business callbacks never
 * run again. A recreated local row always receives a fresh client lifetime. */
export function prepareRedo(state: KernelState, identities: RedoIdentities, schema: KernelSchema): PreparedRedo {
  if (state.protocolFaults.length) throw new Error('Resolve protocol disputes before preparing history controls.')
  const target = projectHistory(state).redo.at(-1)
  if (!target) throw new Error('There is no action to redo.')
  if (!identities.applicationId || state.journal.actions.some(action => action.applicationId === identities.applicationId)) throw new Error('Redo requires a fresh application identity.')
  const records = target.intentIds.map(id => state.journal.intents.find(intent => intent.id === id)!)
  const ids = new Map(identities.controls.map(control => [control.sourceIntentId, control.intentId]))
  if (ids.size !== identities.controls.length || ids.size !== records.length || records.some(record => !ids.has(record.id)))
    throw new Error('Redo requires one fresh control identity per original intent, in its original sequence.')
  if (new Set(ids.values()).size !== ids.size || [...ids.values()].some(id => !id || state.journal.intents.some(intent => intent.id === id))) throw new Error('Redo control identities must be fresh and unique.')
  const created = new Set(records.flatMap(record => { const operation = declaredRowOperation(record); return operation?.kind === 'create' ? [operation.entityId] : [] }))
  const creations = new Map(identities.creations.map(mapping => [mapping.sourceEntityId, mapping.entityId]))
  if (creations.size !== identities.creations.length || creations.size !== created.size || [...created].some(entity => !creations.has(entity)))
    throw new Error('Redo requires exactly one fresh lifetime for each original creation.')
  const usedEntities = new Set(state.entities.map(binding => binding.entityId))
  for (const entityId of creations.values()) {
    if (!entityId || usedEntities.has(entityId)) throw new Error('Redo creation requires a fresh entity lifetime.')
    usedEntities.add(entityId)
  }
  const entity = (sourceEntityId: EntityId) => creations.get(sourceEntityId) ?? currentHistoryEntity(state, sourceEntityId)
  const readValue = (expected: ExpectedResource): ResourceValue => {
    if (expected.resource.kind !== 'order') return expected.expected
    if (expected.expected.kind !== 'value' || !Array.isArray(expected.expected.value) || expected.expected.value.some(id => typeof id !== 'string'))
      throw new Error('An order read must retain its complete entity sequence.')
    return { kind: 'value', value: expected.expected.value.map(id => entity(kernelId<'entity'>(id))) }
  }
  let sequence = state.journal.intents.at(-1)?.sequence ?? 0
  const frontiers = compileFrontierTable(state.journal.frontiers, [...state.journal.intents.map(intent => intent.id), ...identities.controls.map(control => control.intentId)], frontierScope(state.workspace))
  const controls: IntentRecord[] = records.flatMap(record => {
    const decision = declaredResolution(record)
    return decision ? [{ id: ids.get(record.id)!, actionId: target.id, applicationId: identities.applicationId, sequence: ++sequence, cause: 'redo' as const, inputs: [], dependencies: frontiers.intern([record.id]),
      operation: { kind: 'redo-resolution' as const, target: target.applicationId, sourceIntentId: record.id,
        decision: { ...decision, replacements: decision.replacements.map(id => ids.get(id) ?? id) },
        recoveries: state.recoveries.filter(entry => entry.resolution === record.id && entry.state === 'available').map(entry => entry.id),
      },
    }] : []
  })
  const base = { ...state, journal: { ...state.journal, frontiers: frontiers.snapshot(), intents: [...state.journal.intents, ...controls] } }
  const preceding = new Set(base.journal.intents.map(intent => intent.id))
  const dataRecords = records.filter(record => !declaredResolution(record))
  const commands = dataRecords.map(record => {
    const id = ids.get(record.id)!
    if (!id || preceding.has(id)) throw new Error('Redo control identities must be fresh and unique.')
    const dependencies = expandFrontier(state.journal.frontiers, record.dependencies).map(dependency => ids.get(dependency) ?? dependency)
    if (dependencies.some(dependency => !preceding.has(dependency))) throw new Error('A replay dependency must precede its consumer.')
    preceding.add(id)
    const ordering = declaredOrderOperation(record), operation = declaredRowOperation(record)
    let command: RowCommand
    if (ordering) command = { kind: 'order', desired: ordering.desired.map(entity) }
    else if (!operation) throw new Error('Redo requires an original data template.')
    else if (operation.kind === 'create') command = { ...operation, entityId: entity(operation.entityId) }
    else if (operation.kind === 'delete') command = { kind: 'delete', entityId: entity(operation.entityId) }
    else if (operation.kind === 'replace') command = { kind: 'replace', entityId: entity(operation.entityId), document: operation.document }
    else command = { kind: 'write', entityId: entity(operation.entityId), groups: operation.groups.map((group, index) => ({
      id: kernelId<'write-group'>(`${id}:replay:${index}`), writes: group.writes,
      comparison: group.expectations.some(expected => expected.role === 'write-base' && expected.resource.kind === 'entity') ? 'entity' as const : 'paths' as const,
      reads: group.expectations.flatMap(expected => expected.role === 'write-base' ? [] : [{
        resource: expected.resource.kind === 'order' ? expected.resource : { ...expected.resource, entityId: entity(expected.resource.entityId) },
        role: expected.role, expected: readValue(expected),
      }]),
    })) }
    return { id, command, inputs: [], dependencies }
  })
  const prepared = prepareRowAction(base, { action: { id: target.id, applicationId: identities.applicationId, label: target.label, saveAtomicity: target.saveAtomicity },
    commands, inputs: [], cause: 'redo',
  }, schema)
  const data = prepared.intents.map((intent, index) => {
    const original = dataRecords[index]!, replay = intent.operation
    const control = { target: target.applicationId, sourceIntentId: original.id }
    if (replay.kind === 'order') return { ...intent, operation: { kind: 'redo-order' as const, ...control, replay } }
    if (replay.kind !== 'create' && replay.kind !== 'write' && replay.kind !== 'replace' && replay.kind !== 'delete') throw new Error('Redo requires compiled data.')
    return { ...intent, operation: { kind: 'redo' as const, ...control, sourceEntityId: declaredRowOperation(original)!.entityId, entityId: replay.entityId, replay } }
  })
  const intents = [...controls, ...data]
  return ownEncodedValue({ revision: state.revision, frontiers: prepared.frontiers, target: target.applicationId, action: { ...prepared.action, intentIds: intents.map(intent => intent.id) }, intents, inputs: [], recoveries: [] }) as unknown as PreparedRedo
}

export function appendPreparedRedo(state: KernelState, prepared: PreparedRedo, schema: KernelSchema): KernelState {
  if (prepared.revision !== state.revision) throw new Error('Prepared redo is stale; prepare against the current history frontier.')
  const expected = prepareRedo(state, { applicationId: prepared.action.applicationId, controls: prepared.intents.map(intent => {
    if (intent.operation.kind !== 'redo' && intent.operation.kind !== 'redo-order' && intent.operation.kind !== 'redo-resolution') throw new Error('Prepared redo can only contain replay controls.')
    return { sourceIntentId: intent.operation.sourceIntentId, intentId: intent.id }
  }), creations: prepared.intents.flatMap(intent => intent.operation.kind === 'redo' && intent.operation.replay.kind === 'create'
    ? [{ sourceEntityId: intent.operation.sourceEntityId, entityId: intent.operation.entityId }] : []) }, schema)
  if (!encodedValuesEqual(ownEncodedValue(prepared), ownEncodedValue(expected))) throw new Error('Redo must equal the complete current replay of its stored template.')
  assertNewGroupIds(state, expected.intents)
  let entities = state.entities
  for (const intent of expected.intents) if (intent.operation.kind === 'redo' && intent.operation.replay.kind === 'create') entities = registerLocalEntity(entities, intent.operation.entityId, intent.id)
  const released = new Map(expected.intents.flatMap(intent => intent.operation.kind === 'redo-resolution' ? intent.operation.recoveries.map(id => [id, intent.id] as const) : []))
  for (const entry of state.recoveries) if (released.has(entry.id)) for (const ref of entry.inputs) {
    const input = state.inputs.find(input => input.ref.id === ref.id && input.ref.version === ref.version)
    if (input?.disposition.kind !== 'recovery' || input.disposition.recoveryId !== entry.id) throw new Error('Redo cannot take input from another recovery owner.')
  }
  const inputs = Object.freeze(state.inputs.map(input => input.disposition.kind === 'recovery' && released.has(input.disposition.recoveryId)
    ? Object.freeze({ ...input, disposition: Object.freeze({ kind: 'discarded' as const, by: released.get(input.disposition.recoveryId)! }) }) : input))
  const recoveries = Object.freeze(state.recoveries.map(entry => released.has(entry.id) ? Object.freeze({ ...entry, state: 'discarded' as const }) : entry))
  const candidate = Object.freeze({ ...state, entities, inputs, recoveries,
    journal: Object.freeze({ frontiers: expected.frontiers, intents: Object.freeze([...state.journal.intents, ...expected.intents]), actions: Object.freeze([...state.journal.actions, expected.action]) }),
  })
  const projected = projectKernel(candidate, schema)
  const hardIssue = [...projected.rows.flatMap(row => row.issues), ...projected.order.issues].find(issue => issue.intentIds?.some(id => expected.action.intentIds.includes(id))
    && ['policy-blocked', 'readonly-write', 'schema-invalid', 'schema-validation-failed', 'semantic-read-changed', 'policy-guard-changed'].includes(issue.code))
  if (hardIssue) throw new Error(hardIssue.message)
  return candidate
}
