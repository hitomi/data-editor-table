import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('two partitions share one owner while new selection and retained editor targets stay isolated', async ({ page, context }) => {
  const name = `partitions-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Alpha', hidden: 7 }, b: { value: 'Beta', hidden: 8 } })
  await context.route('**/__kernel-source/*', async route => {
    const path = route.request().url(), body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  await page.goto('/')
  await page.evaluate(async name => {
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, false)
    ;(await import('/src/test-fixtures/workspace-partitions.tsx')).renderPartitions()
  }, name)
  const alpha = page.getByRole('region', { name: 'Alpha pane' }), beta = page.getByRole('region', { name: 'Beta pane' })
  await expect(alpha.getByRole('gridcell')).toHaveText('Alpha')
  await expect(beta.getByRole('gridcell')).toHaveText('Beta')
  await alpha.getByRole('gridcell').focus(); await alpha.getByRole('gridcell').press('Control+a')
  await expect(alpha.getByRole('gridcell', { selected: true })).toHaveCount(1)
  await alpha.getByRole('button', { name: 'Edit value', exact: true }).click()
  await alpha.getByRole('textbox', { name: 'Value', exact: true }).fill('Alpha retained')
  await expect(alpha.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  await page.evaluate(async () => (await import('/src/test-fixtures/workspace-partitions.tsx')).renderPartitions(true))
  await expect(alpha.getByRole('gridcell')).toHaveText('Beta')
  await expect(alpha.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue('Alpha retained')
  await expect(beta.getByRole('textbox')).toHaveCount(0)
  await alpha.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(alpha.getByRole('gridcell')).toHaveText('Beta')
  await expect(beta.getByText('No rows yet.', { exact: true })).toBeVisible()
  await alpha.getByRole('gridcell', { name: 'Beta', exact: true }).click()
  await alpha.getByRole('button', { name: 'Edit value', exact: true }).click()
  await expect(alpha.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue('Beta')
  await alpha.getByRole('button', { name: 'Discard input', exact: true }).click()
  await alpha.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => source.writes).toBe(1)
  await expect(alpha.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 'Alpha retained', hidden: 7 }, { value: 'Beta', hidden: 8 }])
})
