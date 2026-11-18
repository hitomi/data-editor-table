import {
  canonicalEncodedValue, hashSubmission, kernelId, ownDocument,
  type Document, type OperationLookup, type PersistenceSource,
  type ScopeIdentity, type ServerAuthority, type SubmissionRef,
} from 'data-editor-table/protocol'

type Outcome = Extract<OperationLookup, { kind: 'applied' | 'not-applied' }>
type StoredRow = { position: number; incarnation: string; document: Document; outcomes: Outcome[] }

/** Each test has its own tab. One synchronous storage write commits both the
 * canonical row and its operation result, which survive reopening in that tab. */
export function createRowAuthority(name: string, initial: { id: number | string; name: string }) {
  const scope: ScopeIdentity = { sourceId: name, id: kernelId<'scope'>('row'), epoch: kernelId<'scope-epoch'>('1') }
  const key = `test-authority:${name}`
  const identityOf = (record: StoredRow) => ({ key: initial.id, incarnation: record.incarnation })
  function load(): StoredRow {
    return JSON.parse(sessionStorage.getItem(key)!) as StoredRow
  }
  function write(record: StoredRow) { sessionStorage.setItem(key, JSON.stringify(record)) }
  if (!sessionStorage.getItem(key)) write({ position: 1, incarnation: 'original', document: initial, outcomes: [] })
  const version = (position: number) => ({ kind: 'ordered' as const, position: String(position), token: `version-${position}` })
  function snapshot(): ServerAuthority {
    const record = load()
    const identity = identityOf(record)
    return { scope, observation: kernelId<'observation'>(crypto.randomUUID()), version: version(record.position),
      rows: [{ identity, document: record.document }], order: [identity] }
  }
  function checkScope(other: ScopeIdentity) {
    if (other.sourceId !== name || other.id !== scope.id || other.epoch !== scope.epoch) throw Error('Unexpected fixture scope')
  }
  function previous(record: StoredRow, ref: SubmissionRef) {
    checkScope(ref.scope)
    return record.outcomes.find(outcome => {
      const proof = outcome.kind === 'applied' ? outcome.receipt : outcome.proof
      if (proof.operationId !== ref.operationId) return false
      if (proof.payloadHash !== ref.payloadHash) throw Error('Operation ID reused for a different payload')
      return true
    })
  }
  function reject(record: StoredRow, ref: SubmissionRef, message: string): Outcome {
    const result: Outcome = { kind: 'not-applied', proof: { scope, operationId: ref.operationId,
      payloadHash: ref.payloadHash, rejectionToken: String(ref.operationId),
      reason: { code: 'fixture-rejected', message } } }
    record.outcomes.push(result)
    write(record)
    return result
  }
  const source: PersistenceSource = {
    id: name,
    capabilities: { atomicScopeWrites: true, durableOperationLookup: true, operationIdFence: 'scope-epoch',
      authorityOrder: 'ordered', identity: 'incarnation', operationRetentionMs: 3_600_000, restoreDeleted: false },
    async readAtLeast(other, frontier) {
      checkScope(other)
      const authority = snapshot()
      const current = authority.version
      if (current.kind !== 'ordered' || frontier.some(v => v.kind !== 'ordered' || BigInt(v.position) > BigInt(current.position)
        || v.token !== `version-${v.position}`))
        throw Error('Fixture cannot read the requested version')
      return authority
    },
    async submit(submission) {
      if (await hashSubmission(submission) !== submission.payloadHash) throw Error('Incorrect submission hash')
      const record = load(), existing = previous(record, submission)
      if (existing) return existing
      const identity = identityOf(record)
      const item = submission.items[0]
      if (submission.items.length !== 1 || item?.kind !== 'update' || item.identity.key !== identity.key
        || item.identity.incarnation !== identity.incarnation || item.after.id !== identity.key || typeof item.after.name !== 'string'
        || submission.baseAuthority.token !== version(record.position).token
        || canonicalEncodedValue(item.before) !== canonicalEncodedValue(record.document))
        return reject(record, submission, 'The row or its base version changed')
      record.document = ownDocument({ ...item.after, name: item.after.name.trim() })
      record.position++
      const result: Outcome = { kind: 'applied', receipt: { scope, operationId: submission.operationId,
        payloadHash: submission.payloadHash, committedVersion: version(record.position),
        results: [{ kind: 'updated', itemId: item.id, identity, canonical: record.document }] } }
      record.outcomes.push(result)
      write(record)
      return result
    },
    async lookupOperation(ref) {
      const record = load()
      return previous(record, ref) ?? reject(record, ref, 'This operation did not execute')
    },
  }
  function changeName(name: string) {
    const record = load()
    write({ ...record, position: record.position + 1, document: ownDocument({ ...record.document, name }) })
    return snapshot()
  }
  function replaceRow(name: string) {
    const record = load()
    write({ ...record, position: record.position + 1, incarnation: crypto.randomUUID(), document: { id: initial.id, name } })
    return snapshot()
  }
  return { scope, source, snapshot, changeName, replaceRow }
}
