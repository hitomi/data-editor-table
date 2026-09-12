import type { KernelState } from './state.js'
import type { ExpectedResource, IntentRecord } from './model.js'
import { rowOperationForIntent } from './intent.js'
import type { RowOperation } from './resources.js'
import { SharedFrontiers } from './shared-frontier.js'
import { compileFrontierTable, frontierScope } from './frontier-table.js'
import { sharedBaseResolver, type BaseFact } from './shared-base.js'

/** Per-projection fact context. Restore each flat journal node once without
 * changing its order. No index or resolved value survives a KernelState change. */
export function compileSharedStateBases(state: KernelState) {
  const frontiers = compileFrontierTable(state.journal.frontiers, state.journal.intents.map(intent => intent.id), frontierScope(state.workspace))
  const arena = frontiers.arena
  const settlements = new Map(state.settlements.map(entry => [entry.intentId, entry]))
  const results = new Map(state.commits.flatMap(commit => commit.receipt.results.map(result => [JSON.stringify([commit.submission.operationId, result.itemId]), result] as const)))
  // Inventory and immutable membership nodes belong to this state context.
  // Each resource retains its own seen root and value in its resolver cache.
  const items = new SharedFrontiers([...results.keys()])
  const intents = new Map<string, IntentRecord>(state.journal.intents.map(intent => [intent.id, intent]))
  const resolvers = new Map<string, ReturnType<typeof sharedBaseResolver>>()
  return (expected: ExpectedResource, local: Iterable<RowOperation> = []) => {
    if (expected.role !== 'write-base' || expected.anchor.kind === 'authority' || expected.resource.kind === 'order') return expected.expected
    const root = frontiers.get(expected.anchor.kind === 'logical-output' ? expected.anchor.predecessor : expected.anchor.frontier)
    if (root === null) return expected.expected
    const entity = expected.resource.entityId
    const key = JSON.stringify(expected.resource)
    let resolver = resolvers.get(key)
    if (!resolver) {
      const facts = { get(id: string): BaseFact | undefined {
        const intent = intents.get(id)
        if (!intent || !('entityId' in intent.operation) || intent.operation.entityId !== entity) return undefined
        const settlement = settlements.get(intent.id)
        if (settlement?.kind === 'committed') {
          const item = JSON.stringify([settlement.operationId, settlement.itemId]), result = results.get(item)
          if (!result || result.kind === 'ordered') throw new Error('Committed intent is missing its exact entity result.')
          return { kind: 'canonical', item, document: result.kind === 'deleted' ? null : result.canonical }
        }
        if (!settlement) {
          const operation = rowOperationForIntent(state, intent)
          if (operation) return { kind: 'unsettled', operation }
        }
        return undefined
      } }
      resolver = sharedBaseResolver(arena, expected.resource, facts, items); resolvers.set(key, resolver)
    }
    return resolver.resolve(root,expected.expected,local)
  }
}
