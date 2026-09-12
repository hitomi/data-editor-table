import { readFile } from 'node:fs/promises'
import { expect, test } from './test.js'

const cases = [
  { route: '/', database: 'quick-start-workspace-v1', id: 'quick-start' },
  { route: '/playground', database: 'playground-workspace-v1', id: 'playground' },
  { route: '/multi-image-import', database: 'image-import-workspace-v1', id: 'image-import' },
  { route: '/cross-grid-drag', database: 'partitioned-workspace-v1', id: 'partitioned-inventory' },
]
for (const scenario of cases) test(`retained work can be downloaded after incompatible open on ${scenario.route}`, async ({ page }) => {
  await page.goto(scenario.route === '/' ? '/#/playground' : '/')
  const original = await page.evaluate(async ({ database, id }) => {
    const opening = indexedDB.open(database, 2)
    opening.onupgradeneeded = () => {
      for (const name of ['heads', 'records', 'outcomes', 'resources', 'checkpoints', 'checkpoint-outcomes']) opening.result.createObjectStore(name)
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['heads', 'records', 'resources'], 'readwrite')
      tx.objectStore('heads').put({ workspace: { id, schema: 'previous-schema', codec: 'previous-codec', scope: { sourceId: 'old', id: 'old', epoch: 'old' } }, epoch: 'original-owner', root: 'original-root' }, id)
      tx.objectStore('records').put({ format: 1, input: '需要恢复的原文' }, 'original-root')
      tx.objectStore('resources').put(new TextEncoder().encode('Original file bytes').buffer, 'original-file')
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
    db.close()
    return (await (await import('/src/test-fixtures/recovery-archive.ts')).exportIndexedDbRecoveryDatabase(database)).text()
  }, scenario)
  await page.goto(`/#${scenario.route}`)
  const recovery = page.getByRole('region', { name: 'Workspace recovery', exact: true })
  await expect(recovery).toBeVisible()
  await expect(page.getByRole('grid')).toHaveCount(0)
  for (const width of [1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1080 })
    const button = recovery.getByRole('button', { name: 'Prepare retained work download', exact: true })
    const box = await button.boundingBox()
    expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  }
  if (scenario.route === '/') {
    await page.evaluate(database => {
      const transaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === database && args[1] === 'readonly') {
          IDBDatabase.prototype.transaction = transaction
          throw new Error('Injected archive read failure')
        }
        return transaction.apply(this, args)
      }
    }, scenario.database)
    await recovery.getByRole('button', { name: 'Prepare retained work download', exact: true }).click()
    await expect(recovery.getByRole('alert').filter({ hasText: 'The download could not be prepared.' })).toBeVisible()
    await expect(recovery.getByRole('link', { name: 'Download retained work', exact: true })).toHaveCount(0)
  }
  await recovery.getByRole('button', { name: 'Prepare retained work download', exact: true }).press('Enter')
  const link = recovery.getByRole('link', { name: 'Download retained work', exact: true })
  await expect(link).toBeVisible()
  const downloading = page.waitForEvent('download'); await link.click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe(`${scenario.database}-recovery.json`)
  expect(await readFile((await download.path())!, 'utf8')).toBe(original)
  await page.reload()
  await expect(recovery).toBeVisible()
  await recovery.getByRole('button', { name: /^Retry opening/ }).click()
  await expect(recovery).toBeVisible()
  expect(await page.evaluate(async database => (await (await import('/src/test-fixtures/recovery-archive.ts')).exportIndexedDbRecoveryDatabase(database)).text(), scenario.database)).toBe(original)
})
