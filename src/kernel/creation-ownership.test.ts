import { expect, it } from 'vitest'
import { entityId, KernelFixture, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { prepareUndo, projectHistory } from './history.js'
import { kernelId } from './model.js'
import { defineKernelSchema } from './schema.js'
import { bindServerAuthority, unboundServerIdentities } from './source.js'

it('keeps history and task ownership through a partial save assigning a creation key', async () => {
  const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: kernelId<'field'>('x'), path: ['x'], readonly: false }] })
  const fixture = new KernelFixture({ a: { x: 0 } }, schema)
  const source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
  async function read() {
    const snapshot = source.snapshot()
    const allocations = unboundServerIdentities(fixture.state, snapshot).map(identity => ({ identity, entityId: entityId(`allocated:${fixture.next()}`) }))
    expect(fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, snapshot, allocations) }).result.kind).toBe('accepted')
  }
  const deletion = fixture.apply([{ kind: 'delete', entityId: entityId('a') }], 'row', 'delete original')
  source.external({ a: { x: 7 } }); await read()
  const creation = fixture.apply([{ kind: 'create', entityId: entityId('local'), document: { x: 1, hidden: 8 } }])
  const request = fixture.freeze().submission
  expect(request.coverage.flatMap(item => item.intentIds)).toEqual(creation.action.intentIds)
  const successor = fixture.apply([fixture.write('local', { x: 2 })], 'row', 'successor original')
  const target = { kind: 'cell' as const, field: { entityId: entityId('local'), fieldId: kernelId<'field'>('x') } }
  expect(fixture.dispatch({ kind: 'session-opened', revision: fixture.state.revision, sessionId: kernelId<'session'>('editor'),
    inputId: kernelId<'input'>('editor-input'), viewId: kernelId<'view'>('view'), target, input: { kind: 'encoded', value: 'editor original' }, reads: [] }).result.kind).toBe('accepted')
  const session = fixture.state.session!
  const task = { taskId: kernelId<'task'>('upload'), executionId: 'upload:1' }
  expect(fixture.dispatch({ kind: 'task-registered', ...task, revision: fixture.state.revision,
    owner: { kind: 'session', sessionId: session.id, input: session.input }, inputId: kernelId<'input'>('upload-input'),
    input: { kind: 'encoded', value: 'upload original' }, reads: [] }).result.kind).toBe('accepted')
  expect(fixture.dispatch({ kind: 'task-started', ...task }).result.kind).toBe('accepted')
  source.normalize = document => ({ ...document, x: 1.5, hidden: 9 })
  const result = await source.submit(request)
  if (result.kind !== 'applied') throw new Error('Expected an applied creation')
  const created = result.receipt.results.find(item => item.kind === 'created')!
  if (created.kind !== 'created') throw new Error('Missing assigned identity')
  expect(created.identity.key).not.toBe('local')
  expect(fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }).result.kind).toBe('accepted')
  await read()
  expect(fixture.state.entities.find(entity => entity.entityId === entityId('local'))).toEqual({ kind: 'bound', entityId: entityId('local'), identity: created.identity })
  expect(fixture.state.session).toMatchObject({ id: session.id, target, input: session.input, rawInput: session.rawInput })
  expect(fixture.state.settlements.map(proof => proof.intentId)).toEqual(creation.action.intentIds)
  expect(fixture.state.journal.intents).toEqual([...deletion.intents, ...creation.intents, ...successor.intents])
  expect(projectHistory(fixture.state).undo.at(-1)?.id).toBe(successor.action.id)
  expect(fixture.dispatch({ kind: 'task-completed', ...task, result: { kind: 'session-candidate', sessionId: session.id,
    input: { kind: 'encoded', value: 'upload result' } } }).result.kind).toBe('accepted')
  expect(fixture.state.session?.target).toEqual(target)
  expect(fixture.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'upload result' })
  expect(fixture.state.tasks[0]?.kind).toBe('consumed')
  expect(fixture.project().rows.find(row => row.entityId === entityId('local'))?.preview).toEqual({ x: 2, hidden: 9 })
  const undo = prepareUndo(fixture.state, { actionId: kernelId<'action'>('undo'), applicationId: kernelId<'application'>('undo'),
    controls: [{ entityId: entityId('local'), intentId: kernelId<'intent'>('undo-local') }] })
  expect(fixture.dispatch({ kind: 'prepared-undo', prepared: undo }).result.kind).toBe('accepted')
  expect(fixture.project().rows.find(row => row.entityId === entityId('local'))?.preview).toEqual({ x: 1.5, hidden: 9 })
  expect(fixture.project().changes).toEqual([])
  expect(fixture.state.inputs.find(input => input.input.kind === 'encoded' && input.input.value === 'delete original')?.disposition.kind).toBe('intents')
  expect(source.snapshot().rows).toEqual([{ identity: { key: 'a', incarnation: 'life:1' }, document: { x: 7 } },
    { identity: created.identity, document: { x: 1.5, hidden: 9 } }])
  expect(source.writes).toBe(1)
})
