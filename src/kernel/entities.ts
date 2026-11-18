import type { CompleteAuthority, EntityBinding, EntityId, ExactReceipt, FrozenSubmission, IntentId, ServerIdentity } from './model.js'
import { sameServerIdentity, serverIdentityKey, validateExactReceipt } from './protocol.js'

export type EntityRegistry = readonly EntityBinding[]
export type CreatedBinding = Readonly<{ entityId: EntityId; identity: ServerIdentity }>

/** Registry entries outlive display rows. A retired ID is never reused, even
 * when the new server row has the same business key as a deleted row.
 */
export function registerLocalEntity(registry: EntityRegistry, entityId: EntityId, creationIntentId: IntentId): EntityRegistry {
  if (!entityId || !creationIntentId) throw new Error('Local creation requires entity and intent identities.')
  if (registry.some(entry => entry.entityId === entityId)) throw new Error('An entity identity cannot be reused.')
  return Object.freeze([...registry, Object.freeze({ kind: 'local' as const, entityId, creationIntentId })])
}

export function createdBindingsForReceipt(submission: FrozenSubmission, receipt: ExactReceipt): readonly CreatedBinding[] {
  validateExactReceipt(submission, receipt)
  const bindings: CreatedBinding[] = []
  for (const result of receipt.results) {
    if (result.kind !== 'created') continue
    const item = submission.items.find(item => item.id === result.itemId)
    if (item?.kind !== 'create') throw new Error('A creation result requires a matching creation item.')
    bindings.push(Object.freeze({ entityId: item.entityId, identity: Object.freeze({ ...result.identity }) }))
  }
  return Object.freeze(bindings)
}

/** Called within the authority/receipt settlement transition, after the
 * authority freshness barrier has passed. `created` comes only from the exact
 * receipt; key equality or a row appearing in a refresh cannot bind a creation.
 * A later snapshot can already omit a just-created entity: retain its exact
 * binding as retired so history and late tasks still refer to that lifetime.
 */
export function reconcileEntityRegistry(
  registry: EntityRegistry,
  snapshot: CompleteAuthority,
  created: readonly CreatedBinding[] = [],
): EntityRegistry {
  const entries = new Map<EntityId, EntityBinding>()
  const identities = new Map<string, EntityId>()
  for (const entry of registry) {
    if (entries.has(entry.entityId)) throw new Error('Duplicate registry entity identity.')
    entries.set(entry.entityId, entry)
    if (entry.kind !== 'local') {
      const identity = serverIdentityKey(entry.identity)
      if (identities.has(identity)) throw new Error('One incarnation cannot belong to multiple entities.')
      identities.set(identity, entry.entityId)
    }
  }
  const bound = new Set<EntityId>()
  for (const binding of created) {
    if (bound.has(binding.entityId)) throw new Error('A receipt cannot bind an entity twice.')
    bound.add(binding.entityId)
    const previous = entries.get(binding.entityId)
    if (!previous || previous.kind !== 'local') throw new Error('Only a registered local creation may acquire a server identity.')
    const identity = serverIdentityKey(binding.identity)
    if (identities.has(identity)) throw new Error('A creation cannot reuse a known server incarnation.')
    identities.set(identity, binding.entityId)
    entries.set(binding.entityId, Object.freeze({ kind: 'bound', entityId: binding.entityId, identity: Object.freeze({ ...binding.identity }) }))
  }
  const present = new Set<EntityId>()
  for (const row of snapshot.entities) {
    if (present.has(row.entityId)) throw new Error('Duplicate authority entity identity.')
    present.add(row.entityId)
    const previous = entries.get(row.entityId)
    if (previous?.kind === 'local') throw new Error('A refresh cannot bind a local creation without an exact receipt.')
    if (previous?.kind === 'retired') throw new Error('A retired entity cannot reappear; restoration requires a new incarnation.')
    if (previous && !sameServerIdentity(previous.identity, row.identity)) throw new Error('A stable entity identity cannot change its server incarnation.')
    const identity = serverIdentityKey(row.identity)
    const owner = identities.get(identity)
    if (owner && owner !== row.entityId) throw new Error('An authority observation cannot reassign an incarnation to another entity.')
    identities.set(identity, row.entityId)
    entries.set(row.entityId, Object.freeze({ kind: 'bound', entityId: row.entityId, identity: Object.freeze({ ...row.identity }) }))
  }
  for (const [id, entry] of entries) if (entry.kind === 'bound' && !present.has(id)) {
    entries.set(id, Object.freeze({ ...entry, kind: 'retired' }))
  }
  return Object.freeze([...entries.values()])
}
