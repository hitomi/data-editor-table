import { expect, it } from 'vitest'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId } from './model.js'
import { Workspace } from './workspace.js'

it('exports only resources referenced by a retained request without publishing them for semantic use', async () => {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>('workspace'), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const workspace = await Workspace.openDurable({ scope, source: new SourceFixture(scope, {}), schema: permissiveSchema, policy: permissivePolicy, session: storage.acquire(), restore: false })
  storage.rejectNext = true
  await expect(workspace.registerResource(new File(['kept'], 'original.txt', { lastModified: 123 }))).rejects.toThrow()
  const snapshot = workspace.getSnapshot(), entry = snapshot.ingress.pending[0]!
  if (entry.payload.kind !== 'event' || entry.payload.event.kind !== 'resource-registered') throw new Error('Expected a rejected registration')
  const resourceId = entry.payload.event.descriptor.id
  expect(() => workspace.getResource(resourceId)).toThrow('Resource is no longer available')
  const exported = workspace.getIngressResource(entry.id, resourceId) as File
  expect(await exported.text()).toBe('kept')
  expect(exported.name).toBe('original.txt')
  expect(exported.lastModified).toBe(123)
  expect(workspace.getState()).toBe(snapshot.state)
  expect(workspace.getSnapshot().ingress).toBe(snapshot.ingress)
  expect(() => workspace.getIngressResource(entry.id, kernelId<'resource'>('unrelated'))).toThrow('does not reference')
  expect(() => workspace.getIngressResource(kernelId<'ingress'>('unrelated'), resourceId)).toThrow('no longer owns')
  await workspace.disposeIngress([entry.id], snapshot.ingress.generation, 'discarded')
  expect(() => workspace.getIngressResource(entry.id, resourceId)).toThrow('no longer owns')
  expect(await exported.text()).toBe('kept')
})

it('retains a returned payload and its file after losing the disposition reply and restoring immediately', async () => {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>('workspace'), scope, schema: permissiveSchema.version, codec: permissiveSchema.codec })
  const options = { scope, source: new SourceFixture(scope, {}), schema: permissiveSchema, policy: permissivePolicy }
  const workspace = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })
  storage.rejectNext = true
  await expect(workspace.registerResource(new File(['returned body'], 'returned.txt'))).rejects.toThrow()
  const entry = workspace.getIngress().pending[0]!
  if (entry.payload.kind !== 'event' || entry.payload.event.kind !== 'resource-registered') throw new Error('Expected registration')
  const resourceId = entry.payload.event.descriptor.id
  storage.loseResponse = true
  await expect(workspace.disposeIngress([entry.id], workspace.getIngress().generation, 'returned')).rejects.toThrow()
  expect(workspace.getIngress().pending).toContainEqual(entry)
  const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(restored.getIngress().pending).toEqual([])
  expect(restored.getReturnedIngress(entry.id)).toEqual(entry.payload)
  expect(await restored.getIngressResource(entry.id, resourceId).text()).toBe('returned body')
  expect(() => restored.getResource(resourceId)).toThrow('no longer available')
  expect(await restored.releaseResource(resourceId)).toMatchObject({ kind: 'rejected', issue: { code: 'resource-retained' } })
})
