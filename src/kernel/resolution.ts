import type { FrontierTable } from './model.js'
import { compileFrontierTable, frontierScope } from './frontier-table.js'
import { encodedValuesEqual, ownEncodedValue } from './document.js'
import { declaredRowOperation, orderOperationForIntent, rowOperationForIntent } from './intent.js'
import { appendPreparedAction, inputRefKey, recordIntentSettlements } from './journal.js'
import { kernelId, type ActionId, type ApplicationId, type Document, type EntityId, type IntentId, type IntentRecord, type ObservationId, type OwnedInput, type PreparedAction } from './model.js'
import { captureOrderBase } from './order.js'
import { prepareRowAction, type RowCommand } from './prepare.js'
import { projectKernel, reservedIntentIds } from './projection.js'
import { recoverIntentDocument } from './recovery.js'
import type { KernelSchema } from './schema.js'
import { policyForEntity, type KernelState } from './state.js'

export type ResolutionChoice =
  | Readonly<{ kind: 'use-authority' | 'keep-local' }>
  | Readonly<{ kind: 'merge'; commands: readonly RowCommand[]; input: OwnedInput }>
  | Readonly<{ kind: 'recreate'; entityId: EntityId; document?: Document }>
  | Readonly<{ kind: 'adopt-existing'; entityId: EntityId; document: Document }>
export type ResolutionRequest = Readonly<{
  revision: number
  observation: ObservationId
  issueIds: readonly string[]
  intentIds?: readonly IntentId[]
  target: Readonly<{ kind: 'row'; entityId: EntityId }> | Readonly<{ kind: 'order' }>
  choice: ResolutionChoice
}>
export type ResolutionIdentities = Readonly<{ actionId: ActionId; applicationId: ApplicationId; controlId: IntentId }>
export type PreparedResolution = Readonly<{
  request: ResolutionRequest
  identities: ResolutionIdentities
  control: IntentRecord
  frontiers: FrontierTable
  replacement: PreparedAction | null
}>

function decisionBase(state: KernelState, control: IntentRecord, frontiers: FrontierTable): KernelState {
  if (control.operation.kind !== 'resolve') throw new Error('Expected an explicit resolution control.')
  const journal = Object.freeze({ ...state.journal, frontiers, intents: Object.freeze([...state.journal.intents, control]) })
  return recordIntentSettlements(Object.freeze({ ...state, journal }), [
    ...control.operation.decision.targets.map(intentId => ({ kind: 'discarded' as const, intentId, by: control.id })),
    { kind: 'control-completed', intentId: control.id },
  ])
}

/** Compile only a decision the caller actually reviewed. A later revision or
 * observation requires another review; preparing against "whatever is latest"
 * is not permission to overwrite a newer remote value. */
export function prepareResolution(state: KernelState, raw: ResolutionRequest, identities: ResolutionIdentities, schema: KernelSchema): PreparedResolution {
  const request = ownEncodedValue(raw) as unknown as ResolutionRequest
  if (state.authority.content.kind !== 'complete' || request.revision !== state.revision || request.observation !== state.authority.content.snapshot.observation)
    throw new Error('The reviewed conflict is stale; retain the decision input and review the current observation.')
  if (state.protocolFaults.length) throw new Error('Resolve transport evidence disputes before changing data requirements.')
  if (!identities.actionId || !identities.applicationId || !identities.controlId
    || state.journal.actions.some(action => action.id === identities.actionId || action.applicationId === identities.applicationId)
    || state.journal.intents.some(intent => intent.id === identities.controlId)) throw new Error('A resolution requires fresh action, application and control identities.')
  const projection = projectKernel(state, schema)
  const selected = request.target.kind === 'order' ? projection.order : projection.rows.find(row => request.target.kind === 'row' && row.entityId === request.target.entityId)
  if (!selected || !selected.issues.length || !selected.intentIds.length) throw new Error('The selected domain has no unresolved intent conflict.')
  const issueIds = new Set(request.issueIds)
  if (!issueIds.size || issueIds.size !== request.issueIds.length || request.issueIds.length !== selected.issues.length || selected.issues.some(issue => !issueIds.has(issue.id)))
    throw new Error('The decision must identify the complete current conflict review for its selected domain.')
  const targets = [...(request.intentIds ?? selected.intentIds)]
  if (!targets.length || new Set(targets).size !== targets.length || targets.some(id => !selected.intentIds.includes(id)))
    throw new Error('A resolution must name exact active contributions in the reviewed domain.')
  const reserved = reservedIntentIds(state)
  if (targets.some(id => reserved.has(id))) throw new Error('A resolution cannot discard or replace a reserved request contribution.')
  const records = state.journal.intents.filter(intent => targets.includes(intent.id))
  const choice = request.choice
  let commands: RowCommand[] = []
  if (choice.kind === 'keep-local') {
    commands = records.map(record => {
      const ordering = orderOperationForIntent(state, record), row = rowOperationForIntent(state, record)
      if (ordering) return { kind: 'order', desired: ordering.desired }
      if (!row) throw new Error('A retained contribution requires a stored data payload.')
      if (row.kind === 'create') throw new Error('A creation collision requires explicit recreation or adoption of an existing entity.')
      if (row.kind === 'delete') return { kind: 'delete', entityId: row.entityId }
      if (row.kind === 'replace') return { kind: 'replace', entityId: row.entityId, document: row.document }
      return { kind: 'write', entityId: row.entityId, groups: row.groups.map(group => ({ id: group.id, writes: group.writes,
        comparison: group.expectations.some(expected => expected.role === 'write-base' && expected.resource.kind === 'entity') ? 'entity' : 'paths',
        reads: group.expectations.flatMap(expected => expected.role === 'write-base' ? [] : [{ role: expected.role, resource: expected.resource, expected: expected.expected }]),
      })) }
    })
  } else if (choice.kind === 'merge') {
    if (!choice.commands.length || choice.commands.some(command => request.target.kind === 'order' ? command.kind !== 'order'
      : command.kind === 'order' || command.kind === 'create' || command.entityId !== request.target.entityId))
      throw new Error('A merge must declare changes only in the reviewed row or order domain.')
    commands = [...choice.commands]
  } else if (choice.kind === 'recreate') {
    if (request.target.kind !== 'row' || state.entities.find(binding => request.target.kind === 'row' && binding.entityId === request.target.entityId)?.kind !== 'retired')
      throw new Error('Recreation requires an explicitly deleted target lifetime.')
    if (!state.policy.create || !policyForEntity(state.policy, request.target.entityId).replace) throw new Error('Recreation requires current create and replace permission.')
    if (!choice.entityId || state.entities.some(binding => binding.entityId === choice.entityId)) throw new Error('Recreation requires a fresh entity identity.')
    commands = [{ kind: 'create', entityId: choice.entityId, document: choice.document ?? recoverIntentDocument(state, request.target.entityId, targets) }]
  } else if (choice.kind === 'adopt-existing') {
    if (request.target.kind !== 'row' || !records.some(record => declaredRowOperation(record)?.kind === 'create')
      || !selected.issues.some(issue => issue.code === 'create-key-collision')) throw new Error('Adoption requires an explicit local creation collision.')
    if (state.entities.find(binding => binding.entityId === choice.entityId)?.kind !== 'bound') throw new Error('Adoption requires a currently bound destination lifetime.')
    commands = [{ kind: 'replace', entityId: choice.entityId, document: choice.document }]
  } else if (choice.kind !== 'use-authority') throw new Error('Unknown resolution choice.')
  const commandIds = commands.map((_, index) => kernelId<'intent'>(`${identities.controlId}:data:${index}`))
  const frontiers = compileFrontierTable(state.journal.frontiers, state.journal.intents.map(intent => intent.id), frontierScope(state.workspace))
  const control: IntentRecord = { id: identities.controlId, actionId: identities.actionId, applicationId: identities.applicationId,
    sequence: (state.journal.intents.at(-1)?.sequence ?? 0) + 1, cause: 'resolution', inputs: [], dependencies: frontiers.intern(targets),
    operation: { kind: 'resolve', decision: { kind: choice.kind, targets, observation: request.observation, issueIds: request.issueIds, replacements: commandIds } },
  }
  const base = decisionBase(state, control, frontiers.snapshot())
  let replacement: PreparedAction | null = null
  if (commands.length) {
    const refs = new Set(records.flatMap(record => record.inputs.map(inputRefKey)))
    const materials = choice.kind === 'merge' ? [choice.input] : state.inputs.filter(input => refs.has(inputRefKey(input.ref))).map(input => input.input)
    if (!materials.length) materials.push({ kind: 'encoded', value: ownEncodedValue(choice) })
    const inputs = materials.map((input, index) => ({ ref: { id: kernelId<'input'>(`${identities.controlId}:input:${index}`), version: 0 }, input }))
    replacement = prepareRowAction(base, {
      action: { id: identities.actionId, applicationId: identities.applicationId, label: `Resolve ${choice.kind}`, saveAtomicity: 'transaction' }, cause: 'resolution', inputs,
      commands: commands.map((command, index) => ({ id: commandIds[index]!, inputs: inputs.map(input => input.ref), dependencies: [control.id],
        command: command.kind === 'write' ? { ...command, groups: command.groups.map((group, groupIndex) => ({ ...group, id: kernelId<'write-group'>(`${commandIds[index]}:group:${groupIndex}`) })) } : command,
      })),
    }, schema)
    const candidate = appendPreparedAction(base, replacement, schema), projected = projectKernel(candidate, schema)
    const invalid = [...projected.rows.flatMap(row => row.issues), ...projected.order.issues].find(issue => issue.intentIds?.some(id => commandIds.includes(id)))
    if (invalid) throw new Error(invalid.message)
  }
  return ownEncodedValue({ request, identities, control, frontiers: frontiers.snapshot(), replacement }) as unknown as PreparedResolution
}

export function appendPreparedResolution(state: KernelState, prepared: PreparedResolution, schema: KernelSchema): KernelState {
  const expected = prepareResolution(state, prepared.request, prepared.identities, schema)
  if (!encodedValuesEqual(ownEncodedValue(prepared), ownEncodedValue(expected))) throw new Error('A resolution must equal the complete reviewed decision and compiled payload.')
  const base = decisionBase(state, expected.control, expected.frontiers)
  if (expected.replacement) {
    const candidate = appendPreparedAction(base, expected.replacement, schema)
    return Object.freeze({ ...candidate, journal: Object.freeze({ ...candidate.journal,
      actions: Object.freeze(candidate.journal.actions.map(action => action.applicationId === expected.control.applicationId
        ? Object.freeze({ ...action, intentIds: Object.freeze([expected.control.id, ...action.intentIds]) }) : action)),
    }) })
  }
  const projected = projectKernel(base, schema)
  const frontiers = compileFrontierTable(base.journal.frontiers, base.journal.intents.map(intent => intent.id), frontierScope(base.workspace))
  const capturedOrder = captureOrderBase(base)
  const action = Object.freeze({ id: expected.identities.actionId, applicationId: expected.identities.applicationId, label: 'Use authority',
    intentIds: Object.freeze([expected.control.id]), saveAtomicity: 'transaction' as const, beforeOrder: projected.order.desired, orderBase: { ...capturedOrder, frontier: frontiers.intern(capturedOrder.frontier) }, recoveryDocuments: Object.freeze([]),
  })
  return Object.freeze({ ...base, journal: Object.freeze({ ...base.journal, frontiers: frontiers.snapshot(), actions: Object.freeze([...base.journal.actions, action]) }) })
}
