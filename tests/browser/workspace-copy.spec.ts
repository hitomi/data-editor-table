import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('copy preserves captured axes and quoted authoring values, and rejects missing members without a partial export', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-write'])
  const name = `workspace-copy-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') },
    { a: { value: 'Alpha\t"first"\nline' }, b: { value: 'Beta' } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await page.goto('/')
  await page.evaluate(async name => {
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, false)
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container, true)
  }, name)
  const grid = page.getByRole('grid', { name: 'Workspace rows' }), cells = grid.getByRole('gridcell')
  await expect(cells).toHaveCount(4)
  await cells.first().focus()
  await cells.first().press('Control+a')
  async function copy() {
    return cells.first().evaluate(cell => {
      const clipboardData = new DataTransfer(), event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true })
      cell.dispatchEvent(event)
      return { text: event.clipboardData!.getData('text/plain'), handled: event.defaultPrevented }
    })
  }
  const expected = '"Alpha\t""first""\nline"\t"Alpha\t""first""\nline"\nBeta\tBeta'
  // Exercise the trusted keyboard gesture and read its result through a real
  // paste into an ordinary textarea, without granting clipboard-read permission.
  await cells.first().press('Control+c')
  await expect(page.getByRole('status')).toHaveText('Selection copied.')
  await page.evaluate(() => { const input = document.createElement('textarea'); input.setAttribute('aria-label', 'Clipboard destination'); document.body.append(input) })
  const destination = page.getByRole('textbox', { name: 'Clipboard destination', exact: true })
  await destination.focus()
  await destination.press('Control+v')
  await expect(destination).toHaveValue(expected)
  await destination.evaluate(element => element.remove())
  await page.evaluate(() => {
    const original = navigator.clipboard.writeText
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: original })
      throw new DOMException('Clipboard access denied', 'NotAllowedError')
    } })
  })
  await cells.first().press('Control+c')
  await expect(page.getByRole('alert')).toHaveText('Could not copy the selection. Check clipboard access and selected cells, then try again.')
  await expect(page.getByRole('status')).toHaveCount(0)
  await cells.first().press('Control+c')
  await expect(page.getByRole('status')).toHaveText('Selection copied.')
  expect(await copy()).toEqual({ text: expected, handled: true })
  await page.evaluate(async () => (await import('/src/test-fixtures/workspace-grid.tsx')).filterWorkspaceGrid('Beta'))
  await expect(cells).toHaveCount(2)
  expect(await copy()).toEqual({ text: expected, handled: true })
  source.external({ b: { value: 'Beta' } })
  await page.evaluate(async () => (await import('/src/test-fixtures/workspace-grid.tsx')).refreshWorkspaceGrid())
  expect(await copy()).toEqual({ text: '', handled: true })
  await expect(page.getByRole('alert')).toHaveText('Could not copy the selection. Check clipboard access and selected cells, then try again.')
  await cells.first().click()
  expect(await copy()).toEqual({ text: 'Beta', handled: true })
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(source.writes).toBe(0)
})

test('copied quoted text passes through retained paste, authoritative save and reload', async ({ page, context }) => {
  const name = `workspace-copy-save-${crypto.randomUUID()}`, value = 'Alpha\t"first"\nline'
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') },
    { a: { value, hidden: 1 }, b: { value: 'Destination', hidden: 2 } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  async function mount(restore: boolean) {
    await page.evaluate(async ({ name, restore }) => {
      await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
      const container = document.createElement('div'); document.body.append(container)
      ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
    }, { name, restore })
  }
  await page.goto('/')
  await mount(false)
  const cells = page.getByRole('grid', { name: 'Workspace rows' }).getByRole('gridcell')
  await expect(cells).toHaveCount(2)
  await cells.first().click()
  const text = await cells.first().evaluate(cell => {
    const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    cell.dispatchEvent(event)
    return event.clipboardData!.getData('text/plain')
  })
  expect(text).toBe('"Alpha\t""first""\nline"')
  await cells.last().click()
  await cells.last().evaluate((cell, text) => {
    const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    event.clipboardData!.setData('text/plain', text)
    cell.dispatchEvent(event)
  }, text)
  await expect(cells.last()).toHaveText(value)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => source.writes).toBe(1)
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value, hidden: 1 }, { value, hidden: 2 }])
  await page.reload()
  await mount(true)
  await expect(cells).toHaveText([value, value])
})
