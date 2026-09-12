import { expect, test } from 'vitest'
import { Workspace } from '../kernel/workspace.js'
import { defineKernelSchema } from '../kernel/schema.js'
import { kernelId } from '../kernel/model.js'
import { prepareRowAction } from '../kernel/prepare.js'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { prepareWorkspaceRestore, prepareWorkspaceRowRestore } from './workspace-restore.js'

test('field and row restore preserve authority, membership and permissions through undo', async () => {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 1, hidden: 'original' }, b: { x: 2 } })
  const fieldId = kernelId<'field'>('x')
  const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: fieldId, path: ['x'], readonly: false }] })
  const workspace = new Workspace({ scope, source, schema, policy: permissivePolicy })
  await workspace.refresh()
  const [a, b] = workspace.getProjection().rows.map(row => row.entityId), created = kernelId<'entity'>('created')
  const changed = prepareRowAction(workspace.getState(), { cause: 'user', inputs: [],
    action: { id: kernelId<'action'>('change'), applicationId: kernelId<'application'>('change'), label: 'Change', saveAtomicity: 'transaction' },
    commands: [a!, b!].map(entityId => ({ id: kernelId<'intent'>(entityId), inputs: [], dependencies: [], command: {
      kind: 'write' as const, entityId, groups: [{ id: kernelId<'write-group'>(entityId), comparison: 'paths' as const, reads: [], writes: [{ kind: 'set' as const, path: ['x'], value: 9 }] }],
    } })),
  }, schema)
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared: changed })).kind).toBe('accepted')
  const creation = prepareRowAction(workspace.getState(), { cause: 'user', inputs: [],
    action: { id: kernelId<'action'>('create'), applicationId: kernelId<'application'>('create'), label: 'Create', saveAtomicity: 'transaction' },
    commands: [{ id: kernelId<'intent'>('create'), inputs: [], dependencies: [], command: { kind: 'create', entityId: created, document: { x: 7 } } }],
  }, schema)
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared: creation })).kind).toBe('accepted')
  const fields = [a!, b!, a!, created].map(entityId => ({ entityId, fieldId }))
  await workspace.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('blocked'),
    entities: [{ entityId: b!, policy: { ...permissivePolicy.defaultEntity, write: false } }] } })
  expect(() => prepareWorkspaceRestore(workspace, workspace.getSnapshot(), fields, 'Restore')).toThrow('permissions')
  expect(workspace.getProjection().rows.map(row => row.preview?.x)).toEqual([9, 9, 7])
  await workspace.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('allowed') } })
  const restored = prepareWorkspaceRestore(workspace, workspace.getSnapshot(), fields, 'Restore')
  expect(restored.intents).toHaveLength(2)
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared: restored })).kind).toBe('accepted')
  expect(workspace.getProjection().rows.map(row => row.preview?.x)).toEqual([1, 2, 7])
  expect((await workspace.undo()).kind).toBe('accepted')
  expect(workspace.getProjection().rows.map(row => row.preview?.x)).toEqual([9, 9, 7])
  const changedOrder = prepareRowAction(workspace.getState(), { cause: 'user', inputs: [],
    action: { id: kernelId<'action'>('reorder'), applicationId: kernelId<'application'>('reorder'), label: 'Reorder', saveAtomicity: 'transaction' },
    commands: [
      { id: kernelId<'intent'>('hidden'), inputs: [], dependencies: [], command: { kind: 'write', entityId: a!, groups: [{ id: kernelId<'write-group'>('hidden'), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['hidden'], value: 'local hidden' }] }] } },
      { id: kernelId<'intent'>('reorder'), inputs: [], dependencies: [], command: { kind: 'order', desired: [b!, created, a!] } },
    ],
  }, schema)
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared: changedOrder })).kind).toBe('accepted')
  const rowRestore = prepareWorkspaceRowRestore(workspace, workspace.getSnapshot(), [a!, created], 'Restore rows')
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared: rowRestore })).kind).toBe('accepted')
  expect(workspace.getProjection().order.preview).toEqual([a, b])
  expect(workspace.getProjection().rows.find(row => row.entityId === a)?.preview).toEqual({ x: 1, hidden: 'original' })
  expect(workspace.getProjection().rows.find(row => row.entityId === created)).toBeUndefined()
  expect((await workspace.undo()).kind).toBe('accepted')
  expect(workspace.getProjection().order.preview).toEqual([b, created, a])
  expect(workspace.getProjection().rows.find(row => row.entityId === a)?.preview).toEqual({ x: 9, hidden: 'local hidden' })
  expect(workspace.getProjection().rows.find(row => row.entityId === created)?.preview).toEqual({ x: 7 })
  expect(source.writes).toBe(0)
})
