import { expect, test } from './test.js'

for (const [route, caption] of [
  ['/', 'Quick-start products'],
  ['/#/playground', 'Inventory items'],
  ['/#/multi-image-import', 'Image import rows'],
  ['/#/cross-grid-drag', 'Left inventory'],
]) {
  test(`${caption} keeps actions compact and the grid visible at desktop widths`, async ({ page }) => {
    await page.goto(route!)
    const grid = page.getByRole('grid', { name: caption, exact: true })
    await expect(grid).toBeVisible()
    const workspace = page.locator('.business-grid__workspace').filter({ has: grid })
    const paste = workspace.getByRole('button', { name: 'Paste into selection', exact: true })
    for (const width of [1440, 1920, 2560, 3840]) {
      await page.setViewportSize({ width, height: 1000 })
      const idleEditor = workspace.getByRole('button', { name: 'Edit value', exact: true })
      const actions = workspace.locator('.business-grid__workspace-actions')
      await expect(actions.getByRole('button', { name: 'Edit value', exact: true })).toBeVisible()
      const editorBox = (await idleEditor.boundingBox())!, actionBox = (await actions.boundingBox())!
      expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(actionBox.y + actionBox.height + 1)
      await expect(workspace.locator('.business-grid__workspace-editor')).toBeHidden()
      const gridBox = (await grid.boundingBox())!
      const pasteBox = (await paste.boundingBox())!
      if (route !== '/') {
        const minimumWidth = route === '/#/playground' ? 1270 : route === '/#/cross-grid-drag' ? 788 : 612
        const viewport = workspace.locator('.business-grid__workspace-viewport')
        await expect.poll(async () => Math.abs((await grid.boundingBox())!.width - Math.max(minimumWidth,
          await viewport.evaluate(element => element.clientWidth)))).toBeLessThan(2)
      }
      // A full-width action per row previously pushed the actual grid down the page.
      expect(pasteBox.width).toBeLessThan(gridBox.width / 2)
      expect(gridBox.y).toBeLessThan(450)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await paste.evaluate(element => parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThan(0)
      const rows = grid.getByRole('row')
      expect(Math.abs((await rows.nth(1).boundingBox())!.height - 36)).toBeLessThan(1)
      expect(Math.abs((await rows.first().boundingBox())!.height - 40)).toBeLessThan(1)
      const heading = grid.getByRole('columnheader').getByRole('button').first()
      await expect(heading).toHaveCSS('border-top-width', '0px')
      if (route === '/#/cross-grid-drag') {
        const controls = grid.getByRole('rowheader').filter({ hasText: 'Protected' })
        const header = (await controls.boundingBox())!
        const label = (await controls.getByText('Protected', { exact: true }).boundingBox())!
        expect(header.height).toBeLessThan(60)
        expect(label.height).toBeLessThan(24)
      }
      await page.screenshot({ path: `/tmp/grid-layout-${caption!.toLowerCase().replaceAll(' ', '-')}-${test.info().project.name}-${width}.png` })
      if (route === '/') {
        const description = (await page.locator('.quick-start-code-panel > p').boundingBox())!
        const code = (await page.locator('.quick-start-code-panel pre').boundingBox())!
        expect(code.y - description.y - description.height).toBeLessThan(40)
      }
    }
  })
}

test('inventory flex columns fill wide viewports and resize from their displayed width', async ({ page }) => {
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items', exact: true })
  await expect(grid).toBeVisible()
  const name = grid.getByRole('columnheader', { name: 'Name', exact: true })
  const quantity = grid.getByRole('columnheader', { name: 'Quantity', exact: true })
  const image = grid.getByRole('columnheader', { name: 'Image', exact: true })
  const viewport = page.locator('.business-grid__workspace-viewport').filter({ has: grid })
  for (const width of [1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(async () => {
      const available = await viewport.evaluate(element => element.clientWidth)
      return Math.abs((await grid.boundingBox())!.width - Math.max(1270, available))
    }).toBeLessThan(2)
    expect(Math.abs((await image.boundingBox())!.width - 116)).toBeLessThan(2)
    const nameGrowth = (await name.boundingBox())!.width - 260
    const quantityGrowth = (await quantity.boundingBox())!.width - 150
    expect(Math.abs(nameGrowth - 2 * quantityGrowth)).toBeLessThan(2)
  }
  const resizer = grid.getByRole('separator', { name: 'Resize Name', exact: true })
  const initial = (await name.boundingBox())!.width
  const handle = (await resizer.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => Math.abs((await name.boundingBox())!.width - initial - 80)).toBeLessThan(2)
  await resizer.press('ArrowLeft')
  await expect.poll(async () => Math.abs((await name.boundingBox())!.width - initial - 70)).toBeLessThan(2)
  await page.setViewportSize({ width: 1920, height: 1000 })
  await expect.poll(async () => Math.abs((await name.boundingBox())!.width - initial - 70)).toBeLessThan(2)
  const cell = grid.getByRole('gridcell', { name: 'Amber poster', exact: true })
  await cell.dblclick()
  const input = page.getByRole('textbox', { name: 'Name', exact: true })
  await expect(input).toBeFocused()
  await input.fill('Resized inventory item')
  await input.press('Enter')
  await expect(grid.getByRole('gridcell', { name: 'Resized inventory item', exact: true })).toBeVisible()
  await expect(page.getByText('1 saves', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('gridcell', { name: 'Resized inventory item', exact: true })).toBeVisible()
})
