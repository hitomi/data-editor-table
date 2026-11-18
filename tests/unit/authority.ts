import { vi } from 'vitest'
import type { GridColumnForCellTypes } from '../../src/cell-types/contracts.js'
import type { StandardGridCellTypeSchema } from '../../src/cell-types/standard-contracts.js'
import { createFieldGridDocumentModel, createRemoteGridDataSource } from '../../src/data/remote-data-source.js'
import { ownDocument } from '../../src/kernel/document.js'
import { kernelId, type Document, type ExactItemResult, type FrozenSubmission, type OperationLookup, type ServerIdentity, type ServerKey } from '../../src/kernel/model.js'
import type { PersistenceSource, ServerAuthority } from '../../src/kernel/source.js'
import type { SubmissionRef } from '../../src/kernel/persistence.js'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function rejected(submission: SubmissionRef, message = 'Not applied'): Extract<OperationLookup, { kind: 'not-applied' }> {
  const { operationId, payloadHash, scope } = submission
  return { kind: 'not-applied', proof: { operationId, payloadHash, scope, rejectionToken: 'rejected', reason: { code: 'rejected', message } } }
}

/** A test server. Reading never publishes a subscription event, so tests can
 * independently control the arrival order of reads, pushes and receipts. */
export function testAuthority(initialRows: readonly object[]) {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('test'), epoch: kernelId<'scope-epoch'>('1') }
  const version = (position: number) => ({ kind: 'ordered' as const, position: String(position), token: 'v' + position })
  const snapshot = (rows: readonly object[], position: number): ServerAuthority => {
    const records = rows.map(row => {
      const document = ownDocument(row)
      const key = document.id
      if (typeof key !== 'string' && typeof key !== 'number') throw new Error('Test rows require a key')
      return { identity: { key, incarnation: 'seed' }, document }
    })
    return { scope, rows: records, order: records.map(row => row.identity), observation: kernelId<'observation'>(crypto.randomUUID()), version: version(position) }
  }
  let current = snapshot(initialRows, 1)
  const outcomes = new Map<string, OperationLookup>()
  function apply(submission: FrozenSubmission, options: {
    position?: number
    create?: (proposed: Document) => Document
    update?: (proposed: Document) => Document
  } = {}): Extract<OperationLookup, { kind: 'applied' }> {
    const results: ExactItemResult[] = []
    const rows = new Map<ServerKey, ServerAuthority['rows'][number]>(current.rows.map(row => [row.identity.key, row]))
    let order = [...current.order]
    const created = new Map<string, ServerIdentity>()
    for (const item of submission.items) {
      if (item.kind === 'order') continue
      if (item.kind === 'create') {
        const document = options.create?.(item.document) ?? item.document
        if (typeof document.id !== 'string' && typeof document.id !== 'number') throw new Error('Missing creation key')
        const identity = { key: document.id, incarnation: crypto.randomUUID() }
        created.set(item.id, identity)
        rows.set(identity.key, { identity, document })
        order.push(identity)
        results.push({ kind: 'created', itemId: item.id, identity, canonical: document })
      } else if (item.kind === 'update') {
        const document = options.update?.(item.after) ?? item.after
        rows.set(item.identity.key, { identity: item.identity, document })
        results.push({ kind: 'updated', itemId: item.id, identity: item.identity, canonical: document })
      } else {
        rows.delete(item.identity.key)
        order = order.filter(row => row.key !== item.identity.key)
        results.push({ kind: 'deleted', itemId: item.id, identity: item.identity })
      }
    }
    for (const item of submission.items) if (item.kind === 'order') {
      order = item.after.map(ref => ref.kind === 'bound' ? ref.identity : created.get(ref.itemId)!)
      results.push({ kind: 'ordered', itemId: item.id, canonicalOrder: order })
    }
    const position = options.position ?? Number(current.version.kind === 'ordered' ? current.version.position : 0) + 1
    current = { scope, observation: kernelId<'observation'>(crypto.randomUUID()), version: version(position), rows: [...rows.values()], order }
    const result = { kind: 'applied' as const, receipt: { operationId: submission.operationId, payloadHash: submission.payloadHash,
      scope, committedVersion: current.version, results } }
    outcomes.set(submission.operationId, result)
    return result
  }
  const source = {
    id: scope.sourceId,
    capabilities: { atomicScopeWrites: true, durableOperationLookup: true, operationIdFence: 'scope-epoch',
      authorityOrder: 'ordered', identity: 'incarnation', operationRetentionMs: 60_000, restoreDeleted: true },
    readAtLeast: vi.fn<PersistenceSource['readAtLeast']>(async () => current),
    submit: vi.fn<PersistenceSource['submit']>(async submission => outcomes.get(submission.operationId) ?? apply(submission)),
    lookupOperation: vi.fn<PersistenceSource['lookupOperation']>(async ref => outcomes.get(ref.operationId) ?? { kind: 'unknown', issue: { code: 'offline', message: 'Unknown result' } }),
  } satisfies PersistenceSource
  return { scope, source, snapshot, apply, current: () => current, install: (authority: ServerAuthority) => { current = authority } }
}

export function testGridSource<Row extends { id: string }>(
  rows: readonly Row[], columns: readonly GridColumnForCellTypes<Row, StandardGridCellTypeSchema>[],
) {
  const server = testAuthority(rows)
  const dataSource = createRemoteGridDataSource<Row, string>({ columns, scope: server.scope, source: server.source, initialAuthority: server.current(),
    model: { ...createFieldGridDocumentModel(columns), identityPath: ['id'] }, getRowKey: row => row.id, persistence: { mode: 'manual-save' } })
  return { dataSource, server }
}
