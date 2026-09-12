import { encodedValuesEqual, isDocument, ownEncodedValue, pathsOverlap, resourceValuesEqual } from './document.js'
import { appendSessionAction, inputRefKey } from './journal.js'
import type { EditorLease, FieldRef, InputId, InputRecord, KernelIssue, OwnedInput, PreparedAction, RecoveryId, ResourceRef, Session, SessionId, SessionTarget, ViewId, ViewPredicate } from './model.js'
import { projectKernel } from './projection.js'
import { pathContains, resourceAtRows } from './resources.js'
import type { KernelSchema } from './schema.js'
import { policyForEntity, type KernelState } from './state.js'
import { setViewQuery, viewQuery } from './view.js'

type SessionOpeningContext = Readonly<{
  dependencies: Session['dependencies']
  policy: KernelState['policy']
  editorGeneration: number
  queryBase: Session['queryBase']
}>
/** Captured before enqueueing. Unrelated durable writes must not invalidate
 * a queued edit, while changed values, permissions and editor ownership must. */
export function captureSessionOpeningContext(state: KernelState, target: SessionTarget, reads: readonly ResourceRef[], schema: KernelSchema): SessionOpeningContext {
  return owned({ dependencies: captureSessionDependencies(state, [...targetResources(target, schema), ...reads], schema),
    policy: state.policy, editorGeneration: state.editorGeneration, queryBase: queryBase(state, target) })
}
type EditorRequest = Readonly<{ lease: EditorLease; inputVersion: number }>
export type SessionEvent =
  | Readonly<{ kind: 'session-opened'; revision: number; context?: SessionOpeningContext; sessionId: SessionId; inputId: InputId; viewId: ViewId; target: SessionTarget; input: OwnedInput; reads: readonly ResourceRef[]; recoveryId?: RecoveryId }>
  | Readonly<{ kind: 'session-attached'; sessionId: SessionId; viewId: ViewId }>
  | (EditorRequest & Readonly<{ kind: 'session-detached' }>)
  | (EditorRequest & Readonly<{ kind: 'session-input'; input: OwnedInput; composition: Session['composition'] }>)
  | (EditorRequest & Readonly<{ kind: 'session-reconfirmed'; revision: number }>)
  | (EditorRequest & Readonly<{ kind: 'session-retargeted'; revision: number; target: SessionTarget; reads: readonly ResourceRef[] }>)
  | (EditorRequest & Readonly<{ kind: 'session-apply'; prepared: PreparedAction }>)
  | (EditorRequest & Readonly<{ kind: 'session-query-apply'; queryVersion: number; predicate: ViewPredicate | null }>)
  | Readonly<{ kind: 'session-cancelled'; sessionId: SessionId; inputVersion: number; lease: EditorLease | null }>

function owned<const T>(value: T): T { return ownEncodedValue(value) as unknown as T }
function assertInput(input: OwnedInput) {
  if (input.kind !== 'encoded' && input.kind !== 'resource') throw new Error('Unknown session input representation.')
  if (input.kind === 'encoded' && !('value' in input)) throw new Error('Encoded session input requires an explicit value.')
  if (input.kind === 'resource' && !input.id) throw new Error('Resource input requires an owned resource identity.')
}
function fields(target: SessionTarget): readonly FieldRef[] {
  return target.kind === 'cell' ? [target.field] : target.kind === 'bulk' ? target.fields : []
}
function requireSession(state: KernelState, id: SessionId): Session {
  if (!state.session || state.session.id !== id) throw new Error('The session is no longer active.')
  return state.session
}
function requireEditor(state: KernelState, request: EditorRequest): Session {
  const session = requireSession(state, request.lease.sessionId)
  if (!session.editor || !encodedValuesEqual(owned(session.editor), owned(request.lease)) || request.inputVersion !== session.input.version)
    throw new Error('The editor lease or input version is stale.')
  return session
}
function nextEditor(state: KernelState, sessionId: SessionId, viewId: ViewId): EditorLease {
  if (!viewId || !Number.isSafeInteger(state.editorGeneration + 1)) throw new Error('A fresh editor generation and view identity are required.')
  return owned({ sessionId, viewId, generation: state.editorGeneration + 1 })
}
function logical(state: KernelState, schema: KernelSchema) {
  const projection = projectKernel(state, schema)
  return { projection, rows: new Map(projection.rows.flatMap(row => row.preview && row.existence !== 'pending-delete' ? [[row.entityId, row.preview] as const] : [])) }
}
export function captureSessionDependencies(state: KernelState, resources: readonly ResourceRef[], schema: KernelSchema): Session['dependencies'] {
  for (const resource of resources) {
    if (resource.kind !== 'order' && resource.kind !== 'path' && resource.kind !== 'entity') throw new Error('Unknown session dependency.')
    if (resource.kind !== 'order' && !resource.entityId) throw new Error('A session dependency requires an entity identity.')
    if (resource.kind === 'path' && (!resource.path.length || resource.path.some(segment => typeof segment !== 'string'))) throw new Error('Invalid dependency path.')
  }
  const { projection, rows } = logical(state, schema)
  return owned(resources.map(resource => ({ resource, expected: resourceAtRows(rows, resource, projection.order.preview) })))
}

function queryBase(state: KernelState, target: SessionTarget): Session['queryBase'] {
  if (target.kind !== 'filter') return null
  if (target.queryVersion !== viewQuery(state, target.viewId).version) throw new Error('Filter authoring requires the currently reviewed query version.')
  return viewQuery(state, target.viewId).filters.find(filter => filter.columnId === target.columnId) ?? null
}

/** New text or an explicitly changed authoring context supersedes the current
 * input version. Historical raw input and recovery sources remain available. */
export function replaceSessionInput(state: KernelState, session: Session, input: OwnedInput, composition: Session['composition']): KernelState {
  assertInput(input)
  if (!Number.isSafeInteger(session.input.version + 1) || (composition !== 'idle' && composition !== 'composing')) throw new Error('Invalid input version or composition state.')
  const current = state.inputs.find(record => inputRefKey(record.ref) === inputRefKey(session.input))
  if (current?.disposition.kind !== 'session' || current.disposition.sessionId !== session.id) throw new Error('The session no longer owns its current input.')
  const ref = { ...session.input, version: session.input.version + 1 }
  if (state.inputs.some(record => inputRefKey(record.ref) === inputRefKey(ref))) throw new Error('An input version cannot be reused.')
  const inputs: readonly InputRecord[] = owned([...state.inputs.map(record => inputRefKey(record.ref) === inputRefKey(session.input)
    ? { ...record, disposition: { kind: 'superseded' as const, by: ref } } : record),
  { ref, input, disposition: { kind: 'session', sessionId: session.id } }])
  return Object.freeze({ ...state, inputs, session: owned({ ...session, input: ref, rawInput: input, composition }) })
}
function targetResources(target: SessionTarget, schema: KernelSchema): readonly ResourceRef[] {
  if (target.kind !== 'cell' && target.kind !== 'bulk' && target.kind !== 'filter') throw new Error('Unknown session target.')
  if (target.kind === 'filter') {
    if (target.viewId !== undefined && (typeof target.viewId !== 'string' || !target.viewId)) throw new Error('A filter requires a valid view identity.')
    if (!target.columnId || !Number.isSafeInteger(target.queryVersion) || target.queryVersion < 0) throw new Error('A filter requires a versioned query target.')
    return []
  }
  const targets = fields(target), keys = targets.map(field => JSON.stringify([field.entityId, field.fieldId]))
  if (!targets.length || new Set(keys).size !== keys.length) throw new Error('Session targets must be a nonempty, fixed set of unique fields.')
  if (target.kind === 'bulk' && target.creations) {
    const identities = new Set<string>(), proposedKeys = new Set<string>()
    for (const creation of target.creations) {
      if (!creation.entityId || identities.has(creation.entityId) || !isDocument(creation.document)
        || !targets.some(field => field.entityId === creation.entityId)
        || Object.keys(creation).some(key => !['entityId', 'document', 'proposedKey'].includes(key)))
        throw new Error('New session rows require unique identities, complete defaults and fixed target fields.')
      identities.add(creation.entityId)
      if (creation.proposedKey !== undefined) {
        const key = JSON.stringify([typeof creation.proposedKey, creation.proposedKey])
        if (!['string', 'number'].includes(typeof creation.proposedKey) || proposedKeys.has(key)) throw new Error('New session rows require valid, distinct proposed keys.')
        proposedKeys.add(key)
      }
    }
  }
  return targets.map(field => {
    const binding = schema.fields.find(entry => entry.id === field.fieldId)
    if (!field.entityId || !binding) throw new Error('A session target requires a known field and entity identity.')
    return { kind: 'path', entityId: field.entityId, path: binding.path }
  })
}

/** Observe relevant logical values and current permissions, never a global
 * revision as a proxy for whether an editor's context has changed. */
export function sessionContextIssues(state: KernelState, session: Session, schema: KernelSchema): readonly KernelIssue[] {
  const { projection, rows } = logical(state, schema), issues: KernelIssue[] = []
  const target = session.target
  if (target.kind === 'filter' && !encodedValuesEqual(owned(viewQuery(state, target.viewId).filters.find(filter => filter.columnId === target.columnId) ?? null), owned(session.queryBase)))
    issues.push({ code: 'session-query-changed', message: 'This column filter changed. Review its current query before applying your input.' })
  for (const field of fields(session.target)) {
    const binding = schema.fields.find(entry => entry.id === field.fieldId), policy = policyForEntity(state.policy, field.entityId)
    const creation = target.kind === 'bulk' && target.creations?.find(creation => creation.entityId === field.entityId)
    if (creation && state.entities.some(entity => entity.entityId === creation.entityId))
      issues.push({ code: 'session-creation-occupied', message: 'A proposed new row identity is already occupied. Retain the input and review its targets.', ...field })
    else if (creation && !state.policy.create)
      issues.push({ code: 'session-policy-blocked', message: 'Creating rows is no longer permitted. Retain the input and review its targets.', ...field })
    else if (!creation && !rows.has(field.entityId)) issues.push({ code: 'session-target-missing', message: 'The original edit target is unavailable. Retain or recover its input.', ...field })
    else if (!binding || binding.readonly || !policy.write || policy.readonlyPaths.some(path => pathsOverlap(path, binding.path)))
      issues.push({ code: 'session-policy-blocked', message: 'The edit target is no longer writable.', ...field })
    else if (projection.rows.find(row => row.entityId === field.entityId)?.issues.length)
      issues.push({ code: 'session-target-conflicted', message: 'Resolve the target conflict before applying this input.', ...field })
  }
  for (const dependency of session.dependencies) {
    if (!resourceValuesEqual(resourceAtRows(rows, dependency.resource, projection.order.preview), dependency.expected))
      issues.push({ code: 'session-context-changed', message: 'An observed edit dependency changed. Explicitly confirm the new context before applying.' })
  }
  return owned(issues)
}

export function refreshSessionContext(state: KernelState, schema: KernelSchema): KernelState {
  const session = state.session
  if (!session) return state
  const issues = sessionContextIssues(state, session, schema)
  if (encodedValuesEqual(owned(issues), owned(session.issues))) return state
  return Object.freeze({ ...state, session: owned({ ...session, issues, phase: issues.length ? 'blocked' : 'editing' }) })
}

export function assertSessionWrites(session: Session, prepared: PreparedAction, schema: KernelSchema, cause: 'user' | 'task' = 'user') {
  if (session.target.kind === 'filter') throw new Error('Filter input must be applied to a versioned view query, never to data intents.')
  const targets = fields(session.target).map(field => ({ ...field, path: schema.fields.find(entry => entry.id === field.fieldId)!.path }))
  const touched = new Set<number>()
  const creations = session.target.kind === 'bulk' ? session.target.creations ?? [] : [], created = new Set<string>()
  if (creations.length && prepared.action.saveAtomicity !== 'transaction') throw new Error('Creating session rows requires one atomic transaction with all existing targets.')
  for (const intent of prepared.intents) {
    if (intent.cause !== cause) throw new Error('Session actions must retain their input cause.')
    if (intent.operation.kind === 'create') {
      const operation = intent.operation, declared = creations.find(creation => creation.entityId === operation.entityId)
      if (!declared || created.has(operation.entityId) || !encodedValuesEqual(owned(operation), owned({ kind: 'create', ...declared })))
        throw new Error('Session creation must exactly match its retained row defaults and identity.')
      created.add(operation.entityId)
      continue
    }
    if (intent.operation.kind !== 'write') throw new Error('Field sessions can only apply prepared field writes and declared new rows.')
    const operation = intent.operation
    for (const group of operation.groups) for (const patch of group.writes) {
      const index = targets.findIndex(target => target.entityId === operation.entityId && pathContains(target.path, patch.path))
      if (index < 0) throw new Error('Session apply cannot write outside its fixed target fields.')
      touched.add(index)
    }
  }
  if (created.size !== creations.length) throw new Error('Session apply must create every declared new row exactly once.')
  if (touched.size !== targets.length) throw new Error('Bulk apply must include all fixed targets; explicitly confirm a new target set before shrinking it.')
}

export function reduceSession(state: KernelState, raw: SessionEvent, schema: KernelSchema): KernelState {
  const event = owned(raw)
  switch (event.kind) {
    case 'session-opened': {
      const currentContext = event.context === undefined ? event.revision === state.revision
        : encodedValuesEqual(owned(event.context), owned(captureSessionOpeningContext(state, event.target, event.reads, schema)))
      if (state.session || !currentContext || !event.sessionId || state.sessionIds.includes(event.sessionId))
        throw new Error('Session open requires current context, a fresh identity and no existing session.')
      assertInput(event.input)
      if (!event.inputId || state.inputs.some(input => input.ref.id === event.inputId)) throw new Error('Session input identity must be fresh.')
      const resources = [...targetResources(event.target, schema), ...event.reads]
      const recovery = event.recoveryId === undefined ? undefined : state.recoveries.find(entry => entry.id === event.recoveryId)
      if (event.recoveryId !== undefined && (!recovery || recovery.state !== 'available')) throw new Error('Recovery entry is not available for transfer.')
      const retainedInputs = recovery?.inputs ?? []
      const retained = new Set(retainedInputs.map(inputRefKey))
      for (const ref of retainedInputs) {
        const input = state.inputs.find(input => inputRefKey(input.ref) === inputRefKey(ref))
        if (!input || input.disposition.kind !== 'recovery' || input.disposition.recoveryId !== recovery!.id) throw new Error('Recovery no longer owns its complete input bundle.')
      }
      const editor = nextEditor(state, event.sessionId, event.viewId), input = { id: event.inputId, version: 0 }
      const disposition = { kind: 'session' as const, sessionId: event.sessionId }
      const session: Session = owned({ id: event.sessionId, input, rawInput: event.input, retainedInputs, target: event.target,
        queryBase: queryBase(state, event.target), dependencies: captureSessionDependencies(state, resources, schema), phase: 'editing', editor, composition: 'idle', issues: [] })
      return Object.freeze({ ...state, session, editorGeneration: editor.generation, sessionIds: Object.freeze([...state.sessionIds, session.id]),
        inputs: owned([...state.inputs.map(record => retained.has(inputRefKey(record.ref)) ? { ...record, disposition } : record), { ref: input, input: event.input, disposition }]),
        recoveries: owned(state.recoveries.map(entry => entry.id === recovery?.id ? { ...entry, state: 'consumed' as const } : entry)),
      })
    }
    case 'session-attached': {
      const session = requireSession(state, event.sessionId)
      if (session.editor) throw new Error('The active editor must detach before another view takes its lease.')
      const editor = nextEditor(state, session.id, event.viewId)
      return Object.freeze({ ...state, editorGeneration: editor.generation, session: owned({ ...session, editor, composition: 'idle' }) })
    }
    case 'session-detached': {
      const session = requireEditor(state, event)
      return Object.freeze({ ...state, session: owned({ ...session, editor: null, composition: 'idle' }) })
    }
    case 'session-input': {
      const session = requireEditor(state, event)
      return replaceSessionInput(state, session, event.input, event.composition)
    }
    case 'session-reconfirmed': {
      const session = requireEditor(state, event)
      if (event.revision !== state.revision || session.composition !== 'idle') throw new Error('Context confirmation requires the current reviewed revision and completed composition.')
      const target = session.target.kind === 'filter' ? { ...session.target, queryVersion: viewQuery(state, session.target.viewId).version } : session.target
      return replaceSessionInput(state, owned({ ...session, target, queryBase: queryBase(state, target),
        dependencies: captureSessionDependencies(state, session.dependencies.map(entry => entry.resource), schema) }), session.rawInput, 'idle')
    }
    case 'session-retargeted': {
      const session = requireEditor(state, event)
      if (event.revision !== state.revision || session.composition !== 'idle') throw new Error('Target changes require current reviewed context and completed composition.')
      if ((session.target.kind === 'filter') !== (event.target.kind === 'filter')) throw new Error('Changing between data editing and filtering requires a separate session.')
      const dependencies = captureSessionDependencies(state, [...targetResources(event.target, schema), ...event.reads], schema)
      const editor = nextEditor(state, session.id, event.lease.viewId)
      const candidate = replaceSessionInput(state, owned({ ...session, target: event.target, queryBase: queryBase(state, event.target), dependencies, editor }), session.rawInput, 'idle')
      const issues = sessionContextIssues(candidate, candidate.session!, schema)
      if (issues.length) throw new Error(issues[0]!.message)
      return Object.freeze({ ...candidate, editorGeneration: editor.generation })
    }
    case 'session-apply': {
      const session = requireEditor(state, event)
      if (session.composition !== 'idle') throw new Error('Complete composition before applying input.')
      const issues = sessionContextIssues(state, session, schema)
      if (issues.length) throw new Error(issues[0]!.message)
      assertSessionWrites(session, event.prepared, schema)
      const candidate = appendSessionAction(state, event.prepared, schema)
      if (session.target.kind === 'bulk' && session.target.creations?.length) {
        const created = new Set(session.target.creations.map(creation => creation.entityId))
        const issue = projectKernel(candidate, schema).rows.find(row => created.has(row.entityId) && row.issues.length)?.issues[0]
        if (issue) throw new Error(issue.message)
      }
      return Object.freeze({ ...candidate, session: null })
    }
    case 'session-query-apply': {
      const session = requireEditor(state, event)
      if (session.target.kind !== 'filter' || session.composition !== 'idle') throw new Error('Query apply requires a filter session with completed composition.')
      const issues = sessionContextIssues(state, session, schema)
      if (issues.length) throw new Error(issues[0]!.message)
      const columnId = session.target.columnId
      const query = viewQuery(state, session.target.viewId)
      const scope = session.target.viewId === undefined ? {} : { viewId: session.target.viewId }
      const filters = query.filters.filter(filter => filter.columnId !== columnId)
      if (event.predicate !== null) filters.push({ columnId, predicate: event.predicate })
      const candidate = setViewQuery(state, { kind: 'view-query-set', ...scope, expectedVersion: event.queryVersion, filters, sort: query.sort }, schema)
      const appliedQueryVersion = viewQuery(candidate, session.target.viewId).version
      const refs = new Set([session.input, ...session.retainedInputs].map(inputRefKey))
      for (const ref of refs) {
        const input = state.inputs.find(input => inputRefKey(input.ref) === ref)
        if (input?.disposition.kind !== 'session' || input.disposition.sessionId !== session.id) throw new Error('The session no longer owns its complete input bundle.')
      }
      return Object.freeze({ ...candidate, session: null, inputs: owned(state.inputs.map(input => refs.has(inputRefKey(input.ref))
        ? { ...input, disposition: { kind: 'applied-to-view' as const, ...scope, queryVersion: appliedQueryVersion } } : input)) })
    }
    case 'session-cancelled': {
      const session = requireSession(state, event.sessionId)
      if (event.inputVersion !== session.input.version || !encodedValuesEqual(owned(event.lease), owned(session.editor)))
        throw new Error('Cancellation belongs to an old editor or input version.')
      const refs = new Set([session.input, ...session.retainedInputs].map(inputRefKey))
      return Object.freeze({ ...state, session: null, inputs: owned(state.inputs.map(input => refs.has(inputRefKey(input.ref))
        ? { ...input, disposition: { kind: 'cancelled-session' as const, sessionId: session.id } } : input)) })
    }
  }
}
