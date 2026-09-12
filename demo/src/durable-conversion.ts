import { canonicalEncodedValue, ownEncodedValue, type DurableTaskDefinition, type DurableTaskOutcome, type DurableTaskRequest, type TaskDefinitionRef, type TaskResult, type KernelIssue } from 'data-editor-table'

type Record = { request: DurableTaskRequest; bytes: ArrayBuffer | null; outcome: DurableTaskOutcome | null }
const canonical = (value: unknown) => canonicalEncodedValue(ownEncodedValue(value))
async function digest(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) {
  return `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

/** Browser-local execution service. Acceptance stores the exact request and
 * bytes as an ArrayBuffer first (no browser file-handle persistence); lookup may finish that same pure conversion after a reload.
 * This service has no upload side effect and never invents a missing execution.
 */
export async function openDurableConversion(databaseName: string, definition: Readonly<{
  ref: TaskDefinitionRef; failure: KernelIssue
  convert(request: DurableTaskRequest, resource: Blob | null): Promise<TaskResult>
}>): Promise<DurableTaskDefinition> {
  const ref = ownEncodedValue(definition.ref) as unknown as TaskDefinitionRef
  const failure = ownEncodedValue(definition.failure) as unknown as KernelIssue
  function requestValue(raw: DurableTaskRequest): DurableTaskRequest {
    const request = ownEncodedValue(raw) as unknown as DurableTaskRequest
    if (canonical(request.ref.definition) !== canonical(ref)) throw new Error('The exact conversion definition is unavailable.')
    return request
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(databaseName, 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore('executions')
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => resolve(opening.result)
  })
  db.onversionchange = () => db.close()
  function access<T>(request: DurableTaskRequest, update: (record: Record | null) => { record: Record | null; result: T }): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('executions', 'readwrite'), store = transaction.objectStore('executions')
      const key = JSON.stringify([request.ref.workspaceId, request.ref.executionId]), reading = store.get(key)
      let value: T, error: unknown
      transaction.oncomplete = () => resolve(value)
      transaction.onabort = () => reject(error ?? transaction.error ?? new Error('Image task storage failed.'))
      reading.onsuccess = () => {
        try {
          const record: Record | null = reading.result ?? null
          if (record && canonical(record.request) !== canonical(request)) throw new Error('Image execution identity has another request.')
          const next = update(record); value = next.result
          if (next.record) store.put(next.record, key)
        } catch (failure) { error = failure; transaction.abort() }
      }
    })
  }
  async function finish(request: DurableTaskRequest, record: Record | null): Promise<DurableTaskOutcome> {
    if (!record) return { kind: 'unknown', ref: request.ref, issue: { code: 'not-found', message: 'The image execution has not been accepted.' } }
    if (record.outcome) return record.outcome
    let outcome: DurableTaskOutcome
    try {
      if (request.resource && (!record.bytes || (await digest(record.bytes)).slice(7) !== request.resource.sha256)) throw new Error('Stored conversion bytes differ from the accepted request.')
      const resource = record.bytes && request.resource ? new Blob([record.bytes], { type: request.resource.descriptor.mediaType }) : null
      const result = ownEncodedValue(await definition.convert(request, resource)) as unknown as TaskResult
      outcome = { kind: 'succeeded', ref: request.ref, result }
    } catch { outcome = { kind: 'failed', ref: request.ref, issue: failure } }
    return access(request, current => {
      if (!current) throw new Error('Accepted image execution disappeared.')
      const terminal = current.outcome ?? outcome
      return { record: { ...current, outcome: terminal }, result: terminal }
    })
  }
  return {
    ref, capabilities: { idempotentStart: true, durableOutcomeLookup: true, executionIdFence: 'workspace' },
    start: async (raw, context) => {
      const request = requestValue(raw)
      const { payloadHash: _hash, ...ref } = request.ref
      if (await digest(new TextEncoder().encode(canonical({ ...request, ref }))) !== request.ref.payloadHash) throw new Error('Image request digest differs.')
      if (!!request.resource !== !!context.resource) throw new Error('Image resource ownership differs from the request.')
      const bytes = context.resource ? await context.resource.arrayBuffer() : null
      if (request.resource && (!bytes || (await digest(bytes)).slice(7) !== request.resource.sha256)) throw new Error('Image bytes differ from the request.')
      const record = await access(request, existing => { const record = existing ?? { request, bytes, outcome: null }; return { record, result: record } })
      return finish(request, record)
    },
    lookup: async raw => { const request = requestValue(raw)
      return finish(request, await access(request, record => ({ record, result: record }))) },
  }
}
