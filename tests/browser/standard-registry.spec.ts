import { expect, test, type Page } from './test.js'

test('quick start uses Workspace value codecs and retains saved values across reload and desktop widths', async ({ page }) => {
  const consoleErrors = observeBrowserErrors(page)

  await page.goto('/#/')
  const grid = page.getByRole('grid', { name: 'Quick-start products' })
  await expect(grid).toBeVisible()
  await expect(page.getByTestId('quick-start-code')).not.toContainText('registry=')
  await expect(page.getByTestId('quick-start-code')).not.toContainText('StandardGridCellTypeSchema')

  const firstRow = grid.getByRole('row').filter({ hasText: 'Amber poster' })
  await firstRow.getByRole('gridcell', { name: 'True', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.getByRole('combobox', { name: 'Active', exact: true }).selectOption('false')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(firstRow.getByRole('gridcell', { name: 'False', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await page.reload()
  await expect(firstRow.getByRole('gridcell', { name: 'False', exact: true })).toBeVisible()
  await firstRow.getByRole('gridcell', { name: '12', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.getByRole('textbox', { name: 'Quantity', exact: true }).fill('-1')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Enter a non-negative whole number.')
  await page.reload()
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Quantity', exact: true })).toHaveValue('-1')
  await page.getByRole('textbox', { name: 'Quantity', exact: true }).fill('25')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect(firstRow.getByRole('gridcell', { name: '25', exact: true })).toBeVisible()

  for (const width of [1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect(grid).toBeVisible()
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  }

  expect(consoleErrors).toEqual([])
})

test('column-scoped select catalogs edit independently', async ({ page }) => {
  const errors = observeBrowserErrors(page)
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  const row = grid.getByRole('row').filter({ hasText: 'Amber poster' })
  await row.getByRole('gridcell', { name: 'Ready', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  const status = page.getByRole('combobox', { name: 'Status', exact: true })
  await expect(status.getByRole('option', { name: 'Draft', exact: true })).toHaveCount(1)
  await expect(status.getByRole('option', { name: 'Featured', exact: true })).toHaveCount(0)
  await expect(status.getByRole('option', { name: 'Archived', exact: true })).toBeDisabled()
  await status.selectOption({ label: 'Draft' })
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(row.getByRole('gridcell', { name: 'Draft', exact: true })).toBeVisible()
  await row.getByRole('gridcell', { name: 'Featured, Seasonal, Wholesale', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  const tags = page.getByRole('listbox', { name: 'Tags', exact: true })
  await expect(tags.getByRole('option', { name: 'Featured', exact: true })).toHaveCount(1)
  await expect(tags.getByRole('option', { name: 'Draft', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Discard input', exact: true }).click()
  expect(errors).toEqual([])
})

test('cell editors expose their column label and validation error', async ({ page }) => {
  const errors = observeBrowserErrors(page)
  await page.goto('/#/playground')
  const row = page.getByRole('grid', { name: 'Inventory items' }).getByRole('row').filter({ hasText: 'Amber poster' })
  await row.getByRole('gridcell', { name: '12', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Quantity', exact: true })
  await expect(editor).toBeFocused()
  await editor.fill('not-a-number')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(editor).toHaveAttribute('aria-invalid', 'true')
  const error = page.getByRole('alert')
  await expect(error).toHaveText('Enter a non-negative number.')
  await expect(editor).toHaveAttribute('aria-describedby', (await error.getAttribute('id'))!)
  await editor.press('Escape')
  await expect(editor).toHaveValue('not-a-number')
  expect(errors).toEqual([])
})

test('grid selection and filter input are keyboard operable without dropping input on Escape', async ({ page }) => {
  const errors = observeBrowserErrors(page)
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid).toHaveAttribute('aria-multiselectable', 'true')
  const firstCell = grid.getByRole('gridcell').first()
  await firstCell.focus()
  await expect(firstCell).toBeFocused()
  expect(await firstCell.evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0)
  await firstCell.press('Control+a')
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(await grid.getByRole('gridcell').count())
  await firstCell.press('Shift+Space')
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(7)
  await firstCell.press('Control+Space')
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(36)
  await page.getByRole('button', { name: 'Filter values', exact: true }).press('Enter')
  const input = page.getByRole('textbox', { name: 'Name filter', exact: true })
  await input.fill('Amber')
  await input.press('Escape')
  await expect(input).toHaveValue('Amber')
  await expect(page.getByRole('button', { name: 'Apply filter', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Apply filter', exact: true }).press('Enter')
  await expect(grid.getByRole('row')).toHaveCount(2)
  expect(errors).toEqual([])
})

test('background saves do not reset focused workspace controls', async ({ page }) => {
  const errors = observeBrowserErrors(page)
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await grid.getByRole('gridcell', { name: 'Amber poster', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Focus remains stable')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  const sort = page.getByRole('button', { name: 'Sort Name', exact: true })
  await sort.focus()
  await expect(page.getByText('1 saves', { exact: true })).toBeVisible()
  await expect(sort).toBeFocused()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect(grid.getByRole('gridcell', { name: 'Focus remains stable', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('image cells use business alt text instead of their data URL', async ({ page }) => {
  const consoleErrors = observeBrowserErrors(page)
  await page.goto('/#/multi-image-import')
  await page.getByLabel('Choose images to import').setInputFiles({
    name: 'avatar.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="blue"/></svg>',
    ),
  })
  await page.getByRole('checkbox', { name: 'Confirm these replacements and new rows' }).check()
  await page.getByRole('button', { name: 'Apply image import', exact: true }).click()
  const imageCell = page.getByRole('grid', { name: 'Image import rows' }).getByRole('gridcell').first()
  await expect(imageCell.getByRole('img', { name: 'avatar' })).toBeVisible()
  expect(await imageCell.textContent()).not.toContain('data:image')
  expect(consoleErrors).toEqual([])
})

function observeBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => { errors.push(error.message) })
  return errors
}
