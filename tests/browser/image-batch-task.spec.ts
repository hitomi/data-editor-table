import { expect, test } from './test.js'

for (const mode of ['complete', 'interrupted', 'corrupted'] as const) test(`batch conversion resumes exact accepted bytes after reload (${mode})`, async ({ page }) => {
  const name = `batch-convert-${crypto.randomUUID()}`
  await page.goto('/')
  const start = await page.evaluate(async name => {
    const fixture = await import('/src/test-fixtures/image-batch-task.ts')
    await fixture.openBatchWorkspace(name, false, true)
    return fixture.startBatchConversion()
  }, name)
  expect(start.task).toMatchObject({ kind: 'running', execution: { outcome: { kind: 'unknown' } } })
  expect(start.rows).toEqual([{ name: 'Original', image: null }])
  if (mode !== 'complete') await page.evaluate(async ({ name, mode }) => {
    // Retain acceptance and exact bytes, simulate interruption before terminal persistence.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(`${name}:conversions`, 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, transaction = db.transaction('executions', 'readwrite'), cursor = transaction.objectStore('executions').openCursor()
        cursor.onsuccess = () => { if (!cursor.result) { transaction.abort(); return }; cursor.result.update({ ...cursor.result.value, outcome: null, ...(mode === 'corrupted' ? { bytes: new Uint8Array([9]).buffer } : {}) }) }
        transaction.oncomplete = () => { db.close(); resolve() }
        transaction.onabort = () => { db.close(); reject(transaction.error) }
      }
    })
  }, { name, mode })
  await page.reload()
  const recovered = await page.evaluate(async ({ name, id }) => {
    const fixture = await import('/src/test-fixtures/image-batch-task.ts')
    await fixture.openBatchWorkspace(name, true)
    return fixture.recoverBatch(id)
  }, { name, id: start.id })
  if (mode === 'corrupted') expect(recovered.task).toMatchObject({ kind: 'failed', execution: { outcome: { kind: 'failed', issue: { code: 'image-batch-conversion' } } } })
  else expect(recovered.task).toMatchObject({ kind: 'result-ready', result: { kind: 'action-candidate', input: { kind: 'encoded', value: {
    format: 'image-import-result:1', plan: start.plan, images: [
      { fileName: '一.first.svg', name: '一.first', image: 'data:image/svg+xml;base64,PHN2Zy8+' },
      { fileName: 'second.png', name: 'second', image: 'data:image/png;base64,AP8K' },
    ],
  } } } })
  expect(recovered.rows).toEqual(start.rows)
  expect(recovered.actions).toBe(0)
  await page.reload()
  const retained = await page.evaluate(async ({ name, id }) => {
    const fixture = await import('/src/test-fixtures/image-batch-task.ts')
    await fixture.openBatchWorkspace(name, true)
    return fixture.inspectBatch(id)
  }, { name, id: start.id })
  expect(retained.task).toEqual(recovered.task)
})
