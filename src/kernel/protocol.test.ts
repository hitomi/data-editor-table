import { describe, expect, it } from 'vitest'
import { ownDocument } from './document.js'
import { kernelId, type AuthorityVersion, type CompleteAuthority, type ExactReceipt, type FrozenSubmission } from './model.js'
import { authorityCovers, authorityCoversFrontier, joinAuthorityFrontier, ownCompleteAuthority, sameServerIdentity, serverIdentityKey, validateExactReceipt, validateFrozenSubmission } from './protocol.js'

const scope = { sourceId: 'fixture-source', id: kernelId<'scope'>('test'), epoch: kernelId<'scope-epoch'>('epoch1') }
const entity = kernelId<'entity'>('entity1')
const item = kernelId<'item'>('item1')
const intent = kernelId<'intent'>('intent1')
const identity = { key: 'key1', incarnation: 'life1' }
const version = (position: string): AuthorityVersion => ({ kind: 'ordered', position, token: `version:${position}` })
function submission(): FrozenSubmission {
  return {
    workspaceId: kernelId<'workspace'>('workspace'),
    operationId: kernelId<'operation'>('operation1'), scope, schema: kernelId<'schema-version'>('schema1'),
    payloadHash: kernelId<'payload-hash'>('prepared-hash'), baseAuthority: version('1'),
    items: [{ kind: 'update', id: item, entityId: entity, identity, before: { x: 0, hidden: 'old' }, after: { x: 1, hidden: 'new' },
      writes: [{ kind: 'set', path: ['x'], value: 1 }, { kind: 'set', path: ['hidden'], value: 'new' }] }],
    coverage: [{ itemId: item, intentIds: [intent] }], frontier: [intent],
  }
}
function receipt(request = submission()): ExactReceipt {
  return { operationId: request.operationId, scope, payloadHash: request.payloadHash, committedVersion: version('2'),
    results: [{ kind: 'updated', itemId: item, identity, canonical: { x: 1.5, hidden: 'server-normalized' } }] }
}

describe('kernel authority evidence', () => {
  it('uses exact ordered versions beyond JavaScript numeric precision', () => {
    expect(authorityCovers(version('9007199254740993'), version('9007199254740992'))).toBe(true)
    expect(authorityCovers(version('9007199254740992'), version('9007199254740993'))).toBe(false)
    expect(() => authorityCovers(version('02'), version('1'))).toThrow('canonical')
    expect(() => authorityCovers(version('2'), { ...version('2'), token: 'conflicting' })).toThrow('conflicting')
  })

  it('retains incomparable causal frontiers until a read proves both', () => {
    const a = { kind: 'causal' as const, token: 'a', stamp: kernelId<'causal-stamp'>('a'), covers: [] }
    const b = { kind: 'causal' as const, token: 'b', stamp: kernelId<'causal-stamp'>('b'), covers: [] }
    const joined = joinAuthorityFrontier([a], [b])
    expect(joined).toHaveLength(2)
    expect(authorityCoversFrontier(b, joined)).toBe(false)
    expect(authorityCoversFrontier({ kind: 'causal', token: 'c', stamp: kernelId<'causal-stamp'>('c'), covers: [a.stamp, b.stamp] }, joined)).toBe(true)
    expect(() => authorityCovers(a, version('2'))).toThrow('ordering protocols')
  })

  it('owns complete authority and requires exact identity/order membership', () => {
    const document = { x: 1 }
    const snapshot: CompleteAuthority = { scope, observation: kernelId<'observation'>('read1'), version: version('1'),
      entities: [{ entityId: entity, identity, document }], order: [entity] }
    const owned = ownCompleteAuthority(snapshot)
    document.x = 8
    expect(owned.entities[0]?.document.x).toBe(1)
    expect(() => ownCompleteAuthority({ ...snapshot, order: [] })).toThrow('every entity')
    expect(() => ownCompleteAuthority({ ...snapshot, entities: [...snapshot.entities, { ...snapshot.entities[0]!, entityId: kernelId<'entity'>('other') }] })).toThrow('server keys')
    expect(sameServerIdentity(identity, { ...identity, incarnation: 'life2' })).toBe(false)
    expect(serverIdentityKey({ key: 1, incarnation: 'life' })).not.toBe(serverIdentityKey({ key: '1', incarnation: 'life' }))
  })
})

describe('frozen write and exact receipt contracts', () => {
  it('accepts canonical outputs independently of proposed values', () => {
    expect(() => validateExactReceipt(submission(), receipt())).not.toThrow()
  })

  it('rejects omitted hidden writes instead of treating display fields as the whole mutation', () => {
    const request = submission(), original = request.items[0]!
    if (original.kind !== 'update') throw new Error('Unexpected fixture')
    expect(() => validateFrozenSubmission({ ...request, items: [{ ...original, writes: original.writes.slice(0, 1) }] })).toThrow('complete proposed document')
    expect(original.before).toEqual({ x: 0, hidden: 'old' })
  })

  it('requires complete, nonoverlapping intent coverage', () => {
    const request = submission()
    expect(() => validateFrozenSubmission({ ...request, coverage: [] })).toThrow('coverage')
    expect(() => validateFrozenSubmission({ ...request, coverage: [{ itemId: item, intentIds: [intent, intent] }] })).toThrow('multiple')
    expect(() => validateFrozenSubmission({ ...request, frontier: [kernelId<'intent'>('not-submitted')] })).toThrow('covered')
  })

  it('permits same-request create references in persistent ordering', () => {
    const request = submission(), createId = kernelId<'item'>('create'), orderId = kernelId<'item'>('order')
    const a = kernelId<'intent'>('create-intent'), b = kernelId<'intent'>('order-intent')
    const withCreate: FrozenSubmission = { ...request, items: [
      { kind: 'create', id: createId, entityId: entity, document: ownDocument({ x: 1 }) },
      { kind: 'order', id: orderId, before: [], after: [{ kind: 'created-in-submission', itemId: createId }] },
    ], coverage: [{ itemId: createId, intentIds: [a] }, { itemId: orderId, intentIds: [b] }], frontier: [a, b] }
    expect(() => validateFrozenSubmission(withCreate)).not.toThrow()
    const order = withCreate.items[1]!
    if (order.kind !== 'order') throw new Error('Unexpected fixture')
    expect(() => validateFrozenSubmission({ ...withCreate, items: [withCreate.items[0]!, { ...order, after: [{ kind: 'created-in-submission', itemId: item }] }] })).toThrow('outside')
  })

  it('rejects mismatched, partial, duplicate and wrong-incarnation receipts', () => {
    const request = submission(), applied = receipt(request)
    for (const invalid of [
      { ...applied, payloadHash: kernelId<'payload-hash'>('other') },
      { ...applied, scope: { ...scope, epoch: kernelId<'scope-epoch'>('epoch2') } },
      { ...applied, committedVersion: version('0') },
      { ...applied, results: [] },
      { ...applied, results: [...applied.results, ...applied.results] },
      { ...applied, results: [{ kind: 'updated' as const, itemId: item, identity: { ...identity, incarnation: 'different' }, canonical: { x: 1 } }] },
    ]) expect(() => validateExactReceipt(request, invalid)).toThrow()
  })

  it('rejects request or canonical orders that drop valid rows', () => {
    const request = submission(), orderId = kernelId<'item'>('order'), orderIntent = kernelId<'intent'>('order-intent')
    const secondIdentity = { key: 'key2', incarnation: 'life2' }
    const withOrder: FrozenSubmission = { ...request,
      items: [...request.items, { kind: 'order', id: orderId, before: [identity, secondIdentity], after: [
        { kind: 'bound', identity: secondIdentity }, { kind: 'bound', identity },
      ] }],
      coverage: [...request.coverage, { itemId: orderId, intentIds: [orderIntent] }], frontier: [...request.frontier, orderIntent],
    }
    const applied: ExactReceipt = { ...receipt(withOrder), results: [...receipt(withOrder).results,
      { kind: 'ordered', itemId: orderId, canonicalOrder: [identity, secondIdentity] },
    ] }
    expect(() => validateExactReceipt(withOrder, applied)).not.toThrow()
    const order = withOrder.items[1]!
    if (order.kind !== 'order') throw new Error('Unexpected fixture')
    expect(() => validateFrozenSubmission({ ...withOrder, items: [request.items[0]!, { ...order, after: order.after.slice(0, 1) }] })).toThrow('every surviving')
    expect(() => validateExactReceipt(withOrder, { ...applied, results: [applied.results[0]!, { kind: 'ordered', itemId: orderId, canonicalOrder: [identity] }] })).toThrow('membership')
    expect(() => validateExactReceipt(withOrder, { ...applied, results: [applied.results[0]!, { kind: 'ordered', itemId: orderId, canonicalOrder: [identity, { ...secondIdentity, incarnation: 'wrong-life' }] }] })).toThrow('membership')
  })
})
