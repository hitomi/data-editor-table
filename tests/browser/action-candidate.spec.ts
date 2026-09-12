import { abortExpectedRequest, expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { DurableTaskFixture } from '../kernel/durable-task-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('lost action candidates recover without writes, remain visible for review and save existing plus new rows exactly once', async ({ page, context }) => {
  const name = `candidate-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 0, hidden: 7 } })
  const service = new DurableTaskFixture()
  service.result = () => ({ kind: 'action-candidate', input: { kind: 'encoded', value: [8, 9] } })
  let drop = true
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await context.route('**/__kernel-task/*', async route => {
    const body = route.request().postDataJSON(), start = route.request().url().endsWith('/start')
    const outcome = await service.definition[start ? 'start' : 'lookup'](body.request, { signal: new AbortController().signal,
      resource: body.resource ? new Blob([new Uint8Array(body.resource)]) : null })
    if (start && drop) { drop = false; await abortExpectedRequest(route); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(outcome) })
  })
  async function mount(restore: boolean) {
    await page.evaluate(async ({ name, restore }) => {
      await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
      const container = document.createElement('div'); document.body.append(container)
      ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
    }, { name, restore })
  }
  await page.goto('/'); await mount(false)
  const id = await page.evaluate(async () => (await import('/src/test-fixtures/action-candidate.ts')).startActionCandidate())
  expect(service.executions).toBe(1)
  await page.reload(); await mount(true)
  await page.evaluate(async id => (await import('/src/test-fixtures/durable-workspace.ts')).recoverFileTask(id), id)
  await expect(page.getByRole('textbox', { name: 'Retained file result', exact: true })).toHaveValue('[8,9]')
  expect(source.writes).toBe(0)
  const result = await page.evaluate(async id => (await import('/src/test-fixtures/action-candidate.ts')).applyActionCandidate(id), id)
  expect(result.kind).toBe('accepted')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => source.writes).toBe(1)
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload(); await mount(true)
  await expect(page.getByRole('grid', { name: 'Workspace rows' }).getByRole('gridcell')).toHaveText(['8', '9'])
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 8, hidden: 7 }, { value: 9 }])
  expect(service.executions).toBe(1)
  expect(service.lookups).toHaveLength(1)
})
