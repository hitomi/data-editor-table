import { expect, test } from './test.js'

for (const [route, caption] of [['playground', 'Inventory items'], ['cross-grid-drag', 'Left inventory'], ['multi-image-import', 'Image import rows']]) test(`image thumbnails preserve the original sizing and native drag behavior on ${route}`, async ({ page, browserName }) => {
  await page.goto(`/#/${route}`)
  const grid = page.getByRole('grid', { name: caption, exact: true })
  const cell = grid.getByRole('gridcell').first()
  await expect(cell).toBeVisible()
  await cell.click()
  const choosing = page.waitForEvent('filechooser')
  await cell.press('Enter')
  await (await choosing).setFiles({ name: 'thumbnail.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="blue"/></svg>') })
  const thumbnail = cell.getByRole('img')
  await expect(thumbnail).toBeVisible()
  await expect(thumbnail).toHaveAttribute('draggable', 'false')
  for (const width of [1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect(thumbnail).toHaveCSS('width', '40px')
    await expect(thumbnail).toHaveCSS('height', '30px')
    await expect(thumbnail).toHaveCSS('object-fit', 'cover')
    const boxes = await cell.evaluate(node => {
      const cell = node.getBoundingClientRect(), image = node.querySelector('img')!.getBoundingClientRect()
      return { offset: Math.abs(cell.x + cell.width / 2 - image.x - image.width / 2) }
    })
    expect(boxes.offset).toBeLessThan(2)
    await page.screenshot({ path: `/tmp/image-parity-${route}-${browserName}-${width}.png` })
  }
})

test('a replacement upload wins even when the cancelled conversion finishes last', async ({ page }) => {
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid.getByRole('row')).toHaveCount(37)
  await page.getByRole('switch', { name: 'Auto-save', exact: true }).click()
  const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Amber poster', exact: true }) })
  await row.getByRole('gridcell', { name: 'No image', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.evaluate(() => {
    const read = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (blob) {
      FileReader.prototype.readAsDataURL = read
      document.documentElement.dataset.replacedUploadHeld = 'true'
      window.addEventListener('finish-replaced-upload', () => read.call(this, blob), { once: true })
    }
  })
  const chooser = page.getByLabel('Choose a file', { exact: true })
  const svg = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"/>`
  await chooser.setInputFiles({ name: 'old.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg(2)) })
  await expect(page.locator('html')).toHaveAttribute('data-replaced-upload-held', 'true')
  await expect(chooser).toBeEnabled()
  await chooser.setInputFiles({ name: 'new.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg(6)) })
  const input = page.getByRole('textbox', { name: 'Image', exact: true })
  const expected = `data:image/svg+xml;base64,${Buffer.from(svg(6)).toString('base64')}`
  await expect(row.getByRole('img')).toHaveAttribute('src', expected)
  await expect(input).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('finish-replaced-upload')))
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const opening = indexedDB.open('playground-image-tasks-v1')
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction('executions', 'readonly'), read = tx.objectStore('executions').getAll()
      let complete = false
      read.onsuccess = () => { complete = read.result.length === 2 && read.result.every(record => record.outcome?.kind === 'succeeded') }
      tx.oncomplete = () => { db.close(); resolve(complete) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))).toBe(true)
  await expect(row.getByRole('img')).toHaveAttribute('src', expected)
  await expect(input).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Download old.svg', exact: true }).first()).toBeVisible()
  await expect(row.getByRole('img')).toHaveAttribute('src', expected)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('1 saves', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect(row.getByRole('img')).toHaveAttribute('src', expected)
})

for (const activation of ['double-click', 'Enter', 'F2', 'active-click']) test(`image ${activation} opens the native filtered picker and applies the selected file`, async ({ page }) => {
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid.getByRole('row')).toHaveCount(37)
  await page.getByRole('switch', { name: 'Auto-save', exact: true }).click()
  const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Amber poster', exact: true }) })
  const cell = row.getByRole('gridcell', { name: 'No image', exact: true })
  if (activation !== 'double-click') await cell.click()
  const picking = page.waitForEvent('filechooser')
  if (activation === 'double-click') await cell.dblclick()
  else if (activation === 'active-click') await cell.click()
  else await cell.press(activation)
  const chooser = await picking
  expect(await chooser.element().getAttribute('accept')).toBe('image/*')
  let selected = chooser
  if (activation === 'Enter') {
    await chooser.setFiles([])
    await expect(page.getByRole('textbox', { name: 'Image', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    const again = page.waitForEvent('filechooser')
    await cell.press('Enter')
    selected = await again
  }
  await selected.setFiles({ name: 'chosen.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>') })
  const image = row.getByRole('img', { name: 'Amber poster', exact: true })
  await expect(image).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Image', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('1 saves', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(5)
})

test('a delayed cell-drop result cannot replace or auto-apply newer editor input', async ({ page }) => {
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid.getByRole('row')).toHaveCount(37)
  await page.getByRole('switch', { name: 'Auto-save', exact: true }).click()
  await page.evaluate(() => {
    const read = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (blob) {
      FileReader.prototype.readAsDataURL = read
      document.documentElement.dataset.uploadHeld = 'true'
      window.addEventListener('release-upload', () => read.call(this, blob), { once: true })
    }
  })
  const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Blue card', exact: true }) })
  await row.getByRole('gridcell', { name: 'No image', exact: true }).evaluate(cell => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>'], 'delayed.svg', { type: 'image/svg+xml' }))
    cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })
  await expect(page.locator('html')).toHaveAttribute('data-upload-held', 'true')
  const input = page.getByRole('textbox', { name: 'Image', exact: true })
  const newer = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>').toString('base64')}`
  await input.fill(newer)
  await page.evaluate(() => window.dispatchEvent(new Event('release-upload')))
  await expect(page.getByLabel('Choose a file', { exact: true })).toBeEnabled()
  await expect(input).toHaveValue(newer)
  await expect(row.getByRole('img')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Download delayed.svg', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(row.getByRole('img')).toHaveAttribute('src', newer)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('1 saves', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect(row.getByRole('img')).toHaveAttribute('src', newer)
})

test('dropping directly on an image cell applies to that row and supports undo and save', async ({ page }) => {
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid.getByRole('row')).toHaveCount(37)
  await page.getByRole('switch', { name: 'Auto-save', exact: true }).click()
  await grid.getByRole('gridcell', { name: 'Amber poster', exact: true }).click()
  const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Blue card', exact: true }) })
  await row.getByRole('gridcell', { name: 'No image', exact: true }).evaluate(cell => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>'], 'blue.svg', { type: 'image/svg+xml' }))
    cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })
  const image = row.getByRole('img', { name: 'Blue card', exact: true })
  await expect(image).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Image', exact: true })).toHaveCount(0)
  await expect(grid.getByRole('img', { name: 'Amber poster', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(image).toHaveCount(0)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(image).toBeVisible()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('1 saves', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(3)
})

test('image editor drop recovers failed input and auto-applies a replacement before saving the rendered image', async ({ page }) => {
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid.getByRole('row')).toHaveCount(37)
  await page.getByRole('switch', { name: 'Auto-save', exact: true }).click()
  const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Amber poster', exact: true }) })
  await row.getByRole('gridcell', { name: 'No image', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Image', exact: true })
  const drop = page.getByRole('group', { name: 'Drop a file here', exact: true })
  await expect(page.getByLabel('Choose a file', { exact: true })).toBeEnabled()
  const send = (name: string, type: string, text: string) => drop.evaluate((element, file) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File([file.text], file.name, { type: file.type }))
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  }, { name, type, text })
  await send('notes.txt', 'text/plain', 'Retain this rejected file')
  await expect(page.getByRole('alert').filter({ hasText: 'The file result could not be applied.' })).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(page.getByRole('link', { name: 'Download notes.txt', exact: true }).first()).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(input).toHaveValue('')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>'
  const expected = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  await send('photo.svg', 'image/svg+xml', svg)
  await expect(input).toHaveCount(0)
  const image = row.getByRole('img', { name: 'Amber poster', exact: true })
  await expect(image).toHaveAttribute('src', expected)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('1 saves', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect(image).toHaveAttribute('src', expected)
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(2)
})

for (const entry of ['image drop', 'filter'] as const) test(`a ${entry} opened while save settings are committing keeps its input`, async ({ page }) => {
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid.getByRole('row')).toHaveCount(37)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      const request = Reflect.apply(put, this, args) as IDBRequest
      if (this.name === 'records' && (args[0] as { event?: { kind?: string } }).event?.kind === 'save-schedule-configured') {
        IDBObjectStore.prototype.put = put
        request.addEventListener('success', event => {
          event.stopImmediatePropagation()
          document.documentElement.dataset.scheduleHeld = 'true'
          window.addEventListener('release-schedule', () => request.onsuccess?.call(request, new Event('success')), { once: true })
        }, { once: true })
      }
      return request
    }
  })
  await page.getByRole('switch', { name: 'Auto-save', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-schedule-held', 'true')
  const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Blue card', exact: true }) })
  if (entry === 'filter') await grid.getByRole('button', { name: 'Filter Name', exact: true }).click()
  else await row.getByRole('gridcell', { name: 'No image', exact: true }).evaluate(cell => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>'], 'during-settings.svg', { type: 'image/svg+xml' }))
    cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })
  await page.evaluate(() => window.dispatchEvent(new Event('release-schedule')))
  if (entry === 'filter') {
    const dialog = page.getByRole('dialog', { name: 'Filter Name', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Name filter', exact: true }).fill('Blue')
    await dialog.getByRole('button', { name: 'Apply filter', exact: true }).click()
    await expect(grid.getByRole('row')).toHaveCount(2)
    await page.reload()
    await expect(grid.getByRole('row')).toHaveCount(2)
    await expect(row).toBeVisible()
    return
  }
  await expect(row.getByRole('img')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('1 saves', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect(row.getByRole('img')).toBeVisible()
  expect(await row.getByRole('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(3)
})
