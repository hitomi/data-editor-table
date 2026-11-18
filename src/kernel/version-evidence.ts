import { CausalHistory } from './causal-history.js'
import { contentEvidence, joinContent, type VersionContent } from './version-content.js'
import type { AuthorityFrontier, AuthorityVersion, ExactReceipt } from './model.js'
import { joinAuthorityFrontier, ownAuthorityVersion, serverKeyIdentity } from './protocol.js'
import type { PersistenceSource, ServerAuthority } from './source.js'

export const versionKey = (version: AuthorityVersion) => version.kind === 'ordered' ? version.position : version.stamp

/** On a total order an incarnation occupies one contiguous interval of observed
 * snapshots. Complete membership observations bound that interval. A deletion
 * receipt fixes an upper bound even without a snapshot of its version. */
class OrderedHistory {
  readonly #positions: bigint[] = []
  readonly #lifetimes = new Map<string, { first: bigint; last: bigint }>()

  #latest = -1n
  readonly #deletions = new Map<string, bigint>()

  prepare(position: bigint, content: VersionContent) {
    const { members, documents } = content
    const present = members ?? [...documents].filter(([, value]) => value !== null).map(([id]) => id)
    let low = 0, high = this.#positions.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (this.#positions[mid]! < position) low = mid + 1
      else high = mid
    }
    const previous = this.#positions[low - 1], next = this.#positions[low]
    const retired = () => { throw new Error('A retired entity cannot reappear; restoration requires a new incarnation.') }
    if (members && position <= this.#latest) {
      for (const [id, { first, last }] of this.#lifetimes) {
        if (first <= position && position <= last && !members.has(id)) retired()
      }
    }
    for (const id of present) {
      const lifetime = this.#lifetimes.get(id)
      const deletion = this.#deletions.get(id)
      if (deletion !== undefined && deletion <= position) retired()
      if (next === position && (!lifetime || lifetime.first > position || lifetime.last < position)) retired()
      if (!lifetime) continue
      if (previous !== undefined && lifetime.last < previous || next !== undefined && lifetime.first > next) retired()
    }
    for (const [id, value] of documents) {
      if (value === null && (this.#lifetimes.get(id)?.last ?? -1n) >= position) retired()
    }
    return () => {
      if (position > this.#latest) this.#latest = position
      if (members && next !== position) this.#positions.splice(low, 0, position)
      for (const [id, value] of documents) if (value === null) {
        const deletion = this.#deletions.get(id)
        if (deletion === undefined || position < deletion) this.#deletions.set(id, position)
      }
      for (const id of present) {
        const lifetime = this.#lifetimes.get(id)
        if (!lifetime) this.#lifetimes.set(id, { first: position, last: position })
        else if (position < lifetime.first) lifetime.first = position
        else if (position > lifetime.last) lifetime.last = position
      }
    }
  }
}

/** The physical scope admits immutable evidence once. Callers may validate the
 * candidate against their read barrier or frozen write before committing it. */
export class ScopeVersionEvidence {
  #frontier: AuthorityFrontier = Object.freeze([])
  get frontier() { return this.#frontier }
  readonly #versions = new Map<string, { token: string; content: VersionContent }>()
  readonly #observations = new Map<string, string>()
  readonly #keyOwners = new Map<string, string>()
  readonly #causal = new CausalHistory()
  readonly #ordered = new OrderedHistory()

  constructor(private readonly capabilities: PersistenceSource['capabilities']) {}

  expand(version: AuthorityVersion) {
    return version.kind === 'causal' ? this.#causal.expand(version) : version
  }

  prepare(raw: AuthorityVersion, observation: ServerAuthority | ExactReceipt) {
    const input = ownAuthorityVersion(raw)
    if (input.kind !== this.capabilities.authorityOrder) throw new Error('Cannot change the authority ordering protocol.')
    const id = versionKey(input), known = this.#versions.get(id)
    if (known && known.token !== input.token) throw new Error('One authority version cannot change its token.')
    const snapshot = 'observation' in observation ? observation : undefined
    if (snapshot) {
      const observed = this.#observations.get(snapshot.observation)
      if (observed !== undefined && observed !== id) throw new Error('An observation identity cannot acquire a different authority version.')
    }
    const incoming = contentEvidence(observation)
    const content = joinContent(known?.content, incoming.content)
    const newOwners = new Map<string, string>()
    if (this.capabilities.identity === 'no-key-reuse-in-epoch') for (const identity of incoming.identities) {
      const key = serverKeyIdentity(identity.key), original = newOwners.get(key) ?? this.#keyOwners.get(key)
      if (original !== undefined && original !== identity.incarnation) throw new Error('A server key cannot change incarnation within this epoch.')
      if (original === undefined) newOwners.set(key, identity.incarnation)
    }
    const changed = content !== known?.content
    const causal = input.kind === 'causal' ? this.#causal.prepare(input, content, changed) : undefined
    const ordered = input.kind === 'ordered' && changed ? this.#ordered.prepare(BigInt(input.position), content) : undefined
    const version = causal?.version ?? input
    const heads = this.frontier.map(head => head.kind === 'causal' && causal ? causal.expand(head) : head)
    const frontier = joinAuthorityFrontier(heads, [version])
    return { version, frontier, commit: () => {
      causal?.commit()
      ordered?.()
      this.#frontier = frontier
      this.#versions.set(id, { token: version.token, content })
      if (snapshot) this.#observations.set(snapshot.observation, id)
      for (const [key, owner] of newOwners) this.#keyOwners.set(key, owner)
    } }
  }
}
