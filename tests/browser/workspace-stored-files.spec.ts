import { readFile } from 'node:fs/promises'
import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('unassigned stored bytes can be downloaded after reload and explicitly released without changing rows', async ({ page, context }) => {
  const name = `stored-files-${crypto.randomUUID()}`, source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial' } })
  await context.route('**/__kernel-source/*', async route => {
    const path = route.request().url(), body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  async function mount(restore: boolean) {
    await page.goto('/')
    await page.evaluate(async ({ name, restore }) => {
      document.body.replaceChildren()
      await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
      const container = document.createElement('div'); document.body.append(container)
      ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
    }, { name, restore })
  }
  await mount(false)
  const bytes = 'Unassigned original bytes\n保留输入'
  await page.evaluate(async bytes => {
    await (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().registerResource(new File([bytes], 'original.txt', { type: 'text/plain' }))
  }, bytes)
  await mount(true)
  const panel = page.getByRole('region', { name: 'Unused stored files', exact: true }), remove = panel.getByRole('button', { name: 'Remove stored file', exact: true })
  await expect(panel).toBeVisible(); await expect(remove).toBeDisabled()
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('link', { name: 'Download original.txt', exact: true }).click()])
  expect(await readFile((await download.path())!, 'utf8')).toBe(bytes)
  await panel.getByRole('checkbox').check()
  await page.getByRole('grid', { name: 'Workspace rows' }).getByRole('gridcell').click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Edit value', exact: true })).toBeVisible()
  await expect(remove).toBeDisabled()
  await expect(panel.getByRole('checkbox')).not.toBeChecked()
  await panel.getByRole('checkbox').check(); await remove.click()
  await expect(panel).toHaveCount(0)
  await mount(true)
  await expect(panel).toHaveCount(0)
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getState().resources.map(resource => resource.status))).toEqual(['released'])
  expect(source.writes).toBe(0)
  await expect(page.getByRole('gridcell')).toHaveText('Initial')
})
