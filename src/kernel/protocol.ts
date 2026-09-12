import { applyDocumentPatches, encodedValuesEqual, ownDocument } from './document.js'
import type {
  AuthorityFrontier, AuthorityVersion, CompleteAuthority, ExactReceipt, FrozenSubmission,
  ScopeIdentity, ServerIdentity, ServerKey,
} from './model.js'

export function sameScope(left: ScopeIdentity, right: ScopeIdentity) {
  return left.sourceId === right.sourceId && left.id === right.id && left.epoch === right.epoch
}

export function serverKeyIdentity(key: ServerKey): string {
  if (typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key))) throw new Error('A server key must be a string or finite number.')
  return JSON.stringify([typeof key, key])
}

export function serverIdentityKey(identity: ServerIdentity): string {
  validateServerIdentity(identity)
  return JSON.stringify([typeof identity.key, identity.key, identity.incarnation])
}

export function sameServerIdentity(left: ServerIdentity, right: ServerIdentity) {
  return serverIdentityKey(left) === serverIdentityKey(right)
}

function validateServerIdentity(identity: ServerIdentity) {
  serverKeyIdentity(identity.key)
  if (!identity.incarnation || identity.incarnation !== identity.incarnation.trim()) throw new Error('An entity incarnation is required.')
}

export function validateAuthorityVersion(version: AuthorityVersion) {
  if (!version.token) throw new Error('An authority token is required.')
  if (version.kind === 'ordered') {
    // Decimal strings survive JSON checkpoints without precision loss.
    if (!/^(0|[1-9][0-9]*)$/.test(version.position)) throw new Error('An authority position must be a canonical unsigned decimal string.')
  } else if (!version.stamp || version.covers.some(stamp => !stamp) || new Set(version.covers).size !== version.covers.length) {
    throw new Error('Causal authority requires a stamp and unique covered stamps.')
  }
}

/** Arrival order and token inequality are never freshness evidence. */
export function authorityCovers(actual: AuthorityVersion, required: AuthorityVersion): boolean {
  validateAuthorityVersion(actual); validateAuthorityVersion(required)
  if (actual.kind !== required.kind) throw new Error('A scope cannot switch authority ordering protocols.')
  if (actual.kind === 'ordered' && required.kind === 'ordered') {
    if (actual.position === required.position && actual.token !== required.token) throw new Error('One authority position cannot have conflicting tokens.')
    return BigInt(actual.position) >= BigInt(required.position)
  }
  if (actual.kind === 'causal' && required.kind === 'causal') {
    if (actual.stamp === required.stamp) {
      if (actual.token !== required.token) throw new Error('One authority stamp cannot have conflicting tokens.')
      return true
    }
    if (actual.covers.includes(required.stamp) && required.covers.includes(actual.stamp)) throw new Error('Causal authority cannot contain a cycle.')
    return actual.covers.includes(required.stamp)
  }
  return false
}

export function authorityCoversFrontier(actual: AuthorityVersion, required: AuthorityFrontier) {
  return required.every(version => authorityCovers(actual, version))
}

export function joinAuthorityFrontier(...frontiers: readonly AuthorityFrontier[]): AuthorityFrontier {
  const frontier: AuthorityVersion[] = []
  for (const version of frontiers.flat()) {
    validateAuthorityVersion(version)
    if (frontier.some(current => authorityCovers(current, version))) continue
    for (let index = frontier.length - 1; index >= 0; index--) {
      if (authorityCovers(version, frontier[index]!)) frontier.splice(index, 1)
    }
    frontier.push(ownAuthorityVersion(version))
  }
  return Object.freeze(frontier)
}

export function ownAuthorityVersion(version: AuthorityVersion): AuthorityVersion {
  validateAuthorityVersion(version)
  return Object.freeze(version.kind === 'ordered' ? { ...version } : { ...version, covers: Object.freeze([...version.covers]) })
}

export function ownCompleteAuthority(snapshot: CompleteAuthority): CompleteAuthority {
  if (!snapshot.scope.sourceId || !snapshot.scope.id || !snapshot.scope.epoch || !snapshot.observation) throw new Error('Scope, epoch and observation identities are required.')
  validateAuthorityVersion(snapshot.version)
  const entities = new Set<string>(), keys = new Set<string>()
  for (const row of snapshot.entities) {
    validateServerIdentity(row.identity)
    if (!row.entityId || entities.has(row.entityId)) throw new Error('Authority entity identities must be unique.')
    const key = serverKeyIdentity(row.identity.key)
    if (keys.has(key)) throw new Error('Authority server keys must be unique.')
    entities.add(row.entityId); keys.add(key)
  }
  if (snapshot.order.length !== entities.size || new Set(snapshot.order).size !== entities.size
    || snapshot.order.some(id => !entities.has(id))) throw new Error('Complete authority order must contain every entity exactly once.')
  return Object.freeze({
    scope: Object.freeze({ ...snapshot.scope }),
    observation: snapshot.observation,
    version: ownAuthorityVersion(snapshot.version),
    entities: Object.freeze(snapshot.entities.map(row => Object.freeze({
      entityId: row.entityId, identity: Object.freeze({ ...row.identity }), document: ownDocument(row.document),
    }))),
    order: Object.freeze([...snapshot.order]),
  })
}

/** Verify a compiled plan, including the full write set. Business permissions
 * and server CAS are separate checks, not inferred from this representation.
 */
export function validateFrozenSubmission(submission: FrozenSubmission) {
  if (!submission.workspaceId || !submission.operationId || !submission.payloadHash || !submission.schema || !submission.scope.sourceId || !submission.scope.id || !submission.scope.epoch)
    throw new Error('A submission needs stable operation, hash, schema and scope identities.')
  validateAuthorityVersion(submission.baseAuthority)
  if (submission.items.length === 0) throw new Error('An empty plan cannot become a submission.')
  const itemIds = new Set<string>(), entityIds = new Set<string>(), creates = new Set<string>()
  let hasOrder = false
  for (const item of submission.items) {
    if (!item.id || itemIds.has(item.id)) throw new Error('Submission item identities must be unique.')
    itemIds.add(item.id)
    if (item.kind === 'order') {
      if (hasOrder) throw new Error('A submission can contain only one order item.')
      hasOrder = true
      const before = item.before.map(serverIdentityKey)
      if (new Set(before).size !== before.length) throw new Error('Order base contains duplicate identities.')
      continue
    }
    if (!item.entityId || entityIds.has(item.entityId)) throw new Error('A normalized submission has at most one item per entity.')
    entityIds.add(item.entityId)
    if (item.kind === 'create') {
      creates.add(item.id); ownDocument(item.document)
      if (item.proposedKey !== undefined) serverKeyIdentity(item.proposedKey)
      if (item.restores) {
        validateServerIdentity(item.restores.identity)
        if (!item.restores.operationId || !item.restores.itemId) throw new Error('Restoration requires an exact deletion operation and item identity.')
      }
    } else {
      validateServerIdentity(item.identity); ownDocument(item.before)
      if (item.kind === 'update') {
        const after = ownDocument(item.after)
        if (!encodedValuesEqual(applyDocumentPatches(item.before, item.writes), after))
          throw new Error('The declared write set does not produce the complete proposed document.')
      }
    }
  }
  for (const item of submission.items) if (item.kind === 'order') {
    const members = new Set(item.before.map(serverIdentityKey))
    for (const mutation of submission.items) {
      if (mutation.kind === 'delete') {
        if (!members.delete(serverIdentityKey(mutation.identity))) throw new Error('An ordered deletion must belong to the complete order base.')
      } else if (mutation.kind === 'update' && !members.has(serverIdentityKey(mutation.identity))) {
        throw new Error('An ordered update must belong to the complete order base.')
      }
    }
    const identities = item.after.map(ref => {
      if (ref.kind === 'bound') {
        if (!members.has(serverIdentityKey(ref.identity))) throw new Error('Order target cannot add an unbound or deleted incarnation.')
        return `bound:${serverIdentityKey(ref.identity)}`
      }
      if (!creates.has(ref.itemId)) throw new Error('Order references a creation outside its submission.')
      return `create:${ref.itemId}`
    })
    if (new Set(identities).size !== identities.length) throw new Error('Order target contains duplicate references.')
    if (identities.length !== members.size + creates.size) throw new Error('Order target must retain every surviving entity and submitted creation.')
  }
  const covered = new Set<string>(), coveredItems = new Set<string>()
  for (const entry of submission.coverage) {
    if (!itemIds.has(entry.itemId) || coveredItems.has(entry.itemId) || entry.intentIds.length === 0)
      throw new Error('Every item must have one nonempty coverage entry.')
    coveredItems.add(entry.itemId)
    for (const intentId of entry.intentIds) {
      if (!intentId || covered.has(intentId)) throw new Error('An intent cannot be covered by multiple submission items.')
      covered.add(intentId)
    }
  }
  if (coveredItems.size !== itemIds.size) throw new Error('Every submission item requires exact coverage.')
  if (submission.frontier.some(id => !covered.has(id)) || new Set(submission.frontier).size !== submission.frontier.length)
    throw new Error('The submitted frontier must refer to covered intents exactly once.')
}

export function validateExactReceipt(submission: FrozenSubmission, receipt: ExactReceipt) {
  validateFrozenSubmission(submission)
  if (!sameScope(submission.scope, receipt.scope) || receipt.operationId !== submission.operationId || receipt.payloadHash !== submission.payloadHash)
    throw new Error('Receipt does not belong to this frozen submission.')
  if (!authorityCovers(receipt.committedVersion, submission.baseAuthority)) throw new Error('A receipt cannot precede its write base.')
  const items = new Map(submission.items.map(item => [item.id, item] as const))
  const seen = new Set<string>(), keys = new Set<string>()
  for (const result of receipt.results) {
    const item = items.get(result.itemId)
    if (!item || seen.has(result.itemId)) throw new Error('Receipt items must match the request exactly once.')
    seen.add(result.itemId)
    if (item.kind === 'order') {
      if (result.kind !== 'ordered') throw new Error('Receipt result kind does not match its item.')
      const ordered = result.canonicalOrder.map(serverIdentityKey)
      if (new Set(ordered).size !== ordered.length) throw new Error('Canonical order contains duplicate identities.')
    } else if (item.kind === 'create') {
      if (result.kind !== 'created') throw new Error('Receipt result kind does not match its item.')
      validateServerIdentity(result.identity); ownDocument(result.canonical)
      if (item.restores && sameServerIdentity(item.restores.identity, result.identity)) throw new Error('Restoration must create a new incarnation.')
    } else {
      if ((item.kind === 'update' && result.kind !== 'updated') || (item.kind === 'delete' && result.kind !== 'deleted'))
        throw new Error('Receipt result kind does not match its item.')
      if (result.kind !== 'updated' && result.kind !== 'deleted') throw new Error('Invalid entity receipt.')
      if (!sameServerIdentity(item.identity, result.identity)) throw new Error('Receipt cannot change an existing entity incarnation.')
      if (result.kind === 'updated') ownDocument(result.canonical)
    }
    if (result.kind === 'created' || result.kind === 'updated') {
      const key = serverKeyIdentity(result.identity.key)
      if (keys.has(key)) throw new Error('Receipt binds multiple entities to one server key.')
      keys.add(key)
    }
  }
  if (seen.size !== items.size) throw new Error('An atomic receipt cannot omit submission items.')
  for (const result of receipt.results) if (result.kind === 'ordered') {
    const item = items.get(result.itemId)
    if (item?.kind !== 'order') throw new Error('Invalid order result.')
    const expected = new Set(item.after.map(ref => {
      if (ref.kind === 'bound') return serverIdentityKey(ref.identity)
      const created = receipt.results.find(result => result.itemId === ref.itemId)
      if (created?.kind !== 'created') throw new Error('A canonical order requires every referenced creation result.')
      return serverIdentityKey(created.identity)
    }))
    if (result.canonicalOrder.length !== expected.size || result.canonicalOrder.some(identity => !expected.has(serverIdentityKey(identity))))
      throw new Error('Canonical ordering must retain exactly the submitted entity membership.')
  }
}
