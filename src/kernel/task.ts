import { compileFrontierTable, expandFrontier, frontierScope } from './frontier-table.js'
import { encodedValuesEqual, ownEncodedValue, pathsOverlap, resourceValuesEqual } from './document.js'
import { declaredRowOperation } from './intent.js'
import { appendTaskAction, inputRefKey } from './journal.js'
import type { DurableTaskOutcome, DurableTaskRequest, FieldRef, InputId, InputRecord, KernelIssue, OwnedInput, PreparedAction, ResourceRef, SessionId, TaskDefinitionRef, TaskId, TaskOwner, TaskResult, TaskState } from './model.js'
import { prepareRowAction, type RowCommand } from './prepare.js'
import { projectKernel } from './projection.js'
import { pathContains, resourceAtRows } from './resources.js'
import type { KernelSchema } from './schema.js'
import { assertSessionWrites, captureSessionDependencies, replaceSessionInput, sessionContextIssues } from './session.js'
import { policyForEntity, type KernelState } from './state.js'
import { assertDurableTaskRequest } from './durable-task.js'

export type TaskRef = Readonly<{ taskId: TaskId; executionId: string }>
export type TaskRegistration = TaskRef & Readonly<{ kind: 'task-registered'; revision: number; owner: TaskOwner; inputId: InputId; input: OwnedInput; reads: readonly ResourceRef[]; definition?: TaskDefinitionRef; execution?: DurableTaskRequest }>
export type TaskCommand =
  | (TaskRef & Readonly<{ kind: 'task-cancelled' | 'task-consume' }>)
  | (TaskRef & Readonly<{ kind: 'task-reapply'; revision: number; owner: TaskOwner; prepared?: PreparedAction }>)
export type TaskEvent = TaskCommand | TaskRegistration
  | (TaskRef & Readonly<{ kind: 'task-started' }>)
  | (TaskRef & Readonly<{ kind: 'task-completed'; result: TaskResult }>)
  | (TaskRef & Readonly<{ kind: 'task-failed'; issue: KernelIssue }>)
  | (TaskRef & Readonly<{ kind: 'task-execution-observed'; outcome: DurableTaskOutcome }>)
export type TaskEffect = TaskRef & Readonly<{ kind: 'run-task' | 'abort-task' }>
export type TaskStep = Readonly<{ state: KernelState; effects: readonly TaskEffect[]; ignored?: string }>

const own = <const T>(value: T): T => ownEncodedValue(value) as unknown as T
const same = (left: unknown, right: unknown) => encodedValuesEqual(ownEncodedValue(left), ownEncodedValue(right))
const fieldKey = (field: FieldRef) => JSON.stringify([field.entityId, field.fieldId])
const step = (state: KernelState, effects: readonly TaskEffect[] = []): TaskStep => Object.freeze({ state, effects: Object.freeze(effects) })
const ignored = (state: KernelState, reason: string): TaskStep => Object.freeze({ ...step(state), ignored: reason })
const issue = (error: unknown): KernelIssue => own({ code: 'task-blocked', message: error instanceof Error ? error.message : 'Task result could not be applied.' })
const put = (state: KernelState, task: TaskState): KernelState => Object.freeze({ ...state, tasks: Object.freeze(state.tasks.map(previous => previous.id === task.id ? own(task) : previous)) })
const taskBase = (task: TaskState) => ({ id: task.id, owner: task.owner, input: task.input, dependencies: task.dependencies, executionId: task.executionId,
  ...(task.execution ? { execution: task.execution } : {}) })
function checkInput(input: OwnedInput) {
  if ((input.kind !== 'encoded' && input.kind !== 'resource') || (input.kind === 'encoded' && !('value' in input)) || (input.kind === 'resource' && !input.id)) throw new Error('A task requires an owned encoded value or resource identity.')
}

export function fieldGeneration(state: KernelState, field: FieldRef): number {
  return state.fieldGenerations.find(entry => fieldKey(entry.field) === fieldKey(field))?.generation ?? 0
}
function advanceFields(state: KernelState, fields: readonly FieldRef[]): KernelState {
  if (!fields.length) return state
  const entries = new Map(state.fieldGenerations.map(entry => [fieldKey(entry.field), entry] as const))
  for (const field of new Map(fields.map(field => [fieldKey(field), field] as const)).values()) {
    const generation = (entries.get(fieldKey(field))?.generation ?? 0) + 1
    if (!Number.isSafeInteger(generation)) throw new Error('Field input generation exhausted.')
    entries.set(fieldKey(field), own({ field, generation }))
  }
  return Object.freeze({ ...state, fieldGenerations: Object.freeze([...entries.values()]) })
}

function ownerCurrent(state: KernelState, owner: TaskOwner): boolean {
  if (owner.kind === 'workspace') return owner.workspaceId === state.workspace.id
  if (owner.kind === 'session') return state.session?.id === owner.sessionId && inputRefKey(state.session.input) === inputRefKey(owner.input)
  if (owner.kind === 'field') return Number.isSafeInteger(owner.generation) && owner.generation >= 0 && owner.generation === fieldGeneration(state, owner.field)
  return false
}
function ownerResources(state: KernelState, owner: TaskOwner, schema: KernelSchema): readonly ResourceRef[] {
  if (!ownerCurrent(state, owner)) throw new Error('The task owner or input generation is stale.')
  if (owner.kind === 'workspace') return []
  if (owner.kind === 'session') return state.session!.dependencies.map(dependency => dependency.resource)
  const binding = schema.fields.find(field => field.id === owner.field.fieldId)
  if (!binding || !owner.field.entityId) throw new Error('The task field binding is unavailable.')
  return [{ kind: 'path', entityId: owner.field.entityId, path: binding.path }]
}
function assertOwner(state: KernelState, owner: TaskOwner, schema: KernelSchema) {
  ownerResources(state, owner, schema)
  if (owner.kind === 'session') {
    const session = state.session!, issues = sessionContextIssues(state, session, schema)
    if (session.composition !== 'idle') throw new Error('Task input cannot replace active composition.')
    if (issues.length) throw new Error(issues[0]!.message)
  } else if (owner.kind === 'field') {
    const binding = schema.fields.find(field => field.id === owner.field.fieldId)!, policy = policyForEntity(state.policy, owner.field.entityId)
    const row = projectKernel(state, schema).rows.find(row => row.entityId === owner.field.entityId)
    if (!row?.preview || row.existence === 'pending-delete') throw new Error('The original task target is unavailable.')
    if (row.issues.length) throw new Error('The task target has an unresolved conflict.')
    if (binding.readonly || !policy.write || policy.readonlyPaths.some(path => pathsOverlap(path, binding.path))) throw new Error('The task target is no longer writable.')
  }
}
function assertDependencies(state: KernelState, task: TaskState, schema: KernelSchema) {
  const projection = projectKernel(state, schema)
  const rows = new Map(projection.rows.flatMap(row => row.preview && row.existence !== 'pending-delete' ? [[row.entityId, row.preview] as const] : []))
  for (const dependency of task.dependencies) {
    if (!resourceValuesEqual(resourceAtRows(rows, dependency.resource, projection.order.preview), dependency.expected)) throw new Error('A task dependency changed. Retain the successful result and explicitly reapply it against a reviewed context.')
    if (dependency.resource.kind !== 'order' && projection.rows.some(row => dependency.resource.kind !== 'order' && row.entityId === dependency.resource.entityId && row.issues.length))
      throw new Error('A task dependency has an unresolved conflict.')
    if (dependency.resource.kind === 'order' && projection.order.issues.length) throw new Error('The task ordering dependency is conflicted.')
  }
}

/** Preparation may reference this complete bundle, but cannot acquire it.
 * Ownership changes only together with successful task consumption. */
export function taskInputRecords(state: KernelState, taskId: TaskId, owner?: TaskOwner): readonly InputRecord[] {
  const task = state.tasks.find(task => task.id === taskId)
  if (!task) throw new Error('Unknown task.')
  const selected = owner ?? task.owner
  if (!ownerCurrent(state, selected)) throw new Error('The selected task owner is no longer current.')
  const refs = [task.input, ...(selected.kind === 'session' ? [state.session!.input, ...state.session!.retainedInputs] : [])]
  return Object.freeze(refs.map(ref => {
    const input = state.inputs.find(record => inputRefKey(record.ref) === inputRefKey(ref))
    if (!input) throw new Error('Task input material is missing.')
    return input
  }))
}

/** Reprepare stored data declarations after unrelated revision changes. Every
 * original write base and semantic read must still match; no callback runs and
 * a relevant change cannot silently become the new comparison base. */
function reprepare(state: KernelState, original: PreparedAction, schema: KernelSchema): PreparedAction {
  compileFrontierTable(original.frontiers, [...new Set([...state.journal.intents, ...original.intents].map(intent => intent.id))], frontierScope(state.workspace))
  const commands = original.intents.map(intent => {
    const operation = intent.operation
    let command: RowCommand
    if (intent.cause !== 'task') throw new Error('A task result must declare task contributions.')
    if (operation.kind === 'create' || operation.kind === 'order') command = operation
    else if (operation.kind === 'replace') command = { kind: 'replace', entityId: operation.entityId, document: operation.document }
    else if (operation.kind === 'delete') command = { kind: 'delete', entityId: operation.entityId }
    else if (operation.kind === 'write') command = { ...operation, groups: operation.groups.map(group => ({ id: group.id, writes: group.writes,
      comparison: group.expectations.some(expected => expected.role === 'write-base' && expected.resource.kind === 'entity') ? 'entity' : 'paths',
      reads: group.expectations.flatMap(expected => expected.role === 'write-base' ? [] : [{ role: expected.role, resource: expected.resource, expected: expected.expected }]),
    })) }
    else throw new Error('Tasks cannot return history or control intents.')
    return { id: intent.id, command, inputs: intent.inputs, dependencies: expandFrontier(original.frontiers, intent.dependencies) }
  })
  if (!same(original.action.intentIds, original.intents.map(intent => intent.id))) throw new Error('Task result action membership is incomplete.')
  const prepared = prepareRowAction(state, { action: original.action, commands, inputs: original.inputs, cause: 'task' }, schema)
  for (let index = 0; index < original.intents.length; index++) {
    const before = original.intents[index]!.operation, after = prepared.intents[index]!.operation
    if (before.kind !== after.kind) throw new Error('A task declaration changed operation kind.')
    if (before.kind === 'write' && after.kind === 'write') {
      for (let group = 0; group < before.groups.length; group++) {
        const bases = before.groups[group]!.expectations.filter(expected => expected.role === 'write-base')
        const current = after.groups[group]!.expectations.filter(expected => expected.role === 'write-base')
        if (!same(bases.map(({ resource, expected }) => ({ resource, expected })), current.map(({ resource, expected }) => ({ resource, expected })))) throw new Error('A stored task write base changed.')
      }
    } else if ((before.kind === 'replace' || before.kind === 'delete') && (after.kind === 'replace' || after.kind === 'delete')) {
      if (!same(before.expected.expected, after.expected.expected)) throw new Error('A stored task entity comparison changed.')
    } else if (before.kind === 'order' && after.kind === 'order' && !same(before.expectedOrder, after.expectedOrder)) throw new Error('A stored task ordering comparison changed.')
  }
  return prepared
}

function consume(state: KernelState, task: TaskState, result: TaskResult, owner: TaskOwner, schema: KernelSchema, prepared?: PreparedAction, reviewed = false): KernelState {
  assertOwner(state, owner, schema)
  if (result.kind === 'session-candidate') {
    if (owner.kind !== 'session' || prepared) throw new Error('Session candidate results require a selected session and no data proposal.')
    if (!reviewed && result.sessionId !== owner.sessionId) throw new Error('A different result target requires explicit reviewed reapplication.')
    checkInput(result.input)
    const input = state.inputs.find(input => inputRefKey(input.ref) === inputRefKey(task.input))
    if (input?.disposition.kind !== 'task' || input.disposition.taskId !== task.id) throw new Error('The task no longer owns its input.')
    const current = state.session!
    const candidate = replaceSessionInput(state, current, result.input, 'idle'), session = candidate.session!
    return put(Object.freeze({ ...candidate, session: own({ ...session, retainedInputs: [...session.retainedInputs, task.input] }),
      inputs: own(candidate.inputs.map(input => inputRefKey(input.ref) === inputRefKey(task.input) ? { ...input, disposition: { kind: 'session' as const, sessionId: session.id } } : input)),
    }), own({ ...taskBase(task), kind: 'consumed', result, destination: { kind: 'session', sessionId: session.id, input: session.input } }))
  }
  if (result.kind === 'action-candidate' && (!reviewed || !prepared)) throw new Error('An action candidate requires a reviewed, complete proposal.')
  if (result.kind !== 'action' && result.kind !== 'action-candidate') throw new Error('Unknown task result type.')
  const action = prepared ?? (result.kind === 'action' ? reprepare(state, result.action, schema) : null)
  if (!action) throw new Error('A reviewed action proposal is missing.')
  if (action.intents.some(intent => intent.cause !== 'task')) throw new Error('Task apply must identify all contributions as task results.')
  if (owner.kind === 'session') assertSessionWrites(state.session!, action, schema, 'task')
  if (owner.kind === 'field') {
    const binding = schema.fields.find(field => field.id === owner.field.fieldId)!
    for (const intent of action.intents) {
      const operation = intent.operation
      if (operation.kind !== 'write' || operation.entityId !== owner.field.entityId || operation.groups.some(group => group.writes.some(patch => !pathContains(binding.path, patch.path))))
        throw new Error('A field task cannot write outside its owner field.')
    }
  }
  const candidate = appendTaskAction(state, task.id, owner.kind === 'session' ? owner.sessionId : null, action, schema), projection = projectKernel(candidate, schema)
  const conflict = [...projection.rows.flatMap(row => row.issues), ...projection.order.issues].find(issue => issue.intentIds?.some(id => action.action.intentIds.includes(id)))
  if (conflict) throw new Error(conflict.message)
  return put(Object.freeze({ ...candidate, ...(owner.kind === 'session' ? { session: null } : {}) }), own({ ...taskBase(task), kind: 'consumed', result,
    destination: { kind: 'action', applicationId: action.action.applicationId } }))
}

function cancel(state: KernelState, task: TaskState): TaskStep {
  const result = 'result' in task && task.result ? { result: task.result } : {}
  const cancelled: TaskState = own({ ...taskBase(task), kind: 'cancelled', ...result })
  const candidate = put(state, cancelled)
  return step(Object.freeze({ ...candidate, inputs: own(candidate.inputs.map(input => inputRefKey(input.ref) === inputRefKey(task.input)
    ? { ...input, disposition: { kind: 'cancelled-task' as const, taskId: task.id } } : input)) }), [{ kind: 'abort-task', taskId: task.id, executionId: task.executionId }])
}

export function reduceTask(state: KernelState, raw: TaskEvent, schema: KernelSchema): TaskStep {
  const event = own(raw)
  if (event.kind === 'task-registered') {
    if (event.revision !== state.revision || !event.taskId || !event.executionId || state.tasks.some(task => task.id === event.taskId || task.executionId === event.executionId)) throw new Error('Task registration requires current context and fresh task/execution identities.')
    if (!event.inputId || state.inputs.some(input => input.ref.id === event.inputId)) throw new Error('Task input identity must be fresh.')
    checkInput(event.input); assertOwner(state, event.owner, schema)
    if (event.definition && (!event.execution || !same(event.definition, event.execution.ref.definition))) throw new Error('Durable task registration requires its completely prepared execution request.')
    if (event.execution) assertDurableTaskRequest(event.execution, state, event.taskId, event.executionId, event.input, event.owner)
    const dependencies = captureSessionDependencies(state, [...ownerResources(state, event.owner, schema), ...event.reads], schema)
    const candidate = event.owner.kind === 'field' ? advanceFields(state, [event.owner.field]) : state
    const owner = event.owner.kind === 'field' ? { ...event.owner, generation: fieldGeneration(candidate, event.owner.field) } : event.owner
    const input = { id: event.inputId, version: 0 }
    const task: TaskState = own({ id: event.taskId, executionId: event.executionId, owner, input, dependencies, kind: 'queued',
      ...(event.execution ? { execution: { request: event.execution, outcome: null } } : {}) })
    return step(Object.freeze({ ...candidate, tasks: Object.freeze([...candidate.tasks, task]),
      inputs: own([...candidate.inputs, { ref: input, input: event.input, disposition: { kind: 'task', taskId: task.id } }]),
    }), [{ kind: 'run-task', taskId: task.id, executionId: task.executionId }])
  }
  const task = state.tasks.find(task => task.id === event.taskId)
  if (!task || task.executionId !== event.executionId) return ignored(state, 'Task completion or command belongs to an inactive execution identity.')
  if (event.kind === 'task-execution-observed') {
    if (!task.execution || !same(task.execution.request.ref, event.outcome.ref)) throw new Error('Task outcome belongs to another definition, request or execution identity.')
    const previous = task.execution.outcome
    if (previous?.kind === 'succeeded' || previous?.kind === 'failed') {
      if (same(previous, event.outcome) || event.outcome.kind === 'unknown' || event.outcome.kind === 'pending') return ignored(state, 'The exact terminal execution outcome is already retained.')
      throw new Error('The execution service contradicted an immutable terminal task outcome.')
    }
    if (!['succeeded', 'failed', 'pending', 'unknown'].includes(event.outcome.kind)) throw new Error('Unknown durable task outcome.')
    const updated = own({ ...task, execution: { ...task.execution, outcome: event.outcome } })
    const candidate = put(state, updated)
    // Outcome proof survives explicit cancellation/supersession independently
    // of whether its result is allowed to acquire a current session or field.
    if (task.kind === 'cancelled' || task.kind === 'consumed' || event.outcome.kind === 'pending' || event.outcome.kind === 'unknown') return step(candidate)
    if (event.outcome.kind === 'failed') return step(task.kind === 'superseded' ? candidate : put(candidate, own({ ...taskBase(updated), kind: 'failed', issue: event.outcome.issue })))
    if (event.outcome.kind !== 'succeeded') return step(candidate)
    const running = task.kind === 'queued' ? put(candidate, own({ ...taskBase(updated), kind: 'running' })) : candidate
    return reduceTask(running, { kind: 'task-completed', taskId: task.id, executionId: task.executionId, result: event.outcome.result }, schema)
  }
  if (task.kind === 'cancelled' || task.kind === 'consumed') return ignored(state, 'Task already has a terminal disposition.')
  switch (event.kind) {
    case 'task-started':
      if (task.kind !== 'queued') return ignored(state, 'Task is not queued for execution.')
      return step(put(state, own({ ...taskBase(task), kind: 'running' })))
    case 'task-cancelled': return cancel(state, task)
    case 'task-failed':
      if (task.kind !== 'running') return ignored(state, 'Task failure belongs to an inactive execution.')
      return step(put(state, own({ ...taskBase(task), kind: 'failed', issue: event.issue })))
    case 'task-completed': {
      if (task.kind !== 'running' && task.kind !== 'superseded') return ignored(state, 'Task already retained its result or failed.')
      if ('result' in task && task.result) return ignored(state, 'Task result is already retained.')
      if (event.result.kind !== 'session-candidate' && event.result.kind !== 'action' && event.result.kind !== 'action-candidate') throw new Error('Task result must be a session candidate, action candidate or complete action.')
      if (event.result.kind !== 'action') {
        checkInput(event.result.input)
      }
      const ready: TaskState = own({ ...taskBase(task), kind: 'result-ready', result: event.result })
      const candidate = put(state, ready)
      if (task.kind === 'superseded') return step(put(state, own({ ...task, result: event.result })))
      if (event.result.kind === 'action-candidate') return step(candidate)
      try {
        if (event.result.kind === 'session-candidate' && (task.owner.kind !== 'session' || event.result.sessionId !== task.owner.sessionId))
          throw new Error('Task result names a different original session. Retain the result for explicit reapplication.')
        assertDependencies(candidate, task, schema)
        return step(consume(candidate, ready, event.result, task.owner, schema))
      } catch (error) { return step(put(candidate, own({ ...ready, kind: 'blocked', issues: [issue(error)] }))) }
    }
    case 'task-consume': {
      if (!('result' in task) || !task.result) throw new Error('The task has no retained successful result.')
      if (task.kind === 'superseded') throw new Error('A superseded result requires explicit reapplication to a reviewed owner.')
      assertDependencies(state, task, schema)
      return step(consume(state, task, task.result, task.owner, schema))
    }
    case 'task-reapply': {
      if (event.revision !== state.revision || !('result' in task) || !task.result) throw new Error('Reapplication requires a successful result and the currently reviewed revision.')
      if (task.result.kind !== 'session-candidate' && !event.prepared) throw new Error('Reapplying a data result requires a newly prepared complete proposal.')
      return step(consume(state, task, task.result, event.owner, schema, event.prepared, true))
    }
  }
}

/** Record semantic supersession before the runtime aborts physical work.
 * Superseded successes remain available for explicit reapplication. */
export function reconcileTaskOwners(previous: KernelState, initial: KernelState, schema: KernelSchema, cancelledSession: SessionId | null): TaskStep {
  const touched: FieldRef[] = []
  for (const intent of initial.journal.intents.slice(previous.journal.intents.length)) {
    const operation = declaredRowOperation(intent)
    if (!operation) continue
    for (const field of schema.fields) if (operation.kind !== 'write' || operation.groups.some(group => group.writes.some(patch => pathsOverlap(patch.path, field.path))))
      touched.push({ entityId: operation.entityId, fieldId: field.id })
  }
  if (initial.session && (!previous.session || !same(previous.session.input, initial.session.input))) {
    for (const session of [previous.session, initial.session]) if (session) touched.push(...(session.target.kind === 'cell' ? [session.target.field] : session.target.kind === 'bulk' ? session.target.fields : []))
  }
  let state = advanceFields(initial, touched)
  const effects: TaskEffect[] = []
  for (const task of state.tasks) {
    if (task.kind === 'cancelled' || task.kind === 'consumed') continue
    if (cancelledSession !== null && task.owner.kind === 'session' && task.owner.sessionId === cancelledSession) {
      const cancelled = cancel(state, task); state = cancelled.state; effects.push(...cancelled.effects)
    } else if (!ownerCurrent(state, task.owner) && task.kind !== 'superseded') {
      state = put(state, own({ ...taskBase(task), kind: 'superseded',
        ...('result' in task && task.result ? { result: task.result } : {}),
      }))
      effects.push({ kind: 'abort-task', taskId: task.id, executionId: task.executionId })
    }
  }
  return step(state, effects)
}
