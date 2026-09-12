import { expect, fulfillExpectedFailure, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('exact commit followed by failed reads retains a successor through IndexedDB reload without resending', async ({ page, context }) => {
  const name = `commit-read-failure-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: 7 } })
  source.normalize = document => ({ ...document, value: String(document.value).toUpperCase(), hidden: 9 })
  let failReads = false, failAfterCommit = true, failedReads = 0
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    if (path.endsWith('/read') && failReads) { failedReads++; await fulfillExpectedFailure(route, { status: 503, body: 'Authority temporarily unavailable' }); return }
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    if (path.endsWith('/submit') && failAfterCommit) failReads = true
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  const mount = async (restore: boolean) => {
    if (!restore) await page.goto('/')
    await page.evaluate(async ({ name, restore }) => {
      await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore, 'manual', false, { refresh: !restore })
      const container = document.createElement('div'); document.body.append(container)
      ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
    }, { name, restore })
  }
  const state = () => page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getState())
  const grid = page.getByRole('grid', { name: 'Workspace rows', exact: true })
  const edit = async (text: string) => {
    await grid.getByRole('gridcell').click()
    await page.getByRole('button', { name: 'Edit value', exact: true }).click()
    await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill(text)
    await page.getByRole('button', { name: 'Apply value', exact: true }).click()
    await expect(grid.getByRole('gridcell')).toHaveText(text)
  }
  await mount(false); await edit('first')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await state()).persistence.kind).toBe('committed-awaiting-authority')
  await expect(grid.getByRole('gridcell')).toHaveText('first')
  await expect(page.getByRole('status').filter({ hasText: 'Changes reached the server. Waiting for updated rows.' })).toBeVisible()
  await expect(page.getByText('The save result is unknown. Check pending results.', { exact: true })).toHaveCount(0)
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 'FIRST', hidden: 9 }])
  expect((await state()).commits).toHaveLength(1); expect((await state()).settlements).toEqual([])
  await edit('second')
  const before = await state(), bytes = JSON.stringify(source.requests[0])
  await page.reload(); await mount(true)
  await expect(grid.getByRole('gridcell')).toHaveText('second')
  await expect(page.getByRole('status').filter({ hasText: 'Changes reached the server. Waiting for updated rows.' })).toBeVisible()
  const failedBefore = failedReads
  await page.getByRole('button', { name: 'Check pending results', exact: true }).click()
  await expect.poll(() => failedReads).toBe(failedBefore + 1)
  await expect(page.getByRole('button', { name: 'Check pending results', exact: true })).toBeEnabled()
  await expect.poll(async () => (await state()).authority.read.kind).toBe('failed')
  expect((await state()).journal.intents).toEqual(before.journal.intents)
  expect((await state()).inputs).toEqual(before.inputs)
  expect((await state()).settlements).toEqual([])
  expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1); expect(source.lookups).toBe(0)
  expect(JSON.stringify(source.requests[0])).toBe(bytes)
  failReads = false; failAfterCommit = false
  await page.getByRole('button', { name: 'Check pending results', exact: true }).click()
  await expect.poll(async () => (await state()).persistence.kind).toBe('idle')
  await expect(grid.getByRole('gridcell')).toHaveText('second')
  expect((await state()).settlements.map(proof => proof.intentId)).toEqual([before.journal.intents[0]!.id])
  expect((await state()).inputs.map(input => input.disposition.kind)).toEqual(before.inputs.map(input => input.disposition.kind === 'intents' && input.disposition.intentIds.includes(before.journal.intents[0]!.id) ? 'settled-intents' : input.disposition.kind))
  expect((await state()).inputs.map(({ ref, input }) => ({ ref, input }))).toEqual(before.inputs.map(({ ref, input }) => ({ ref, input })))
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(grid.getByRole('gridcell')).toHaveText('SECOND')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  expect(source.requests[1]!.items[0]).toMatchObject({ kind: 'update', before: { value: 'FIRST', hidden: 9 }, after: { value: 'second', hidden: 9 } })
  await page.reload(); await mount(true)
  await expect(grid.getByRole('gridcell')).toHaveText('SECOND')
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 'SECOND', hidden: 9 }])
  expect(source.requests).toHaveLength(2); expect(source.writes).toBe(2); expect(source.lookups).toBe(0)
  expect((await state()).journal.intents).toEqual(before.journal.intents)
  expect((await state()).inputs.map(({ ref, input }) => ({ ref, input }))).toEqual(before.inputs.map(({ ref, input }) => ({ ref, input })))
  expect(JSON.stringify(source.requests[0])).toBe(bytes)
})

test('confirmed application without a receipt keeps its distinct status after reload until details arrive', async ({ page, context }) => {
  const name = `awaiting-receipt-${crypto.randomUUID()}`
  let receiptAvailable = false
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: 7 } })
  source.normalize = document => ({ ...document, value: 'FIRST', hidden: 9 })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(path.endsWith('/submit') ? { kind: 'applied-without-receipt', commitToken: 'confirmed-write' }
      : path.endsWith('/lookup') && !receiptAvailable ? { kind: 'unknown', issue: { code: 'pending', message: 'Receipt is not available yet' } } : result) })
  })
  const mount = async (restore: boolean) => {
    if (restore) await page.reload(); else await page.goto('/')
    await page.evaluate(async ({ name, restore }) => {
      await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore, 'manual', false, { refresh: !restore })
      const container = document.createElement('div'); document.body.append(container)
      ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
    }, { name, restore })
  }
  await mount(false)
  await page.getByRole('grid', { name: 'Workspace rows' }).getByRole('gridcell').click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill('first')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const status = page.getByRole('status').filter({ hasText: 'Changes reached the server. Waiting for save details.' })
  await expect(status).toBeVisible()
  await expect(page.getByText('The save result is unknown. Check pending results.', { exact: true })).toHaveCount(0)
  await mount(true)
  await expect(status).toBeVisible()
  await expect(page.getByRole('gridcell')).toHaveText('first')
  receiptAvailable = true
  await page.getByRole('button', { name: 'Check pending results', exact: true }).click()
  await expect(page.getByRole('gridcell')).toHaveText('FIRST')
  await expect(status).toHaveCount(0)
  expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1); expect(source.lookups).toBe(2)
})
