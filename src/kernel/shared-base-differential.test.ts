import { expect, it } from 'vitest'
import { SharedFrontiers, type SharedFrontier } from './shared-frontier.js'
import { sharedBaseResolver, type BaseFact } from './shared-base.js'
import { seededRandom } from '../../tests/kernel/generated-trace.js'
import { kernelId, type Document, type Patch, type ResourceValue } from './model.js'
import { operationResource, resourceAtDocument, type RowOperation, type RowResource } from './resources.js'

// Characterization of the current ordered array fold. Shares document patch
// semantics intentionally; it independently enumerates every ancestor instead
// of using the candidate's memoization or persistent item membership.
function arrayBase(ids: readonly string[], facts: ReadonlyMap<string, BaseFact>, resource: RowResource, fallback: ResourceValue, local: readonly RowOperation[]) {
  let value = fallback, resolved = false
  const seen = new Set<string>()
  for (const id of ids) {
    const fact = facts.get(id)
    if (fact?.kind === 'canonical') {
      if (seen.has(fact.item)) continue
      seen.add(fact.item); value = resourceAtDocument(fact.document, resource); resolved = true
    } else if (fact?.kind === 'unsettled') {
      if (resolved) value = operationResource(resource, value, fact.operation)
      else if (fact.operation.kind === 'create') { value = resourceAtDocument(fact.operation.document, resource); resolved = true }
    }
  }
  if (resolved) for (const operation of local) value = operationResource(resource, value, operation)
  return value
}
function outcome(run: () => ResourceValue) {
  try { return { value: run() } } catch (error) {
    if (!(error instanceof Error) || !['The authored write domain cannot materialize its nested write.', 'A write parent is missing or is not an object.'].includes(error.message)) throw error
    return { error: error.message }
  }
}
it.each(Array.from({ length: 32 }, (_, seed) => seed))('matches ordered array bases across nested domains and branches for seed %i', seed => {
  const random = seededRandom(seed), entityId = kernelId<'entity'>('a')
  const ids = Array.from({ length: 40 }, (_, index) => String(index)), arena = new SharedFrontiers(ids)
  const documents: (Document | null)[] = [null, {}, { profile: null, hidden: 7 }, { profile: { x: 2, y: 3 }, hidden: 9 }]
  const write = (patch: Patch): RowOperation => ({ kind: 'write', entityId, groups: [{ id: kernelId<'write-group'>('group'), expectations: [], writes: [patch] }] })
  const operations: RowOperation[] = [
    write({ kind: 'set', path: ['profile','x'], value: 11 }), write({ kind: 'remove', path: ['profile'] }),
    write({ kind: 'set', path: ['profile'], value: null }), write({ kind: 'set', path: ['profile'], value: { x: 5 } }),
    { kind: 'create', entityId, document: { profile: { x: 1 }, hidden: 7 } },
    { kind: 'replace', entityId, document: { hidden: 13 }, expected: { resource: { kind: 'entity', entityId }, role: 'write-base', expected: { kind: 'missing' }, anchor: { kind: 'authority', observation: kernelId<'observation'>('read') } } },
  ]
  const facts = new Map<string, BaseFact>(ids.map(id => {
    const choice = random(3), item = random(documents.length)
    return [id, choice === 0 ? { kind: 'canonical', item: String(item), document: documents[item]! } : choice === 1 ? { kind: 'unsettled', operation: operations[random(operations.length)]! } : { kind: 'skip' }]
  }))
  const resources: RowResource[] = [{ kind: 'entity', entityId }, { kind: 'path', entityId, path: ['profile'] }, { kind: 'path', entityId, path: ['profile','x'] }, { kind: 'path', entityId, path: ['hidden'] }]
  const items = new SharedFrontiers(documents.map((_, index) => String(index)))
  const resolvers = resources.map(resource => sharedBaseResolver(arena, resource, facts, items))
  const branches: { root: SharedFrontier | null; ids: string[] }[] = [{ root: null, ids: [] }]
  for (let step = 0; step < 150; step++) {
    const parent = branches[random(branches.length)]!, id = ids[random(ids.length)]!
    if (parent.ids.includes(id)) continue
    const root = arena.append(parent.root,id), ordered = [...parent.ids,id], local = random(2) ? [operations[random(operations.length)]!] : []
    const fallback: ResourceValue = random(2) ? { kind: 'missing' } : { kind: 'value', value: null }
    for (const [index, resource] of resources.entries()) {
      const expected = outcome(() => arrayBase(ordered, facts, resource, fallback, local))
      expect(outcome(() => resolvers[index]!.resolve(root, fallback, local)), JSON.stringify({ seed, step, ordered, resource, local })).toEqual(expected)
      expect(outcome(() => resolvers[index]!.resolve(parent.root, fallback)), JSON.stringify({ seed, step, parent: parent.ids, resource })).toEqual(outcome(() => arrayBase(parent.ids, facts, resource, fallback, [])))
    }
    branches.push({ root, ids: ordered })
  }
})
