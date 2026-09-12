import { abortExpectedRequest, expect, test, type BrowserContext } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

async function source(context: BrowserContext, databaseName: string) {
  const scope = { sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const backend = new SourceFixture(scope, { a: { value: 'Initial', hidden: 7 } })
  backend.normalize = document => ({ ...document, value: String(document.value).trim().toUpperCase() })
  let loseNextResponse = false
  await context.route('**/__kernel-source/*', async route => {
    const body = route.request().postDataJSON(), path = new URL(route.request().url()).pathname
    const result = path.endsWith('/read') ? await backend.readAtLeast()
      : path.endsWith('/lookup') ? await backend.lookupOperation(body) : await backend.submit(body)
    if (path.endsWith('/submit') && loseNextResponse) { loseNextResponse = false; await abortExpectedRequest(route); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  return { backend, loseResponse() { loseNextResponse = true } }
}

test('durable Workspace saves canonical server data and reopening cannot regress through an older read', async ({ page, context }) => {
  const databaseName = `workspace-save-${crypto.randomUUID()}`, { backend } = await source(context, databaseName), old = backend.snapshot()
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const saved = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).editAndSaveWorkspace(' edited '))
  expect(saved.saved).toBe('committed'); expect(saved.row).toEqual({ value: 'EDITED', hidden: 7 })
  expect(saved.inputDispositions).toEqual(['settled-intents'])
  await page.reload()
  const restored = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  expect(restored.row).toEqual(saved.row); expect(restored.persistence).toBe('idle')
  backend.readHook = async () => old
  const stale = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).refreshDurableWorkspace())
  expect(stale.result).toBe('rejected'); expect(stale.row).toEqual(saved.row)
  backend.readHook = null
  const refreshed = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).refreshDurableWorkspace())
  expect(refreshed.result).toBe('accepted'); expect(refreshed.row).toEqual(saved.row)
  expect(backend.requests).toHaveLength(1); expect(backend.writes).toBe(1)
})

test('reopening after a lost mutation response recovers the original operation by lookup without a duplicate write', async ({ page, context }) => {
  const databaseName = `workspace-recover-${crypto.randomUUID()}`, server = await source(context, databaseName)
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  server.loseResponse()
  const unknown = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).editAndSaveWorkspace(' retained '))
  expect(unknown.saved).toBe('unresolved'); expect(unknown.persistence).toBe('outcome-unknown')
  expect(unknown.inputDispositions).toEqual(['intents']); expect(server.backend.writes).toBe(1)
  const original = server.backend.requests[0]!
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const recovered = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).recoverDurableWorkspace())
  expect(recovered.result).toBe('committed'); expect(recovered.row).toEqual({ value: 'RETAINED', hidden: 7 })
  expect(recovered.inputDispositions).toEqual(['settled-intents']); expect(recovered.persistence).toBe('idle')
  expect(server.backend.requests).toEqual([original]); expect(server.backend.lookups).toBe(1)
})

test('clean close releases the real workspace lease and the next owner restores exactly saved input', async ({ page, context }) => {
  const databaseName = `workspace-close-${crypto.randomUUID()}`, { backend } = await source(context, databaseName)
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const saved = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).editAndSaveWorkspace(' close me '))
  expect(saved.saved).toBe('committed')
  const next = await context.newPage()
  await next.goto('/')
  const occupied = await next.evaluate(async databaseName => {
    try { await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true); return null }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }, databaseName)
  expect(occupied).toContain('active owner')
  const closed = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).closeDurableWorkspace())
  expect(closed.result.kind).toBe('closed'); expect(closed.result.assessment.lifecycle).toBe('closed')
  expect(closed.result.assessment.blockers).toEqual([]); expect(closed.late?.kind).toBe('rejected')
  expect(closed.unchanged).toBe(true); expect(closed.pending).toBe(0)
  const reopened = await next.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  expect(reopened.row).toEqual({ value: 'CLOSE ME', hidden: 7 }); expect(reopened.inputDispositions).toEqual(['settled-intents'])
  expect(backend.writes).toBe(1)
  await next.close()
})

test('a durable debounce restores its pending frontier and automatically saves canonical data after reload', async ({ page, context }) => {
  const databaseName = `workspace-debounce-${crypto.randomUUID()}`, { backend } = await source(context, databaseName)
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'))
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).configureWorkspaceSchedule('debounced', 1000))
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).queueScheduledEdit(' first '))
  await page.clock.runFor(900)
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).queueScheduledEdit(' latest '))
  expect(backend.requests).toHaveLength(0)
  await page.reload()
  const restored = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  expect(restored.schedule).toMatchObject({ mode: 'debounced', debounceMs: 1000, pending: true })
  expect(restored.row?.value).toBe(' latest ')
  await page.clock.runFor(999); expect(backend.requests).toHaveLength(0)
  await page.clock.runFor(1)
  await expect.poll(async () => page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceDiagnostics())).toMatchObject({
    persistence: 'idle', row: { value: 'LATEST', hidden: 7 }, inputDispositions: ['settled-intents', 'settled-intents'],
  })
  expect(backend.requests).toHaveLength(1); expect(backend.writes).toBe(1)
  await page.reload()
  const saved = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  expect(saved.row).toEqual({ value: 'LATEST', hidden: 7 }); expect(saved.schedule.pending).toBe(false)
})

test('immediate save retains an unknown request across reload and follows up only after original-operation recovery', async ({ page, context }) => {
  const databaseName = `workspace-auto-unknown-${crypto.randomUUID()}`, server = await source(context, databaseName)
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  server.loseResponse()
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).configureWorkspaceSchedule('immediate'))
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).queueScheduledEdit(' first '))
  await expect.poll(async () => page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceDiagnostics())).toMatchObject({ persistence: 'outcome-unknown' })
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).queueScheduledEdit(' second '))
  await page.reload()
  const restored = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  expect(restored.schedule.pending).toBe(true); expect(restored.persistence).toBe('outcome-unknown')
  expect(server.backend.requests).toHaveLength(1)
  const original = server.backend.requests[0]!
  const recovered = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).recoverDurableWorkspace())
  expect(recovered.result).toBe('committed')
  await expect.poll(async () => page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceDiagnostics())).toMatchObject({
    persistence: 'idle', row: { value: 'SECOND', hidden: 7 }, inputDispositions: ['settled-intents', 'settled-intents'],
  })
  expect(server.backend.requests).toHaveLength(2); expect(server.backend.lookups).toBe(1)
  expect(server.backend.requests[1]!.operationId).not.toBe(original.operationId)
})
