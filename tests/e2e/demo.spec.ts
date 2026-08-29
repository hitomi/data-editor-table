import { expect, test } from '@playwright/test'

test('demo exposes draft, patch, auto-save, sorting, and the image type renderer', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')

  await expect(page.getByRole('grid', { name: 'Demo dataset' })).toBeVisible()
  const nameCell = page.getByRole('gridcell', { name: 'Amber poster', exact: true })
  await nameCell.dblclick()
  const editor = page.locator('.rdg-text-editor')
  await editor.fill('Amber poster revised')
  await editor.press('Enter')

  await expect(page.getByText('Patch preview').locator('..').getByText('Amber poster revised')).toBeVisible()
  await expect(page.getByText('Dirty').locator('..').getByText('Amber poster')).toBeVisible()
  await expect(page.getByTestId('save-count')).toHaveText('1 saves', { timeout: 3_000 })
  await expect(page.getByText('Authoritative JSON').locator('..').getByText('Amber poster revised')).toBeVisible()
  await expect(page.getByText('Dirty').locator('..').locator('pre')).toHaveText('{}')

  await page.getByRole('columnheader', { name: 'Name' }).click()
  await expect(page.getByRole('gridcell', { name: 'Amber poster revised', exact: true })).toBeVisible()

  const imageInput = page.locator('input[type="file"]').first()
  await imageInput.setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwL3WQAAAABJRU5ErkJggg==', 'base64') })
  await expect(page.getByText('Patch preview').locator('..').locator('pre')).toContainText('data:image/png;base64')
  await expect(page.getByTestId('save-count')).toHaveText('2 saves', { timeout: 3_000 })
  expect(errors).toEqual([])
})
