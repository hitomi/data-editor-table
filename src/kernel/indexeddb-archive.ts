type ArchiveValue = { type: string; value?: unknown }

async function archiveValue(value: unknown, ancestors = new Set<object>()): Promise<ArchiveValue> {
  if (value === null) return { type: 'null' }
  if (value === undefined) return { type: 'undefined' }
  if (typeof value === 'string' || typeof value === 'boolean') return { type: typeof value, value }
  if (typeof value === 'number') return { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) }
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) }
  if (typeof value !== 'object') throw new Error('Unsupported recovery archive value.')
  if (value instanceof Date) return { type: 'date', value: String(value.getTime()) }
  const bytes = (buffer: ArrayBuffer) => {
    const input = new Uint8Array(buffer), pieces: string[] = []
    for (let offset = 0; offset < input.length; offset += 8192) pieces.push(String.fromCharCode(...input.subarray(offset, offset + 8192)))
    return btoa(pieces.join(''))
  }
  if (value instanceof ArrayBuffer) return { type: 'array-buffer', value: bytes(value) }
  if (value instanceof Blob) return { type: value instanceof File ? 'file' : 'blob', value: {
    mime: value.type, bytes: bytes(await value.arrayBuffer()), ...(value instanceof File ? { name: value.name, lastModified: value.lastModified } : {}),
  } }
  if (ancestors.has(value)) throw new Error('Cyclic recovery values require a separate archive converter.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return { type: 'array', value: await Promise.all(Array.from({ length: value.length }, async (_, index) =>
      Object.hasOwn(value, index) ? archiveValue(value[index], new Set(ancestors)) : { type: 'hole' })) }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Unsupported recovery archive object.')
    return { type: 'object', value: await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await archiveValue(item, new Set(ancestors))])) }
  } finally { ancestors.delete(value) }
}

/** Export all workspaces in an existing database, even when current recovery
 * schemas reject them. A single readonly transaction captures every store.
 * This is a forensic archive, not a validated Workspace checkpoint/import. */
export async function exportIndexedDbRecoveryDatabase(databaseName: string): Promise<Blob> {
  if (!databaseName) throw new Error('A recovery database name is required.')
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onupgradeneeded = () => request.transaction!.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('The existing recovery database could not be opened.'))
  })
  try {
    const names = [...db.objectStoreNames]
    const stores = names.length ? await new Promise<{ name: string; keyPath: string | string[] | null; autoIncrement: boolean; entries: { key: IDBValidKey; value: unknown }[] }[]>((resolve, reject) => {
      const tx = db.transaction(names, 'readonly')
      const result = names.map(name => {
        const store = tx.objectStore(name), entries: { key: IDBValidKey; value: unknown }[] = []
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          const current = cursor.result
          if (current) { entries.push({ key: current.key, value: current.value }); current.continue() }
        }
        return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, entries }
      })
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? new Error('Recovery archive read aborted.'))
      tx.onerror = () => { /* Transaction abort owns rejection. */ }
    }) : []
    const value = await archiveValue(stores)
    return new Blob([JSON.stringify({ format: 'data-editor-table-indexeddb-archive', version: 1, databaseName, databaseVersion: db.version, stores: value })], { type: 'application/json' })
  } finally { db.close() }
}
