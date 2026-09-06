import { expect, test } from '@playwright/test'

for (const scenario of ['intermediate', 'later', 'reload-failure'] as const) {
  test(`saved authority survives ${scenario}, delayed cache reads and reopening`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto('/')
    await page.evaluate(async (scenario) => {
      document.body.replaceChildren()
      const container = document.createElement('div')
      document.body.append(container)
      const fixture = await import('/src/test-fixtures/persistence-consistency.tsx')
      fixture.mountPersistenceConsistencyFixture(container, scenario)
    }, scenario)
    const grid = page.getByRole('grid', { name: 'Persistence consistency' })
    await grid.getByRole('gridcell', { name: 'Initial', exact: true }).click()
    await page.keyboard.press('Enter')
    const editor = grid.getByRole('textbox', { name: 'Name', exact: true })
    await editor.fill(scenario === 'reload-failure' ? 'Submitted' : '  Submitted  ')
    await editor.press('Enter')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => diagnostics(page).then((value) => value.writes)).toBe(1)
    await page.getByRole('button', { name: 'Deliver save response' }).click()

    if (scenario === 'reload-failure') {
      await expect(page.getByText('Authority read unavailable', { exact: true })).toBeVisible()
      await expect(grid.getByRole('gridcell', { name: /^Submitted/ })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Restore reads' }).click()
      await page.getByRole('button', { name: 'Refresh data', exact: true }).click()
      await expect(page.getByText('Authority read unavailable', { exact: true })).toHaveCount(0)
    }
    const expected = scenario === 'later' ? 'Later server edit' : 'Submitted'
    await expect(grid.getByRole('gridcell', { name: expected, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Deliver old cache read' }).click()
    expect((await diagnostics(page)).cacheAccepted).toBe(false)
    await expect(grid.getByRole('gridcell', { name: expected, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Reopen table' }).click()
    await grid.getByRole('gridcell', { name: expected, exact: true }).click()
    await page.keyboard.press('Enter')
    await expect(editor).toHaveValue(expected)
    await editor.press('Escape')
    expect((await diagnostics(page)).writes).toBe(1)
    expect(errors).toEqual([])
  })
}

async function diagnostics(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const fixture = await import('/src/test-fixtures/persistence-consistency.tsx')
    return fixture.persistenceConsistencyDiagnostics()
  })
}
