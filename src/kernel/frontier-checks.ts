import { compileFrontierTable } from './frontier-table.js'
import type { Anchor, FrontierRef, FrontierTable, IntentId, IntentRecord } from './model.js'

/** One immutable candidate context for both admission and durable recovery. */
export function compileFrontierChecks(table: FrontierTable, intents: readonly Pick<IntentRecord, 'id' | 'sequence'>[], scope: string) {
  const compiled = compileFrontierTable(table, intents.map(intent => intent.id), scope)
  const sequences = new Map(intents.map(intent => [intent.id, intent.sequence]))
  const latest: number[] = []
  for (const node of table.nodes) {
    const sequence = sequences.get(node.intent)
    if (sequence === undefined) throw new Error('Unknown journal frontier intent.')
    latest.push(Math.max(sequence, node.parent === null ? -Infinity : latest[node.parent]!))
  }
  const checked = new Map<FrontierRef, Set<FrontierRef>>()
  const check = (ref: FrontierRef, sequence: number, dependencies?: FrontierRef) => {
    const node = compiled.get(ref)
    if (ref !== null && latest[ref]! >= sequence) throw new Error('Journal frontier must reference earlier causal dependencies.')
    if (dependencies !== undefined && !checked.get(ref)?.has(dependencies)) {
      if (!compiled.arena.isSubset(node, compiled.get(dependencies))) throw new Error('Journal frontier must reference earlier causal dependencies.')
      let matches = checked.get(ref)
      if (!matches) { matches = new Set(); checked.set(ref, matches) }
      matches.add(dependencies)
    }
  }
  const anchor = (value: Anchor, sequence: number, dependencies: FrontierRef) => {
    if (value.kind === 'authority') return
    if (value.kind === 'logical-output') check(value.predecessor, sequence, dependencies)
    else if (value.kind === 'submission-output') {
      check(value.frontier, sequence, dependencies)
      check(value.fallback.predecessor, sequence, dependencies)
    } else throw new Error('Unknown journal anchor.')
  }
  return { check, anchor, sequence: (id: IntentId) => sequences.get(id) }
}
