import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('sort headers keep fixed editor identity through uncertain publication, alias columns and reload', async ({ page, context }) => {
  const name = `workspace-sort-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { b: { value: 'Beta' }, a: { value: 'Alpha' } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  async function mount(restore: boolean) {
    await page.goto('/')
    await page.evaluate(async ({ name, restore }) => {
      await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
      const container = document.createElement('div'); document.body.append(container)
      ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container, true)
    }, { name, restore })
  }
  await mount(false)
  const grid = page.getByRole('grid', { name: 'Workspace rows' })
  await expect(grid.getByRole('gridcell')).toHaveText(['Beta', 'Beta', 'Alpha', 'Alpha'])
  await grid.getByRole('gridcell', { name: 'Beta', exact: true }).first().click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Edit value', exact: true })
  await input.fill('Retained Beta input')
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  const originalTarget = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getState().session!.target)
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).loseNextWorkspaceAcknowledgement())
  await page.getByRole('button', { name: 'Sort Value', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sort Value', exact: true })).toBeDisabled()
  await expect(grid.getByRole('gridcell')).toHaveText(['Beta', 'Beta', 'Alpha', 'Alpha'])
  await expect(input).toHaveValue('Retained Beta input')
  await page.getByRole('button', { name: 'Check pending results', exact: true }).click()
  await expect(grid.getByRole('gridcell')).toHaveText(['Alpha', 'Alpha', 'Beta', 'Beta'])
  await expect(grid.getByRole('columnheader', { name: 'Value', exact: true })).toHaveAttribute('aria-sort', 'ascending')
  await page.getByRole('button', { name: 'Sort Value copy', exact: true }).click({ modifiers: ['Shift'] })
  await expect(grid.getByRole('columnheader', { name: 'Value copy', exact: true })).toHaveAttribute('aria-sort', 'descending')
  await expect(grid.getByRole('gridcell')).toHaveText(['Beta', 'Beta', 'Alpha', 'Alpha'])
  await mount(true)
  await expect(grid.getByRole('columnheader', { name: 'Value', exact: true })).toHaveAttribute('aria-sort', 'descending')
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(input).toHaveValue('Retained Beta input')
  const state = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getState())
  expect(state.viewHistory.findLast(query => query.viewId === 'grid-editor')?.sort).toEqual([{ fieldId: 'value', direction: 'desc' }])
  expect(state.session?.target).toEqual(originalTarget)
  expect(source.writes).toBe(0)
  expect(errors).toEqual([])
})

test('Shift sorting orders multiple typed fields and keeps priority across reload', async ({ page }) => {
  await page.goto('/')
  const grid = page.getByRole('grid', { name: 'Quick-start products' })
  await page.getByRole('button', { name: 'Sort Status', exact: true }).click()
  await expect(grid.getByRole('columnheader', { name: 'Status', exact: true })).toHaveAttribute('aria-sort', 'ascending')
  await page.getByRole('button', { name: 'Sort Quantity', exact: true }).click({ modifiers: ['Shift'] })
  await expect(page.getByRole('button', { name: 'Sort Quantity', exact: true })).toContainText('Priority 2')
  await page.getByRole('button', { name: 'Sort Quantity', exact: true }).click({ modifiers: ['Shift'] })
  await expect(grid.getByRole('row').nth(1)).toContainText('Blue card')
  await expect(grid.getByRole('row').nth(2)).toContainText('Cedar label')
  await page.reload()
  await expect(grid.getByRole('row').nth(2)).toContainText('Cedar label')
  await expect(page.getByRole('button', { name: 'Sort Quantity', exact: true })).toContainText('↓ Priority 2')
  await expect(page.getByRole('button', { name: 'Sort Quantity', exact: true })).toHaveAttribute('aria-description', 'Descending, priority 2')
  await page.getByRole('button', { name: 'Sort Status', exact: true }).click()
  await expect(grid.getByRole('columnheader', { name: 'Status', exact: true })).toHaveAttribute('aria-sort', 'descending')
  await expect(page.getByRole('button', { name: 'Sort Quantity', exact: true })).not.toContainText('Priority')
  await page.getByRole('button', { name: 'Sort Status', exact: true }).click()
  await expect(grid.getByRole('columnheader', { name: 'Status', exact: true })).not.toHaveAttribute('aria-sort')
  await expect(grid.getByRole('row').nth(1)).toContainText('Amber poster')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
})

test('sorting can publish while an authority refresh is held without stranding either operation', async ({ page, context, browserName }) => {
  const name = `sort-during-refresh-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { b: { value: 'Beta' }, a: { value: 'Alpha' } })
  let hold = false, entered = false, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    if (path.endsWith('/read') && hold) { entered = true; await barrier }
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await page.goto('/')
  await page.evaluate(async name => {
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, false)
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
  }, name)
  const grid = page.getByRole('grid', { name: 'Workspace rows' })
  await expect(grid.getByRole('gridcell')).toHaveText(['Beta', 'Alpha'])
  hold = true
  await page.getByRole('button', { name: 'Refresh rows', exact: true }).click()
  await expect.poll(() => entered).toBe(true)
  await page.getByRole('button', { name: 'Sort Value', exact: true }).click()
  await expect(grid.getByRole('gridcell')).toHaveText(['Alpha', 'Beta'])
  if (browserName === 'chromium') {
    const debuggerSession = await context.newCDPSession(page)
    await debuggerSession.send('HeapProfiler.collectGarbage')
    await debuggerSession.detach()
  }
  release()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await expect(grid.getByRole('gridcell')).toHaveText(['Alpha', 'Beta'])
  await expect(page.getByRole('button', { name: 'Sort Value', exact: true })).toBeEnabled()
  expect(source.writes).toBe(0)
})
