import { expect, test } from '@playwright/test'

type Fixture = ReturnType<typeof import('../../demo/src/test-fixtures/save-actions').mountSaveActionsFixture>

for (const scenario of ['dispute', 'unknown'] as const) {
  test(`toolbar and host agree while save is ${scenario}`, async ({ page }) => {
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Demo pages' }).waitFor()
    await page.evaluate(async scenario => {
      const { mountSaveActionsFixture } = await import('/src/test-fixtures/save-actions.tsx')
      const container = document.createElement('div')
      document.body.replaceChildren(container)
      Object.assign(window, { saveActionsFixture: mountSaveActionsFixture(container, scenario) })
    }, scenario)
    const fixture = await page.evaluateHandle(() => (window as Window & { saveActionsFixture: Fixture }).saveActionsFixture)
    const grid = page.getByRole('grid', { name: 'Save actions' })
    const button = page.getByRole('button', { name: scenario === 'unknown' ? 'Custom save' : 'Save changes', exact: true })
    const editor = grid.getByRole('textbox', { name: 'Name' })
    if (scenario === 'unknown') await fixture.evaluate(f => f.firstWrite())
    await grid.getByRole('gridcell', { name: scenario === 'unknown' ? /^First/ : 'Initial' }).dblclick()
    await editor.fill('Keep raw input')
    if (scenario === 'dispute') {
      await expect(button).toBeEnabled()
      await fixture.evaluate(f => f.firstWrite())
    }
    await expect.poll(() => fixture.evaluate(f => f.state())).toMatchObject({
      save: false, retry: false, disputed: scenario === 'dispute', writes: 1,
      ...(scenario === 'unknown' ? { recovery: 'confirm' } : {}),
    })
    await expect(button).toBeDisabled()
    expect(await fixture.evaluate(f => f.save())).toBe('blocked')
    await expect(editor).toHaveValue('Keep raw input')
    if (scenario === 'dispute') {
      await fixture.evaluate(f => f.verify())
      await expect(button).toBeEnabled()
      expect(await fixture.evaluate(f => f.save())).toBe('confirmed')
      expect(await fixture.evaluate(f => f.state())).toMatchObject({ writes: 2, persisted: 'Keep raw input', disputed: false })
    } else {
      const confirm = page.getByRole('button', { name: 'Check original save', exact: true })
      await expect(confirm).toBeEnabled()
      await confirm.evaluate(button => button.click())
      await expect(confirm).toHaveCount(0)
      await expect(editor).toHaveValue('Keep raw input')
      await expect(button).toBeEnabled()
      expect(await fixture.evaluate(f => f.state())).toMatchObject({ writes: 1, persisted: 'First' })
    }
  })
}
