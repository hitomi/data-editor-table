import { expect, it } from 'vitest'
import { SharedFrontiers, type SharedFrontier } from './shared-frontier.js'
import { seededRandom } from '../../tests/kernel/generated-trace.js'

it('shares identical prefixes without confusing reordered branches with the same tail', () => {
  const arena = new SharedFrontiers(['a', 'b', 'c'])
  const a = arena.append(null, 'a'), ab = arena.append(a, 'b'), abc = arena.append(ab, 'c')
  const b = arena.append(null, 'b'), ba = arena.append(b, 'a'), bac = arena.append(ba, 'c')
  expect(arena.append(ab, 'c')).toBe(abc)
  expect(abc).not.toBe(bac)
  expect(arena.expand(abc)).toEqual(['a', 'b', 'c']); expect(arena.expand(bac)).toEqual(['b', 'a', 'c'])
  expect(arena.isSubset(abc, bac)).toBe(true); expect(arena.isSubset(bac, abc)).toBe(true)
  expect(arena.isSubset(a, abc)).toBe(true); expect(arena.isSubset(abc, a)).toBe(false)
  expect(arena.isSubset(null, abc)).toBe(true); expect(arena.isSubset(abc, null)).toBe(false)
  const size = arena.size, allocations = arena.membershipNodes
  expect(() => arena.append(abc, 'a')).toThrow('Repeated')
  expect(() => arena.append(null, 'unknown')).toThrow('Unknown intent')
  expect(() => arena.append(new SharedFrontiers(['a']).append(null, 'a'), 'b')).toThrow('owner')
  expect(() => arena.expand({ ...abc })).toThrow('owner')
  expect(() => arena.isSubset(null, { ...abc })).toThrow('owner')
  expect(arena.size).toBe(size); expect(arena.membershipNodes).toBe(allocations)
  expect(Object.isFrozen(abc)).toBe(true); expect(Object.isFrozen(arena.expand(abc))).toBe(true)
})

it('bounds append allocation independently of prefix length and expands without recursive traversal', () => {
  const intents = Array.from({ length: 10000 }, (_, index) => `intent:${index}`), arena = new SharedFrontiers(intents)
  let frontier: SharedFrontier | null = null
  for (const intent of intents) frontier = arena.append(frontier, intent)
  expect(arena.size).toBe(intents.length)
  expect(arena.membershipNodes).toBe(intents.length * 32)
  expect(arena.expand(frontier)).toEqual(intents)
  expect(() => arena.append(frontier, intents[0]!)).toThrow('Repeated')
})

it.each(Array.from({ length: 16 }, (_, seed) => seed))('matches independent array branches for seed %i', seed => {
  const ids = Array.from({ length: 40 }, (_, index) => `i:${index}`), arena = new SharedFrontiers(ids), random = seededRandom(seed)
  const branches: { node: SharedFrontier | null; values: string[] }[] = [{ node: null, values: [] }]
  for (let step = 0; step < 200; step++) {
    const parent = branches[random(branches.length)]!, intent = ids[random(ids.length)]!
    if (parent.values.includes(intent)) { expect(() => arena.append(parent.node, intent)).toThrow('Repeated'); continue }
    const node = arena.append(parent.node, intent), values = [...parent.values, intent]
    expect(arena.expand(node)).toEqual(values)
    expect(arena.expand(parent.node)).toEqual(parent.values)
    expect(arena.append(parent.node, intent)).toBe(node)
    const other = branches[random(branches.length)]!
    expect(arena.isSubset(node, other.node)).toBe(values.every(id => other.values.includes(id)))
    expect(arena.isSubset(other.node, node)).toBe(other.values.every(id => values.includes(id)))
    branches.push({ node, values })
  }
})

it('roundtrips a shared archive without relying on object identity from another arena', () => {
  const arena = new SharedFrontiers(['a', 'b', 'c']), a = arena.append(null, 'a')
  const ab = arena.append(a, 'b'), ac = arena.append(a, 'c')
  const archive = arena.archive('workspace:1', [ab, ac, ab, null])
  const restored = SharedFrontiers.restore('workspace:1', ['a', 'b', 'c'], JSON.parse(JSON.stringify(archive)))
  expect(restored.roots.map(root => restored.arena.expand(root))).toEqual([['a','b'], ['a','c'], ['a','b'], []])
  expect(restored.roots[0]).toBe(restored.roots[2])
  expect(restored.roots[0]?.parent).toBe(restored.roots[1]?.parent)
  expect(restored.arena.archive('workspace:1', restored.roots)).toEqual(archive)
  expect(() => restored.arena.expand(ab)).toThrow('owner')
})

it.each(['cycle', 'missing', 'length', 'duplicate', 'repeated-intent', 'unknown-intent', 'root', 'scope', 'format'])('rejects %s archive corruption without modifying the original arena', corruption => {
  const arena = new SharedFrontiers(['a','b']), a = arena.append(null,'a'), ab = arena.append(a,'b')
  const original = arena.archive('scope',[ab]), raw = structuredClone(original) as {
    format: number; scope: string; nodes: {parent: number | null; intent: string; length: number}[]; roots: (number | null)[]
  }
  switch (corruption) {
    case 'cycle': raw.nodes[0]!.parent=0; break
    case 'missing': raw.nodes[1]!.parent=8; break
    case 'length': raw.nodes[1]!.length=1; break
    case 'duplicate': raw.nodes.push({...raw.nodes[0]!}); break
    case 'repeated-intent': raw.nodes[1]!.intent='a'; break
    case 'unknown-intent': raw.nodes[1]!.intent='unknown'; break
    case 'root': raw.roots[0]=2; break
    case 'scope': raw.scope='different'; break
    case 'format': raw.format=2; break
  }
  expect(() => SharedFrontiers.restore('scope',['a','b'],raw)).toThrow()
  expect(arena.archive('scope',[ab])).toEqual(original)
})
