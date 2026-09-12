import { compileFrontierChecks } from './frontier-checks.js'
import { applyDocumentPatches, encodedValuesEqual, isDocument, ownEncodedValue, pathsOverlap, resourceValuesEqual } from './document.js'
import { registerLocalEntity } from './entities.js'
import { declaredRowOperation, undoSettlementSuggestions } from './intent.js'
import type { ExpectedResource, InputRef, IntentId, IntentRecord, IntentSettlement, PreparedAction, ResourceRef, SessionId, TaskId } from './model.js'
import { projectKernel } from './projection.js'
import { serverKeyIdentity } from './protocol.js'
import { pathContains, resourceAtRows } from './resources.js'
import type { KernelState } from './state.js'
import type { KernelSchema } from './schema.js'
import { assertOrderMembers, captureOrderBase, orderPredecessors } from './order.js'
import { assertFrontierExtension, expandFrontier, frontierScope } from './frontier-table.js'

export function inputRefKey(ref: InputRef): string {
  if (!ref.id || !Number.isSafeInteger(ref.version) || ref.version < 0) throw new Error('Input references require a stable identity and nonnegative safe version.')
  return JSON.stringify([ref.id, ref.version])
}

function validateResource(resource: ResourceRef) {
  if (resource.kind === 'order') return
  if (!resource.entityId) throw new Error('A resource requires an entity identity.')
  if (resource.kind === 'path' && (resource.path.length === 0 || resource.path.some(segment => typeof segment !== 'string')))
    throw new Error('A storage path must contain string segments.')
}

function validateExpectation(expected: ExpectedResource, intent: IntentRecord, prepared: PreparedAction, checks: ReturnType<typeof compileFrontierChecks>, state: KernelState) {
  validateResource(expected.resource)
  if (!['write-base', 'semantic-read', 'policy-guard'].includes(expected.role)) throw new Error('An expectation must declare its semantic role.')
  if (expected.expected.kind !== 'missing' && expected.expected.kind !== 'value') throw new Error('An expectation requires an explicit resource envelope.')
  if (expected.resource.kind === 'entity' && expected.expected.kind === 'value' && !isDocument(expected.expected.value)) throw new Error('An entity comparison requires a complete document.')
  const anchor = expected.anchor
  const observation = anchor.kind === 'authority' ? anchor.observation : anchor.kind === 'logical-output' ? anchor.fallback.observation : anchor.fallback.fallback.observation
  if (observation !== prepared.observation) throw new Error('Prepared expectation does not belong to the current authority observation.')
  checks.anchor(anchor, intent.sequence, intent.dependencies)
  if (anchor.kind === 'submission-output') {
    const refs = expandFrontier(prepared.frontiers, anchor.frontier)
    const submission = 'submission' in state.persistence && state.persistence.submission.operationId === anchor.operationId ? state.persistence.submission
      : state.commits.find(fact => fact.submission.operationId === anchor.operationId)?.submission
    const item = submission?.items.find(item => item.id === anchor.itemId)
    if (!item || item.kind === 'order' || expected.resource.kind === 'order' || item.entityId !== expected.resource.entityId)
      throw new Error('A submission anchor must reference the exact entity item.')
    const coverage = submission!.coverage.find(entry => entry.itemId === anchor.itemId)!.intentIds
    if (refs.length !== coverage.length || refs.some(id => !coverage.includes(id))) throw new Error('A submission output anchor must name its complete item frontier.')
  }
}

/** Validate and own the complete candidate before returning any changed fact.
 * The caller publishes this journal together with input ownership and local
 * identity registration in one transition; no half-action can escape. */
export function appendPreparedAction(state: KernelState, raw: PreparedAction, schema: KernelSchema): KernelState {
  return appendAction(state, raw, schema, new Set())
}

/** Only the live session's complete ownership bundle may enter this handoff.
 * The caller validates its editor lease, dependencies and target before this
 * candidate is published. Ordinary actions cannot take registered input. */
export function appendSessionAction(state: KernelState, raw: PreparedAction, schema: KernelSchema): KernelState {
  const session = state.session
  if (!session) throw new Error('There is no session to transfer.')
  const refs = new Set([session.input, ...session.retainedInputs].map(inputRefKey))
  if (raw.inputs.length !== refs.size || raw.inputs.some(input => !refs.has(inputRefKey(input.ref))))
    throw new Error('Session apply must transfer every retained input exactly once.')
  for (const input of raw.inputs) {
    const previous = state.inputs.find(record => inputRefKey(record.ref) === inputRefKey(input.ref))
    if (!previous || previous.disposition.kind !== 'session' || previous.disposition.sessionId !== session.id
      || !encodedValuesEqual(ownEncodedValue(input.input), ownEncodedValue(previous.input)))
      throw new Error('Session apply cannot replace or steal retained input.')
  }
  return appendAction(state, raw, schema, refs)
}

export function appendTaskAction(state: KernelState, taskId: TaskId, sessionId: SessionId | null, raw: PreparedAction, schema: KernelSchema): KernelState {
  const task = state.tasks.find(task => task.id === taskId), session = sessionId === null ? null : state.session
  if (!task || (sessionId !== null && session?.id !== sessionId)) throw new Error('Task transfer requires its retained input and any selected live session.')
  const refs = new Set([task.input, ...(session ? [session.input, ...session.retainedInputs] : [])].map(inputRefKey))
  if (raw.inputs.length !== refs.size || raw.inputs.some(input => !refs.has(inputRefKey(input.ref)))) throw new Error('Task apply must transfer its complete input bundle.')
  for (const input of raw.inputs) {
    const previous = state.inputs.find(record => inputRefKey(record.ref) === inputRefKey(input.ref))
    const taskInput = inputRefKey(input.ref) === inputRefKey(task.input)
    if (!previous || (taskInput ? previous.disposition.kind !== 'task' || previous.disposition.taskId !== task.id
      : previous.disposition.kind !== 'session' || previous.disposition.sessionId !== sessionId)
      || !encodedValuesEqual(ownEncodedValue(input.input), ownEncodedValue(previous.input))) throw new Error('Task apply cannot replace or steal retained input.')
  }
  return appendAction(state, raw, schema, refs)
}

function appendAction(state: KernelState, raw: PreparedAction, schema: KernelSchema, transferred: ReadonlySet<string>): KernelState {
  const prepared = ownEncodedValue(raw) as unknown as PreparedAction
  if (state.authority.content.kind !== 'complete') throw new Error('A complete authority is required before accepting data edits.')
  const authority = state.authority.content.snapshot
  if (prepared.revision !== state.revision || prepared.observation !== authority.observation || prepared.policyVersion !== state.policy.version)
    throw new Error('Prepared action is stale; its input must be retained and prepared against the current context.')
  const action = prepared.action
  assertFrontierExtension(state.journal.frontiers, prepared.frontiers)
  const checks = compileFrontierChecks(prepared.frontiers, [...state.journal.intents, ...prepared.intents], frontierScope(state.workspace))
  if (!action.id || !action.applicationId || typeof action.label !== 'string' || !['row', 'transaction'].includes(action.saveAtomicity))
    throw new Error('Action metadata is incomplete.')
  if (state.journal.actions.some(existing => existing.applicationId === action.applicationId)) throw new Error('An application identity cannot be reused.')
  if (state.journal.actions.some(existing => existing.id === action.id)) throw new Error('Only an explicit redo can reapply an existing action identity.')
  if (!prepared.intents.length || action.intentIds.length !== prepared.intents.length || new Set(action.intentIds).size !== action.intentIds.length
    || prepared.intents.some((intent, index) => action.intentIds[index] !== intent.id)) throw new Error('The action must cover all its intents exactly once in causal order.')
  const known = new Set(state.journal.intents.map(intent => intent.id))
  const projection = projectKernel(state, schema)
  const virtual = new Map(projection.rows.filter(row => row.preview && row.existence !== 'pending-delete').map(row => [row.entityId, row.preview!] as const))
  let virtualOrder = projection.order.preview.filter(id => virtual.has(id))
  if (!encodedValuesEqual(ownEncodedValue(action.beforeOrder), virtualOrder)) throw new Error('An action must retain its complete initial logical order.')
  if (!encodedValuesEqual(ownEncodedValue({ ...action.orderBase, frontier: expandFrontier(prepared.frontiers, action.orderBase.frontier) }), ownEncodedValue(captureOrderBase(state)))) throw new Error('An action must retain its authoritative order base and causal frontier.')
  const recoveryDocuments = [...new Set(prepared.intents.flatMap(intent => 'entityId' in intent.operation ? [intent.operation.entityId] : []))]
    .flatMap(entityId => { const document = virtual.get(entityId); return document ? [{ entityId, document, observation: authority.observation }] : [] })
  if (!encodedValuesEqual(ownEncodedValue(action.recoveryDocuments), ownEncodedValue(recoveryDocuments))) throw new Error('Recovery material must equal the complete original logical documents.')
  const authoritative = new Map(authority.entities.map(row => [row.entityId, row.document] as const))
  const groupIds = new Set(state.journal.intents.flatMap(intent => {
    const operation = declaredRowOperation(intent)
    return operation?.kind === 'write' ? operation.groups.map(group => group.id) : []
  }))
  let sequence = state.journal.intents.at(-1)?.sequence ?? 0, entities = state.entities
  for (const intent of prepared.intents) {
    if (!intent.id || known.has(intent.id) || intent.actionId !== action.id || intent.applicationId !== action.applicationId
      || !Number.isSafeInteger(intent.sequence) || intent.sequence !== ++sequence) throw new Error('Intent identities, action membership and sequence must be unique and causal.')
    if (!['user', 'task', 'resolution'].includes(intent.cause)) throw new Error('Undo and redo require validated history control transitions.')
    checks.check(intent.dependencies, intent.sequence)
    if (new Set(intent.inputs.map(inputRefKey)).size !== intent.inputs.length) throw new Error('An intent cannot reference the same input version twice.')
    const operation = intent.operation
    if (operation.kind !== 'create' && operation.kind !== 'write' && operation.kind !== 'replace' && operation.kind !== 'delete' && operation.kind !== 'order')
      throw new Error('This entry point accepts prepared row data operations; control records require their own transition.')
    if (operation.kind === 'order') {
      assertOrderMembers(operation.desired, virtual.keys())
      const inactive = new Set([...state.settlements.map(proof => proof.intentId), ...projection.neutralIntentIds])
      const predecessors = orderPredecessors([...state.journal.intents.filter(intent => !inactive.has(intent.id)), ...prepared.intents.filter(previous => previous.sequence < intent.sequence)], state)
      const fallback = { kind: 'authority', observation: prepared.observation }
      const anchor = predecessors.length ? { kind: 'logical-output', predecessor: predecessors, fallback } : fallback
      const actualAnchor = operation.anchor.kind === 'logical-output' ? { ...operation.anchor, predecessor: expandFrontier(prepared.frontiers, operation.anchor.predecessor) } : operation.anchor
      if (!encodedValuesEqual(ownEncodedValue(actualAnchor), ownEncodedValue(anchor))
        || !encodedValuesEqual(operation.expectedOrder, virtualOrder) || !encodedValuesEqual(operation.authorityBase, authority.order)) throw new Error('Order must retain its complete current authoring context and structural dependencies.')
      validateExpectation({ resource: { kind: 'order' }, expected: { kind: 'value', value: virtualOrder }, role: 'write-base', anchor: operation.anchor }, intent, prepared, checks, state)
      virtualOrder = [...operation.desired]
    } else if (operation.kind === 'create') {
      if (operation.restoresEntity !== undefined) throw new Error('Restoration identity links require a validated history transition.')
      entities = registerLocalEntity(entities, operation.entityId, intent.id)
      if (!isDocument(operation.document)) throw new Error('A creation requires a document.')
      if (operation.proposedKey !== undefined) serverKeyIdentity(operation.proposedKey)
      virtual.set(operation.entityId, operation.document)
      virtualOrder.push(operation.entityId)
    } else {
      let before = virtual.get(operation.entityId)
      if (!before) throw new Error('A data edit must target an existing logical entity.')
      const validateBase = (expected: ExpectedResource) => {
        validateExpectation(expected, intent, prepared, checks, state)
        if (expected.role === 'write-base' && (expected.resource.kind === 'order' || expected.resource.entityId !== operation.entityId))
          throw new Error('A write base must belong to its target entity.')
        const actual = resourceAtRows(expected.role === 'policy-guard' ? authoritative : virtual, expected.resource, expected.role === 'policy-guard' ? authority.order : virtualOrder)
        if (!resourceValuesEqual(actual, expected.expected)) throw new Error('Prepared expectation differs from the authoring context.')
      }
      if (operation.kind === 'write') {
        if (!operation.groups.length) throw new Error('A write requires at least one atomic group.')
        for (const group of operation.groups) {
          if (!group.id || groupIds.has(group.id) || !group.writes.length) throw new Error('Write groups require unique identities and a nonempty write set.')
          groupIds.add(group.id)
          for (const expected of group.expectations) validateBase(expected)
          for (let index = 0; index < group.writes.length; index++) {
            const patch = group.writes[index]!
            if (patch.kind !== 'set' && patch.kind !== 'remove') throw new Error('Unknown document patch.')
            validateResource({ kind: 'path', entityId: operation.entityId, path: patch.path })
            if (group.writes.slice(0, index).some(previous => pathsOverlap(previous.path, patch.path))) throw new Error('Overlapping writes cannot be hidden inside an atomic group.')
            if (!group.expectations.some(expected => expected.role === 'write-base' && expected.resource.kind !== 'order'
              && (expected.resource.kind === 'entity' || pathContains(expected.resource.path, patch.path)))) throw new Error('Every declared write requires a covering comparison base.')
          }
          before = applyDocumentPatches(before, group.writes)
          virtual.set(operation.entityId, before)
        }
      } else {
        validateBase(operation.expected)
        if (operation.expected.role !== 'write-base' || operation.expected.resource.kind !== 'entity' || operation.expected.expected.kind !== 'value')
          throw new Error('Replacement and deletion require a complete entity comparison base.')
        if (operation.kind === 'delete') {
          if (!encodedValuesEqual(before, operation.recoveryDocument)) throw new Error('Deletion recovery must preserve the authored logical document.')
          virtual.delete(operation.entityId)
          virtualOrder = virtualOrder.filter(id => id !== operation.entityId)
        } else {
          if (!isDocument(operation.document)) throw new Error('A replacement requires a document.')
          virtual.set(operation.entityId, operation.document)
        }
      }
    }
    known.add(intent.id)
  }
  const incoming = new Map(prepared.inputs.map(input => [inputRefKey(input.ref), input] as const))
  if (incoming.size !== prepared.inputs.length) throw new Error('Prepared input identities must be unique.')
  const existing = new Set(state.inputs.map(input => inputRefKey(input.ref)))
  const used = new Map<string, IntentId[]>()
  for (const intent of prepared.intents) for (const ref of intent.inputs) {
    const key = inputRefKey(ref)
    if (!incoming.has(key)) throw new Error('Every referenced input must be owned by the complete prepared action.')
    const users = used.get(key) ?? []; users.push(intent.id); used.set(key, users)
  }
  for (const [key, input] of incoming) {
    if (existing.has(key) && !transferred.has(key)) throw new Error('An existing input requires an explicit ownership-transfer transition.')
    const users = used.get(key)
    if (!users || input.disposition.kind !== 'intents' || users.length !== input.disposition.intentIds.length
      || users.some((id, index) => input.disposition.kind !== 'intents' || input.disposition.intentIds[index] !== id))
      throw new Error('Input ownership must cover every consuming intent, including bulk fan-out.')
    if (input.input.kind !== 'encoded' && input.input.kind !== 'resource') throw new Error('Unknown owned input representation.')
    if (input.input.kind === 'resource' && !input.input.id) throw new Error('Resource input requires an owned resource identity.')
  }
  const candidate: KernelState = Object.freeze({ ...state, entities,
    journal: Object.freeze({ intents: Object.freeze([...state.journal.intents, ...prepared.intents]), actions: Object.freeze([...state.journal.actions, action]), frontiers: prepared.frontiers }),
    inputs: Object.freeze([...state.inputs.map(input => transferred.has(inputRefKey(input.ref)) ? incoming.get(inputRefKey(input.ref))! : input),
      ...prepared.inputs.filter(input => !transferred.has(inputRefKey(input.ref)))]),
  })
  const projected = projectKernel(candidate, schema)
  const hardIssues = [...projected.rows.flatMap(row => row.issues), ...projected.order.issues].filter(issue => issue.intentIds?.some(id => action.intentIds.includes(id))
    && (issue.code === 'policy-blocked' || issue.code === 'readonly-write' || issue.code === 'schema-invalid' || issue.code === 'schema-validation-failed'))
  if (hardIssues.length) throw new Error(hardIssues[0]!.message)
  return candidate
}

/** Transfer an input to terminal evidence only when all its contributions
 * have terminal evidence. Partial row saves retain the aggregate ownership. */
export function settleProjectionEvidence(state: KernelState, schema: KernelSchema): KernelState {
  let current = state
  for (;;) {
    const controls = undoSettlementSuggestions(current)
    const controlled = recordIntentSettlements(current, controls)
    const suggestions = projectKernel(controlled, schema).suggestedSettlements
    if (!controls.length && !suggestions.length) return current
    // Each pass settles at least one previously unsettled journal contribution.
    // This finite closure lets a confirmed row deletion discharge a dependent
    // order in the same atomic publication, without requiring another refresh.
    current = recordIntentSettlements(controlled, suggestions)
  }
}

export function recordIntentSettlements(state: KernelState, additions: readonly IntentSettlement[]): KernelState {
  if (!additions.length) return state
  const known = new Set(state.journal.intents.map(intent => intent.id)), settled = new Set(state.settlements.map(proof => proof.intentId))
  for (const proof of additions) {
    if (!known.has(proof.intentId) || settled.has(proof.intentId)) throw new Error('Settlement must name one known, not-yet-settled intent exactly once.')
    settled.add(proof.intentId)
  }
  const owned = ownEncodedValue(additions) as unknown as readonly IntentSettlement[]
  const settlements = Object.freeze([...state.settlements, ...owned])
  const proofs = new Map(settlements.map(entry => [entry.intentId, entry] as const))
  const inputs = Object.freeze(state.inputs.map(input => {
    if (input.disposition.kind !== 'intents') return input
    const terminal = input.disposition.intentIds.map(id => proofs.get(id))
    if (terminal.some(entry => !entry)) return input
    return Object.freeze({ ...input, disposition: Object.freeze({ kind: 'settled-intents' as const, proofs: Object.freeze(terminal.map(entry => entry!)) }) })
  }))
  return Object.freeze({ ...state, settlements, inputs })
}
