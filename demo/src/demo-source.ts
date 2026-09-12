import { canonicalEncodedValue, hashSubmission, kernelId, ownEncodedValue, type Document, type ExactItemResult, type FrozenSubmission,
  type OperationLookup, type PersistenceSource, type ScopeIdentity, type ServerAuthority, type ServerIdentity, type SubmissionRef } from 'data-editor-table'

type Terminal = Extract<OperationLookup, { kind: 'applied' | 'not-applied' }>
type Root = { format: 1; scope: ScopeIdentity; position: string; rows: ServerAuthority['rows']; outcomes: { operationId: string; hash: string; result: Terminal }[] }
const encoded = (value: unknown) => canonicalEncodedValue(ownEncodedValue(value))
const version = (root: Root) => ({ kind: 'ordered' as const, position: root.position, token: `products:${root.position}` })

/** This demo's authority is IndexedDB, not an emulation of a remote backend's
 * guarantees. One readwrite transaction commits complete rows and exact
 * operation receipts together. Every tab addresses the same physical source.
 * The host supplies validation for this fixed source scope and schema.
 */
export type DemoSource = PersistenceSource & Readonly<{
  failNextSave(): void
  changeDocument(identity: ServerIdentity, change: (document: Document) => Document): Promise<void>
}>
export async function openDemoSource(scope: ScopeIdentity, initial: readonly Document[], validate: (document: Document) => void, structure: boolean): Promise<DemoSource> {
  let failNext = false
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`${scope.sourceId}:authority`, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('root')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  db.onversionchange = () => db.close()
  function transaction<T>(run: (root: Root) => T, write: boolean): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('root', write ? 'readwrite' : 'readonly'), store = tx.objectStore('root'), request = store.get('products')
      let result: T, failure: unknown
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Product transaction aborted.'))
      tx.onerror = () => { /* onabort is the terminal result. */ }
      request.onsuccess = () => {
        try {
          const root: Root = request.result ?? { format: 1, scope, position: '1', rows: initial.map((document, index) => ({
            identity: { key: `product-${index + 1}`, incarnation: 'initial-v1' }, document: ownEncodedValue(document) as Document })), outcomes: [] }
          if (root.format !== 1 || encoded(root.scope) !== encoded(scope)) throw new Error('Stored product authority needs migration.')
          result = run(root)
          if (write) store.put(root, 'products')
        } catch (error) { failure = error; tx.abort() }
      }
    })
  }
  await transaction(() => undefined, true)
  const checkScope = (other: ScopeIdentity) => { if (encoded(scope) !== encoded(other)) throw new Error('Wrong product scope.') }
  function rejection(ref: SubmissionRef, message: string): Terminal {
    return { kind: 'not-applied', proof: { scope, operationId: ref.operationId, payloadHash: ref.payloadHash,
      rejectionToken: `not-applied:${ref.operationId}`, reason: { code: 'products-rejected', message } } }
  }
  function existing(root: Root, ref: SubmissionRef) {
    const found = root.outcomes.find(outcome => outcome.operationId === ref.operationId)
    if (found && found.hash !== ref.payloadHash) throw new Error('Operation identity was reused with another payload.')
    return found?.result
  }
  return {
    failNextSave: () => { failNext = true },
    changeDocument: (identity, change) => transaction(root => {
      const index = root.rows.findIndex(row => encoded(row.identity) === encoded(identity))
      if (index < 0) throw new Error('The original row no longer exists.')
      const document = ownEncodedValue(change(ownEncodedValue(root.rows[index]!.document) as Document)) as Document
      validate(document)
      root.rows = root.rows.map((row, position) => position === index ? { identity: row.identity, document } : row)
      root.position = String(BigInt(root.position) + 1n)
    }, true),
    id: scope.sourceId,
    capabilities: { atomicScopeWrites: true, durableOperationLookup: true, operationIdFence: 'scope-epoch', authorityOrder: 'ordered',
      identity: 'incarnation', operationRetentionMs: 3600000, restoreDeleted: structure },
    readAtLeast: (other, frontier) => {
      checkScope(other)
      return transaction(root => {
        if (frontier.some(boundary => boundary.kind !== 'ordered' || BigInt(boundary.position) > BigInt(root.position)
          || boundary.token !== `products:${boundary.position}`)) throw new Error('Product authority cannot satisfy the requested boundary.')
        return { scope, observation: kernelId<'observation'>(crypto.randomUUID()), version: version(root), rows: root.rows, order: root.rows.map(row => row.identity) }
      }, false)
    },
    submit: async raw => {
      const submission = ownEncodedValue(raw) as unknown as FrozenSubmission
      checkScope(submission.scope)
      if (await hashSubmission(submission) !== submission.payloadHash) throw new Error('Invalid product payload digest.')
      return transaction(root => {
        const previous = existing(root, submission)
        if (previous) return previous
        let result: Terminal
        try {
          if (encoded(submission.baseAuthority) !== encoded(version(root))) throw new Error('Products changed. Refresh and review the edit.')
          if (!structure && submission.items.some(item => item.kind !== 'update')) throw new Error('This source only edits existing rows.')
          if (failNext) { failNext = false; throw new Error('The simulated save failed. Retry when ready.') }
          let rows = [...root.rows]
          const results: ExactItemResult[] = [], used = new Set<string>(), ids = new Set<string>()
          for (const item of submission.items) {
            if (ids.has(item.id)) throw new Error('Duplicate submitted item.')
            ids.add(item.id)
            if (item.kind === 'order') continue
            if (item.kind === 'create') {
              if (item.restores) {
                const proof = root.outcomes.find(outcome => outcome.operationId === item.restores!.operationId)?.result
                if (proof?.kind !== 'applied' || !proof.receipt.results.some(result => result.kind === 'deleted'
                  && result.itemId === item.restores!.itemId && encoded(result.identity) === encoded(item.restores!.identity))) throw new Error('Missing deletion restoration proof.')
              }
              validate(item.document)
              const identity: ServerIdentity = { key: item.proposedKey ?? crypto.randomUUID(), incarnation: crypto.randomUUID() }
              if (rows.some(row => encoded(row.identity.key) === encoded(identity.key))) throw new Error('Product key already exists.')
              rows.push({ identity, document: item.document })
              results.push({ kind: 'created', itemId: item.id, identity, canonical: item.document })
              continue
            }
            const identity = encoded(item.identity), index = rows.findIndex(row => encoded(row.identity) === identity)
            if (used.has(identity) || index < 0 || encoded(rows[index]!.document) !== encoded(item.before)) throw new Error('Product identity or value changed.')
            used.add(identity)
            if (item.kind === 'delete') {
              rows.splice(index, 1)
              results.push({ kind: 'deleted', itemId: item.id, identity: item.identity })
            } else {
              validate(item.after)
              rows[index] = { identity: item.identity, document: item.after }
              results.push({ kind: 'updated', itemId: item.id, identity: item.identity, canonical: item.after })
            }
          }
          const orders = submission.items.filter(item => item.kind === 'order')
          if (orders.length > 1) throw new Error('Only one complete order is allowed.')
          const order = orders[0]
          if (order) {
            if (encoded(order.before) !== encoded(root.rows.map(row => row.identity))) throw new Error('Row order changed.')
            const identities = order.after.map(ref => {
              if (ref.kind === 'bound') return ref.identity
              const result = results.find(result => result.kind === 'created' && result.itemId === ref.itemId)
              if (result?.kind !== 'created') throw new Error('Order references an unknown creation.')
              return result.identity
            })
            const keys = identities.map(encoded)
            if (keys.length !== rows.length || new Set(keys).size !== rows.length || keys.some(key => !rows.some(row => encoded(row.identity) === key))) throw new Error('Order must contain all surviving rows exactly once.')
            rows = identities.map(identity => rows.find(row => encoded(row.identity) === encoded(identity))!)
            results.push({ kind: 'ordered', itemId: order.id, canonicalOrder: identities })
          }
          root.rows = rows; root.position = String(BigInt(root.position) + 1n)
          result = { kind: 'applied', receipt: { scope, operationId: submission.operationId, payloadHash: submission.payloadHash, committedVersion: version(root), results } }
        } catch (error) { result = rejection(submission, error instanceof Error ? error.message : 'Product update rejected.') }
        root.outcomes.push({ operationId: submission.operationId, hash: submission.payloadHash, result })
        return result
      }, true)
    },
    lookupOperation: ref => {
      checkScope(ref.scope)
      return transaction(root => {
        const previous = existing(root, ref)
        if (previous) return previous
        // An absent lookup creates a durable negative fence. A later arrival
        // of this operation cannot execute after the caller observed rejection.
        const result = rejection(ref, 'The operation did not execute.')
        root.outcomes.push({ operationId: ref.operationId, hash: ref.payloadHash, result })
        return result
      }, true)
    },
  }
}
