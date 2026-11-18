import type { Document, ResourceValue } from './model.js'
import type { RowOperation, RowResource } from './resources.js'
import { operationResource, resourceAtDocument } from './resources.js'
import { SharedFrontiers, type SharedFrontier } from './shared-frontier.js'

export type BaseFact = Readonly<{ kind: 'skip' }> | Readonly<{ kind: 'canonical'; item: string; document: Document | null }>
  | Readonly<{ kind: 'unsettled'; operation: RowOperation }>
type Fold = Readonly<{ value: ResourceValue | null; items: SharedFrontier | null }>

/** Incremental fold for one resource and one immutable fact context.
 * Null means no canonical/create base, distinct from ResourceValue.missing.
 * Caller fallback and same-intent prefix never enter the shared cache. */
export function sharedBaseResolver(frontiers: SharedFrontiers, resource: RowResource, facts: Readonly<{ get(id: string): BaseFact | undefined }>, items: SharedFrontiers) {
  const cache = new Map<SharedFrontier | null, Fold>([[null, { value: null, items: null }]])
  let evaluated = 0
  return {
    get evaluated() { return evaluated },
    resolve(frontier: SharedFrontier | null, fallback: ResourceValue, localPrefix: Iterable<RowOperation> = []): ResourceValue {
      frontiers.has(frontier, '') // validates arena ownership, including cached roots
      const pending: SharedFrontier[] = []
      for (let node = frontier; node && !cache.has(node); node = node.parent) pending.push(node)
      for (let index = pending.length - 1; index >= 0; index--) {
        const node = pending[index]!, previous = cache.get(node.parent)!, fact = facts.get(node.intent)
        let value = previous.value, seen = previous.items
        if (fact?.kind === 'canonical' && !items.has(seen, fact.item)) {
          seen = items.append(seen, fact.item); value = resourceAtDocument(fact.document, resource)
        } else if (fact?.kind === 'unsettled') {
          if (value !== null) value = operationResource(resource, value, fact.operation)
          else if (fact.operation.kind === 'create') value = resourceAtDocument(fact.operation.document, resource)
        }
        cache.set(node, Object.freeze({ value, items: seen })); evaluated++
      }
      let value = cache.get(frontier)!.value
      if (value === null) return fallback
      for (const operation of localPrefix) value = operationResource(resource, value, operation)
      return value
    },
  }
}
