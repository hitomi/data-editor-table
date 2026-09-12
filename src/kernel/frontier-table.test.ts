import { expect, it, vi } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { ownEncodedValue } from './document.js'
import { compileFrontierTable, expandFrontier } from './frontier-table.js'
import { assertJournalFrontiers } from './journal-frontiers.js'
import { kernelId, type PreparedAction } from './model.js'
import { seededRandom } from '../../tests/kernel/generated-trace.js'

it.each(Array.from({ length: 16 }, (_, seed) => seed))('preserves left-first dependency union against array membership for seed %i', seed => {
  const fixture = new KernelFixture(), ids = Array.from({ length: 24 }, (_, index) => kernelId<'intent'>(`intent:${index}`))
  const builder = compileFrontierTable(fixture.state.journal.frontiers, ids), random = seededRandom(seed)
  for (let step = 0; step < 80; step++) {
    const values = () => [...new Set(Array.from({ length: random(16) }, () => ids[random(ids.length)]!))]
    const a = values(), b = values(), left = builder.intern(a), right = builder.intern(b)
    const result = builder.union(left, right)
    expect(builder.arena.expand(builder.get(result))).toEqual([...new Set([...a, ...b])])
    expect(builder.arena.expand(builder.get(left))).toEqual(a)
    expect(builder.arena.expand(builder.get(right))).toEqual(b)
    expect(builder.union(result, right)).toBe(result)
    if (b.every(id => a.includes(id))) expect(result).toBe(left)
  }
  expect(() => builder.union(null, 999999)).toThrow('reference')
})

it.each([16, 32, 64])('validates shared causal prefixes without repeatedly looking up their %i intent sequences', count => {
  const fixture = new KernelFixture({ a: { x: 0, y: 0, hidden: 7 } })
  for (let value = 1; value <= count; value++) fixture.apply([fixture.write('a', { x: value, y: -value })])
  const state = fixture.state, original = JSON.stringify(state), ids = new Set(state.journal.intents.map(intent => intent.id))
  const get = Map.prototype.get
  let lookups = 0
  const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
    const value = get.call(this, key)
    if (ids.has(key as never) && typeof value === 'number') lookups++
    return value
  })
  try { assertJournalFrontiers(state) } finally { spy.mockRestore() }
  expect(JSON.stringify(state)).toBe(original)
  // Includes arena ordinal lookups; bounds work, not wall-clock duration.
  expect(lookups).toBeLessThanOrEqual(count * 8)
})

it.each([16, 32, 64])('stores shared journal prefixes once for %i accepted two-field edits', count => {
  const fixture = new KernelFixture({ a: { x: 0, y: 0, hidden: 7 } })
  for (let value = 1; value <= count; value++) fixture.apply([fixture.write('a', { x: value, y: -value })])
  const state = fixture.state, journal = state.journal
  expect(journal.frontiers.nodes).toHaveLength(count - 1)
  for (const [index, intent] of journal.intents.entries()) {
    if (intent.operation.kind !== 'write') throw new Error('Expected a write')
    const anchors = intent.operation.groups[0]!.expectations.map(expected => expected.anchor)
    if (index === 0) expect(anchors.every(anchor => anchor.kind === 'authority')).toBe(true)
    else {
      expect(anchors[0]).toEqual(anchors[1])
      const anchor = anchors[0]!
      if (anchor.kind !== 'logical-output') throw new Error('Expected logical predecessor')
      expect(typeof anchor.predecessor).toBe('number')
      expect(expandFrontier(journal.frontiers, anchor.predecessor)).toEqual(journal.intents.slice(0, index).map(intent => intent.id))
    }
  }
  const copied = ownEncodedValue(JSON.parse(JSON.stringify(state))) as unknown as typeof state
  expect(copied.journal.frontiers.nodes).toHaveLength(count - 1)
  assertJournalFrontiers(copied)
  expect(fixture.project().rows[0]!.preview).toEqual({ x: count, y: -count, hidden: 7 })
  // The same stored prefix owns both ordered anchors and causal dependencies.
  expect(journal.intents.reduce((sum, intent) => sum + expandFrontier(journal.frontiers, intent.dependencies).length, 0)).toBe(count * (count - 1) / 2)
})

it.each(['scope', 'rewrite', 'cycle', 'length', 'unknown-intent', 'duplicate', 'missing-root'])('rejects %s without publishing candidate frontier nodes', corruption => {
  const fixture = new KernelFixture({ a: { x: 0 } })
  fixture.apply([fixture.write('a', { x: 1 })]); fixture.apply([fixture.write('a', { x: 2 })])
  const prepared = fixture.prepare([fixture.write('a', { x: 3 })])
  const raw = JSON.parse(JSON.stringify(prepared)), before = fixture.state
  switch (corruption) {
    case 'scope': raw.frontiers.scope = 'other workspace'; break
    case 'rewrite': raw.frontiers.nodes[0].intent = prepared.intents[0]!.id; break
    case 'cycle': raw.frontiers.nodes[1].parent = 1; break
    case 'length': raw.frontiers.nodes[1].length = 100; break
    case 'unknown-intent': raw.frontiers.nodes[1].intent = 'unknown'; break
    case 'duplicate': raw.frontiers.nodes.push({ ...raw.frontiers.nodes[0] }); break
    case 'missing-root': raw.intents[0].operation.groups[0].expectations[0].anchor.predecessor = 999; break
  }
  const original = JSON.stringify(raw)
  expect(fixture.dispatch({ kind: 'prepared-action', prepared: raw as PreparedAction }).result.kind).toBe('rejected')
  expect(fixture.state).toBe(before)
  expect(JSON.stringify(raw)).toBe(original)
  assertJournalFrontiers(before)
})

it('keeps reordered branches distinct after cloning and extending the accepted flat table', () => {
  const fixture = new KernelFixture({ a: { x: 0 } })
  fixture.apply([fixture.write('a', { x: 1 })]); fixture.apply([fixture.write('a', { x: 2 })]); fixture.apply([fixture.write('a', { x: 3 })])
  const base = fixture.state.journal.frontiers, ids = fixture.state.journal.intents.map(intent => intent.id)
  const builder = compileFrontierTable(base, ids), original = JSON.stringify(base)
  const abc = builder.intern(ids), bac = builder.intern([ids[1]!, ids[0]!, ids[2]!])
  expect(abc).not.toBe(bac)
  const table = ownEncodedValue(builder.snapshot()) as unknown as typeof base
  const restored = compileFrontierTable(table, ids)
  expect(restored.arena.expand(restored.get(abc))).toEqual(ids)
  expect(restored.arena.expand(restored.get(bac))).toEqual([ids[1], ids[0], ids[2]])
  expect(restored.intern(ids)).toBe(abc)
  expect(JSON.stringify(base)).toBe(original)
})

it.each(['missing', 'not-a-dependency'])('validates the %s fallback of a submission anchor before acceptance', corruption => {
  const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } })
  const unrelated = fixture.apply([fixture.write('b', { x: 1 })])
  fixture.apply([fixture.write('a', { x: 1 })])
  const submission = fixture.freeze().submission, prepared = fixture.prepare([fixture.write('a', { x: 2 })])
  const builder = compileFrontierTable(prepared.frontiers, [...fixture.state.journal.intents, ...prepared.intents].map(intent => intent.id))
  const fallback = corruption === 'missing' ? 999 : builder.intern(unrelated.action.intentIds)
  const item = submission.items.find(item => item.kind !== 'order' && item.entityId === 'a')!
  const raw = JSON.parse(JSON.stringify(prepared)), expected = raw.intents[0].operation.groups[0].expectations[0]
  expected.anchor = { kind: 'submission-output', operationId: submission.operationId, itemId: item.id,
    frontier: expected.anchor.predecessor, fallback: { ...expected.anchor, predecessor: fallback } }
  raw.frontiers = builder.snapshot()
  const before = fixture.state
  expect(fixture.dispatch({ kind: 'prepared-action', prepared: raw }).result.kind).toBe('rejected')
  expect(fixture.state).toBe(before)
})

it.each(['future-before-earlier', 'missing-member', 'reordered-members'])('validates %s using the complete prefix and dependency membership', variant => {
  const fixture = new KernelFixture({ a: { x: 0 } })
  for (const x of [1, 2, 3]) fixture.apply([fixture.write('a', { x })])
  const state = fixture.state, ids = state.journal.intents.map(intent => intent.id)
  const builder = compileFrontierTable(state.journal.frontiers, ids)
  const raw = JSON.parse(JSON.stringify(state))
  if (variant === 'future-before-earlier') raw.journal.intents[1].dependencies = builder.intern([ids[2]!, ids[0]!])
  else raw.journal.intents[2].dependencies = builder.intern(variant === 'missing-member' ? [ids[0]!] : [ids[1]!, ids[0]!])
  raw.journal.frontiers = builder.snapshot()
  if (variant === 'reordered-members') expect(() => assertJournalFrontiers(raw)).not.toThrow()
  else expect(() => assertJournalFrontiers(raw)).toThrow('earlier causal dependencies')
  assertJournalFrontiers(state)
})

it.each(['complete', 'missing-member', 'wrong-entity'])('preserves exact submission coverage for a %s anchor', async variant => {
  const initial = { a: { x: 0, hidden: 7 }, b: { x: 0, hidden: 8 } }
  const fixture = new KernelFixture(initial), source = new SourceFixture(fixture.state.workspace.scope, initial)
  fixture.apply([fixture.write('b', { x: 1 })])
  const first = fixture.apply([fixture.write('a', { x: 1 })])
  fixture.apply([fixture.write('a', { x: 2 })])
  const submission = fixture.freeze().submission, prepared = fixture.prepare([fixture.write('a', { x: 3 })])
  const builder = compileFrontierTable(prepared.frontiers, [...fixture.state.journal.intents, ...prepared.intents].map(intent => intent.id))
  const raw = JSON.parse(JSON.stringify(prepared)), expected = raw.intents[0].operation.groups[0].expectations[0]
  const item = submission.items.find(item => item.kind !== 'order' && item.entityId === (variant === 'wrong-entity' ? 'b' : 'a'))!
  expected.anchor = { kind: 'submission-output', operationId: submission.operationId, itemId: item.id,
    frontier: variant === 'missing-member' ? builder.intern(first.action.intentIds) : expected.anchor.predecessor, fallback: expected.anchor }
  raw.frontiers = builder.snapshot()
  const before = fixture.state, original = JSON.stringify(raw)
  const transition = fixture.dispatch({ kind: 'prepared-action', prepared: raw })
  expect(JSON.stringify(raw)).toBe(original)
  if (variant !== 'complete') {
    expect(transition.result.kind).toBe('rejected'); expect(fixture.state).toBe(before)
    return
  }
  expect(transition.result.kind).toBe('accepted')
  source.normalize = document => ({ ...document, x: Number(document.x) + 0.5 })
  const result = await source.submit(submission)
  if (result.kind !== 'applied') throw new Error('Expected exact save result')
  fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt })
  fixture.observe({ a: { x: 2.5, hidden: 7 }, b: { x: 1.5, hidden: 8 } }, 1)
  expect(fixture.project().rows.find(row => row.entityId === 'a')?.preview).toEqual({ x: 3, hidden: 7 })
  assertJournalFrontiers(fixture.state)
  expect(source.writes).toBe(1)
  expect(fixture.state.journal.intents.at(-1)).toEqual(raw.intents[0])
})
