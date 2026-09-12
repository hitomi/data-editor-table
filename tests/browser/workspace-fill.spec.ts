import { expect, test, type Page } from './test.js'

async function authority(page: Page) {
  return page.evaluate(async () => {
    const { openDemoSource } = await import('/src/demo-source.ts')
    const scope = { sourceId: 'playground-inventory-v1', id: 'inventory', epoch: 'v1' }
    const snapshot = await (await openDemoSource(scope, [], () => {}, true)).readAtLeast(scope, [])
    return { scope: snapshot.scope, version: snapshot.version, rows: snapshot.rows, order: snapshot.order }
  })
}
async function setup(page: Page) {
  await page.goto('/#/playground')
  const grid = page.getByRole('grid', { name: 'Inventory items' })
  await expect(grid.getByRole('row')).toHaveCount(37)
  await page.getByRole('switch', { name: 'Auto-save', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Auto-save', exact: true })).not.toBeChecked()
  return grid
}
async function save(page: Page, count: number) {
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText(`${count} saves`, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
}

test('native fill drag repeats captured values, survives sorting and reload, saves full documents and supports saved undo', async ({ page }) => {
  const grid = await setup(page), original = await authority(page)
  const amber = grid.getByRole('gridcell', { name: 'Amber poster', exact: true })
  const blue = grid.getByRole('gridcell', { name: 'Blue card', exact: true })
  await amber.click(); await blue.click({ modifiers: ['Shift'] })
  // The corner is an empty visual drag handle; keyboard users have Fill selection.
  await blue.locator('.business-grid__fill-handle').dragTo(grid.getByRole('gridcell', { name: 'Dune notebook', exact: true }))
  const input = page.getByRole('textbox', { name: 'Edit 4 selected fields', exact: true })
  await expect(input).toHaveValue('Amber poster\nBlue card\nAmber poster\nBlue card')
  expect(await authority(page)).toEqual(original)
  await page.getByRole('button', { name: 'Sort Name', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  await page.reload(); await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(input).toHaveValue('Amber poster\nBlue card\nAmber poster\nBlue card')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(grid.getByRole('gridcell', { name: 'Amber poster', exact: true })).toHaveCount(2)
  await expect(grid.getByRole('gridcell', { name: 'Blue card', exact: true })).toHaveCount(2)
  await save(page, 1)
  const stored = await authority(page)
  expect(stored.rows).toEqual(original.rows.map(row => ({ ...row, document: row.document.id === 'row-3' ? { ...row.document, name: 'Amber poster' }
    : row.document.id === 'row-4' ? { ...row.document, name: 'Blue card' } : row.document })))
  await page.reload()
  await expect(grid.getByRole('gridcell', { name: 'Amber poster', exact: true })).toHaveCount(2)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await save(page, 2)
  expect((await authority(page)).rows).toEqual(original.rows)
  for (const width of [1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test('keyboard fill supports cancellation and review, and a foreign drag cannot use the active source', async ({ page }) => {
  const grid = await setup(page), blue = grid.getByRole('gridcell', { name: 'Blue card', exact: true })
  await blue.click(); await page.getByRole('button', { name: 'Fill selection', exact: true }).click()
  await expect(blue).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Fill selection', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Fill selection', exact: true }).click()
  await blue.evaluate(element => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData('application/x-data-editor-fill', 'foreign-token')
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toHaveCount(0)
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  const input = page.getByRole('textbox', { name: 'Edit 3 selected fields', exact: true })
  await expect(input).toHaveValue('Blue card\nBlue card\nBlue card')
  await expect(grid.getByRole('gridcell', { name: 'Dune notebook', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await page.getByRole('button', { name: 'Fail next save', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Changes were not saved.')
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await page.reload()
  await expect(grid.getByRole('gridcell', { name: 'Blue card', exact: true })).toHaveCount(3)
  await save(page, 1)
  await page.reload()
  await expect(grid.getByRole('gridcell', { name: 'Blue card', exact: true })).toHaveCount(3)
})

test('an expired fill retains the original matrix in ingress instead of silently recapturing remote values', async ({ page }) => {
  const grid = await setup(page)
  await grid.getByRole('gridcell', { name: 'Amber poster', exact: true }).click()
  await page.getByRole('button', { name: 'Fill selection', exact: true }).click()
  await page.getByRole('button', { name: 'Simulate remote change', exact: true }).click()
  await expect(grid.getByText(/^Remote amber/)).toBeVisible()
  const before = await authority(page)
  await grid.getByRole('gridcell', { name: 'Blue card', exact: true }).click()
  const retained = page.getByRole('textbox', { name: 'Retained input 1', exact: true })
  await expect(retained).toBeVisible()
  const raw = JSON.parse(await retained.inputValue())
  expect(raw).toMatchObject({ format: 'workspace-matrix:1', text: 'Amber poster\nAmber poster' })
  expect(raw.layout.rows).toHaveLength(2)
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toHaveCount(0)
  expect(await authority(page)).toEqual(before)
  await page.reload()
  await expect(retained).toHaveValue(JSON.stringify(raw))
  expect(await authority(page)).toEqual(before)
})

test('custom quantity series stays reviewable across reload and saves only the complete generated matrix', async ({ page }) => {
  const grid = await setup(page), original = await authority(page)
  const amber = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Amber poster', exact: true }) })
  const dune = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Dune notebook', exact: true }) })
  const source = amber.getByRole('gridcell', { name: '12', exact: true })
  await source.click()
  await source.locator('.business-grid__fill-handle').dragTo(dune.getByRole('gridcell', { name: '18', exact: true }))
  const input = page.getByRole('textbox', { name: 'Edit 4 selected fields', exact: true })
  await expect(input).toHaveValue('12\n13\n14\n15')
  expect(await authority(page)).toEqual(original)
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  await page.reload()
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(input).toHaveValue('12\n13\n14\n15')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await save(page, 1)
  const expected = original.rows.map(row => {
    const index = ['row-2', 'row-3', 'row-4'].indexOf(String(row.document.id))
    return index < 0 ? row : { ...row, document: { ...row.document, quantity: 13 + index } }
  })
  expect((await authority(page)).rows).toEqual(expected)
  await page.reload()
  await expect(dune.getByRole('gridcell', { name: '15', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await save(page, 2)
  expect((await authority(page)).rows).toEqual(original.rows)
})

test('incompatible custom fill rejects the whole matrix and a later valid gesture still works', async ({ page }) => {
  const grid = await setup(page), original = await authority(page)
  const name = grid.getByRole('gridcell', { name: 'Amber poster', exact: true })
  await name.click()
  await page.getByRole('button', { name: 'Fill selection', exact: true }).click()
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toHaveCount(0)
  expect(await authority(page)).toEqual(original)
  await name.click(); await page.getByRole('button', { name: 'Fill selection', exact: true }).click()
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Edit 2 selected fields', exact: true })).toHaveValue('Amber poster\nAmber poster')
  expect(await authority(page)).toEqual(original)
})

test('custom fill retains its captured series when authority changes before the destination is chosen', async ({ page }) => {
  const grid = await setup(page)
  const amber = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Amber poster', exact: true }) })
  await amber.getByRole('gridcell', { name: '12', exact: true }).click()
  await page.getByRole('button', { name: 'Fill selection', exact: true }).click()
  await page.evaluate(async () => {
    const { openDemoSource } = await import('/src/demo-source.ts')
    const scope = { sourceId: 'playground-inventory-v1', id: 'inventory', epoch: 'v1' }
    const source = await openDemoSource(scope, [], () => {}, true), snapshot = await source.readAtLeast(scope, [])
    const row = snapshot.rows.find(row => row.document.id === 'row-1')!
    await source.changeDocument(row.identity, document => ({ ...document, quantity: 99 }))
  })
  await page.getByRole('button', { name: 'Refresh rows', exact: true }).click()
  await expect(amber.getByRole('gridcell', { name: '99', exact: true })).toBeVisible()
  const actual = await authority(page)
  await grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Blue card', exact: true }) })
    .getByRole('gridcell', { name: '14', exact: true }).click()
  const retained = page.getByRole('textbox', { name: 'Retained input 1', exact: true })
  await expect(retained).toBeVisible()
  const raw = JSON.parse(await retained.inputValue())
  expect(raw).toMatchObject({ format: 'workspace-matrix:1', text: '12\n13' })
  await page.reload()
  await expect(retained).toHaveValue(JSON.stringify(raw))
  expect(await authority(page)).toEqual(actual)
})

test('a changed full-document callback dependency blocks Apply and retains the generated input after reload', async ({ page }) => {
  const grid = await setup(page)
  const amber = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Amber poster', exact: true }) })
  await amber.getByRole('gridcell', { name: '12', exact: true }).click()
  await page.getByRole('button', { name: 'Fill selection', exact: true }).click()
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  const input = page.getByRole('textbox', { name: 'Edit 2 selected fields', exact: true })
  await expect(input).toHaveValue('12\n13')
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  await page.evaluate(async () => {
    const { openDemoSource } = await import('/src/demo-source.ts')
    const scope = { sourceId: 'playground-inventory-v1', id: 'inventory', epoch: 'v1' }
    const source = await openDemoSource(scope, [], () => {}, true), snapshot = await source.readAtLeast(scope, [])
    const row = snapshot.rows.find(row => row.document.id === 'row-2')!
    await source.changeDocument(row.identity, document => ({ ...document, hiddenFillContext: 'remote change' }))
  })
  await page.getByRole('button', { name: 'Refresh rows', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeDisabled()
  const actual = await authority(page)
  await page.reload()
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(input).toHaveValue('12\n13')
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeDisabled()
  expect(await authority(page)).toEqual(actual)
})

test('full-document fill dependencies survive Apply and prevent a later stale save', async ({ page }) => {
  const grid = await setup(page)
  const amber = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: 'Amber poster', exact: true }) })
  await amber.getByRole('gridcell', { name: '12', exact: true }).click()
  await page.getByRole('button', { name: 'Fill selection', exact: true }).click()
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Edit 2 selected fields', exact: true })).toHaveValue('12\n13')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled()
  await page.evaluate(async () => {
    const { openDemoSource } = await import('/src/demo-source.ts')
    const scope = { sourceId: 'playground-inventory-v1', id: 'inventory', epoch: 'v1' }
    const source = await openDemoSource(scope, [], () => {}, true), snapshot = await source.readAtLeast(scope, [])
    const row = snapshot.rows.find(row => row.document.id === 'row-2')!
    await source.changeDocument(row.identity, document => ({ ...document, hiddenFillContext: 'changed after Apply' }))
  })
  await page.getByRole('button', { name: 'Refresh rows', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  const actual = await authority(page)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  expect(await authority(page)).toEqual(actual)
})
