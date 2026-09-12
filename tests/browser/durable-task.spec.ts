import { abortExpectedRequest, expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { DurableTaskFixture } from '../kernel/durable-task-fixture.js'
import { kernelId, type DurableTaskRequest } from '../../src/kernel/model.js'

for (const loss of ['before-execution', 'after-execution'] as const) test(`durable File task survives response loss ${loss} and saves after reload without duplicate execution`, async ({ page, context }) => {
  const databaseName = `task-${loss}-${crypto.randomUUID()}`
  const backend = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: 7 } })
  const tasks = new DurableTaskFixture(), requests: DurableTaskRequest[] = []
  let drop = true
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await backend.readAtLeast() : path.endsWith('/lookup') ? await backend.lookupOperation(body) : await backend.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await context.route('**/__kernel-task/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON() as { request: DurableTaskRequest; resource?: number[] }
    const start = path.endsWith('/start')
    if (start) requests.push(body.request)
    if (start && drop && loss === 'before-execution') { drop = false; await abortExpectedRequest(route); return }
    const result = await tasks.definition[start ? 'start' : 'lookup'](body.request, { signal: new AbortController().signal,
      resource: body.resource ? new Blob([new Uint8Array(body.resource)]) : null })
    if (start && drop) { drop = false; await abortExpectedRequest(route); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, false), databaseName)
  const started = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).startFileTask())
  expect(started.tasks[0]).toMatchObject({ kind: 'running', outcome: 'unknown' })
  expect(started.sessionInput).toEqual({ kind: 'encoded', value: 'selected upload' })
  expect(requests[0]?.resource?.descriptor).toMatchObject({ name: 'input.txt', lastModified: 123, size: 11 })
  await page.reload()
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(databaseName, true), databaseName)
  const lookedUp = await page.evaluate(async taskId => (await import('/src/test-fixtures/durable-workspace.ts')).recoverFileTask(taskId), started.taskId)
  if (loss === 'before-execution') {
    expect(lookedUp.tasks[0]).toMatchObject({ kind: 'running', outcome: 'unknown' }); expect(tasks.executions).toBe(0)
    await page.evaluate(async taskId => (await import('/src/test-fixtures/durable-workspace.ts')).recoverFileTask(taskId, 'retry'), started.taskId)
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0])
  } else {
    expect(lookedUp.tasks[0]).toMatchObject({ kind: 'consumed', outcome: 'succeeded' })
    expect(requests).toHaveLength(1)
  }
  const saved = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).applyCurrentSessionAndSave())
  expect(saved.saved).toBe('committed'); expect(saved.row).toEqual({ value: 42, hidden: 7 })
  expect(saved.inputDispositions.filter(kind => kind === 'settled-intents')).toHaveLength(2)
  expect(tasks.executions).toBe(1); expect(tasks.lookups).toHaveLength(1); expect(backend.writes).toBe(1)
})
