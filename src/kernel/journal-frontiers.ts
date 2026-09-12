import { frontierScope } from './frontier-table.js'
import { compileFrontierChecks } from './frontier-checks.js'
import { declaredOrderOperation, declaredRowOperation } from './intent.js'
import type { KernelState } from './state.js'

/** Validate the complete durable reference closure, including inactive history
 * and fallback anchors. A digest alone does not establish valid references. */
export function assertJournalFrontiers(state: KernelState): void {
  const table = state.journal.frontiers
  const { check, anchor, sequence } = compileFrontierChecks(table, state.journal.intents, frontierScope(state.workspace))
  for (const intent of state.journal.intents) {
    const dependencies = intent.dependencies, row = declaredRowOperation(intent), order = declaredOrderOperation(intent)
    check(intent.dependencies, intent.sequence)
    if (row?.kind === 'write') for (const group of row.groups) for (const expected of group.expectations) anchor(expected.anchor, intent.sequence, dependencies)
    else if (row?.kind === 'replace' || row?.kind === 'delete') anchor(row.expected.anchor, intent.sequence, dependencies)
    if (order) anchor(order.anchor, intent.sequence, dependencies)
    if (intent.operation.kind === 'undo' || intent.operation.kind === 'undo-order') check(intent.operation.frontier, intent.sequence, dependencies)
  }
  for (const action of state.journal.actions) {
    const first = action.intentIds.reduce((first, id) => Math.min(first, sequence(id) ?? -1), Infinity)
    check(action.orderBase.frontier, first)
  }
}
