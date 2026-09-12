import { abortExpectedRequest, expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { DurableTaskFixture } from '../kernel/durable-task-fixture.js'
import { kernelId, type DurableTaskRequest } from '../../src/kernel/model.js'

test('startup recovery finds the saved operation and a later File task, queries both once, and preserves their separate input destinations', async ({ page, context }) => {
  const databaseName = `recovery-scan-${crypto.randomUUID()}`
  const backend = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: 7 } })
  backend.normalize = document => ({ ...document, value: String(document.value).trim().toUpperCase() })
  const tasks = new DurableTaskFixture()
  let loseSource = true, loseTask = true
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await backend.readAtLeast() : path.endsWith('/lookup') ? await backend.lookupOperation(body) : await backend.submit(body)
    if (path.endsWith('/submit') && loseSource) { loseSource = false; await abortExpectedRequest(route); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await context.route('**/__kernel-task/*', async route => {
    const body = route.request().postDataJSON() as { request: DurableTaskRequest; resource?: number[] }
    const start = new URL(route.request().url()).pathname.endsWith('/start')
    const result = await tasks.definition[start ? 'start' : 'lookup'](body.request, { signal: new AbortController().signal,
      resource: body.resource ? new Blob([new Uint8Array(body.resource)]) : null })
    if (start && loseTask) { loseTask = false; await abortExpectedRequest(route); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const saved = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).editAndSaveWorkspace(' saved '))
  expect(saved.saved).toBe('unresolved')
  const started = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).startFileTask('filter'))
  expect(started.tasks[0]).toMatchObject({ kind: 'running', outcome: 'unknown' })
  expect(started.persistence).toBe('outcome-unknown')
  const original = backend.requests[0]!, execution = tasks.requests[0]!
  expect(execution.resource?.descriptor).toMatchObject({ kind: 'file', name: 'input.txt', size: 11, lastModified: 123 })
  const exported = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).exportAndValidateWorkspaceCheckpoint())
  expect(exported.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(exported.reservation).toEqual({ kind: 'submission', submission: original })
  expect(exported.tasks).toEqual(['running'])
  expect(exported.files).toEqual([{ descriptor: execution.resource!.descriptor, text: 'upload body' }])
  expect(exported.ticket.semanticRevision).toBe(exported.revision)
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true, 'lookup'), databaseName)
  const recovered = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).scanDurableWorkspace())
  expect(recovered.result.kind).toBe('completed'); expect(recovered.result.remaining.candidates).toEqual([])
  expect(recovered.row).toEqual({ value: 'SAVED', hidden: 7 })
  expect(recovered.sessionInput).toEqual({ kind: 'encoded', value: 42 })
  expect(recovered.tasks[0]).toMatchObject({ kind: 'consumed', outcome: 'succeeded' })
  expect(recovered.result.remaining.assessment.blockers.some(blocker => blocker.kind === 'session')).toBe(true)
  const applied = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).applyRecoveredFilter())
  expect(applied.result.kind).toBe('accepted'); expect(applied.visible).toBe(0)
  expect(applied.inputDispositions.filter(disposition => disposition === 'applied-to-view')).toHaveLength(2)
  expect(applied.inputDispositions.filter(disposition => disposition === 'settled-intents')).toHaveLength(1)
  expect(backend.requests).toEqual([original]); expect(backend.lookups).toBe(1)
  expect(tasks.requests).toEqual([execution]); expect(tasks.lookups).toEqual([execution]); expect(tasks.executions).toBe(1)
  await page.reload()
  const reopened = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true, 'lookup'), databaseName)
  expect(reopened.inputDispositions).toEqual(applied.inputDispositions); expect(reopened.row).toEqual(applied.row)
})
