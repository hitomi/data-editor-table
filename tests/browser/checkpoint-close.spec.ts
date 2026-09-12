import { abortExpectedRequest, expect, test, type BrowserContext } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

async function source(context: BrowserContext, databaseName: string, loseResponse = false) {
  const backend = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: 7 } })
  backend.normalize = document => ({ ...document, value: String(document.value).trim().toUpperCase() })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await backend.readAtLeast() : path.endsWith('/lookup') ? await backend.lookupOperation(body) : await backend.submit(body)
    if (path.endsWith('/submit') && loseResponse) { loseResponse = false; await abortExpectedRequest(route); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  return backend
}

test('checkpoint-close transfers rejected File input and the lease to another page without changing semantic state', async ({ page, context }) => {
  const databaseName = `checkpoint-close-file-${crypto.randomUUID()}`, backend = await source(context, databaseName)
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const before = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).retainRejectedWorkspaceFile())
  const closed = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).checkpointCloseWorkspace())
  expect(closed.result.kind).toBe('closed'); expect(closed.result.checkpoint).toBeDefined(); expect(closed.unchanged).toBe(true)
  const next = await context.newPage(); await next.goto('/')
  await next.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const restored = await next.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceIngressDiagnostics())
  expect(restored.pending).toEqual(before.pending); expect(restored.rawInput).toEqual(before.rawInput)
  expect(await next.evaluate(async ingressId => (await import('/src/test-fixtures/durable-workspace.ts')).retryRetainedWorkspaceFile(ingressId), before.pending[0]!.id))
    .toEqual({ name: '保留.txt', lastModified: 789, text: 'rejected file body' })
  expect(backend.writes).toBe(0)
})

test('a lost checkpoint receipt is queried before close completes, with only one checkpoint write', async ({ page, context }) => {
  const databaseName = `checkpoint-close-receipt-${crypto.randomUUID()}`
  await source(context, databaseName); await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).retainRejectedWorkspaceFile())
  const unknown = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).checkpointCloseWorkspace(true))
  expect(unknown.result).toMatchObject({ kind: 'blocked', reason: 'checkpoint-failed' }); expect(unknown.status.kind).toBe('unknown')
  const closed = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).checkpointCloseWorkspace())
  expect(closed.result.kind).toBe('closed'); expect(closed.checkpointWrites).toBe(1); expect(closed.checkpointLookups).toBe(1)
})

test('checkpoint-close of an unknown source save reopens and recovers its exact canonical result without another write', async ({ page, context }) => {
  const databaseName = `checkpoint-close-save-${crypto.randomUUID()}`, backend = await source(context, databaseName, true)
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const unknown = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).editAndSaveWorkspace(' edited '))
  expect(unknown.saved).toBe('unresolved')
  expect((await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).checkpointCloseWorkspace())).result.kind).toBe('closed')
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const recovered = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).recoverDurableWorkspace())
  expect(recovered.result).toBe('committed'); expect(recovered.row).toEqual({ value: 'EDITED', hidden: 7 })
  expect(backend.writes).toBe(1); expect(backend.requests).toHaveLength(1)
})

test('explicit discard atomically ends raw input and failed ingress and does not resurrect edits after reopening', async ({ page, context }) => {
  const databaseName = `discard-close-${crypto.randomUUID()}`, backend = await source(context, databaseName)
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).queueScheduledEdit('discard me'))
  const retained = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).retainRejectedWorkspaceFile())
  const closed = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).discardAndCloseWorkspace())
  expect(closed.result.kind).toBe('closed'); expect(closed.discards).toHaveLength(1)
  expect(closed.capabilities.save).toMatchObject({ kind: 'blocked', reason: 'inactive' })
  const next = await context.newPage(); await next.goto('/')
  await next.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const restored = await next.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceDiscardDiagnostics())
  expect(restored.row).toEqual({ value: 'Initial', hidden: 7 }); expect(restored.discards).toEqual(closed.discards)
  expect(restored.sessionInput).toBeUndefined(); expect(restored.history).toEqual({ undo: [], redo: [] })
  expect(restored.capabilities.undo).toEqual({ kind: 'unavailable', reason: 'no-history' })
  expect(restored.capabilities.save).toEqual({ kind: 'unavailable', reason: 'no-changes' })
  expect(restored.ingress.pending).toEqual([])
  expect(restored.ingress.receipts.find(receipt => receipt.id === retained.pending[0]!.id)?.disposition).toBe('discarded')
  expect(backend.writes).toBe(0)
})

test('discard cannot erase an unknown source result and retains canonical data after exact recovery', async ({ page, context }) => {
  const databaseName = `discard-unknown-${crypto.randomUUID()}`, backend = await source(context, databaseName, true)
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).editAndSaveWorkspace(' edited '))
  const blocked = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).discardAndCloseWorkspace())
  expect(blocked.result).toMatchObject({ kind: 'blocked', reason: 'work' }); expect(blocked.discards).toEqual([])
  expect(blocked.capabilities.save).toMatchObject({ kind: 'blocked', reason: 'source-reserved' })
  expect(blocked.capabilities.undo.kind).toBe('available')
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).recoverDurableWorkspace())
  expect((await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).discardAndCloseWorkspace())).result.kind).toBe('closed')
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const restored = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceDiscardDiagnostics())
  expect(restored.row).toEqual({ value: 'EDITED', hidden: 7 }); expect(restored.discards).toHaveLength(1)
  expect(backend.writes).toBe(1); expect(backend.requests).toHaveLength(1)
})
