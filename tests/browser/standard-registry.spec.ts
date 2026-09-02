import { expect, test, type Page } from '@playwright/test'

test('quick start uses the default registry across desktop widths', async ({ page }) => {
  const consoleErrors = observeBrowserErrors(page)

  await page.goto('/#/')
  const grid = page.getByRole('grid', { name: 'Quick-start products' })
  await expect(grid).toBeVisible()
  await expect(page.getByTestId('quick-start-code')).not.toContainText('registry=')
  await expect(page.getByTestId('quick-start-code')).not.toContainText('StandardGridCellTypeSchema')

  const activeCell = grid.locator('[role="gridcell"][data-column-key="active"][data-grid-row-index="0"]')
  const checkbox = activeCell.getByRole('checkbox', { name: 'True' })
  await expect(checkbox).toBeChecked()
  await checkbox.click()
  await expect(activeCell.getByRole('checkbox', { name: 'False' })).not.toBeChecked()

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
  const consoleErrors = observeBrowserErrors(page)

  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid).toBeVisible()

  const statusCell = grid.locator('[role="gridcell"][data-column-key="status"][data-grid-row-index="0"]')
  await statusCell.dblclick()
  const statusOptions = page.getByRole('listbox', { name: 'Choose value' })
  await expect(statusOptions).toBeVisible()
  await expect(statusOptions.getByRole('option', { name: 'Draft' })).toBeVisible()
  await expect(statusOptions.getByRole('option', { name: 'Featured' })).toHaveCount(0)
  await statusOptions.getByRole('option', { name: 'Draft' }).click()
  await expect(statusCell).toContainText('Draft')

  const tagsCell = grid.locator('[role="gridcell"][data-column-key="tags"][data-grid-row-index="0"]')
  await tagsCell.dblclick()
  const tagsDialog = page.getByRole('group', { name: 'Choose values' })
  await expect(tagsDialog.getByLabel('Featured')).toBeVisible()
  await expect(tagsDialog.getByLabel('Draft')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()

  expect(consoleErrors).toEqual([])
})

test('cell editors expose their column label and validation error', async ({ page }) => {
  const consoleErrors = observeBrowserErrors(page)
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  const quantityCell = grid.locator(
    '[role="gridcell"][data-column-key="quantity"][data-grid-row-index="0"]',
  )
  await quantityCell.dblclick()

  const editor = page.getByRole('textbox', { name: 'Quantity' })
  await expect(editor).toBeFocused()
  await editor.fill('not-a-number')
  await editor.press('Enter')
  await expect(editor).toHaveAttribute('aria-invalid', 'true')

  const error = page.locator('[data-grid-editor="true"]').getByRole('alert')
  await expect(error).toBeVisible()
  const errorId = await error.getAttribute('id')
  expect(errorId).toBeTruthy()
  await expect(editor).toHaveAttribute('aria-describedby', errorId!)
  await editor.press('Escape')
  expect(consoleErrors).toEqual([])
})

test('grid selection and dialogs are fully keyboard operable', async ({ page }) => {
  const consoleErrors = observeBrowserErrors(page)
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid).toHaveAttribute('aria-multiselectable', 'true')

  await grid.focus()
  await expect(grid).toBeFocused()
  const focusOutlineWidth = await grid.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).outlineWidth),
  )
  expect(focusOutlineWidth).toBeGreaterThan(0)

  const firstCell = grid.locator('[role="gridcell"][data-grid-row-index="0"]').first()
  await firstCell.click()
  const allCells = grid.locator('[role="gridcell"]')
  await page.keyboard.press('Control+a')
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(
    await allCells.count(),
  )

  await firstCell.click()
  await page.keyboard.press('Shift+Space')
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(
    await grid.locator('[role="gridcell"][data-grid-row-index="0"]').count(),
  )

  await firstCell.click()
  await page.keyboard.press('Control+Space')
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(
    (await grid.locator('[role="row"]').count()) - 1,
  )

  const filterButton = grid.getByRole('button', { name: 'Filter Name' })
  await filterButton.click()
  const dialog = page.getByRole('dialog', { name: 'Filter Name' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(filterButton).toBeFocused()

  const nameCell = grid.locator(
    '[role="gridcell"][data-column-key="name"][data-grid-row-index="0"]',
  )
  await nameCell.click()
  await page.keyboard.press('Control+Space')
  const bulkButton = page.getByRole('button', { name: 'Edit selection…' })
  await bulkButton.click()
  const bulkDialog = page.getByRole('dialog', {
    name: /Edit \d+ selected cells/,
  })
  await expect(bulkDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bulkDialog).toHaveCount(0)
  await expect(bulkButton).toBeFocused()
  expect(consoleErrors).toEqual([])
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
  await expect(page.locator('.image-import-status')).toContainText('Imported 1 image')

  const imageCell = page.getByRole('grid', { name: 'Image import rows' }).locator(
    '[role="gridcell"][data-column-key="image"][data-grid-row-index="0"]',
  )
  await expect(imageCell).toHaveAttribute('aria-label', /avatar/)
  expect(await imageCell.getAttribute('aria-label')).not.toContain('data:image')
  await expect(imageCell.getByRole('img', { name: 'avatar' })).toBeVisible()
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
