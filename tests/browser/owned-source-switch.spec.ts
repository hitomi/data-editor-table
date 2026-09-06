import { expect, test } from '@playwright/test'

test('owned grids keep pending work visible and switch only after it is resolved', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => { consoleErrors.push(error.message) })
  await page.goto('/')
  await page.evaluate(async () => {
    document.body.replaceChildren()
    const container = document.createElement('div')
    document.body.append(container)
    const fixture = await import('/src/test-fixtures/owned-source-switch.tsx')
    fixture.mountOwnedSourceSwitchFixture(container)
  })

  const grid = page.getByRole('grid', { name: 'Owned source switch' })
  await expect(grid.getByRole('gridcell', { name: 'Source A row' })).toBeVisible()
  await grid.getByRole('button', { name: 'Filter Name' }).click()
  await expect(page.getByRole('dialog', { name: 'Filter Name' })).toBeVisible()

  await page.getByRole('button', { name: 'Switch data source' }).evaluate(
    (button: HTMLButtonElement) => button.click(),
  )
  await expect(page.getByText(
    'Apply, save, or cancel the current table changes before opening another data set.',
  )).toBeVisible()
  await expect(grid.getByRole('gridcell', { name: 'Source A row' })).toBeVisible()
  expect(await subscriptions(page)).toEqual({ a: 1, b: 0 })

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Filter Name' })).toHaveCount(0)
  await expect(grid.getByRole('gridcell', { name: 'Source B row' })).toBeVisible()
  expect(await subscriptions(page)).toEqual({ a: 0, b: 1 })
  expect(consoleErrors).toEqual([])
})

async function subscriptions(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const fixture = await import('/src/test-fixtures/owned-source-switch.tsx')
    return fixture.ownedSourceSwitchSubscriptions()
  })
}
