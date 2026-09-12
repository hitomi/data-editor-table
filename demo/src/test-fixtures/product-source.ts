import { hashSubmission, kernelId, type FrozenSubmission } from 'data-editor-table'
import { openDemoSource } from '../demo-source.js'

export async function exerciseProductSource(name: string) {
  const scope = { sourceId: name, id: kernelId<'scope'>('products'), epoch: kernelId<'scope-epoch'>('v1') }
  const initial = [{ name: 'Original', quantity: 1, status: 'draft', active: false, hidden: { retained: 7 } }]
  const first = await openDemoSource(scope, initial, () => {}, false)
  const second = await openDemoSource(scope, [{ ...initial[0]!, name: 'Must not reseed' }], () => {}, false)
  const baseline = await first.readAtLeast(scope, [])
  async function edit(value: string) {
    const item = { kind: 'update' as const, id: kernelId<'item'>(crypto.randomUUID()), entityId: kernelId<'entity'>('product'),
      identity: baseline.rows[0]!.identity, before: baseline.rows[0]!.document, after: { ...baseline.rows[0]!.document, name: value },
      writes: [{ kind: 'set' as const, path: ['name'] as const, value }] }
    const payload = { workspaceId: kernelId<'workspace'>('fixture'), operationId: kernelId<'operation'>(crypto.randomUUID()), scope,
      schema: kernelId<'schema-version'>('v1'), baseAuthority: baseline.version, items: [item], coverage: [{ itemId: item.id, intentIds: [kernelId<'intent'>('edit')] }], frontier: [] }
    return { ...payload, payloadHash: await hashSubmission(payload) } satisfies FrozenSubmission
  }
  const alpha = await edit('Alpha'), beta = await edit('Beta')
  const outcomes = await Promise.all([first.submit(alpha), second.submit(beta)])
  const applied = outcomes[0]!.kind === 'applied' ? alpha : beta
  const repeat = await second.submit(applied)
  const lookup = await first.lookupOperation(applied)
  const late = await edit('Late')
  const negative = await second.lookupOperation(late), fenced = await first.submit(late)
  const wrongHash = { ...applied, payloadHash: kernelId<'payload-hash'>('different') }
  let mismatch = false
  try { await first.lookupOperation(wrongHash) } catch { mismatch = true }
  const latest = await first.readAtLeast(scope, [])
  return { baseline, outcomes, repeat, lookup, negative, fenced, latest, mismatch, applied }
}
export async function reopenDemoSource(name: string, operation: FrozenSubmission) {
  const source = await openDemoSource(operation.scope, [{ name: 'Do not overwrite', quantity: 0, status: 'draft', active: true }], () => {}, false)
  if (name !== source.id) throw new Error('Wrong source')
  return { authority: await source.readAtLeast(operation.scope, []), outcome: await source.lookupOperation(operation) }
}

export async function exerciseDemoStructure(name: string) {
  const scope = { sourceId: name, id: kernelId<'scope'>('products'), epoch: kernelId<'scope-epoch'>('v1') }
  const source = await openDemoSource(scope, [{ name: 'Original', hidden: 7 }], document => { if (document.name === 'Invalid') throw new Error('Invalid row') }, true)
  async function submit(items: FrozenSubmission['items']) {
    const before = await source.readAtLeast(scope, [])
    const payload = { workspaceId: kernelId<'workspace'>('fixture'), operationId: kernelId<'operation'>(crypto.randomUUID()), scope, schema: kernelId<'schema-version'>('v1'),
      baseAuthority: before.version, items, coverage: items.map(item => ({ itemId: item.id, intentIds: [kernelId<'intent'>(item.id)] })), frontier: [] }
    const request = { ...payload, payloadHash: await hashSubmission(payload) }
    return { request, result: await source.submit(request) }
  }
  const before = await source.readAtLeast(scope, [])
  const createdId = kernelId<'item'>('create'), entityId = kernelId<'entity'>('new')
  const created = await submit([{ kind: 'create', id: createdId, entityId, proposedKey: 'new-key', document: { name: 'New', hidden: 8 } },
    { kind: 'order', id: kernelId<'item'>('order'), before: before.order, after: [{ kind: 'created-in-submission', itemId: createdId }, ...before.order.map(identity => ({ kind: 'bound' as const, identity }))] }])
  const ordered = await source.readAtLeast(scope, [])
  const added = ordered.rows[0]!
  const deletion = await submit([{ kind: 'delete', id: kernelId<'item'>('delete'), entityId, identity: added.identity, before: added.document }])
  const restored = await submit([{ kind: 'create', id: kernelId<'item'>('restore'), entityId, proposedKey: added.identity.key, document: added.document,
    restores: { identity: added.identity, operationId: deletion.request.operationId, itemId: kernelId<'item'>('delete') } }])
  const afterRestore = await source.readAtLeast(scope, [])
  const original = afterRestore.rows[0]!
  const invalid = await submit([{ kind: 'update', id: kernelId<'item'>('edit'), entityId: kernelId<'entity'>('original'), identity: original.identity,
    before: original.document, after: { ...original.document, name: 'Must roll back' }, writes: [{ kind: 'set', path: ['name'], value: 'Must roll back' }] },
    { kind: 'create', id: kernelId<'item'>('invalid'), entityId: kernelId<'entity'>('invalid'), document: { name: 'Invalid' } }])
  const afterRejected = await source.readAtLeast(scope, [])
  source.failNextSave()
  const failed = await submit([{ kind: 'update', id: kernelId<'item'>('fail'), entityId: kernelId<'entity'>('original'), identity: original.identity,
    before: original.document, after: { ...original.document, name: 'Do not apply' }, writes: [{ kind: 'set', path: ['name'], value: 'Do not apply' }] }])
  const failureLookup = await source.lookupOperation(failed.request)
  let staleChangeRejected = false
  try { await source.changeDocument(added.identity, () => ({ name: 'Stale incarnation' })) } catch { staleChangeRejected = true }
  await source.changeDocument(original.identity, document => ({ ...document, name: 'External' }))
  return { created: created.result, ordered, deletion: deletion.result, restored: restored.result, afterRestore, invalid: invalid.result, afterRejected,
    failed: failed.result, failureLookup, staleChangeRejected, external: await source.readAtLeast(scope, []) }
}
