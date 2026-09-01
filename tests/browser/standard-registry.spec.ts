import { expect, test } from '@playwright/test'

test('column-scoped select catalogs edit independently', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => { consoleErrors.push(error.message) })

  await page.goto('/#/')
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
