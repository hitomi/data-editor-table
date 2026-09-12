import type { Document, ExactItemResult, FrozenSubmission, ObservationId, OperationLookup, ScopeIdentity, ServerIdentity } from '../../src/kernel/model.js'
import type { SubmissionRef } from '../../src/kernel/persistence.js'
import type { PersistenceSource, ServerAuthority, SourceMutationResult } from '../../src/kernel/source.js'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
const identityKey = (identity: ServerIdentity) => JSON.stringify([typeof identity.key, identity.key, identity.incarnation])

/** Independent test server: no production comparator, projector, reducer or
 * gateway implementation is used to decide atomic backend effects. */
export class SourceFixture implements PersistenceSource {
  get id() { return this.scope.sourceId }
  readonly capabilities = { atomicScopeWrites: true as const, durableOperationLookup: true as const, operationIdFence: 'scope-epoch' as const,
    authorityOrder: 'ordered' as const, identity: 'incarnation' as const, operationRetentionMs: 86_400_000, restoreDeleted: false }
  readonly rows = new Map<string, { identity: ServerIdentity; document: Document }>()
  readonly records = new Map<string, { request: string; result: SourceMutationResult }>()
  readonly requests: FrozenSubmission[] = []
  version = 0
  writes = 0
  reads = 0
  lookups = 0
  private serial = 0
  submitHook: ((request: FrozenSubmission, execute: () => SourceMutationResult) => Promise<SourceMutationResult>) | null = null
  lookupHook: ((ref: SubmissionRef) => Promise<OperationLookup>) | null = null
  readHook: (() => Promise<ServerAuthority>) | null = null
  normalize: (document: Document) => Document = document => document
  normalizeOrder: (order: readonly ServerIdentity[]) => readonly ServerIdentity[] = order => order
  constructor(readonly scope: ScopeIdentity, initial: Readonly<Record<string, Document>>, restoreDeleted = false) {
    this.capabilities.restoreDeleted = restoreDeleted
    for (const [key, document] of Object.entries(initial)) {
      const identity = { key, incarnation: 'life:1' }
      this.rows.set(identityKey(identity), { identity, document: copy(document) })
    }
  }
  snapshot(): ServerAuthority {
    // Test IDs are strings at the transport boundary; casting the complete
    // fixture keeps the source independent of production ID constructors.
    return copy({ scope: this.scope, observation: `server-read:${++this.serial}` as ObservationId, version: { kind: 'ordered', token: `version:${this.version}`, position: String(this.version) },
      rows: [...this.rows.values()], order: [...this.rows.values()].map(row => row.identity),
    }) as ServerAuthority
  }
  external(documents: Readonly<Record<string, Document>>) {
    const before = [...this.rows.values()]
    this.rows.clear()
    for (const [key, document] of Object.entries(documents)) {
      const identity = before.find(row => row.identity.key === key)?.identity ?? { key, incarnation: `external:${++this.serial}` }
      this.rows.set(identityKey(identity), { identity, document: copy(document) })
    }
    this.version++
  }
  async readAtLeast(): Promise<ServerAuthority> { this.reads++; return this.readHook ? this.readHook() : this.snapshot() }
  async submit(request: FrozenSubmission): Promise<SourceMutationResult> {
    this.requests.push(copy(request))
    return this.submitHook ? this.submitHook(request, () => this.execute(request)) : this.execute(request)
  }
  private execute(request: FrozenSubmission): SourceMutationResult {
    const bytes = canonical(request), previous = this.records.get(request.operationId)
    if (previous) {
      if (previous.request !== bytes) throw new Error('Operation identity was reused with a different payload')
      return copy(previous.result)
    }
    let result: SourceMutationResult
    try {
      if (canonical(request.scope) !== canonical(this.scope) || request.baseAuthority.kind !== 'ordered' || request.baseAuthority.position !== String(this.version)) throw new Error('Scope or version CAS failed')
      const next = new Map([...this.rows].map(([id, row]) => [id, copy(row)])), results: ExactItemResult[] = []
      for (const item of request.items) {
        if (item.kind === 'order') continue
        if (item.kind === 'create') {
          if (item.restores) {
            const evidence = this.records.get(item.restores.operationId)?.result
            if (!this.capabilities.restoreDeleted || evidence?.kind !== 'applied' || !evidence.receipt.results.some(result => result.kind === 'deleted'
              && result.itemId === item.restores!.itemId && identityKey(result.identity) === identityKey(item.restores!.identity))) throw new Error('Missing exact deletion restoration proof')
          }
          const identity: ServerIdentity = { key: item.proposedKey ?? `assigned:${++this.serial}`, incarnation: `created:${++this.serial}` }
          if ([...next.values()].some(row => canonical(row.identity.key) === canonical(identity.key))) throw new Error('Key collision')
          const document = copy(this.normalize(copy(item.document)))
          next.set(identityKey(identity), { identity, document }); results.push({ kind: 'created', itemId: item.id, identity, canonical: document })
        } else {
          const key = identityKey(item.identity), before = next.get(key)
          if (!before || canonical(before.document) !== canonical(item.before)) throw new Error('Incarnation or document CAS failed')
          if (item.kind === 'delete') { next.delete(key); results.push({ kind: 'deleted', itemId: item.id, identity: item.identity }) }
          else {
            const document = copy(this.normalize(copy(item.after)))
            next.set(key, { identity: item.identity, document }); results.push({ kind: 'updated', itemId: item.id, identity: item.identity, canonical: document })
          }
        }
      }
      const orders = request.items.filter(item => item.kind === 'order')
      if (orders.length > 1) throw new Error('Only one complete order item is allowed')
      const order = orders[0]
      if (order) {
        if (canonical(order.before) !== canonical([...this.rows.values()].map(row => row.identity))) throw new Error('Complete order CAS failed')
        const identities = order.after.map(ref => {
          if (ref.kind === 'bound') return ref.identity
          const created = results.find(result => result.kind === 'created' && result.itemId === ref.itemId)
          if (created?.kind !== 'created') throw new Error('Order references a missing creation in this operation')
          return created.identity
        })
        const normalized = this.normalizeOrder(copy(identities)), keys = normalized.map(identityKey)
        if (keys.length !== next.size || new Set(keys).size !== keys.length || keys.some(key => !next.has(key))) throw new Error('Order must retain every surviving incarnation exactly once')
        const ordered = keys.map(key => next.get(key)!)
        next.clear(); for (const row of ordered) next.set(identityKey(row.identity), row)
        results.push({ kind: 'ordered', itemId: order.id, canonicalOrder: [...normalized] })
      }
      this.rows.clear(); for (const [id, row] of next) this.rows.set(id, row)
      this.version++; this.writes++
      result = { kind: 'applied', receipt: { scope: request.scope, operationId: request.operationId, payloadHash: request.payloadHash,
        committedVersion: { kind: 'ordered', token: `version:${this.version}`, position: String(this.version) }, results,
      } }
    } catch (error) {
      result = { kind: 'not-applied', proof: { scope: request.scope, operationId: request.operationId, payloadHash: request.payloadHash,
        rejectionToken: `rejected:${request.operationId}`, reason: { code: 'rejected', message: error instanceof Error ? error.message : 'Rejected' },
      } }
    }
    this.records.set(request.operationId, { request: bytes, result: copy(result) })
    return result
  }
  async lookupOperation(ref: SubmissionRef): Promise<OperationLookup> {
    this.lookups++
    if (this.lookupHook) return this.lookupHook(ref)
    const result = this.records.get(ref.operationId)?.result
    if (!result || result.kind === 'applied-without-receipt') return { kind: 'unknown', issue: { code: 'not-found', message: 'No exact outcome is available' } }
    return copy(result)
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
