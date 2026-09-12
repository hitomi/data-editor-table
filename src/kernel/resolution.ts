import type { FrontierTable } from './model.js'
import { compileFrontierTable, expandFrontier, frontierScope } from './frontier-table.js'
import { fieldResolutionIssues, preserveUnreviewedFieldBases } from './field-resolution.js'
import { encodedValuesEqual, ownEncodedValue, pathsOverlap } from './document.js'
import { declaredRowOperation, orderOperationForIntent, rowOperationForIntent } from './intent.js'
import { appendPreparedAction, inputRefKey, recordIntentSettlements } from './journal.js'
import { kernelId, type ActionId, type ApplicationId, type Document, type EntityId, type FieldId, type IntentId, type IntentRecord, type ObservationId, type OwnedInput, type PreparedAction } from './model.js'
import { captureOrderBase } from './order.js'
import { prepareRowAction, type RowCommand } from './prepare.js'
import { projectKernel, reservedIntentIds } from './projection.js'
import { recoverIntentDocument } from './recovery.js'
import type { KernelSchema } from './schema.js'
import { policyForEntity, type KernelState } from './state.js'
import { pathContains } from './resources.js'

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
  target: Readonly<{ kind: 'row'; entityId: EntityId }> | Readonly<{ kind: 'field'; entityId: EntityId; fieldId: FieldId }> | Readonly<{ kind: 'order' }>
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
  const selected = request.target.kind === 'order' ? projection.order : projection.rows.find(row => request.target.kind !== 'order' && row.entityId === request.target.entityId)
  if (!selected || !selected.issues.length || !selected.intentIds.length) throw new Error('The selected domain has no unresolved intent conflict.')
  const field = request.target.kind === 'field' ? schema.fields.find(field => request.target.kind === 'field' && field.id === request.target.fieldId) : null
  if (request.target.kind === 'field' && !field) throw new Error('The reviewed field is no longer bound in this schema.')
  if (field && request.choice.kind !== 'keep-local' && request.choice.kind !== 'use-authority') throw new Error('A field decision must explicitly keep its local value or use authority.')
  const reviewedIssues = field && request.target.kind !== 'order' ? fieldResolutionIssues(selected.issues, request.target.entityId, field.path) : selected.issues
  const issueIds = new Set(request.issueIds)
  if (!issueIds.size || issueIds.size !== request.issueIds.length || request.issueIds.length !== reviewedIssues.length || reviewedIssues.some(issue => !issueIds.has(issue.id)))
    throw new Error('The decision must identify the complete current conflict review for its selected domain.')
  const domainIntents = field ? selected.intentIds.filter(id => {
    const operation = rowOperationForIntent(state, state.journal.intents.find(intent => intent.id === id)!)
    return operation?.kind === 'write' && operation.groups.some(group => group.writes.some(write => pathsOverlap(write.path, field.path)))
  }) : selected.intentIds
  const targets = [...(request.intentIds ?? domainIntents)]
  if (!targets.length || new Set(targets).size !== targets.length || targets.some(id => !domainIntents.includes(id)))
    throw new Error('A resolution must name exact active contributions in the reviewed domain.')
  const reserved = reservedIntentIds(state)
  if (targets.some(id => reserved.has(id))) throw new Error('A resolution cannot discard or replace a reserved request contribution.')
  const records = state.journal.intents.filter(intent => targets.includes(intent.id))
  if (field && records.some(record => {
    const operation = rowOperationForIntent(state, record)
    return operation?.kind !== 'write' || operation.groups.some(group => group.writes.some(write => pathsOverlap(field.path, write.path) && !pathContains(field.path, write.path)))
  })) throw new Error('A parent-domain write requires its complete conflict review.')
  const choice = request.choice
  const fieldTemplates = field ? records.flatMap(record => {
    const operation = rowOperationForIntent(state, record)
    if (operation?.kind !== 'write') throw new Error('Field review requires stored field writes.')
    const groups = operation.groups.map(group => ({ ...group, writes: group.writes.filter(write => choice.kind !== 'use-authority' || !pathsOverlap(field.path, write.path)) })).filter(group => group.writes.length)
    return groups.length ? [{ record, operation: { ...operation, groups } }] : []
  }) : null
  let commands: RowCommand[] = []
  if (choice.kind === 'keep-local' || fieldTemplates) {
    commands = (fieldTemplates?.map(template => template.record) ?? records).map((record, index) => {
      const ordering = orderOperationForIntent(state, record), row = rowOperationForIntent(state, record)
      if (ordering) return { kind: 'order', desired: ordering.desired }
      if (!row) throw new Error('A retained contribution requires a stored data payload.')
      if (row.kind === 'create') throw new Error('A creation collision requires explicit recreation or adoption of an existing entity.')
      if (row.kind === 'delete') return { kind: 'delete', entityId: row.entityId }
      if (row.kind === 'replace') return { kind: 'replace', entityId: row.entityId, document: row.document }
      return { kind: 'write', entityId: row.entityId, groups: (fieldTemplates?.[index]?.operation.groups ?? row.groups).map(group => ({ id: group.id, writes: group.writes,
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
    operation: { kind: 'resolve', decision: { kind: choice.kind, targets, observation: request.observation, issueIds: request.issueIds, replacements: commandIds,
      ...(field && request.target.kind !== 'order' ? { field: { entityId: request.target.entityId, path: field.path } } : {}) } },
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
    if (field && fieldTemplates) {
      // Validate identities, input ownership, complete write sets and action
      // metadata before restoring only the unreviewed comparison evidence.
      appendPreparedAction(base, replacement, schema)
      const retainedFrontiers = compileFrontierTable(replacement.frontiers, [...base.journal.intents, ...replacement.intents].map(intent => intent.id), frontierScope(state.workspace))
      const intents = replacement.intents.map((intent, index) => {
        const template = fieldTemplates[index]!
        if (intent.operation.kind !== 'write') throw new Error('A field replacement requires compiled writes.')
        return { ...intent, dependencies: retainedFrontiers.intern([...new Set([...expandFrontier(replacement!.frontiers, intent.dependencies), ...expandFrontier(state.journal.frontiers, template.record.dependencies)])]),
          operation: preserveUnreviewedFieldBases(template.operation, intent.operation, field.path) }
      })
      replacement = { ...replacement, frontiers: retainedFrontiers.snapshot(), intents }
    }
    const candidate = appendResolutionReplacement(base, replacement, !!field, schema), projected = projectKernel(candidate, schema)
    const invalid = [...projected.rows.flatMap(row => row.issues), ...projected.order.issues].find(issue => issue.intentIds?.some(id => commandIds.includes(id))
      && (!field || issue.code !== 'write-conflict'))
    if (invalid) throw new Error(invalid.message)
  }
  return ownEncodedValue({ request, identities, control, frontiers: frontiers.snapshot(), replacement }) as unknown as PreparedResolution
}

/** Field replacements include immutable comparison evidence from unreviewed
 * contributions. Only the deterministic resolution compiler may publish these;
 * ordinary authoring still requires entirely current compiled expectations. */
function appendResolutionReplacement(state: KernelState, replacement: PreparedAction, field: boolean, schema: KernelSchema): KernelState {
  if (!field) return appendPreparedAction(state, replacement, schema)
  return Object.freeze({ ...state, inputs: Object.freeze([...state.inputs, ...replacement.inputs]), journal: Object.freeze({ frontiers: replacement.frontiers,
    intents: Object.freeze([...state.journal.intents, ...replacement.intents]), actions: Object.freeze([...state.journal.actions, replacement.action]) }) })
}

export function appendPreparedResolution(state: KernelState, prepared: PreparedResolution, schema: KernelSchema): KernelState {
  const expected = prepareResolution(state, prepared.request, prepared.identities, schema)
  if (!encodedValuesEqual(ownEncodedValue(prepared), ownEncodedValue(expected))) throw new Error('A resolution must equal the complete reviewed decision and compiled payload.')
  const base = decisionBase(state, expected.control, expected.frontiers)
  if (expected.replacement) {
    const candidate = appendResolutionReplacement(base, expected.replacement, expected.request.target.kind === 'field', schema)
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
