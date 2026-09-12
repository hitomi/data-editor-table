import { expect, test } from './test.js'

test('exports old-format recovery data and bytes without acquiring a new lease or upgrading storage', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const name = `old-recovery-${crypto.randomUUID()}`
    const api = await import('/src/test-fixtures/recovery-archive.ts')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => { for (const store of ['heads', 'records', 'resources']) request.result.createObjectStore(store) }
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const identity = { id: 'old-owner', scope: { sourceId: 'source', id: 'scope', epoch: 'epoch' }, schema: 'old-schema', codec: 'old-codec' }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['heads', 'records', 'resources'], 'readwrite')
      tx.objectStore('heads').put({ workspace: identity, epoch: 'original-lease', root: 'old-root' }, 'old-owner')
      tx.objectStore('records').put({ format: 1, raw: '未保存的原文', nullable: null, missing: undefined }, 'old-root')
      tx.objectStore('records').put({ format: 8, raw: 'other workspace input' }, 'other-root')
      tx.objectStore('resources').put(new Uint8Array([0, 1, 127, 128, 255]).buffer, ['old-owner', 'file', 'digest'])
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
    db.close()
    const before = await (await api.exportIndexedDbRecoveryDatabase(name)).text()
    const after = await (await api.exportIndexedDbRecoveryDatabase(name)).text()
    const verify = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const version = verify.version, names = [...verify.objectStoreNames]
    const head = await new Promise<unknown>((resolve, reject) => {
      const request = verify.transaction('heads').objectStore('heads').get('old-owner')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    verify.close()
    return { before: JSON.parse(before), identical: before === after, version, names, head }
  })
  type Node = { type: string; value?: unknown }
  const decode = (node: Node): unknown => {
    if (node.type === 'object') return Object.fromEntries((node.value as [string, Node][]).map(([key, value]) => [key, decode(value)]))
    if (node.type === 'array') return (node.value as Node[]).map(decode)
    if (node.type === 'null') return null
    if (node.type === 'undefined') return undefined
    if (node.type === 'number') return Number(node.value)
    if (node.type === 'array-buffer') return [...Buffer.from(node.value as string, 'base64')]
    return node.value
  }
  expect(result.identical).toBe(true)
  expect(result.version).toBe(1)
  expect(result.names).toEqual(['heads', 'records', 'resources'])
  expect(result.head).toMatchObject({ epoch: 'original-lease', root: 'old-root' })
  expect(result.before).toMatchObject({ format: 'data-editor-table-indexeddb-archive', version: 1, databaseVersion: 1 })
  const stores = decode(result.before.stores) as { name: string; entries: unknown[] }[]
  expect(stores.find(store => store.name === 'records').entries).toEqual([
    { key: 'old-root', value: { format: 1, raw: '未保存的原文', nullable: null, missing: undefined } },
    { key: 'other-root', value: { format: 8, raw: 'other workspace input' } },
  ])
  expect(stores.find(store => store.name === 'resources').entries).toEqual([{ key: ['old-owner', 'file', 'digest'], value: [0, 1, 127, 128, 255] }])
})

test('a missing recovery database is not created by export', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const name = `missing-recovery-${crypto.randomUUID()}`
    let error = ''
    try { await (await import('/src/test-fixtures/recovery-archive.ts')).exportIndexedDbRecoveryDatabase(name) }
    catch (failure) { error = String(failure) }
    return { error, exists: (await indexedDB.databases()).some(database => database.name === name) }
  })
  expect(result.error).toContain('could not be opened')
  expect(result.exists).toBe(false)
})
