import { canonicalEncodedValue, ownEncodedValue } from './document.js'
import { kernelId, type AuthorityFrontier, type AuthorityVersion, type CompleteAuthority, type Document, type EntityId, type FrozenSubmission,
  type ObservationId, type OperationLookup, type PayloadHash, type ScopeIdentity, type ServerIdentity } from './model.js'
import { ownAuthorityVersion, sameScope, serverIdentityKey, serverKeyIdentity } from './protocol.js'
import type { SubmissionRef } from './persistence.js'
import type { KernelState } from './state.js'

export type ServerAuthority = Readonly<{
  scope: ScopeIdentity
  observation: ObservationId
  version: AuthorityVersion
  rows: readonly Readonly<{ identity: ServerIdentity; document: Document }>[]
  order: readonly ServerIdentity[]
}>
export type SourceMutationResult = OperationLookup | Readonly<{ kind: 'applied-without-receipt'; commitToken: string }>
/** Sources with the same id refer to the same physical authority and share
 * scope write exclusion, even when multiple adapter objects wrap that source.
 * These capabilities are backend guarantees, not features synthesized from a
 * successful HTTP response or from a client-side rows cache.
 */
export type PersistenceSource = Readonly<{
  id: string
  capabilities: Readonly<{
    atomicScopeWrites: true
    durableOperationLookup: true
    operationIdFence: 'scope-epoch'
    authorityOrder: 'ordered' | 'causal'
    identity: 'incarnation' | 'no-key-reuse-in-epoch'
    operationRetentionMs: number
    /** True guarantees recreation from the complete retained document, with
     * source validation of the exact deletion proof and a new incarnation.
     * A backend that cannot reconstruct its generated/read-only fields must
     * leave this false until it implements an explicit restoration protocol. */
    restoreDeleted: boolean
  }>
  readAtLeast(scope: ScopeIdentity, frontier: AuthorityFrontier): Promise<ServerAuthority>
  submit(submission: FrozenSubmission): Promise<SourceMutationResult>
  lookupOperation(ref: SubmissionRef): Promise<OperationLookup>
}>

export function ownServerAuthority(raw: ServerAuthority): ServerAuthority {
  const snapshot = ownEncodedValue(raw) as unknown as ServerAuthority
  if (!snapshot.scope.sourceId || !snapshot.scope.id || !snapshot.scope.epoch || !snapshot.observation) throw new Error('A server snapshot requires scope, epoch and observation identities.')
  ownAuthorityVersion(snapshot.version)
  const identities = new Set<string>(), keys = new Set<string>()
  for (const row of snapshot.rows) {
    const identity = serverIdentityKey(row.identity), key = serverKeyIdentity(row.identity.key)
    if (identities.has(identity) || keys.has(key)) throw new Error('A complete server snapshot must contain unique row identities and keys.')
    if (typeof row.document !== 'object' || row.document === null || Array.isArray(row.document)) throw new Error('A server row requires a complete document.')
    identities.add(identity); keys.add(key)
  }
  const order = snapshot.order.map(serverIdentityKey)
  if (order.length !== identities.size || new Set(order).size !== order.length || order.some(id => !identities.has(id)))
    throw new Error('A complete server order must include every row incarnation exactly once.')
  return snapshot
}

function knownBindings(state: KernelState): Map<string, EntityId> {
  const known = new Map<string, EntityId>()
  const insert = (identity: ServerIdentity, entityId: EntityId) => {
    const key = serverIdentityKey(identity), previous = known.get(key)
    if (previous && previous !== entityId) throw new Error('An exact creation result conflicts with an already-published entity identity.')
    known.set(key, entityId)
  }
  for (const binding of state.entities) if (binding.kind !== 'local') insert(binding.identity, binding.entityId)
  for (const fact of state.commits) for (const result of fact.receipt.results) if (result.kind === 'created') {
    const item = fact.submission.items.find(item => item.id === result.itemId)
    if (item?.kind !== 'create') throw new Error('A creation receipt is missing its original local entity.')
    insert(result.identity, item.entityId)
  }
  return known
}

export function unboundServerIdentities(state: KernelState, raw: ServerAuthority): readonly ServerIdentity[] {
  const snapshot = ownServerAuthority(raw), known = knownBindings(state)
  if (!sameScope(snapshot.scope, state.workspace.scope)) throw new Error('Server snapshot belongs to another workspace scope.')
  return Object.freeze(snapshot.rows.filter(row => !known.has(serverIdentityKey(row.identity))).map(row => row.identity))
}

/** Runtime allocates IDs for unknown incarnations. Key equality with an
 * uncommitted local creation never participates in this mapping. Pending exact
 * receipts are considered before allocating, even before their read barrier.
 */
export function bindServerAuthority(state: KernelState, raw: ServerAuthority,
  allocations: readonly Readonly<{ identity: ServerIdentity; entityId: EntityId }>[],
): CompleteAuthority {
  const snapshot = ownServerAuthority(raw), known = knownBindings(state)
  if (!sameScope(snapshot.scope, state.workspace.scope)) throw new Error('Server snapshot belongs to another workspace scope.')
  const unknown = new Set(snapshot.rows.filter(row => !known.has(serverIdentityKey(row.identity))).map(row => serverIdentityKey(row.identity)))
  const ids = new Set(state.entities.map(binding => binding.entityId))
  for (const allocation of allocations) {
    const identity = serverIdentityKey(allocation.identity)
    if (!allocation.entityId || !unknown.delete(identity) || ids.has(allocation.entityId)) throw new Error('Each unknown incarnation requires exactly one unused entity identity.')
    ids.add(allocation.entityId); known.set(identity, allocation.entityId)
  }
  if (unknown.size) throw new Error('A complete snapshot cannot omit identity allocation for any row.')
  return ownEncodedValue({ scope: snapshot.scope, observation: snapshot.observation, version: snapshot.version,
    entities: snapshot.rows.map(row => ({ entityId: known.get(serverIdentityKey(row.identity))!, identity: row.identity, document: row.document })),
    order: snapshot.order.map(identity => known.get(serverIdentityKey(identity))!),
  }) as unknown as CompleteAuthority
}

/** The digest covers the entire immutable protocol payload, including local
 * coverage. The digest field itself is excluded. Sources can forward this
 * envelope or persist its digest together with their translated wire request.
 */
export async function hashSubmission(submission: Omit<FrozenSubmission, 'payloadHash'>): Promise<PayloadHash> {
  // Pick protocol fields explicitly so an object that also has payloadHash
  // produces exactly the same digest, without a self-referential hash.
  const payload = ownEncodedValue({ workspaceId: submission.workspaceId, operationId: submission.operationId, scope: submission.scope, schema: submission.schema,
    baseAuthority: submission.baseAuthority, items: submission.items, coverage: submission.coverage, frontier: submission.frontier,
  })
  const bytes = new TextEncoder().encode(canonicalEncodedValue(payload))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return kernelId<'payload-hash'>(`sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`)
}
