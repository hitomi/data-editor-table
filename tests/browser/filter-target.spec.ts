import { expect, test } from '@playwright/test'

for (const column of ['id', 'name']) {
  test(`delayed filter callbacks preserve a new session on ${column}`, async ({ page }) => {
    await page.goto('/')
    const filters = await page.evaluateHandle(async () => {
      const { mountFilterTargetFixture } = await import('/src/test-fixtures/filter-target.tsx')
      const container = document.createElement('div')
      document.body.replaceChildren(container)
      return mountFilterTargetFixture(container)
    })
    await page.getByRole('button', { name: 'Filter id', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel current filter' }).click()
    await page.getByRole('button', { name: 'Filter ' + column, exact: true }).click()
    const input = page.getByRole('textbox', { name: column, exact: true })
    await input.fill('second draft')
    await page.getByRole('button', { name: 'Finish first filter' }).click()
    await expect(input).toHaveValue('second draft')
    expect(await filters.evaluate(read => read())).toEqual([])
    await page.getByRole('button', { name: 'Apply current filter' }).click()
    expect(await filters.evaluate(read => read())).toMatchObject([{ columnKey: column, value: 'second draft' }])
  })
}
