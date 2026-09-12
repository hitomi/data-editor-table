import { readFile } from 'node:fs/promises'
import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('a rejected file request can be archived, reopened and downloaded without executing or releasing its bytes', async ({ page, context }) => {
  const name = `archive-${crypto.randomUUID()}`, source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial' } })
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
  const original = await page.evaluate(async () => {
    const workspace = (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture()
    const input = await workspace.registerResource(new File(['Original archive bytes'], 'archive.txt', { type: 'text/plain' }))
    await workspace.dispatch({ kind: 'session-opened', revision: -1, sessionId: 'rejected-session', inputId: 'rejected-input', viewId: 'rejected-view',
      target: { kind: 'cell', field: { entityId: workspace.getProjection().rows[0]!.entityId, fieldId: 'value' } }, input, reads: [] })
    return workspace.getIngress().pending[0]!
  })
  await expect(page.getByRole('button', { name: 'Keep requests in archive', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Keep requests in archive', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Archived requests', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep requests in archive', exact: true })).toHaveCount(0)
  await mount(true)
  const archive = page.getByRole('region', { name: 'Archived requests', exact: true })
  const [request] = await Promise.all([page.waitForEvent('download'), archive.getByRole('link', { name: 'Download complete request', exact: true }).click()])
  expect(JSON.parse(await readFile((await request.path())!, 'utf8'))).toEqual(original.payload)
  const [file] = await Promise.all([page.waitForEvent('download'), archive.getByRole('link', { name: 'Download archive.txt', exact: true }).click()])
  expect(await readFile((await file.path())!, 'utf8')).toBe('Original archive bytes')
  await expect(page.getByRole('region', { name: 'Unused stored files', exact: true })).toHaveCount(0)
  const state = await page.evaluate(async id => {
    const workspace = (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture()
    return { archive: workspace.getReturnedIngress(id), pending: workspace.getIngress().pending.length, session: workspace.getState().session, tasks: workspace.getState().tasks }
  }, original.id)
  expect(state).toEqual({ archive: original.payload, pending: 0, session: null, tasks: [] })
  expect(source.writes).toBe(0)
  await expect(page.getByRole('gridcell')).toHaveText('Initial')
})
