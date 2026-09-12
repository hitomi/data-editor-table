import { describe, expect, it } from 'vitest'
import { createdBindingsForReceipt, reconcileEntityRegistry, registerLocalEntity } from './entities.js'
import { kernelId, type CompleteAuthority, type ExactReceipt, type FrozenSubmission } from './model.js'
import { ownCompleteAuthority } from './protocol.js'

const first = kernelId<'entity'>('first'), second = kernelId<'entity'>('second')
const create = kernelId<'intent'>('create')
const scope = { sourceId: 'fixture-source', id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
const version = { kind: 'ordered' as const, token: 'v1', position: '1' }
const oldIdentity = { key: 'same-key', incarnation: 'life1' }
const newIdentity = { key: 'same-key', incarnation: 'life2' }
function snapshot(entities: CompleteAuthority['entities']) {
  return ownCompleteAuthority({ scope, observation: kernelId<'observation'>('read'), version, entities, order: entities.map(row => row.entityId) })
}
const row = (entityId = first, identity = oldIdentity) => ({ entityId, identity, document: { x: 1 } })

describe('entity lifetime registry', () => {
  it('retains the original ID after deletion and isolates a reused key', () => {
    const initial = reconcileEntityRegistry([], snapshot([row()]))
    const next = reconcileEntityRegistry(initial, snapshot([row(second, newIdentity)]))
    expect(next).toEqual([
      { kind: 'retired', entityId: first, identity: oldIdentity },
      { kind: 'bound', entityId: second, identity: newIdentity },
    ])
    expect(initial).toEqual([{ kind: 'bound', entityId: first, identity: oldIdentity }])
    expect(() => registerLocalEntity(next, first, create)).toThrow('cannot be reused')
    expect(() => reconcileEntityRegistry(next, snapshot([row()]))).toThrow('retired')
  })

  it('rejects both changes of incarnation and reassignment to a fresh client ID', () => {
    const initial = reconcileEntityRegistry([], snapshot([row()]))
    expect(() => reconcileEntityRegistry(initial, snapshot([row(first, newIdentity)]))).toThrow('cannot change')
    expect(() => reconcileEntityRegistry(initial, snapshot([row(second)]))).toThrow('cannot reassign')
  })

  it('keeps an unsaved local creation across refreshes and refuses guessed bindings', () => {
    const local = registerLocalEntity([], first, create)
    expect(reconcileEntityRegistry(local, snapshot([]))).toEqual(local)
    expect(() => reconcileEntityRegistry(local, snapshot([row()]))).toThrow('without an exact receipt')
  })

  it('binds a creation from its exact item receipt and preserves its ID', () => {
    const local = registerLocalEntity([], first, create)
    const item = kernelId<'item'>('item')
    const request: FrozenSubmission = {
      workspaceId: kernelId<'workspace'>('workspace'),
      scope, operationId: kernelId<'operation'>('operation'), payloadHash: kernelId<'payload-hash'>('hash'), schema: kernelId<'schema-version'>('schema'),
      baseAuthority: version, items: [{ kind: 'create', id: item, entityId: first, document: { x: 1 } }],
      coverage: [{ itemId: item, intentIds: [create] }], frontier: [create],
    }
    const receipt: ExactReceipt = {
      scope, operationId: request.operationId, payloadHash: request.payloadHash, committedVersion: { kind: 'ordered', token: 'v2', position: '2' },
      results: [{ kind: 'created', itemId: item, identity: oldIdentity, canonical: { x: 1.5 } }],
    }
    const bindings = createdBindingsForReceipt(request, receipt)
    expect(reconcileEntityRegistry(local, snapshot([row()]), bindings)).toEqual([{ kind: 'bound', entityId: first, identity: oldIdentity }])
    expect(() => createdBindingsForReceipt(request, { ...receipt, results: [] })).toThrow('omit')
    expect(() => reconcileEntityRegistry(local, snapshot([]), [...bindings, ...bindings])).toThrow('twice')
    expect(local[0]?.kind).toBe('local')
  })

  it('records a creation already removed by a later remote write as retired', () => {
    const local = registerLocalEntity([], first, create)
    expect(reconcileEntityRegistry(local, snapshot([]), [{ entityId: first, identity: oldIdentity }]))
      .toEqual([{ kind: 'retired', entityId: first, identity: oldIdentity }])
  })

  it('rejects an entire registry transition when a later row reuses an identity', () => {
    const initial = reconcileEntityRegistry([], snapshot([row()]))
    expect(() => reconcileEntityRegistry(initial, snapshot([row(second, newIdentity), row(first, { key: 'another-key', incarnation: 'life3' })])))
      .toThrow('cannot change')
    expect(initial).toEqual([{ kind: 'bound', entityId: first, identity: oldIdentity }])
  })
})
