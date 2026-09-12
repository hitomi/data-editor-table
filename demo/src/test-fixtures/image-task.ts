import { openImageTask } from '../image-task.js'
import type { DurableTaskRequest } from 'data-editor-table'

/** Simulate process loss after durable acceptance and before conversion's
 * terminal write. The original request and accepted bytes remain untouched. */
export async function resumeAcceptedImage(databaseName: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  const request = await new Promise<DurableTaskRequest>((resolve, reject) => {
    const transaction = db.transaction('executions', 'readwrite'), store = transaction.objectStore('executions'), cursor = store.openCursor()
    let request: DurableTaskRequest
    cursor.onsuccess = () => {
      const entry = cursor.result
      if (!entry) { transaction.abort(); return }
      request = entry.value.request
      entry.update({ ...entry.value, outcome: null })
    }
    transaction.oncomplete = () => resolve(request)
    transaction.onabort = () => reject(transaction.error ?? new Error('No accepted image execution'))
  })
  db.close()
  const service = await openImageTask(databaseName)
  const context = { signal: new AbortController().signal, resource: null }
  const recovered = await service.lookup(request, context)
  const repeat = await service.lookup(request, context)
  const missing = await service.lookup({ ...request, ref: { ...request.ref, executionId: 'never-accepted' } }, context)
  let mismatchRejected = false
  try { await service.lookup({ ...request, ref: { ...request.ref, payloadHash: 'different-request' } }, context) }
  catch { mismatchRejected = true }
  return { recovered, repeat, missing, mismatchRejected }
}
