import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('redo waits for the saved restored contribution to be confirmed across reopening', async ({ page, context }) => {
  const name = `conflict-reservation-${crypto.randomUUID()}`
  const initial = { a: { value: 'Original', hidden: 1 } }
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, initial)
  let receiptAvailable = false
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(!path.endsWith('/read') && !receiptAvailable
      ? { kind: 'unknown', issue: { code: 'pending', message: 'Receipt is not available yet' } } : result) })
  })
  const mount = async (restore: boolean) => page.evaluate(async ({ name, restore }) => {
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
  }, { name, restore })
  await page.goto('/'); await mount(false)
  const grid = page.getByRole('grid', { name: 'Workspace rows' })
  await grid.getByRole('gridcell', { name: 'Original', exact: true }).dblclick()
  const input = page.getByRole('textbox', { name: 'Edit value', exact: true })
  await input.fill('Local'); await input.press('Enter'); await expect(input).toHaveCount(0)
  source.external({ a: { value: 'Remote', hidden: 1 } })
  const refresh = page.getByRole('button', { name: 'Refresh rows', exact: true })
  await refresh.click(); await expect(refresh).toBeEnabled()
  await grid.getByRole('gridcell', { name: 'Local', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Use remote row', exact: true }).click()
  await expect(grid.getByRole('gridcell', { name: 'Remote', exact: true })).toBeVisible()
  source.external(initial)
  await refresh.click(); await expect(refresh).toBeEnabled()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(grid.getByRole('gridcell', { name: 'Local', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const check = page.getByRole('button', { name: 'Check pending results', exact: true })
  await expect(check).toBeEnabled()
  const redo = page.getByRole('button', { name: 'Redo', exact: true })
  await expect(redo).toBeDisabled()
  await page.reload(); await mount(true)
  await expect(check).toBeEnabled(); await expect(redo).toBeDisabled()
  await expect(grid.getByRole('gridcell', { name: 'Local', exact: true })).toBeVisible()
  receiptAvailable = true
  await check.click(); await expect(check).toHaveCount(0)
  await expect(redo).toBeEnabled(); await redo.click()
  await expect(grid.getByRole('gridcell', { name: 'Local', exact: true })).toBeVisible()
  expect(source.writes).toBe(1)
  expect(source.snapshot().rows[0]!.document).toEqual({ value: 'Local', hidden: 1 })
})

for (const keep of [false, true]) test(`row conflict menu resolves reviewed authority and supports undo (keep local=${keep})`, async ({ page, context }) => {
  const name = `conflict-menu-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Original', hidden: 1 } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  const mount = async (restore: boolean) => page.evaluate(async ({ name, restore }) => {
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
  }, { name, restore })
  await page.goto('/'); await mount(false)
  const grid = page.getByRole('grid', { name: 'Workspace rows' })
  await grid.getByRole('gridcell', { name: 'Original', exact: true }).dblclick()
  const input = page.getByRole('textbox', { name: 'Edit value', exact: true })
  await input.fill('Local'); await input.press('Enter'); await expect(input).toHaveCount(0)
  source.external({ a: { value: 'Remote', hidden: 2 } })
  await page.getByRole('button', { name: 'Refresh rows', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await expect(grid.getByRole('button', { name: 'Changed. Original value: Remote', exact: true })).toBeVisible()
  await grid.getByRole('gridcell', { name: 'Local', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: keep ? 'Keep local row' : 'Use remote row', exact: true }).click()
  const issues = () => page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getProjection().rows.flatMap(row => row.issues))
  await expect.poll(issues).toEqual([])
  await expect(grid.getByRole('gridcell', { name: keep ? 'Local' : 'Remote', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(async () => (await issues()).length).toBeGreaterThan(0)
  await expect(grid.getByRole('gridcell', { name: 'Local', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect.poll(issues).toEqual([])
  if (keep) {
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => source.writes).toBe(1)
    await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  } else expect(source.writes).toBe(0)
  expect(source.snapshot().rows[0]!.document).toEqual({ value: keep ? 'Local' : 'Remote', hidden: 2 })
  await page.reload(); await mount(true)
  await expect(grid.getByRole('gridcell', { name: keep ? 'Local' : 'Remote', exact: true })).toBeVisible()
  await expect.poll(issues).toEqual([])
})

for (const keep of [false, true]) test(`field conflict decision preserves a sibling from the same input across history and reload (keep local=${keep})`, async ({ page, context }) => {
  const name = `field-conflict-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Original', sibling: 0, hidden: 7 } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  const mount = async (restore: boolean) => page.evaluate(async ({ name, restore }) => {
    const fixture = await import('/src/test-fixtures/durable-workspace.ts')
    await fixture.startDurableWorkspace(name, restore)
    if (!restore) await fixture.applyCompoundFieldEdit()
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
  }, { name, restore })
  await page.goto('/'); await mount(false)
  source.external({ a: { value: 'Remote', sibling: 4, hidden: 9 } })
  const refresh = page.getByRole('button', { name: 'Refresh rows', exact: true })
  await refresh.click(); await expect(refresh).toBeEnabled()
  const grid = page.getByRole('grid', { name: 'Workspace rows' })
  await grid.getByRole('gridcell', { name: 'Local', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: keep ? 'Keep local value' : 'Use remote value', exact: true }).click()
  const value = keep ? 'Local' : 'Remote'
  const verify = async () => {
    await expect(grid.getByRole('gridcell', { name: value, exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => {
      const row = (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getProjection().rows[0]!
      return { sibling: row.preview?.sibling, conflicts: row.issues.filter(issue => issue.code === 'write-conflict').length }
    })).toEqual({ sibling: 2, conflicts: 1 })
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  }
  await verify()
  await page.reload(); await mount(true); await verify()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(grid.getByRole('gridcell', { name: 'Local', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await verify()
  await grid.getByRole('gridcell', { name: value, exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Use remote value', exact: true })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Keep local row', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => source.writes).toBe(1); await expect(refresh).toBeEnabled()
  expect(source.snapshot().rows[0]!.document).toEqual({ value, sibling: 2, hidden: 9 })
  await page.reload(); await mount(true)
  await expect(grid.getByRole('gridcell', { name: value, exact: true })).toBeVisible()
})
