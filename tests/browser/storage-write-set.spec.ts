import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

for (const store of ['records', 'checkpoints'] as const) test(`${store} queues the complete durable write set before yielding to a request callback`, async ({ page, context }) => {
  const name = `write-set-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Original' } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  const mount = async (restore: boolean) => page.evaluate(async ({ name, restore, checkpoint }) => {
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore, 'manual', checkpoint && restore ? 'store' : false)
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
  }, { name, restore, checkpoint: store === 'checkpoints' })
  await page.goto('/'); await mount(false)
  const grid = page.getByRole('grid', { name: 'Workspace rows' })
  await grid.getByRole('gridcell', { name: 'Original', exact: true }).dblclick()
  const input = page.getByRole('textbox', { name: 'Edit value', exact: true })
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  if (store === 'checkpoints') {
    await input.fill('Retained input')
    await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  }
  await page.evaluate(({ name, store }) => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      const request = Reflect.apply(put, this, args) as IDBRequest<IDBValidKey>
      const record = args[0] as { commit: { token: unknown }; event?: { kind: string; input?: { value?: unknown } } }
      if (this.name === store && this.transaction.db.name === name
        && (store === 'checkpoints' || record.event?.kind === 'session-input' && record.event.input?.value === 'Retained input')) {
        IDBObjectStore.prototype.put = put
        document.documentElement.dataset.writeSetToken = JSON.stringify(record.commit.token)
        // Model unloading between request completion and its JS continuation:
        // the browser can commit its queued writes even if this callback never
        // reaches the async writer. No fake database or synthetic receipt.
        request.addEventListener('success', event => event.stopImmediatePropagation(), { once: true })
        this.transaction.addEventListener('complete', () => { document.documentElement.dataset.writeSetCommitted = 'true' }, { once: true })
      }
      return request
    }
  }, { name, store })
  if (store === 'records') await input.fill('Retained input')
  else await page.evaluate(() => { void import('/src/test-fixtures/durable-workspace.ts').then(fixture => fixture.checkpointCloseWorkspace()) })
  await expect(page.locator('html')).toHaveAttribute('data-write-set-committed', 'true')
  const receipt = await page.evaluate(({ name, store }) => new Promise<string | null>((resolve, reject) => {
    const opening = indexedDB.open(name)
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction(store === 'records' ? 'outcomes' : 'checkpoint-outcomes', 'readonly')
      const read = tx.objectStore(store === 'records' ? 'outcomes' : 'checkpoint-outcomes').getAll()
      let kind: string | null = null
      read.onsuccess = () => { kind = read.result.find(result => JSON.stringify(result.commit.token) === document.documentElement.dataset.writeSetToken)?.kind ?? null }
      tx.oncomplete = () => { db.close(); resolve(kind) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), { name, store })
  expect(receipt).toBe(store === 'records' ? 'committed' : 'stored')
  expect(source.writes).toBe(0)
  await page.reload(); await mount(true)
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(input).toHaveValue('Retained input')
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await expect(grid.getByRole('gridcell', { name: 'Retained input', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => source.writes).toBe(1)
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  expect(source.snapshot().rows[0]!.document).toEqual({ value: 'Retained input' })
})
