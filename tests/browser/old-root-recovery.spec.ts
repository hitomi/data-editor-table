import { readFile } from 'node:fs/promises'
import { expect, test } from './test.js'

for (const format of [1, 2, 3, 4, 5, 6, 7, 8, 9]) test(`same-identity format ${format} rejects opening but preserves downloadable input`, async ({ page }) => {
  await page.goto('/')
  const grid = page.getByRole('grid', { name: 'Quick-start products', exact: true })
  await grid.getByRole('gridcell', { name: 'Amber poster', exact: true }).click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  const original = `原始未提交输入 format ${format}`
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(original)
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled()
  // Release the actual document/lease before injecting a previous root format.
  await page.goto('about:blank'); await page.goto('/#/playground')
  await expect(page.getByRole('grid', { name: 'Inventory items', exact: true })).toBeVisible()
  const before = await page.evaluate(async format => {
    const opening = indexedDB.open('quick-start-workspace-v1')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error)
    })
    const result = await new Promise<{ record: string; root: unknown; workspace: unknown }>((resolve, reject) => {
      const tx = db.transaction(['heads', 'records', 'resources'], 'readwrite')
      const head = tx.objectStore('heads').get('quick-start'), record = tx.objectStore('records').get('quick-start')
      let encoded = ''
      record.onsuccess = () => {
        if (record.result.format !== 10) { tx.abort(); return }
        record.result.format = format
        encoded = JSON.stringify(record.result)
        tx.objectStore('records').put(record.result, 'quick-start')
        tx.objectStore('resources').put(new TextEncoder().encode('Unassigned original file bytes').buffer, 'retained-original-file')
      }
      tx.oncomplete = () => resolve({ record: encoded, root: head.result.root, workspace: head.result.workspace })
      tx.onabort = () => reject(tx.error ?? new Error('Expected an actual current-format root'))
    })
    db.close(); return result
  }, format)
  expect(before.record).toContain(original)
  await page.goto('about:blank'); await page.goto('/')
  const recovery = page.getByRole('region', { name: 'Workspace recovery', exact: true })
  await expect(recovery).toBeVisible()
  await expect(page.getByRole('grid')).toHaveCount(0)
  for (let attempt = 0; attempt < 2; attempt++) {
    await recovery.getByRole('button', { name: 'Prepare retained work download', exact: true }).click()
    const link = recovery.getByRole('link', { name: 'Download retained work', exact: true })
    await expect(link).toBeVisible()
    const waiting = page.waitForEvent('download'); await link.click()
    const download = await waiting, archive = await readFile((await download.path())!, 'utf8')
    expect(archive).toContain(original)
    expect(archive).toContain(Buffer.from('Unassigned original file bytes').toString('base64'))
    const after = await page.evaluate(async () => {
      const opening = indexedDB.open('quick-start-workspace-v1')
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error)
      })
      const result = await new Promise<{ record: string; root: unknown; workspace: unknown }>((resolve, reject) => {
        const tx = db.transaction(['heads', 'records'], 'readonly')
        const head = tx.objectStore('heads').get('quick-start'), record = tx.objectStore('records').get('quick-start')
        tx.oncomplete = () => resolve({ record: JSON.stringify(record.result), root: head.result.root, workspace: head.result.workspace })
        tx.onabort = () => reject(tx.error)
      })
      db.close(); return result
    })
    expect(after).toEqual(before)
    expect(archive).toBe(await page.evaluate(async () => (await (await import('/src/test-fixtures/recovery-archive.ts')).exportIndexedDbRecoveryDatabase('quick-start-workspace-v1')).text()))
    await page.reload(); await expect(recovery).toBeVisible()
  }
})
