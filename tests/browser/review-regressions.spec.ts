import { expect, test, type Page, type BrowserContext } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'
async function mount(page: Page, name: string, restore: boolean) {
  await page.goto('/')
  await page.evaluate(async ({ name, restore }) => {
    document.body.replaceChildren()
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/review-regressions.tsx')).mountReviewRegressionFixture(container)
  }, { name, restore })
}
async function start(page: Page, context: BrowserContext) {
  const name = `review-${crypto.randomUUID()}`
  const initial = Object.fromEntries(['Initial', '', 'old1', 'old2'].map((value, index) => [String(index), { value, note: 'original', locked: false }]))
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, initial)
  await context.route('**/__kernel-source/*', async route => {
    const path = route.request().url(), body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await mount(page, name, false)
  return { name, source, initial }
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
}
const diagnostics = (page: Page) => page.evaluate(async () => (await import('/src/test-fixtures/review-regressions.tsx')).reviewRegressionDiagnostics())
test('permission revocation preserves authored input across reload and restoration', async ({ page, context }) => {
  const { name, source } = await start(page, context)
  await page.getByRole('grid', { name: 'Review regressions' }).getByRole('gridcell', { name: 'Initial', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Edited')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await page.evaluate(async () => (await import('/src/test-fixtures/review-regressions.tsx')).changeReviewPermission(false))
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await mount(page, name, true)
  expect((await diagnostics(page)).projection.rows[0]!.persistence).toBe('blocked')
  expect(source.writes).toBe(0)
  await page.evaluate(async () => (await import('/src/test-fixtures/review-regressions.tsx')).changeReviewPermission(true))
  await save(page); await mount(page, name, true)
  await expect(page.getByRole('gridcell').first()).toHaveText('Edited')
  expect(source.snapshot().rows[0]!.document).toEqual({ value: 'Edited', note: 'original', locked: false })
})
for (const remove of [false, true]) test(`explicit collision adoption retains hidden input and exact entity identity (delete=${remove})`, async ({ page, context }) => {
  const { name, source, initial } = await start(page, context)
  await page.getByRole('button', { name: 'Add row', exact: true }).click()
  await expect.poll(async () => (await diagnostics(page)).projection.rows.length).toBe(5)
  source.external({ ...initial, new: { value: 'New row', note: 'remote input', locked: false } })
  const remote = source.snapshot().rows.find(row => row.identity.key === 'new')!
  await page.getByRole('button', { name: 'Refresh rows', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review existing row replacement', exact: true })).toBeEnabled()
  await mount(page, name, true)
  await page.getByRole('button', { name: 'Review existing row replacement', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Review row replacement' })).toContainText('local input')
  await page.getByRole('button', { name: 'Replace existing row with reviewed data', exact: true }).click()
  await expect.poll(async () => (await diagnostics(page)).projection.rows.filter(row => row.issues.length).length).toBe(0)
  if (remove) {
    await page.getByRole('checkbox', { name: 'Confirm deletion of the adopted row', exact: true }).check()
    await page.getByRole('button', { name: 'Delete adopted row', exact: true }).click()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByRole('gridcell', { name: 'New row', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
  }
  await save(page)
  expect(source.requests).toHaveLength(1)
  expect(source.requests[0]!.items).toHaveLength(1)
  expect(source.requests[0]!.items[0]).toMatchObject({ kind: remove ? 'delete' : 'update', identity: remote.identity })
  await mount(page, name, true)
  if (remove) {
    await expect(page.getByRole('gridcell', { name: 'New row', exact: true })).toHaveCount(0)
    expect(source.snapshot().rows).toHaveLength(4)
  } else {
    const stored = source.snapshot().rows.find(row => row.identity.key === 'new')!
    expect(stored.identity).toEqual(remote.identity)
    expect(stored.document).toEqual({ value: 'New row', note: 'local input', locked: false })
    await expect(page.getByRole('gridcell', { name: 'New row', exact: true })).toBeVisible()
  }
})
test('DOM copy and paste preserve the final empty row through undo, save and reopening', async ({ page, context }) => {
  const { name, source } = await start(page, context), cells = page.getByRole('gridcell')
  await cells.nth(0).click(); await cells.nth(0).press('Shift+ArrowDown')
  const text = await cells.nth(0).evaluate(cell => {
    const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    cell.dispatchEvent(event); return event.clipboardData!.getData('text/plain')
  })
  expect(text).toBe('Initial\n""')
  await cells.nth(2).click(); await cells.nth(2).press('Shift+ArrowDown')
  await cells.nth(2).evaluate((cell, text) => {
    const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    event.clipboardData!.setData('text/plain', text); cell.dispatchEvent(event)
  }, text)
  await expect(cells).toHaveText(['Initial', '', 'Initial', ''])
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(cells).toHaveText(['Initial', '', 'old1', 'old2'])
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await save(page); await mount(page, name, true)
  await expect(cells).toHaveText(['Initial', '', 'Initial', ''])
  expect(source.snapshot().rows.map(row => row.document.value)).toEqual(['Initial', '', 'Initial', ''])
})
