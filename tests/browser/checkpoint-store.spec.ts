import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('adding checkpoint stores preserves an existing semantic root and File bytes from database schema 1', async ({ page }) => {
  const databaseName = `checkpoint-upgrade-${crypto.randomUUID()}`
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).seedPreviousRecoverySchema(databaseName), databaseName)
  const restored = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, true), databaseName)
  expect(restored.revision).toBe(1)
  expect(restored.file).toEqual({ name: '旧文件.txt', lastModified: 29, text: 'legacy bytes' })
  expect(restored.leaseEpoch).not.toBe('previous-schema-lease')
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).checkpointHeadIsEmpty())).toBe(true)
})

test('a transactional checkpoint head preserves File input across a new lease and permanently fences stale writers', async ({ page }) => {
  const databaseName = `checkpoint-head-${crypto.randomUUID()}`
  const backend = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial' } })
  await page.route('**/__kernel-source/read', async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(await backend.readAtLeast()) })
  })
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const stored = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).storeRejectedWorkspaceCheckpoint())
  expect(stored.result.kind).toBe('stored')
  expect(stored.competitor).toBe('not-stored'); expect(stored.negative).toBe('not-stored'); expect(stored.arriving).toBe('not-stored')
  expect(stored.after).toEqual(stored.before)
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const restored = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceIngressDiagnostics())
  expect(restored.pending).toEqual(stored.pending)
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).storedCheckpointToken())).toBeNull()
  expect(await page.evaluate(async ingressId => (await import('/src/test-fixtures/durable-workspace.ts')).retryRetainedWorkspaceFile(ingressId), stored.pending[0]!.id))
    .toEqual({ name: '保留.txt', lastModified: 789, text: 'rejected file body' })
})

test('a delayed semantic write cannot bypass a checkpoint stored after its candidate was prepared', async ({ page }) => {
  const databaseName = `checkpoint-race-${crypto.randomUUID()}`
  const backend = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial' } })
  await page.route('**/__kernel-source/read', async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(await backend.readAtLeast()) })
  })
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const result = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).checkpointBeforeDelayedSemanticWrite())
  expect(result.stored).toBe('stored'); expect(result.update).toBe('rejected')
  expect(result.after).toEqual(result.before); expect(result.token).not.toBeNull()
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).storedCheckpointToken())).toBeNull()
  expect((await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceIngressDiagnostics())).pending).toHaveLength(1)
})
