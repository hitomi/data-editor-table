import { describe, expect, it } from 'vitest'
import { entityId, KernelFixture, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { kernelId, type PreparedAction, type TaskOwner, type TaskResult } from './model.js'
import { prepareRowAction, type RowCommand } from './prepare.js'
import { defineKernelSchema } from './schema.js'
import { fieldGeneration, taskInputRecords } from './task.js'

const field = { entityId: entityId('a'), fieldId: kernelId<'field'>('x') }
const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: field.fieldId, path: ['x'], readonly: false }] })
function fixture() { return new KernelFixture({ a: { x: 0, hidden: 7 }, b: { x: 0 } }, schema) }
function open(state: KernelFixture) {
  const serial = state.next(), sessionId = kernelId<'session'>(`session:${serial}`)
  expect(state.dispatch({ kind: 'session-opened', revision: state.state.revision, sessionId, inputId: kernelId<'input'>(`editor:${serial}`), viewId: kernelId<'view'>('editor'),
    target: { kind: 'cell', field }, input: { kind: 'encoded', value: 'original text' }, reads: [] }).result.kind).toBe('accepted')
  return { kind: 'session' as const, sessionId, input: state.state.session!.input }
}
function register(state: KernelFixture, owner: TaskOwner) {
  const serial = state.next(), ref = { taskId: kernelId<'task'>(`task:${serial}`), executionId: `execute:${serial}` }
  const registration = state.dispatch({ kind: 'task-registered', ...ref, revision: state.state.revision, owner, inputId: kernelId<'input'>(`file:${serial}`), input: { kind: 'encoded', value: `raw:${serial}` }, reads: [] })
  expect(registration.result.kind, JSON.stringify(registration.result)).toBe('accepted')
  expect(registration.effects).toContainEqual({ kind: 'run-task', ...ref })
  expect(state.dispatch({ kind: 'task-started', ...ref }).result.kind).toBe('accepted')
  return ref
}
function action(state: KernelFixture, taskId: ReturnType<typeof register>['taskId'], commands: readonly RowCommand[] = [state.write('a', { x: 8 })], owner?: TaskOwner): PreparedAction {
  const serial = state.next(), inputs = taskInputRecords(state.state, taskId, owner)
  return prepareRowAction(state.state, { action: { id: kernelId<'action'>(`task-action:${serial}`), applicationId: kernelId<'application'>(`task-action:${serial}`), label: 'Task result', saveAtomicity: 'transaction' },
    cause: 'task', inputs, commands: commands.map((command, index) => ({ id: kernelId<'intent'>(`task-intent:${serial}:${index}`), inputs: inputs.map(input => input.ref), dependencies: [], command })),
  }, state.schema)
}

describe('typed task ownership', () => {
  it.each(['deleted', 'reincarnated', 'permission'] as const)('retains the whole multi-row result when its second target is %s', change => {
    const state = fixture(), ref = register(state, { kind: 'workspace', workspaceId: state.state.workspace.id })
    const prepared = action(state, ref.taskId, [state.write('a', { x: 8 }), state.write('b', { x: 9 })])
    const result: TaskResult = { kind: 'action', action: prepared }, bytes = JSON.stringify(result)
    if (change === 'deleted') state.observe({ a: { x: 0, hidden: 7 } }, 1)
    else if (change === 'reincarnated') state.observe({ a: { x: 0, hidden: 7 }, replacement: { x: 3 } }, 1, { replacement: { key: 'b', incarnation: 'new-lifetime' } })
    else {
      const policy = state.state.policy
      expect(state.dispatch({ kind: 'policy-observed', policy: { ...policy, version: kernelId<'policy-version'>('second-row-readonly'),
        entities: [{ entityId: entityId('b'), policy: { ...policy.defaultEntity, write: false } }] } }).result.kind).toBe('accepted')
    }
    const before = state.state, rows = state.project().rows.map(row => ({ id: row.entityId, document: row.preview }))
    const completion = state.dispatch({ kind: 'task-completed', ...ref, result })
    expect(completion.result.kind).toBe('accepted')
    expect(completion.effects).toEqual([])
    expect(state.state.tasks[0]).toMatchObject({ kind: 'blocked', result })
    expect(state.state.journal).toEqual(before.journal)
    expect(state.state.inputs).toEqual(before.inputs)
    expect(state.project().rows.map(row => ({ id: row.entityId, document: row.preview }))).toEqual(rows)
    expect(state.project().rows.find(row => row.entityId === 'a')?.preview).toEqual({ x: 0, hidden: 7 })
    expect(JSON.stringify(result)).toBe(bytes)
    const blocked = state.state
    expect(state.dispatch({ kind: 'task-consume', ...ref }).result.kind).toBe('rejected')
    expect(state.state).toBe(blocked)
    expect(state.project().changes).toEqual([])
  })

  it.each((['replace', 'delete', 'order'] as const).flatMap(kind => [false, true].map(changed => ({ kind, changed }))))
  ('revalidates a stored $kind action when its comparison changed=$changed', ({ kind, changed }) => {
    const state = fixture(), ref = register(state, { kind: 'workspace', workspaceId: state.state.workspace.id })
    const command: RowCommand = kind === 'replace' ? { kind, entityId: entityId('a'), document: { x: 8, hidden: 7 } }
      : kind === 'delete' ? { kind, entityId: entityId('a') } : { kind, desired: [entityId('b'), entityId('a')] }
    const prepared = action(state, ref.taskId, [command]), result: TaskResult = { kind: 'action', action: prepared }
    const bytes = JSON.stringify(result)
    state.observe({ a: { x: changed && kind !== 'order' ? 3 : 0, hidden: 7 }, b: { x: 0 } }, 1)
    if (changed && kind === 'order') state.apply([{ kind: 'create', entityId: entityId('c'), document: { x: 4 } }])
    const before = state.state
    const transition = state.dispatch({ kind: 'task-completed', ...ref, result })
    expect(transition.result.kind).toBe('accepted')
    expect(transition.effects.some(effect => effect.kind === 'run-task' || effect.kind === 'submit')).toBe(false)
    expect(JSON.stringify(result)).toBe(bytes)
    expect(state.state.tasks[0]).toMatchObject({ kind: changed ? 'blocked' : 'consumed', result })
    if (changed) {
      expect(state.state.journal).toEqual(before.journal)
      expect(state.state.inputs).toEqual(before.inputs)
      const blocked = state.state
      expect(state.dispatch({ kind: 'task-consume', ...ref }).result.kind).toBe('rejected')
      expect(state.state).toBe(blocked)
    } else {
      if (kind === 'order') expect(state.project().order.preview).toEqual([entityId('b'), entityId('a')])
      else expect(state.project().rows.find(row => row.entityId === 'a')?.preview).toEqual(kind === 'delete' ? null : { x: 8, hidden: 7 })
      expect(state.state.inputs.find(input => input.ref.id === state.state.tasks[0]!.input.id)?.disposition).toEqual({ kind: 'intents', intentIds: prepared.action.intentIds })
      expect(state.state.journal.intents).toHaveLength(1)
    }
  })

  it.each(['session', 'field'] as const)('keeps a late %s task on its retired entity when a server key is reused', kind => {
    const state = fixture()
    const edit = state.apply([state.write('a', { x: 1 })], 'row', 'old incarnation edit')
    const owner: TaskOwner = kind === 'session' ? open(state) : { kind: 'field', field, generation: fieldGeneration(state.state, field) }
    const ref = register(state, owner), originalTask = state.state.tasks[0]!, originalSession = state.state.session
    const result: TaskResult = owner.kind === 'session'
      ? { kind: 'session-candidate', sessionId: owner.sessionId, input: { kind: 'encoded', value: 'old uploaded URL' } }
      : { kind: 'action', action: action(state, ref.taskId) }
    state.observe({ b: { x: 0 } }, 1)
    state.observe({ replacement: { x: 0, hidden: 77 }, b: { x: 0 } }, 2, { replacement: { key: 'a', incarnation: 'life:2' } })
    expect(state.state.entities.find(entity => entity.entityId === field.entityId)?.kind).toBe('retired')
    expect(state.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('accepted')
    expect(state.state.tasks[0]).toMatchObject({ owner: originalTask.owner, input: originalTask.input, result })
    const beforeConsume = state.state, consumed = state.dispatch({ kind: 'task-consume', ...ref })
    expect(consumed.result.kind).toBe('rejected'); expect(consumed.effects).toEqual([]); expect(state.state).toBe(beforeConsume)
    expect(state.project().rows.find(row => row.entityId === entityId('replacement'))?.preview).toEqual({ x: 0, hidden: 77 })
    expect(state.project().changes).toEqual([])
    expect(state.state.journal.intents).toEqual(edit.intents)
    expect(state.state.inputs[0]?.input).toEqual({ kind: 'encoded', value: 'old incarnation edit' })
    expect(state.state.inputs.find(input => input.ref.id === originalTask.input.id)?.input).toEqual({ kind: 'encoded', value: expect.stringMatching(/^raw:/) })
    if (originalSession) {
      expect(state.state.session?.target).toEqual(originalSession.target)
      expect(state.state.session?.rawInput).toEqual(originalSession.rawInput)
    }
  })

  it('retains a valid successful candidate with a wrong session target until explicit reapplication', () => {
    const state = fixture(), owner = open(state), ref = register(state, owner)
    const result: TaskResult = { kind: 'session-candidate', sessionId: kernelId<'session'>('wrong-editor'), input: { kind: 'encoded', value: 'recoverable URL' } }
    expect(state.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('accepted')
    expect(state.state.tasks[0]).toMatchObject({ kind: 'blocked', result })
    expect(state.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'original text' })
    expect(state.dispatch({ kind: 'task-consume', ...ref }).result.kind).toBe('rejected')
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: state.state.revision, owner }).result.kind).toBe('accepted')
    expect(state.state.session?.rawInput).toEqual(result.input)
  })

  it('consumes a session candidate once, retains both original texts and keeps task input in the session bundle', () => {
    const state = fixture(), owner = open(state), ref = register(state, owner), original = state.state.session!
    const result: TaskResult = { kind: 'session-candidate', sessionId: owner.sessionId, input: { kind: 'encoded', value: 'uploaded URL' } }
    expect(state.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('accepted')
    const task = state.state.tasks[0]!, session = state.state.session!
    expect(task.kind).toBe('consumed'); expect(session.rawInput).toEqual(result.input)
    expect(session.input.version).toBe(original.input.version + 1)
    expect(session.retainedInputs).toEqual([task.input])
    expect(state.state.inputs.find(input => input.ref.id === task.input.id)?.disposition).toEqual({ kind: 'session', sessionId: owner.sessionId })
    expect(state.state.inputs[0]).toMatchObject({ input: { value: 'original text' }, disposition: { kind: 'superseded', by: session.input } })
    const before = state.state
    expect(state.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('ignored')
    expect(state.dispatch({ kind: 'task-cancelled', ...ref }).result.kind).toBe('ignored')
    expect(state.state).toBe(before)
    expect(state.project().changes).toEqual([])
  })

  it('marks changed input as superseding work, retains a late success, and only explicit reapplication can replace the newer input', () => {
    const state = fixture(), owner = open(state), ref = register(state, owner), session = state.state.session!
    const changed = state.dispatch({ kind: 'session-input', lease: session.editor!, inputVersion: session.input.version, composition: 'idle', input: { kind: 'encoded', value: 'newer user input' } })
    expect(changed.effects).toContainEqual({ kind: 'abort-task', ...ref })
    expect(state.state.tasks[0]?.kind).toBe('superseded')
    const result: TaskResult = { kind: 'session-candidate', sessionId: owner.sessionId, input: { kind: 'encoded', value: 'late upload URL' } }
    expect(state.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('accepted')
    expect(state.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'newer user input' })
    expect(state.state.tasks[0]).toMatchObject({ kind: 'superseded', result })
    expect(state.dispatch({ kind: 'task-consume', ...ref }).result.kind).toBe('rejected')
    const current = state.state.session!
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: state.state.revision, owner: { kind: 'session', sessionId: current.id, input: current.input } }).result.kind).toBe('accepted')
    expect(state.state.session?.rawInput).toEqual(result.input)
    expect(state.state.tasks[0]?.kind).toBe('consumed')
  })

  it('cancels all tasks of an explicitly cancelled session before emitting abort, and ignores late success', () => {
    const state = fixture(), owner = open(state), first = register(state, owner), second = register(state, owner), session = state.state.session!
    const cancelled = state.dispatch({ kind: 'session-cancelled', sessionId: session.id, lease: session.editor, inputVersion: session.input.version })
    expect(cancelled.effects).toEqual([{ kind: 'abort-task', ...first }, { kind: 'abort-task', ...second }])
    expect(state.state.tasks.every(task => task.kind === 'cancelled')).toBe(true)
    for (const task of state.state.tasks) expect(state.state.inputs.find(input => input.ref.id === task.input.id)?.disposition).toEqual({ kind: 'cancelled-task', taskId: task.id })
    const before = state.state
    expect(state.dispatch({ kind: 'task-completed', ...first, result: { kind: 'session-candidate', sessionId: session.id, input: { kind: 'encoded', value: 'late' } } }).result.kind).toBe('ignored')
    expect(state.state).toBe(before)
    expect(state.state.session).toBeNull()
  })

  it('does not cancel tasks on detach or unrelated refresh, and accepts a candidate while the editor is detached', () => {
    const state = fixture(), owner = open(state), ref = register(state, owner), session = state.state.session!
    expect(state.dispatch({ kind: 'session-detached', lease: session.editor!, inputVersion: session.input.version }).effects).toEqual([])
    state.observe({ a: { x: 0, hidden: 9 }, b: { x: 99 } }, 1)
    expect(state.state.tasks[0]?.kind).toBe('running')
    expect(state.dispatch({ kind: 'task-completed', ...ref, result: { kind: 'session-candidate', sessionId: session.id, input: { kind: 'encoded', value: 'uploaded' } } }).result.kind).toBe('accepted')
    expect(state.state.session).toMatchObject({ editor: null, rawInput: { value: 'uploaded' } })
    expect(state.state.tasks[0]?.kind).toBe('consumed')
  })

  it('revalidates stored action declarations after an unrelated revision without rerunning business code or losing hidden fields', () => {
    const state = fixture(), ref = register(state, { kind: 'field', field, generation: fieldGeneration(state.state, field) })
    const prepared = action(state, ref.taskId), result: TaskResult = { kind: 'action', action: prepared }
    state.observe({ a: { x: 0, hidden: 11 }, b: { x: 3 } }, 1)
    expect(state.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('accepted')
    expect(state.state.tasks[0]?.kind).toBe('consumed')
    expect(state.project().rows[0]?.preview).toEqual({ x: 8, hidden: 11 })
    expect(state.state.inputs.find(input => input.ref.id === state.state.tasks[0]!.input.id)?.disposition).toEqual({ kind: 'intents', intentIds: prepared.action.intentIds })
    expect(state.state.tasks[0]).toMatchObject({ result })
    expect(prepared.revision).toBeLessThan(state.state.revision)
  })

  it('keeps a successful action blocked on changed comparisons, then reuses its result in a newly reviewed proposal', () => {
    const state = fixture(), ref = register(state, { kind: 'workspace', workspaceId: state.state.workspace.id })
    const prepared = action(state, ref.taskId), result: TaskResult = { kind: 'action', action: prepared }
    state.observe({ a: { x: 2, hidden: 7 }, b: { x: 0 } }, 1)
    expect(state.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('accepted')
    expect(state.state.tasks[0]).toMatchObject({ kind: 'blocked', result })
    expect(state.state.journal.intents).toEqual([])
    expect(state.dispatch({ kind: 'task-consume', ...ref }).result.kind).toBe('rejected')
    const owner: TaskOwner = { kind: 'field', field: { entityId: entityId('b'), fieldId: field.fieldId }, generation: 0 }
    const retry = action(state, ref.taskId, [state.write('b', { x: 8 })], owner), before = state.state
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: before.revision - 1, owner, prepared: retry }).result.kind).toBe('rejected')
    expect(state.state).toBe(before)
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: before.revision, owner, prepared: retry }).result.kind).toBe('accepted')
    expect(state.project().rows.map(row => row.preview?.x)).toEqual([2, 8])
    expect(state.state.tasks[0]).toMatchObject({ kind: 'consumed', result })
  })

  it('uses field generations to reject a result after the user edits and returns to the same value', () => {
    const state = fixture(), ref = register(state, { kind: 'field', field, generation: 0 })
    const result: TaskResult = { kind: 'action', action: action(state, ref.taskId) }
    state.apply([state.write('a', { x: 1 })]); state.apply([state.write('a', { x: 0 })])
    expect(state.project().rows[0]?.preview?.x).toBe(0)
    expect(state.state.tasks[0]?.kind).toBe('superseded')
    state.dispatch({ kind: 'task-completed', ...ref, result })
    expect(state.project().rows[0]?.preview?.x).toBe(0)
    expect(state.state.tasks[0]).toMatchObject({ kind: 'superseded', result })
  })

  it('supersedes an older field task when a new task takes that field, but leaves independent fields alone', () => {
    const state = fixture(), first = register(state, { kind: 'field', field, generation: 0 })
    const result: TaskResult = { kind: 'action', action: action(state, first.taskId) }
    const otherField = { entityId: entityId('b'), fieldId: field.fieldId }
    register(state, { kind: 'field', field: otherField, generation: 0 })
    const second = register(state, { kind: 'field', field, generation: fieldGeneration(state.state, field) })
    expect(state.state.tasks.map(task => task.kind)).toEqual(['superseded', 'running', 'running'])
    state.dispatch({ kind: 'task-completed', ...first, result })
    expect(state.project().changes).toEqual([])
    expect(state.state.tasks.find(task => task.id === second.taskId)?.kind).toBe('running')
  })

  it('retains permission-blocked results and consumes them after permission returns', () => {
    const state = fixture(), ref = register(state, { kind: 'field', field, generation: 0 }), prepared = action(state, ref.taskId), policy = state.state.policy
    state.dispatch({ kind: 'policy-observed', policy: { ...policy, version: kernelId<'policy-version'>('blocked'), defaultEntity: { ...policy.defaultEntity, write: false } } })
    state.dispatch({ kind: 'task-completed', ...ref, result: { kind: 'action', action: prepared } })
    expect(state.state.tasks[0]?.kind).toBe('blocked')
    expect(state.state.inputs.at(-1)?.disposition.kind).toBe('task')
    state.dispatch({ kind: 'policy-observed', policy })
    expect(state.dispatch({ kind: 'task-consume', ...ref }).result.kind).toBe('accepted')
    expect(state.state.tasks[0]?.kind).toBe('consumed')
  })

  it('rejects an incomplete ownership bundle atomically and retains all session and task input', () => {
    const state = fixture(), owner = open(state), ref = register(state, owner)
    const prepared = action(state, ref.taskId), malformed = { ...prepared, inputs: prepared.inputs.slice(0, 1) }, before = state.state
    state.dispatch({ kind: 'task-completed', ...ref, result: { kind: 'action', action: malformed } })
    expect(state.state.tasks[0]?.kind).toBe('blocked')
    expect(state.state.journal).toBe(before.journal)
    expect(state.state.inputs).toBe(before.inputs)
    expect(state.state.session).toBe(before.session)
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: state.state.revision, owner, prepared: action(state, ref.taskId) }).result.kind).toBe('accepted')
    expect(state.state.session).toBeNull()
    expect(state.state.inputs.every(input => input.disposition.kind === 'intents')).toBe(true)
  })

  it('retains a complete multi-row result when its second row fails schema validation', () => {
    const guarded = defineKernelSchema({ ...schema, validate: document => typeof document.x === 'number' && document.x < 0 ? [{ code: 'negative', message: 'Negative values are invalid.' }] : [] })
    const state = new KernelFixture({ a: { x: 0 }, b: { x: 0 } }, guarded)
    const ref = register(state, { kind: 'workspace', workspaceId: state.state.workspace.id })
    const prepared = action(state, ref.taskId, [state.write('a', { x: 8 }), state.write('b', { x: -1 })]), before = state.state
    expect(state.dispatch({ kind: 'task-completed', ...ref, result: { kind: 'action', action: prepared } }).result.kind).toBe('accepted')
    expect(state.state.tasks[0]?.kind).toBe('blocked')
    expect(state.state.inputs).toBe(before.inputs)
    expect(state.state.journal).toBe(before.journal)
    expect(state.project().rows.map(row => row.preview?.x)).toEqual([0, 0])
  })

  it('does not recapture the value used by an earlier task computation as a new semantic read', () => {
    const state = fixture(), ref = register(state, { kind: 'workspace', workspaceId: state.state.workspace.id })
    const command = state.write('a', { x: 8 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: entityId('b'), path: ['x'] } }] })
    const prepared = action(state, ref.taskId, [command])
    state.observe({ a: { x: 0, hidden: 7 }, b: { x: 2 } }, 1)
    state.dispatch({ kind: 'task-completed', ...ref, result: { kind: 'action', action: prepared } })
    expect(state.state.tasks[0]).toMatchObject({ kind: 'blocked', result: { action: prepared } })
    expect(state.project().changes).toEqual([])
    expect(state.state.inputs.at(-1)?.disposition.kind).toBe('task')
  })

  it('rejects different execution identities and cancellation before start prevents the start effect from running', () => {
    const state = fixture(), ref = { taskId: kernelId<'task'>('queued'), executionId: 'queued' }
    state.dispatch({ kind: 'task-registered', ...ref, revision: state.state.revision, owner: { kind: 'workspace', workspaceId: state.state.workspace.id }, inputId: kernelId<'input'>('queued'), input: { kind: 'encoded', value: 'raw' }, reads: [] })
    const before = state.state
    expect(state.dispatch({ kind: 'task-failed', taskId: ref.taskId, executionId: 'wrong', issue: { code: 'wrong', message: 'wrong' } }).result.kind).toBe('ignored')
    expect(state.state).toBe(before)
    expect(state.dispatch({ kind: 'task-cancelled', ...ref }).result.kind).toBe('accepted')
    expect(state.dispatch({ kind: 'task-started', ...ref }).result.kind).toBe('ignored')
    expect(state.state.tasks[0]?.kind).toBe('cancelled')
    expect(state.state.inputs[0]?.disposition.kind).toBe('cancelled-task')
  })
})

describe('reviewed action candidates', () => {
  it('retains converted data without writes and transfers the complete input only with current reviewed structural action', () => {
    const state = fixture(), owner = { kind: 'workspace' as const, workspaceId: state.state.workspace.id }, ref = register(state, owner)
    const result: TaskResult = { kind: 'action-candidate', input: { kind: 'encoded', value: { images: ['first', 'second'], targets: ['a'] } } }
    expect(state.dispatch({ kind: 'task-completed', ...ref, result }).result.kind).toBe('accepted')
    expect(state.state.tasks[0]).toMatchObject({ kind: 'result-ready', result })
    expect(state.state.journal.actions).toHaveLength(0)
    expect(state.dispatch({ kind: 'task-consume', ...ref }).result.kind).toBe('rejected')
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: state.state.revision, owner }).result.kind).toBe('rejected')
    const prepared = action(state, ref.taskId, [state.write('a', { x: 8 }), { kind: 'create', entityId: entityId('new'), document: { x: 9 } }])
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: state.state.revision - 1, owner, prepared }).result.kind).toBe('rejected')
    const missingInput = { ...prepared, inputs: [] }
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: state.state.revision, owner, prepared: missingInput }).result.kind).toBe('rejected')
    expect(state.state.journal.actions).toHaveLength(0)
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: state.state.revision, owner, prepared }).result.kind).toBe('accepted')
    expect(state.state.tasks[0]).toMatchObject({ kind: 'consumed', result, destination: { kind: 'action', applicationId: prepared.action.applicationId } })
    expect(state.state.journal.actions).toHaveLength(1)
    expect(state.state.inputs.find(input => input.ref.id === state.state.tasks[0]!.input.id)?.disposition).toEqual({ kind: 'intents', intentIds: prepared.action.intentIds })
  })

  it('pins successful candidate resource bytes after cancellation and cannot apply a cancelled candidate', () => {
    const state = fixture(), owner = { kind: 'workspace' as const, workspaceId: state.state.workspace.id }, ref = register(state, owner)
    const resourceId = kernelId<'resource'>('converted')
    expect(state.dispatch({ kind: 'resource-registered', descriptor: { id: resourceId, kind: 'blob', size: 3, mediaType: 'text/plain' } }).result.kind).toBe('accepted')
    expect(state.dispatch({ kind: 'task-completed', ...ref, result: { kind: 'action-candidate', input: { kind: 'resource', id: resourceId } } }).result.kind).toBe('accepted')
    expect(state.dispatch({ kind: 'task-cancelled', ...ref }).result.kind).toBe('accepted')
    expect(state.dispatch({ kind: 'resource-released', resourceId }).result.kind).toBe('rejected')
    expect(state.dispatch({ kind: 'task-reapply', ...ref, revision: state.state.revision, owner }).result.kind).toBe('ignored')
    expect(state.state.journal.actions).toHaveLength(0)
  })
})
