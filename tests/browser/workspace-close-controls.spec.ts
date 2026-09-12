import { expect, test, type BrowserContext, type Page } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

async function start(page: Page, context: BrowserContext) {
  const name = `close-controls-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: 7 } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await mount(page, name, false)
  return { name, source }
}
async function mount(page: Page, name: string, restore: boolean) {
  await page.goto('/')
  await page.evaluate(async ({ name, restore }) => {
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountClosableWorkspaceGrid(container)
  }, { name, restore })
  await expect(page.getByRole('grid', { name: 'Workspace rows' }).getByRole('gridcell')).toHaveText('Initial')
}
async function closedCount(page: Page) {
  return page.evaluate(async () => (await import('/src/test-fixtures/workspace-grid.tsx')).workspaceClosedOwners().length)
}

test('close review expires on new input; unknown checkpoint receipt cannot navigate, and retry restores the exact input', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const { name, source } = await start(page, context)
  const review = page.getByRole('button', { name: 'Review before closing', exact: true })
  await review.click()
  await expect(page.getByRole('button', { name: 'Close workspace', exact: true })).toBeEnabled()
  await page.getByRole('gridcell').click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Edit value', exact: true })
  await input.fill('Unsaved raw input')
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  await expect(page.getByText('Work has changed. Review again before choosing how to close.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep changes and close', exact: true })).toBeDisabled()
  await review.click()
  await expect(page.getByRole('button', { name: 'Close workspace', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(input).toHaveValue('Unsaved raw input')
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toHaveCount(0)
  expect(await closedCount(page)).toBe(0)
  await review.click()
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).loseNextCheckpointAcknowledgement())
  await page.getByRole('button', { name: 'Keep changes and close', exact: true }).click()
  await expect(page.getByText('Closing did not complete. Stay on this page and review again to retry.')).toBeVisible()
  expect(await closedCount(page)).toBe(0)
  await expect(input).toHaveValue('Unsaved raw input')
  await review.click()
  await page.getByRole('button', { name: 'Keep changes and close', exact: true }).click()
  await expect(page.getByText('Workspace closed.', { exact: true })).toBeVisible()
  await expect.poll(() => closedCount(page)).toBe(1)
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).checkpointWriteDiagnostics()))
    .toEqual({ checkpointWrites: 1, checkpointLookups: 1 })
  await mount(page, name, true)
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Edit value', exact: true })).toHaveValue('Unsaved raw input')
  expect(source.writes).toBe(0)
  expect(errors).toEqual([])
})

test('clean close reports release once and permits the next owner to reopen', async ({ page, context }) => {
  const { name, source } = await start(page, context)
  await page.getByRole('button', { name: 'Review before closing', exact: true }).click()
  await page.getByRole('button', { name: 'Close workspace', exact: true }).evaluate(button => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(page.getByText('Workspace closed.', { exact: true })).toBeVisible()
  await expect.poll(() => closedCount(page)).toBe(1)
  const next = await context.newPage()
  await mount(next, name, true)
  expect(source.writes).toBe(0)
})

test('discard close requires explicit consent and does not resurrect raw input after reopening', async ({ page, context }) => {
  const { name, source } = await start(page, context)
  await page.getByRole('gridcell').click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill('Discard this input')
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Review before closing', exact: true }).click()
  const discard = page.getByRole('button', { name: 'Discard unsaved work and close', exact: true })
  await expect(discard).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Discard the unsaved changes and recoverable input listed above.', exact: true }).check()
  await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill('New input after consent')
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  await expect(discard).toBeDisabled()
  await page.getByRole('button', { name: 'Review before closing', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Discard the unsaved changes and recoverable input listed above.', exact: true })).not.toBeChecked()
  await expect(discard).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Discard the unsaved changes and recoverable input listed above.', exact: true }).check()
  await discard.click()
  await expect(page.getByText('Workspace closed.', { exact: true })).toBeVisible()
  await expect.poll(() => closedCount(page)).toBe(1)
  await mount(page, name, true)
  await expect(page.getByRole('button', { name: 'Resume editing', exact: true })).toHaveCount(0)
  await page.getByRole('gridcell').click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Edit value', exact: true })).toHaveValue('Initial')
  expect(source.writes).toBe(0)
})
