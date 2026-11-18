import type { AuthorityVersion, CausalStamp } from './model.js'

import type { VersionContent } from './version-content.js'

type Version = Extract<AuthorityVersion, { kind: 'causal' }>
type Observation = Readonly<{
  parents: readonly CausalStamp[]
  content: VersionContent
  seen: ReadonlySet<string>
  retired: ReadonlySet<string>
}>

function deriveObservation(parents: readonly CausalStamp[], content: VersionContent,
  lookup: (stamp: CausalStamp) => Observation | undefined): Observation {
  const members = content.members
  const seen = new Set(members), retired = new Set<string>()
  for (const [id, value] of content.documents) {
    if (value === null) retired.add(id)
    else seen.add(id)
  }
  let predecessor: Observation | undefined
  for (const parent of parents) {
    const ancestor = lookup(parent)
    if (!ancestor) continue
    predecessor = ancestor
    for (const identity of ancestor.retired) retired.add(identity)
    for (const identity of ancestor.seen) {
      seen.add(identity)
      if (members && !members.has(identity)) retired.add(identity)
    }
  }
  const present = members ?? [...content.documents].filter(([, value]) => value !== null).map(([id]) => id)
  for (const identity of present) {
    if (retired.has(identity)) throw new Error('A retired entity cannot reappear; restoration requires a new incarnation.')
  }
  return {
    parents, content,
    seen: predecessor?.seen.size === seen.size ? predecessor.seen : seen,
    retired: predecessor?.retired.size === retired.size ? predecessor.retired : retired,
  }
}

/** Every complete observation constrains all of its descendants. A row absent
 * after it was seen on that path is retired. Absence on an unrelated branch
 * says nothing about when the row was created. Only identity evidence lives here. */
export class CausalHistory {
  readonly #observations = new Map<CausalStamp, Observation>()
  readonly #children = new Map<CausalStamp, Set<CausalStamp>>()

  prepare(version: Version, content: VersionContent, changed: boolean) {
    const stamp = version.stamp, previous = this.#observations.get(stamp)
    const parents = new Set(previous?.parents)
    for (const parent of version.covers) parents.add(parent)
    const expand = (v: Version) => this.expand(v, stamp, parents)
    // Validate the new edges before traversal, including for receipt-only nodes.
    const expanded = expand(version)
    const staged = new Map<CausalStamp, Observation>()
    if (!previous || parents.size !== previous.parents.length || changed) {
      const queue = [stamp]
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index]!, prior = staged.get(id) ?? this.#observations.get(id)
        const edges = id === stamp ? [...parents] : prior!.parents
        const observation = deriveObservation(edges, id === stamp ? content : prior!.content, parent => staged.get(parent) ?? this.#observations.get(parent))
        staged.set(id, observation)
        // Evidence only grows. Revisit descendants if this stamp acquired
        // lifecycle facts, including when an intermediate observation arrives late.
        if (observation.seen.size !== (prior?.seen.size ?? 0) || observation.retired.size !== (prior?.retired.size ?? 0))
          for (const child of this.#children.get(id) ?? []) queue.push(child)
      }
    }
    return { version: expanded, expand, commit: () => {
      if (!staged.size) return
      for (const [id, observation] of staged) this.#observations.set(id, observation)
      for (const parent of parents) {
        let children = this.#children.get(parent)
        if (!children) { children = new Set(); this.#children.set(parent, children) }
        children.add(stamp)
      }
    } }
  }

  expand(version: Version, stagedStamp?: CausalStamp, stagedParents?: ReadonlySet<CausalStamp>): Version {
    const covers = new Set<CausalStamp>()
    const collect = (stamp: CausalStamp) => {
      const edges = stamp === stagedStamp ? stagedParents : this.#observations.get(stamp)?.parents
      for (const parent of edges ?? []) covers.add(parent)
    }
    collect(version.stamp)
    for (const parent of version.covers) covers.add(parent)
    for (const parent of covers) {
      if (parent === version.stamp) throw new Error('Causal authority cannot contain a cycle.')
      collect(parent)
    }
    return Object.freeze({ ...version, covers: Object.freeze([...covers]) })
  }
}
