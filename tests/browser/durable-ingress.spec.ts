import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('a rejected File registration survives Workspace reloads with its original ingress identity and bytes', async ({ page }) => {
  const databaseName = `workspace-ingress-${crypto.randomUUID()}`
  const backend = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial' } })
  await page.route('**/__kernel-source/read', async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(await backend.readAtLeast()) })
  })
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const before = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).retainRejectedWorkspaceFile())
  expect(before.pending).toHaveLength(1)
  const original = before.pending[0]!
  if (original.payload.kind !== 'event' || original.payload.event.kind !== 'resource-registered') throw new Error('Expected original registration')
  const resourceId = original.payload.event.descriptor.id
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.reload()
    await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
    const restored = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceIngressDiagnostics())
    expect(restored.pending).toEqual(before.pending)
    expect(restored.rawInput).toEqual(before.rawInput)
  }
  const expected = { name: '保留.txt', lastModified: 789, text: 'rejected file body' }
  expect(await page.evaluate(async ingressId => (await import('/src/test-fixtures/durable-workspace.ts')).retryRetainedWorkspaceFile(ingressId), original.id)).toEqual(expected)
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  expect(await page.evaluate(async resourceId => (await import('/src/test-fixtures/durable-workspace.ts')).readWorkspaceFile(resourceId), resourceId)).toEqual(expected)
  const completed = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceIngressDiagnostics())
  expect(completed.pending).toEqual([])
  expect(completed.receipts.find(receipt => receipt.id === original.id)?.disposition).toBe('accepted')
})

test('clean-close persists a returned ingress command before releasing the real lease', async ({ page }) => {
  const databaseName = `workspace-ingress-close-${crypto.randomUUID()}`
  const backend = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial' } })
  await page.route('**/__kernel-source/read', async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(await backend.readAtLeast()) })
  })
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const returned = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).returnRejectedWorkspaceCommand())
  const closed = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).closeDurableWorkspace())
  expect(closed.result.kind).toBe('closed')
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const restored = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceIngressDiagnostics())
  expect(restored.pending).toEqual([])
  expect(restored.receipts.find(receipt => receipt.id === returned.ingressId)?.disposition).toBe('returned')
})
