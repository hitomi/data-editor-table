import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('a full checkpoint crosses a page boundary and installs previously unpersisted ingress for subsequent ordinary reload', async ({ page }) => {
  const databaseName = `workspace-checkpoint-${crypto.randomUUID()}`
  const backend = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial' } })
  await page.route('**/__kernel-source/read', async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(await backend.readAtLeast()) })
  })
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const before = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).archiveRejectedWorkspaceFile(databaseName), databaseName)
  expect(before.pending).toHaveLength(1)
  const original = before.pending[0]!
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true, 'manual', true), databaseName)
  expect((await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceIngressDiagnostics())).pending).toEqual(before.pending)
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const restored = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceIngressDiagnostics())
  expect(restored.pending).toEqual(before.pending); expect(restored.rawInput).toEqual(before.rawInput)
  expect(await page.evaluate(async ingressId => (await import('/src/test-fixtures/durable-workspace.ts')).retryRetainedWorkspaceFile(ingressId), original.id))
    .toEqual({ name: '保留.txt', lastModified: 789, text: 'rejected file body' })
  expect(backend.writes).toBe(0)
})
