import { applyDocumentPatches, ownEncodedValue, readDocument } from './document.js'
import { inputRefKey } from './journal.js'
import type {
  ActionRecord, Anchor, DataOperation, Document, EntityId, ExpectedResource, InputRecord, InputRef, IntentId,
  IntentRecord, OwnedInput, Patch, PreparedAction, ResourceRef, ResourceValue, StoragePath, WriteGroupId, FrontierRef,
} from './model.js'
import { projectKernel } from './projection.js'
import { resourceAtRows } from './resources.js'
import type { KernelState } from './state.js'
import type { KernelSchema } from './schema.js'
import { assertOrderMembers, captureOrderBase, orderPredecessors } from './order.js'
import { compileFrontierTable, frontierScope } from './frontier-table.js'

export type WritePlan = Readonly<{
  id: WriteGroupId
  writes: readonly Patch[]
  comparison: 'paths' | 'entity'
  reads: readonly Readonly<{ resource: ResourceRef; role: 'semantic-read' | 'policy-guard'; expected: ResourceValue }>[]
}>
export type RowCommand =
  | Extract<DataOperation, { kind: 'create' }>
  | Readonly<{ kind: 'write'; entityId: EntityId; groups: readonly WritePlan[] }>
  | Readonly<{ kind: 'replace'; entityId: EntityId; document: Document }>
  | Readonly<{ kind: 'delete'; entityId: EntityId }>
  | Readonly<{ kind: 'order'; desired: readonly EntityId[] }>
export type RowActionPlan = Readonly<{
  action: Omit<ActionRecord, 'intentIds' | 'beforeOrder' | 'orderBase' | 'recoveryDocuments'>
  commands: readonly Readonly<{ id: IntentId; command: RowCommand; inputs: readonly InputRef[]; dependencies: readonly IntentId[] }>[]
  inputs: readonly Readonly<{ ref: InputRef; input: OwnedInput }>[]
  cause: IntentRecord['cause']
}>

/** Business code runs only while preparing a new command. Reads are captured
 * as semantic dependencies, including reads of a field also being written.
 * The returned write set, never the callback, enters the journal/checkpoint. */
export function planDocumentWrite<Input>(
  entityId: EntityId,
  document: Document,
  id: WriteGroupId,
  input: Input,
  planEdit: (context: Readonly<{ read(path: StoragePath): ResourceValue }>, input: Input) => readonly Patch[],
): WritePlan {
  const reads: WritePlan['reads'][number][] = []
  const writes = planEdit(Object.freeze({ read(path: StoragePath) {
    const owned = Object.freeze([...path]) as StoragePath
    const expected = readDocument(document, owned)
    if (!reads.some(read => read.resource.kind === 'path' && read.resource.path.length === owned.length && read.resource.path.every((segment, index) => segment === owned[index])))
      reads.push({ resource: { kind: 'path', entityId, path: owned }, role: 'semantic-read', expected })
    return expected
  } }), input)
  return ownEncodedValue({ id, writes, comparison: 'paths', reads }) as unknown as WritePlan
}

/** Prepare against a particular owned kernel revision. If anything changes
 * before acceptance, the reducer rejects the stale proposal with its original
 * inputs intact; observation equality alone is insufficient. */
export function prepareRowAction(state: KernelState, raw: RowActionPlan, schema: KernelSchema): PreparedAction {
  if (state.authority.content.kind !== 'complete') throw new Error('Cannot prepare data changes before complete authority.')
  const plan = ownEncodedValue(raw) as unknown as RowActionPlan
  const frontiers = compileFrontierTable(state.journal.frontiers, [...state.journal.intents.map(intent => intent.id), ...plan.commands.map(command => command.id)], frontierScope(state.workspace))
  const authority = state.authority.content.snapshot
  const projected = projectKernel(state, schema)
  const virtual = new Map(projected.rows.filter(row => row.preview && row.existence !== 'pending-delete').map(row => [row.entityId, row.preview!] as const))
  const authoritative = new Map(authority.entities.map(row => [row.entityId, row.document] as const))
  let virtualOrder = projected.order.preview.filter(id => virtual.has(id))
  const beforeOrder = [...virtualOrder]
  const recoveryDocuments = [...new Set(plan.commands.flatMap(entry => entry.command.kind === 'order' ? [] : [entry.command.entityId]))]
    .flatMap(entityId => { const document = virtual.get(entityId); return document ? [{ entityId, document, observation: authority.observation }] : [] })
  const inactive = new Set([...state.settlements.map(entry => entry.intentId), ...projected.neutralIntentIds])
  const earlier = state.journal.intents.filter(intent => !inactive.has(intent.id))
  const intents: IntentRecord[] = []
  type Cursor = { ids: IntentId[]; through: number; root: FrontierRef }
  const byEntity = new Map<EntityId, Cursor>()
  const include = (intent: IntentRecord) => {
    if (!('entityId' in intent.operation)) return
    const entity = intent.operation.entityId
    let cursor = byEntity.get(entity)
    if (!cursor) { cursor = { ids: [], through: 0, root: null }; byEntity.set(entity, cursor) }
    cursor.ids.push(intent.id)
  }
  for (const intent of earlier) include(intent)
  let ordering: Cursor | undefined
  const advance = (cursor: Cursor | undefined): FrontierRef => {
    if (!cursor) return null
    while (cursor.through < cursor.ids.length) cursor.root = frontiers.append(cursor.root, cursor.ids[cursor.through++]!)
    return cursor.root
  }
  let sequence = state.journal.intents.at(-1)?.sequence ?? 0
  for (const proposed of plan.commands) {
    let dependencies = frontiers.intern([...new Set(proposed.dependencies)])
    const expectation = (resource: ResourceRef, role: ExpectedResource['role']): ExpectedResource => {
      if (role !== 'policy-guard' && resource.kind === 'order' && !ordering)
        ordering = { ids: [...orderPredecessors([...earlier, ...intents], state)], through: 0, root: null }
      const previous = role === 'policy-guard' ? null : advance(resource.kind === 'order' ? ordering : byEntity.get(resource.entityId))
      dependencies = frontiers.union(dependencies, previous)
      const fallback = { kind: 'authority' as const, observation: authority.observation }
      const anchor: Anchor = previous !== null ? { kind: 'logical-output', predecessor: previous, fallback } : fallback
      return { resource, role, anchor, expected: resourceAtRows(role === 'policy-guard' ? authoritative : virtual, resource, role === 'policy-guard' ? authority.order : virtualOrder) }
    }
    const command = proposed.command
    let operation: DataOperation
    if (command.kind === 'order') {
      assertOrderMembers(command.desired, virtual.keys())
      const expected = expectation({ kind: 'order' }, 'write-base')
      operation = { ...command, expectedOrder: [...virtualOrder], authorityBase: authority.order, anchor: expected.anchor }
      virtualOrder = [...command.desired]
    } else if (command.kind === 'create') {
      operation = command; virtual.set(command.entityId, command.document); virtualOrder.push(command.entityId)
    } else {
      let before = virtual.get(command.entityId)
      if (!before) throw new Error('The logical target no longer exists. Recover or resolve it explicitly before editing.')
      if (command.kind === 'delete') {
        operation = { ...command, expected: expectation({ kind: 'entity', entityId: command.entityId }, 'write-base'), recoveryDocument: before }
        virtual.delete(command.entityId)
        virtualOrder = virtualOrder.filter(id => id !== command.entityId)
      } else if (command.kind === 'replace') {
        operation = { ...command, expected: expectation({ kind: 'entity', entityId: command.entityId }, 'write-base') }
        virtual.set(command.entityId, command.document)
      } else {
        const groups = command.groups.map(group => {
          if (group.comparison !== 'entity' && group.comparison !== 'paths') throw new Error('A write plan must declare its comparison domain.')
          const expectations: ExpectedResource[] = group.comparison === 'entity'
            ? [expectation({ kind: 'entity', entityId: command.entityId }, 'write-base')]
            : group.writes.map(patch => expectation({ kind: 'path', entityId: command.entityId, path: patch.path }, 'write-base'))
          for (const read of group.reads) expectations.push({ ...expectation(read.resource, read.role), expected: read.expected })
          before = applyDocumentPatches(before!, group.writes)
          virtual.set(command.entityId, before)
          return { id: group.id, writes: group.writes, expectations }
        })
        operation = { kind: 'write', entityId: command.entityId, groups }
      }
    }
    const intent: IntentRecord = { id: proposed.id, actionId: plan.action.id, applicationId: plan.action.applicationId, sequence: ++sequence,
      cause: plan.cause, inputs: proposed.inputs, dependencies, operation }
    intents.push(intent); include(intent)
    if (ordering && (operation.kind === 'create' || operation.kind === 'delete' || operation.kind === 'order')) ordering.ids.push(intent.id)
  }
  const inputs: InputRecord[] = plan.inputs.map(input => ({ ...input, disposition: {
    kind: 'intents', intentIds: intents.filter(intent => intent.inputs.some(ref => inputRefKey(ref) === inputRefKey(input.ref))).map(intent => intent.id),
  } }))
  const orderBase = captureOrderBase(state)
  const action = { ...plan.action, beforeOrder, orderBase: { ...orderBase, frontier: frontiers.intern(orderBase.frontier) }, recoveryDocuments, intentIds: intents.map(intent => intent.id) }
  return ownEncodedValue({ revision: state.revision, observation: authority.observation, policyVersion: state.policy.version,
    frontiers: frontiers.snapshot(), action, intents, inputs }) as unknown as PreparedAction
}
