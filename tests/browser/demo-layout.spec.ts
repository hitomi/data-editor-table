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
      const gridBox = (await grid.boundingBox())!
      const pasteBox = (await paste.boundingBox())!
      // A full-width action per row previously pushed the actual grid down the page.
      expect(pasteBox.width).toBeLessThan(gridBox.width / 2)
      expect(gridBox.y).toBeLessThan(450)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await paste.evaluate(element => parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThan(0)
      const heading = grid.getByRole('columnheader').getByRole('button').first()
      await expect(heading).toHaveCSS('border-top-width', '0px')
      if (route === '/') {
        const description = (await page.locator('.quick-start-code-panel > p').boundingBox())!
        const code = (await page.locator('.quick-start-code-panel pre').boundingBox())!
        expect(code.y - description.y - description.height).toBeLessThan(40)
      }
    }
  })
}
