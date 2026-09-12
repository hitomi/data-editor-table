import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('clipboard limits reject before row creation and recheck retained input without discarding it', async ({ page, context }) => {
  const name = `clipboard-limits-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 12 } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  const render = async (maxClipboardBytes: number, maxMutations: number, restore?: boolean) => page.evaluate(async ({ name, maxClipboardBytes, maxMutations, restore }) => {
    if (restore !== undefined) await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
    let container = document.getElementById('limits-grid')
    if (!container) { container = document.createElement('div'); container.id = 'limits-grid'; document.body.append(container) }
    await (await import('/src/test-fixtures/workspace-grid.tsx')).mountCreatingWorkspaceGrid(container, false, false, { maxClipboardBytes, maxMutations })
  }, { name, maxClipboardBytes, maxMutations, restore })
  await page.goto('/'); await render(4, 3, false)
  const grid = page.getByRole('grid', { name: 'Workspace rows' })
  await grid.getByRole('gridcell').first().click()
  const paste = async (text: string) => {
    await grid.getByRole('gridcell').first().evaluate((cell, text) => {
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })
      event.clipboardData!.setData('text/plain', text); cell.dispatchEvent(event)
    }, text)
  }
  const limit = page.getByRole('alert').filter({ hasText: 'configured size limit' })
  await paste('41\n42')
  await expect(limit).toBeVisible()
  await render(5, 2)
  await paste('41\n42')
  await expect(limit).toBeVisible()
  expect(await page.evaluate(async () => {
    const fixture = await import('/src/test-fixtures/durable-workspace.ts')
    return { session: fixture.workspaceForReactFixture().getState().session, factories: (await import('/src/test-fixtures/workspace-grid.tsx')).workspaceRowFactoryCalls() }
  })).toEqual({ session: null, factories: 0 })
  expect(source.writes).toBe(0)
  await render(5, 3)
  await paste('41\nx')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.reload(); await render(5, 2, true)
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Edit 2 selected fields', exact: true })
  await expect(input).toHaveValue('41\nx')
  await input.fill('41\n42')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(limit).toBeVisible()
  await expect(input).toHaveValue('41\n42')
  await expect(grid.getByRole('gridcell')).toHaveCount(1)
  await render(4, 3)
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(limit).toBeVisible()
  await expect(input).toHaveValue('41\n42')
  await expect(grid.getByRole('gridcell')).toHaveCount(1)
  await render(5, 3)
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(grid.getByRole('gridcell')).toHaveText(['41', '42'])
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/workspace-grid.tsx')).workspaceRowFactoryCalls())).toBe(0)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => source.writes).toBe(1)
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  expect(source.snapshot().rows.map(row => row.document.value)).toEqual([41, 42])
  const copy = () => grid.getByRole('gridcell').first().evaluate(cell => {
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })
    event.clipboardData!.setData('text/plain', 'previous clipboard'); cell.dispatchEvent(event)
    return event.clipboardData!.getData('text/plain')
  })
  await render(1, 3)
  expect(await copy()).toBe('previous clipboard')
  await expect(limit).toBeVisible()
  await render(2, 3)
  expect(await copy()).toBe('41')
  await expect(limit).toHaveCount(0)
})
