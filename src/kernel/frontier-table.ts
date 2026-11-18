import { ownEncodedValue } from './document.js'
import type { FrontierRef, FrontierTable, IntentId, WorkspaceIdentity } from './model.js'
import { SharedFrontiers, type SharedFrontier } from './shared-frontier.js'

export function frontierScope(workspace: WorkspaceIdentity): string {
  return JSON.stringify([workspace.id, workspace.scope.sourceId, workspace.scope.id, workspace.scope.epoch, workspace.schema, workspace.codec])
}

export function emptyFrontierTable(workspace: WorkspaceIdentity): FrontierTable {
  return Object.freeze({ scope: frontierScope(workspace), nodes: Object.freeze([]) })
}

/** Candidate-local builder. Publishing its snapshot belongs to the same
 * revision-checked transition that accepts the associated intents. */
export function compileFrontierTable(raw: FrontierTable, inventory: readonly IntentId[], scope = raw.scope) {
  const table = ownEncodedValue(raw) as unknown as FrontierTable
  const restored = SharedFrontiers.restore(scope, inventory, { format: 1, ...table, roots: table.nodes.map((_, index) => index) })
  const nodes = [...restored.roots] as SharedFrontier[]
  const references = new Map(nodes.map((node, index) => [node, index]))
  const get = (ref: FrontierRef): SharedFrontier | null => {
    if (ref === null) return null
    if (!Number.isSafeInteger(ref) || ref < 0 || ref >= nodes.length) throw new Error('Unknown journal frontier reference.')
    return nodes[ref]!
  }
  const append = (parent: FrontierRef, intent: IntentId): number => {
    const node = restored.arena.append(get(parent), intent)
    let ref = references.get(node)
    if (ref === undefined) { ref = nodes.length; references.set(node, ref); nodes.push(node) }
    return ref
  }
  return {
    arena: restored.arena,
    get,
    append,
    intern(ids: readonly IntentId[]): FrontierRef {
      let ref: FrontierRef = null
      for (const id of ids) ref = append(ref, id)
      return ref
    },
    /** Preserve left order, then append unseen right members. Used for causal
     * dependencies, never to replace an ordered authoring anchor. */
    union(left: FrontierRef, right: FrontierRef): FrontierRef {
      const a = get(left), b = get(right)
      if (restored.arena.isSubset(b, a)) return left
      if (left === null) return right
      const missing: IntentId[] = []
      for (let node = b; node; node = node.parent) if (!restored.arena.has(a, node.intent)) missing.push(node.intent as IntentId)
      let result = left
      for (let index = missing.length - 1; index >= 0; index--) result = append(result, missing[index]!)
      return result
    },
    snapshot(): FrontierTable {
      const archive = restored.arena.archive(scope, [])
      return Object.freeze({ scope, nodes: archive.nodes as FrontierTable['nodes'] })
    },
  }
}

export function assertFrontierExtension(base: FrontierTable, candidate: FrontierTable): void {
  if (base.scope !== candidate.scope || candidate.nodes.length < base.nodes.length || base.nodes.some((node, index) => {
    const other = candidate.nodes[index]!
    return node.parent !== other.parent || node.intent !== other.intent || node.length !== other.length
  })) throw new Error('A candidate cannot replace accepted frontier facts.')
}

/** Read trusted accepted tables iteratively. Full table validation occurs at
 * candidate/recovery boundaries, not once per resource. */
export function expandFrontier(table: FrontierTable, ref: FrontierRef): readonly IntentId[] {
  const reversed: IntentId[] = []
  for (let index = ref; index !== null;) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= table.nodes.length) throw new Error('Unknown journal frontier reference.')
    const node = table.nodes[index]!
    if (node.parent !== null && (!Number.isSafeInteger(node.parent) || node.parent < 0 || node.parent >= index)) throw new Error('Invalid journal frontier parent.')
    reversed.push(node.intent); index = node.parent
  }
  return Object.freeze(reversed.reverse())
}
