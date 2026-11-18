import { expect, test } from '@playwright/test'

for (const replacement of [false, true]) {
  test(`a delayed editor callback preserves a later edit on ${replacement ? 'a replacement row' : 'the same row'}`, async ({ page }) => {
    await page.goto('/')
    const savedName = await page.evaluateHandle(async () => {
      const fixture = await import('/src/test-fixtures/editor-target.tsx')
      const container = document.createElement('div')
      document.body.replaceChildren(container)
      return fixture.mountEditorTargetFixture(container)
    })
    const grid = page.getByRole('grid', { name: 'Editor target' })
    const editor = grid.getByRole('textbox', { name: 'Name', exact: true })
    await grid.getByRole('gridcell', { name: 'Original', exact: true }).click()
    await page.keyboard.press('Enter')
    await expect(editor).toHaveValue('Original')
    await editor.press('Escape')
    if (replacement) await page.getByRole('button', { name: 'Replace row' }).click()
    await grid.getByRole('gridcell', { name: replacement ? 'Replacement' : 'Original', exact: true }).click()
    if (!await editor.isVisible()) await page.keyboard.press('F2')
    await editor.fill('Keep the second edit')
    await page.getByRole('button', { name: 'Finish first edit' }).evaluate(button => button.click())
    await expect(editor).toHaveValue('Keep the second edit')
    await editor.press('Enter')
    const save = page.getByRole('button', { name: 'Save changes', exact: true })
    await save.click()
    await expect.poll(() => savedName.evaluate(read => read())).toBe('Keep the second edit')
    await expect(save).toBeDisabled()
    await expect(grid.getByRole('gridcell', { name: 'Keep the second edit', exact: true })).toBeVisible()
  })
}
