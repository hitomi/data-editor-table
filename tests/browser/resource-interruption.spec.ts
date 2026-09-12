import { expect, interruptResourceWork, test, type Page } from './test.js'

async function authority(page: Page) {
  return page.evaluate(async () => {
    const { openDemoSource } = await import('/src/demo-source.ts')
    const scope = { sourceId: 'image-import-authority-v1', id: 'images', epoch: 'v1' }
    const snapshot = await (await openDemoSource(scope, [], () => {}, true)).readAtLeast(scope, [])
    return { version: snapshot.version, rows: snapshot.rows, order: snapshot.order }
  })
}

test('reload during task cancellation preserves the already durable original file', async ({ page }) => {
  await page.goto('/#/multi-image-import')
  await expect(page.getByRole('grid', { name: 'Image import rows' }).getByRole('row')).toHaveCount(4)
  const before = await authority(page)
  const body = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'
  await page.locator('main').evaluate((main, body) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File([body], 'interrupted.svg', { type: 'image/svg+xml' }))
    main.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
  }, body)
  await expect(page.getByRole('region', { name: 'Review image import' }).getByRole('img', { name: 'interrupted', exact: true })).toBeVisible()
  // Dispatch and navigation deliberately share a browser turn. Cancellation
  // has no completion receipt yet; either durable task disposition may win.
  await interruptResourceWork(page, () => page.getByRole('button', { name: 'Cancel task', exact: true }).evaluate(button => {
    ;(button as HTMLButtonElement).click()
    location.reload()
  }))
  const original = page.getByRole('link', { name: 'Download interrupted.svg', exact: true })
  await expect(original).toHaveAttribute('href', `data:image/svg+xml;base64,${Buffer.from(body).toString('base64')}`)
  await expect(original).toHaveAttribute('download', 'interrupted.svg')
  await expect(page.getByRole('grid', { name: 'Image import rows' }).getByRole('img')).toHaveCount(0)
  expect(await authority(page)).toEqual(before)
})
