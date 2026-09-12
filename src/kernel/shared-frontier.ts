/** Internal ordered frontier arena. Its archive is not a Workspace recovery format.
 * Membership uses a persistent 32-level ordinal trie; appending never copies
 * the complete ancestor list or membership set. Ordinals belong to this arena.
 */
export type SharedFrontier = Readonly<{ parent: SharedFrontier | null; intent: string; length: number }>
export type FrontierArchive = Readonly<{ format: 1; scope: string;
  nodes: readonly Readonly<{ parent: number | null; intent: string; length: number }>[]; roots: readonly (number | null)[] }>
type Members = Readonly<{ left: Members | null; right: Members | null }>
const leaf: Members = Object.freeze({ left: null, right: null })
export class SharedFrontiers {
  readonly #ordinals = new Map<string, number>()
  readonly #membership = new Map<SharedFrontier, Members>()
  readonly #children = new Map<SharedFrontier | null, Map<string, SharedFrontier>>()
  #membershipNodes = 0
  constructor(intents: readonly string[]) {
    for (const intent of intents) {
      if (!intent || this.#ordinals.has(intent) || this.#ordinals.size >= 2 ** 32) throw new Error('Invalid intent inventory')
      this.#ordinals.set(intent, this.#ordinals.size)
    }
  }
  get size() { return this.#membership.size }
  get membershipNodes() { return this.#membershipNodes }
  has(frontier: SharedFrontier | null, intent: string): boolean {
    let cursor = this.#members(frontier)
    const ordinal = this.#ordinals.get(intent)
    if (ordinal === undefined) return false
    for (let bit = 31; bit >= 0 && cursor; bit--) cursor = ((ordinal >>> bit) & 1) ? cursor.right : cursor.left
    return cursor !== null
  }
  /** Membership comparison is unordered; shared trie branches need no walk.
   * Ordered frontier identity remains separate from this subset relation. */
  isSubset(frontier: SharedFrontier | null, container: SharedFrontier | null): boolean {
    const pending: [Members | null, Members | null][] = [[this.#members(frontier), this.#members(container)]]
    while (pending.length) {
      const [left, right] = pending.pop()!
      if (left === null || left === right) continue
      if (right === null) return false
      pending.push([left.left, right.left], [left.right, right.right])
    }
    return true
  }
  archive(scope: string, roots: readonly (SharedFrontier | null)[]): FrontierArchive {
    if (!scope) throw new Error('Missing archive scope')
    const ids = new Map([...this.#membership.keys()].map((node, index) => [node, index]))
    const reference = (node: SharedFrontier | null) => {
      this.#members(node)
      return node === null ? null : ids.get(node)!
    }
    return Object.freeze({ format: 1, scope, nodes: Object.freeze([...ids.keys()].map(node => Object.freeze({
      parent: reference(node.parent), intent: node.intent, length: node.length,
    }))), roots: Object.freeze(roots.map(reference)) })
  }
  static restore(scope: string, intents: readonly string[], raw: unknown) {
    const archive = structuredClone(raw) as FrontierArchive
    if (!scope || !archive || archive.format !== 1 || archive.scope !== scope || !Array.isArray(archive.nodes) || !Array.isArray(archive.roots))
      throw new Error('Invalid frontier archive')
    const arena = new SharedFrontiers(intents), nodes: SharedFrontier[] = []
    const reference = (index: number | null, bound: number) => {
      if (index === null) return null
      if (!Number.isSafeInteger(index) || index < 0 || index >= bound) throw new Error('Invalid frontier reference')
      return nodes[index]!
    }
    for (const entry of archive.nodes) {
      if (!entry || typeof entry.intent !== 'string' || !Number.isSafeInteger(entry.length) || entry.length < 1) throw new Error('Invalid frontier node')
      const parent = reference(entry.parent, nodes.length)
      if (entry.length !== (parent?.length ?? 0) + 1) throw new Error('Invalid frontier length')
      const before = arena.size, node = arena.append(parent, entry.intent)
      if (arena.size !== before + 1) throw new Error('Duplicate frontier node')
      nodes.push(node)
    }
    const roots = Object.freeze(archive.roots.map(index => reference(index, nodes.length)))
    return Object.freeze({ arena, roots })
  }
  #members(frontier: SharedFrontier | null) {
    if (frontier === null) return null
    const members = this.#membership.get(frontier)
    if (!members) throw new Error('Unknown frontier owner')
    return members
  }
  append(parent: SharedFrontier | null, intent: string): SharedFrontier {
    const members = this.#members(parent), ordinal = this.#ordinals.get(intent)
    if (ordinal === undefined) throw new Error('Unknown intent')
    const previous = this.#children.get(parent)?.get(intent)
    if (previous) return previous
    const path: { node: Members | null; right: boolean }[] = []
    let cursor = members
    for (let bit = 31; bit >= 0; bit--) {
      const right = ((ordinal >>> bit) & 1) === 1
      path.push({ node: cursor, right }); cursor = cursor ? (right ? cursor.right : cursor.left) : null
    }
    if (cursor) throw new Error('Repeated causal intent')
    let next = leaf
    for (let index = path.length - 1; index >= 0; index--) {
      const { node, right } = path[index]!
      next = Object.freeze({ left: right ? node?.left ?? null : next, right: right ? next : node?.right ?? null })
      this.#membershipNodes++
    }
    const frontier = Object.freeze({ parent, intent, length: (parent?.length ?? 0) + 1 })
    this.#membership.set(frontier, next)
    let children = this.#children.get(parent)
    if (!children) { children = new Map(); this.#children.set(parent, children) }
    children.set(intent, frontier)
    return frontier
  }
  expand(frontier: SharedFrontier | null): readonly string[] {
    this.#members(frontier)
    const result = Array.from({ length: frontier?.length ?? 0 }, () => '')
    for (let node = frontier; node; node = node.parent) result[node.length - 1] = node.intent
    return Object.freeze(result)
  }
}
