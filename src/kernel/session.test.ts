import { describe, expect, it } from 'vitest'
import { entityId, KernelFixture, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { kernelId, type PreparedAction, type RecoveryId, type ResourceRef, type SessionTarget } from './model.js'
import { prepareRowAction, type RowCommand } from './prepare.js'
import { defineKernelSchema } from './schema.js'
import { prepareResolution } from './resolution.js'
import { prepareUndo } from './history.js'
import { inputRefKey } from './journal.js'
import { captureSessionOpeningContext } from './session.js'
import { projectView } from './view.js'

const schema = defineKernelSchema({ ...permissiveSchema, fields: [
  { id: kernelId<'field'>('x'), path: ['x'], readonly: false },
  { id: kernelId<'field'>('hidden'), path: ['hidden'], readonly: true },
] })
const target: SessionTarget = { kind: 'cell', field: { entityId: entityId('a'), fieldId: kernelId<'field'>('x') } }
function setup() { return new KernelFixture({ a: { x: 0, hidden: 7 }, b: { x: 0 } }, schema) }
function open(fixture: KernelFixture, selected: SessionTarget = target, recoveryId?: RecoveryId, reads: readonly ResourceRef[] = []) {
  const number = fixture.next()
  const result = fixture.dispatch({ kind: 'session-opened', revision: fixture.state.revision, sessionId: kernelId<'session'>(`session:${number}`),
    inputId: kernelId<'input'>(`session-input:${number}`), viewId: kernelId<'view'>('view:a'), target: selected,
    input: { kind: 'encoded', value: 'unparsed text' }, reads, ...(recoveryId === undefined ? {} : { recoveryId }) })
  expect(result.result.kind, JSON.stringify(result.result)).toBe('accepted')
  return editor(fixture)
}
function editor(fixture: KernelFixture) {
  const session = fixture.state.session!
  return { lease: session.editor!, inputVersion: session.input.version }
}
function prepare(fixture: KernelFixture, commands: readonly RowCommand[] = [fixture.write('a', { x: 1 })]): PreparedAction {
  const session = fixture.state.session!, refs = [session.input, ...session.retainedInputs], number = fixture.next()
  return prepareRowAction(fixture.state, {
    action: { id: kernelId<'action'>(`session-action:${number}`), applicationId: kernelId<'application'>(`session-action:${number}`), label: 'Apply editor', saveAtomicity: 'transaction' },
    cause: 'user', commands: commands.map((command, index) => ({ id: kernelId<'intent'>(`session-intent:${number}:${index}`), command, inputs: refs, dependencies: [] })),
    inputs: refs.map(ref => { const input = fixture.state.inputs.find(input => inputRefKey(input.ref) === inputRefKey(ref))!; return { ref, input: input.input } }),
  }, fixture.schema)
}
function createRecovery(fixture: KernelFixture) {
  fixture.apply([fixture.write('a', { x: 1 })], 'row', 'first original')
  fixture.apply([fixture.write('a', { x: 2 })], 'row', 'second original')
  fixture.observe({ a: { x: 3, hidden: 7 }, b: { x: 0 } }, 1)
  const prepared = prepareResolution(fixture.state, { revision: fixture.state.revision, observation: kernelId<'observation'>('read:1'),
    issueIds: fixture.project().rows.find(row => row.entityId === entityId('a'))!.issues.map(issue => issue.id), target: { kind: 'row', entityId: entityId('a') }, choice: { kind: 'use-authority' },
  }, { actionId: kernelId<'action'>('resolve'), applicationId: kernelId<'application'>('resolve'), controlId: kernelId<'intent'>('resolve') }, schema)
  expect(fixture.dispatch({ kind: 'prepared-resolution', prepared }).result.kind).toBe('accepted')
  expect(fixture.dispatch({ kind: 'prepared-undo', prepared: prepareUndo(fixture.state, {
    actionId: kernelId<'action'>('undo'), applicationId: kernelId<'application'>('undo'), controls: [],
  }) }).result.kind).toBe('accepted')
  return fixture.state.recoveries[0]!
}

describe('session ownership and editor leases', () => {
  it('applies retained new row defaults and existing fields atomically, rejecting substituted creation data', () => {
    const fixture = setup(), newRow = { entityId: entityId('new'), document: { x: 0, hidden: 9 } }
    open(fixture, { kind: 'bulk', fields: ['a', 'new'].map(id => ({ entityId: entityId(id), fieldId: kernelId<'field'>('x') })), creations: [newRow] })
    const before = fixture.state
    const forged = prepare(fixture, [{ kind: 'create', ...newRow, document: { x: 0, hidden: 99 } }, fixture.write('a', { x: 4 }), fixture.write('new', { x: 5 })])
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: forged }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.project().rows.some(row => row.entityId === 'new')).toBe(false)
    const prepared = prepare(fixture, [{ kind: 'create', ...newRow }, fixture.write('a', { x: 4 }), fixture.write('new', { x: 5 })])
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: { ...prepared, action: { ...prepared.action, saveAtomicity: 'row' } } }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared }).result.kind).toBe('accepted')
    expect(fixture.state.session).toBeNull()
    expect(fixture.project().rows.find(row => row.entityId === 'a')?.preview).toEqual({ x: 4, hidden: 7 })
    expect(fixture.project().rows.find(row => row.entityId === 'new')?.preview).toEqual({ x: 5, hidden: 9 })
    expect(fixture.freeze().submission.items.map(item => item.kind)).toEqual(['update', 'create'])
  })

  it('retargets a deleted bulk selection only after review, retains raw input and fences old target callbacks', () => {
    const fixture = setup(); open(fixture, { kind: 'bulk', fields: ['a', 'b'].map(id => ({ entityId: entityId(id), fieldId: kernelId<'field'>('x') })) })
    const original = fixture.state.session!, old = editor(fixture)
    fixture.observe({ b: { x: 0 } }, 1)
    const selected: SessionTarget = { kind: 'cell', field: { entityId: entityId('b'), fieldId: kernelId<'field'>('x') } }
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'session-retargeted', ...old, revision: before.revision - 1, target: selected, reads: [] }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.dispatch({ kind: 'session-retargeted', ...old, revision: before.revision, target: selected, reads: [] }).result.kind).toBe('accepted')
    const session = fixture.state.session!
    expect(session.rawInput).toEqual(original.rawInput); expect(session.id).toBe(original.id)
    expect(session.input.version).toBe(original.input.version + 1)
    expect(session.editor!.generation).toBeGreaterThan(old.lease.generation)
    expect(session.phase).toBe('editing')
    expect(fixture.state.inputs[0]?.disposition).toEqual({ kind: 'superseded', by: session.input })
    expect(fixture.dispatch({ kind: 'session-input', ...old, input: { kind: 'encoded', value: 'wrong target input' }, composition: 'idle' }).result.kind).toBe('rejected')
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: prepare(fixture, [fixture.write('b', { x: 8 })]) }).result.kind).toBe('accepted')
    expect(fixture.project().rows.find(row => row.entityId === entityId('b'))?.preview).toEqual({ x: 8 })
  })

  it('keeps the old target and recovery sources when retargeting fails, and preserves them after a valid retarget', () => {
    const fixture = setup(), recovery = createRecovery(fixture); open(fixture, target, recovery.id)
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'session-retargeted', ...editor(fixture), revision: before.revision,
      target: { kind: 'cell', field: { entityId: entityId('a'), fieldId: kernelId<'field'>('hidden') } }, reads: [] }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.dispatch({ kind: 'session-retargeted', ...editor(fixture), revision: before.revision,
      target: { kind: 'cell', field: { entityId: entityId('b'), fieldId: kernelId<'field'>('x') } }, reads: [] }).result.kind).toBe('accepted')
    expect(fixture.state.session!.retainedInputs).toEqual(recovery.inputs)
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: prepare(fixture, [fixture.write('b', { x: 5 })]) }).result.kind).toBe('accepted')
    expect(fixture.state.inputs.filter(input => recovery.inputs.some(ref => inputRefKey(ref) === inputRefKey(input.ref))).every(input => input.disposition.kind === 'intents')).toBe(true)
  })

  it('applies filter input to an exact query version, preserves other columns and sorting, and leaves data history alone', () => {
    const fixture = setup(); open(fixture, { kind: 'filter', columnId: 'x', queryVersion: 0 })
    const history = fixture.state.journal
    expect(fixture.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [{ columnId: 'hidden', predicate: { kind: 'compare', fieldId: kernelId<'field'>('hidden'), operator: 'equals', value: 7 } }], sort: [{ fieldId: kernelId<'field'>('x'), direction: 'desc' }] }).result.kind).toBe('accepted')
    expect(fixture.state.session?.phase).toBe('editing')
    const current = editor(fixture), before = fixture.state
    const predicate = { kind: 'compare' as const, fieldId: kernelId<'field'>('x'), operator: 'equals' as const, value: 0 }
    expect(fixture.dispatch({ kind: 'session-query-apply', ...current, queryVersion: 0, predicate }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.dispatch({ kind: 'session-query-apply', ...current, queryVersion: 1, predicate }).result.kind).toBe('accepted')
    expect(fixture.state.session).toBeNull()
    expect(fixture.state.journal).toBe(history)
    expect(fixture.project().changes).toEqual([])
    expect(fixture.state.view.filters.map(filter => filter.columnId)).toEqual(['hidden', 'x'])
    expect(projectView(fixture.state, schema).rows.map(row => row.entityId)).toEqual(['a'])
    expect(fixture.state.inputs[0]?.disposition).toEqual({ kind: 'applied-to-view', queryVersion: 2 })
    const applied = fixture.state.viewHistory.find(query => query.version === 2)!
    expect(fixture.dispatch({ kind: 'view-query-set', expectedVersion: 2, filters: [], sort: [] }).result.kind).toBe('accepted')
    expect(fixture.state.viewHistory.find(query => query.version === 2)).toBe(applied)
    expect(fixture.state.inputs[0]?.disposition).toEqual({ kind: 'applied-to-view', queryVersion: 2 })
  })

  it('preserves filter input through invalid expressions and a competing same-column filter until explicit review', () => {
    const fixture = setup(); open(fixture, { kind: 'filter', columnId: 'x', queryVersion: 0 })
    const original = editor(fixture), before = fixture.state
    expect(fixture.dispatch({ kind: 'session-query-apply', ...original, queryVersion: 0,
      predicate: { kind: 'compare', fieldId: kernelId<'field'>('x'), operator: 'contains', value: 99 } }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    fixture.dispatch({ kind: 'view-query-set', expectedVersion: 0, filters: [{ columnId: 'x', predicate: { kind: 'missing', fieldId: kernelId<'field'>('x') } }], sort: [] })
    expect(fixture.state.session?.phase).toBe('blocked')
    expect(fixture.dispatch({ kind: 'session-query-apply', ...original, queryVersion: 1, predicate: null }).result.kind).toBe('rejected')
    expect(fixture.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'unparsed text' })
    expect(fixture.dispatch({ kind: 'session-reconfirmed', ...original, revision: fixture.state.revision }).result.kind).toBe('accepted')
    expect(fixture.dispatch({ kind: 'session-query-apply', ...original, queryVersion: 1, predicate: null }).result.kind).toBe('rejected')
    expect(fixture.dispatch({ kind: 'session-query-apply', ...editor(fixture), queryVersion: 1, predicate: null }).result.kind).toBe('accepted')
    expect(fixture.state.view.filters).toEqual([])
    expect(fixture.state.inputs.at(-1)?.disposition).toEqual({ kind: 'applied-to-view', queryVersion: 2 })
  })

  it('retains superseded raw versions and rejects duplicated or reordered input', () => {
    const fixture = setup(), original = open(fixture), first = fixture.state.session!
    expect(fixture.dispatch({ kind: 'session-input', ...original, input: { kind: 'encoded', value: 'new text' }, composition: 'idle' }).result.kind).toBe('accepted')
    expect(fixture.state.session!.id).toBe(first.id)
    expect(fixture.state.session!.input.version).toBe(1)
    expect(fixture.state.inputs[0]).toMatchObject({ input: { value: 'unparsed text' }, disposition: { kind: 'superseded', by: fixture.state.session!.input } })
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'session-input', ...original, input: { kind: 'encoded', value: 'late old text' }, composition: 'idle' }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 0, hidden: 7 })
  })

  it('releases composing on detach, preserves input, and fences all events from the old lease after remount', () => {
    const fixture = setup(), request = open(fixture)
    fixture.dispatch({ kind: 'session-input', ...request, input: { kind: 'encoded', value: '中文' }, composition: 'composing' })
    const old = editor(fixture), prepared = prepare(fixture), before = fixture.state
    expect(fixture.dispatch({ kind: 'session-apply', ...old, prepared }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.dispatch({ kind: 'session-detached', ...old }).result.kind).toBe('accepted')
    expect(fixture.state.session).toMatchObject({ editor: null, composition: 'idle', rawInput: { value: '中文' } })
    expect(fixture.dispatch({ kind: 'session-attached', sessionId: old.lease.sessionId, viewId: kernelId<'view'>('view:b') }).result.kind).toBe('accepted')
    expect(editor(fixture).lease.generation).toBeGreaterThan(old.lease.generation)
    const attached = fixture.state
    for (const event of [
      { kind: 'session-input' as const, ...old, input: { kind: 'encoded' as const, value: 'late' }, composition: 'idle' as const },
      { kind: 'session-detached' as const, ...old },
      { kind: 'session-apply' as const, ...old, prepared: prepare(fixture) },
      { kind: 'session-cancelled' as const, ...old, sessionId: old.lease.sessionId },
    ]) expect(fixture.dispatch(event).result.kind).toBe('rejected')
    expect(fixture.state).toBe(attached)
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: prepare(fixture) }).result.kind).toBe('accepted')
    expect(fixture.state.session).toBeNull()
    expect(fixture.state.inputs.at(-1)).toMatchObject({ input: { value: '中文' }, disposition: { kind: 'intents' } })
  })

  it('allows unrelated refreshes but requires reviewed confirmation when the edited field changes', () => {
    const fixture = setup(); open(fixture)
    fixture.observe({ a: { x: 0, hidden: 9 }, b: { x: 8 } }, 1)
    expect(fixture.state.session?.phase).toBe('editing')
    fixture.observe({ a: { x: 4, hidden: 9 }, b: { x: 8 } }, 2)
    expect(fixture.state.session?.phase).toBe('blocked')
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: prepare(fixture) }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.dispatch({ kind: 'session-reconfirmed', ...editor(fixture), revision: before.revision - 1 }).result.kind).toBe('rejected')
    expect(fixture.dispatch({ kind: 'session-reconfirmed', ...editor(fixture), revision: before.revision }).result.kind).toBe('accepted')
    expect(fixture.state.session?.phase).toBe('editing')
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: prepare(fixture) }).result.kind).toBe('accepted')
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 1, hidden: 9 })
  })

  it('keeps deleted targets and permission changes blocked with input available for explicit cancellation', () => {
    const fixture = setup(); open(fixture)
    fixture.dispatch({ kind: 'policy-observed', policy: { ...fixture.state.policy, version: kernelId<'policy-version'>('blocked'), defaultEntity: { ...fixture.state.policy.defaultEntity, write: false } } })
    expect(fixture.state.session?.issues[0]?.code).toBe('session-policy-blocked')
    fixture.observe({ b: { x: 0 } }, 1)
    expect(fixture.state.session?.issues[0]?.code).toBe('session-target-missing')
    fixture.dispatch({ kind: 'session-reconfirmed', ...editor(fixture), revision: fixture.state.revision })
    expect(fixture.state.session?.phase).toBe('blocked')
    const session = fixture.state.session!
    expect(session.rawInput).toEqual({ kind: 'encoded', value: 'unparsed text' })
    expect(fixture.dispatch({ kind: 'session-cancelled', sessionId: session.id, ...editor(fixture) }).result.kind).toBe('accepted')
    expect(fixture.state.inputs.at(-1)?.disposition).toEqual({ kind: 'cancelled-session', sessionId: session.id })
    expect(fixture.state.journal.intents).toEqual([])
  })

  it('atomically rejects partial bulk targets, extra writes, forged raw input and stale preparations', () => {
    const fixture = setup(); open(fixture, { kind: 'bulk', fields: ['a', 'b'].map(id => ({ entityId: entityId(id), fieldId: kernelId<'field'>('x') })) })
    const complete = prepare(fixture, [fixture.write('a', { x: 1 }), fixture.write('b', { x: 2 })]), before = fixture.state
    const forged = { ...complete, inputs: complete.inputs.map(input => ({ ...input, input: { kind: 'encoded' as const, value: 'forged' } })) }
    for (const prepared of [prepare(fixture), prepare(fixture, [fixture.write('a', { x: 1, hidden: 8 }), fixture.write('b', { x: 2 })]), forged, { ...complete, revision: complete.revision - 1 }]) {
      expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared }).result.kind).toBe('rejected')
      expect(fixture.state).toBe(before)
    }
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: complete }).result.kind).toBe('rejected')
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: complete }).result.kind).toBe('accepted')
    expect(fixture.state.session).toBeNull()
    expect(fixture.state.inputs[0]?.disposition).toEqual({ kind: 'intents', intentIds: complete.action.intentIds })
    expect(fixture.project().rows.map(row => row.preview?.x)).toEqual([1, 2])
  })

  it('never reuses a closed session identity or lets a new open overwrite an active editor', () => {
    const fixture = setup(), first = open(fixture), session = fixture.state.session!
    const event = { kind: 'session-opened' as const, revision: fixture.state.revision, sessionId: session.id, inputId: kernelId<'input'>('new'), viewId: kernelId<'view'>('view'), target, input: { kind: 'encoded' as const, value: 'replacement' }, reads: [] }
    const before = fixture.state
    expect(fixture.dispatch(event).result.kind).toBe('rejected'); expect(fixture.state).toBe(before)
    fixture.dispatch({ kind: 'session-cancelled', sessionId: session.id, ...first })
    expect(fixture.dispatch({ ...event, revision: fixture.state.revision }).result.kind).toBe('rejected')
    const second = open(fixture)
    expect(second.lease.generation).toBeGreaterThan(first.lease.generation)
    expect(fixture.dispatch({ kind: 'session-input', ...first, input: { kind: 'encoded', value: 'late' }, composition: 'idle' }).result.kind).toBe('rejected')
  })

  it('moves the complete recovery bundle into a session and then all contributions into intents exactly once', () => {
    const fixture = setup(), recovery = createRecovery(fixture)
    expect(recovery.inputs).toHaveLength(2)
    const oldProofs = fixture.state.settlements, oldInputs = fixture.state.inputs.slice(0, 2)
    const cleanTarget: SessionTarget = { kind: 'cell', field: { entityId: entityId('b'), fieldId: kernelId<'field'>('x') } }
    open(fixture, cleanTarget, recovery.id)
    expect(fixture.state.recoveries[0]?.state).toBe('consumed')
    const retained = fixture.state.inputs.filter(input => recovery.inputs.some(ref => inputRefKey(ref) === inputRefKey(input.ref)))
    expect(retained.map(input => input.input)).toEqual([{ kind: 'encoded', value: 'first original' }, { kind: 'encoded', value: 'second original' }])
    expect(retained.every(input => input.disposition.kind === 'session')).toBe(true)
    fixture.dispatch({ kind: 'session-detached', ...editor(fixture) })
    expect(fixture.state.recoveries[0]?.state).toBe('consumed')
    fixture.dispatch({ kind: 'session-attached', sessionId: fixture.state.session!.id, viewId: kernelId<'view'>('remount') })
    const prepared = prepare(fixture, [fixture.write('b', { x: 1 })]), before = fixture.state
    const incomplete = { ...prepared, inputs: prepared.inputs.slice(0, 1) }
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: incomplete }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared }).result.kind).toBe('accepted')
    expect(fixture.state.inputs.slice(0, 2)).toEqual(oldInputs)
    expect(fixture.state.settlements).toEqual(oldProofs)
    for (const input of prepared.inputs) expect(fixture.state.inputs.find(record => inputRefKey(record.ref) === inputRefKey(input.ref))?.disposition).toEqual({ kind: 'intents', intentIds: prepared.action.intentIds })
    expect(fixture.dispatch({ kind: 'session-opened', revision: fixture.state.revision, sessionId: kernelId<'session'>('again'), inputId: kernelId<'input'>('again'), viewId: kernelId<'view'>('again'), target, input: { kind: 'encoded', value: 'again' }, reads: [], recoveryId: recovery.id }).result.kind).toBe('rejected')
  })

  it('explicit cancellation terminates current and retained recovery input, preserving supersession and original proofs', () => {
    const fixture = setup(), recovery = createRecovery(fixture); open(fixture, target, recovery.id)
    fixture.dispatch({ kind: 'session-input', ...editor(fixture), input: { kind: 'encoded', value: 'changed recovery' }, composition: 'idle' })
    const session = fixture.state.session!, proofs = fixture.state.settlements
    fixture.dispatch({ kind: 'session-detached', ...editor(fixture) })
    expect(fixture.dispatch({ kind: 'session-cancelled', sessionId: session.id, inputVersion: session.input.version, lease: null }).result.kind).toBe('accepted')
    for (const ref of [session.input, ...session.retainedInputs]) expect(fixture.state.inputs.find(input => inputRefKey(input.ref) === inputRefKey(ref))?.disposition.kind).toBe('cancelled-session')
    expect(fixture.state.inputs.find(input => input.ref.id === session.input.id && input.ref.version === 0)?.disposition.kind).toBe('superseded')
    expect(fixture.state.settlements).toEqual(proofs)
  })

  it('refuses to route filter input into data history', () => {
    const fixture = setup(); open(fixture, { kind: 'filter', columnId: 'x', queryVersion: 0 })
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared: prepare(fixture) }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
  })
})


it.each([false, true].flatMap(semantic => [false, true].flatMap(changed => [false, true].map(converged => ({ semantic, changed, converged })))))
  ('keeps review observations distinct from computation reads after Apply: $semantic/$changed/$converged', ({ semantic, changed, converged }) => {
    const fixture = setup(), resource: ResourceRef = { kind: 'path', entityId: entityId('b'), path: ['x'] }
    open(fixture, target, undefined, [resource])
    const session = fixture.state.session!, raw = session.rawInput
    const prepared = prepare(fixture, [fixture.write('a', { x: 1 }, semantic ? { reads: [{ resource, role: 'semantic-read' }] } : {})])
    const original = JSON.stringify(prepared.intents)
    expect(fixture.dispatch({ kind: 'session-apply', ...editor(fixture), prepared }).result.kind).toBe('accepted')
    expect(fixture.state.session).toBeNull()
    const authority = { a: { x: converged ? 1 : 0, hidden: 99 }, b: { x: changed ? 2 : 0 } }
    fixture.observe(authority, 1)
    // Repeated observations must not reprepare the input or turn a failed
    // calculation premise into a new base, including remote == desired.
    fixture.observe(authority, 2)
    const row = fixture.project().rows.find(row => row.entityId === entityId('a'))!
    const blocked = semantic && changed
    const proofs = converged && !blocked ? prepared.action.intentIds.map(intentId => ({ kind: 'externally-satisfied', intentId, observation: kernelId<'observation'>('read:1') })) : []
    expect(row.issues.map(issue => issue.code)).toEqual(blocked ? ['semantic-read-changed'] : [])
    expect(fixture.project().changes.map(change => change.kind === 'update' ? change.after : null))
      .toEqual(blocked || converged ? [] : [{ x: 1, hidden: 99 }])
    expect(JSON.stringify(fixture.state.journal.intents)).toBe(original)
    expect(fixture.state.inputs.find(input => inputRefKey(input.ref) === inputRefKey(session.input))).toMatchObject({
      input: raw, disposition: converged && !blocked ? { kind: 'settled-intents', proofs }
        : { kind: 'intents', intentIds: prepared.action.intentIds },
    })
    expect(fixture.state.settlements).toEqual(proofs)
    if (!blocked) expect(row.preview).toEqual({ x: 1, hidden: 99 })
  })

describe('queued editor opening context', () => {
  for (const change of ['schedule', 'value', 'permission', 'editor'] as const) {
    it(`allows only unrelated changes before opening: ${change}`, () => {
      const fixture = setup()
      const request = { kind: 'session-opened' as const, revision: fixture.state.revision,
        context: captureSessionOpeningContext(fixture.state, target, [], schema), target, reads: [],
        sessionId: kernelId<'session'>('queued'), inputId: kernelId<'input'>('queued-input'),
        viewId: kernelId<'view'>('view:a'), input: { kind: 'encoded' as const, value: 'Retained text' } }
      if (change === 'schedule') fixture.dispatch({ kind: 'save-schedule-configured',
        expectedToken: fixture.state.schedule.token, options: { mode: 'manual', debounceMs: 0 } })
      if (change === 'value') fixture.observe({ a: { x: 9, hidden: 7 }, b: { x: 0 } }, 2)
      if (change === 'permission') fixture.dispatch({ kind: 'policy-observed', policy: {
        ...fixture.state.policy, version: kernelId<'policy-version'>('changed'),
        defaultEntity: { ...fixture.state.policy.defaultEntity, write: false },
      } })
      if (change === 'editor') {
        const owner = open(fixture)
        fixture.dispatch({ kind: 'session-cancelled', sessionId: fixture.state.session!.id, ...owner })
      }
      expect(fixture.state.revision).toBeGreaterThan(request.revision)
      const result = fixture.dispatch(request).result
      expect(result.kind).toBe(change === 'schedule' ? 'accepted' : 'rejected')
      expect(fixture.state.session?.rawInput ?? null).toEqual(change === 'schedule' ? request.input : null)
    })
  }
})
