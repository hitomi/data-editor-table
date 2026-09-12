import { describe, expect, it } from 'vitest'
import { ReferenceCausalReads } from '../../tests/kernel/causal-read-model.js'
import { kernelId } from './model.js'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { evaluatePrefixes, type PrefixComputation, type PrefixRead } from './prefix-evaluation.js'

const projection = () => new KernelFixture({ a: { x: 1 } }).project()

describe('iterative causal prefix evaluation', () => {
  it('completes 30000 dependent prefixes without nesting the JavaScript call stack or restarting computations', () => {
    const result = projection(), depth = 30000
    let entered = 0, completed = 0
    const compute = function* (through: number): PrefixComputation {
      entered++
      if (through > 0) {
        const child = yield through - 1
        expect(child.projection).toBe(result)
      }
      completed++
      return result
    }
    expect(evaluatePrefixes(compute, depth)).toBe(result)
    expect(entered).toBe(depth + 1); expect(completed).toBe(depth + 1)
  })

  it('shares completed prefix indexes across branches and repeated reads while retaining parent progress', () => {
    const result = projection(), calls: number[] = [], reads: PrefixRead[] = []
    const compute = function* (through: number): PrefixComputation {
      calls.push(through)
      if (through === 3) { reads.push(yield 2); reads.push(yield 1); reads.push(yield 2) }
      if (through === 2) { reads.push(yield 1); reads.push(yield 0) }
      if (through === 1) reads.push(yield 0)
      return result
    }
    expect(evaluatePrefixes(compute, 3)).toBe(result)
    expect(calls).toEqual([3, 2, 1, 0])
    expect(reads[0]).toBe(reads[2])
    expect(reads[1]).toBe(reads[4]); expect(reads[3]).toBe(reads[5])
    expect(reads[0]!.documents.get(result.rows[0]!.entityId)).toEqual({ x: 1 })
    expect(reads[0]!.rows.get(result.rows[0]!.entityId)).toBe(result.rows[0])
    expect(reads[0]!.order).toEqual(result.order.preview)
  })

  it('throws a failed child at the suspended read site and never caches an incomplete prefix', () => {
    const result = projection(), failure = new Error('dependency failed')
    let attempts = 0, caught = 0
    const compute = function* (through: number): PrefixComputation {
      if (through === 0) { attempts++; throw failure }
      for (let attempt = 0; attempt < 2; attempt++) {
        try { yield 0 } catch (error) { expect(error).toBe(failure); caught++ }
      }
      return result
    }
    expect(evaluatePrefixes(compute, 1)).toBe(result)
    expect(attempts).toBe(2); expect(caught).toBe(2)
    expect(() => evaluatePrefixes(compute, 0)).toThrow(failure)
  })

  it('preserves a real chain of neutralized providers when its earliest authority changes', () => {
    const names = Array.from({ length: 13 }, (_, index) => `row:${index}`)
    const initial = Object.fromEntries(names.map(name => [name, { x: 0 }])), fixture = new KernelFixture(initial)
    const oracle = new ReferenceCausalReads(Object.fromEntries(names.map(name => [name, 0])))
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!, previous = names[index - 1]
      fixture.apply([fixture.write(name, { x: 1 }, { reads: previous ? [{ role: 'semantic-read', resource: { kind: 'path', entityId: kernelId<'entity'>(previous), path: ['x'] } }] : [] })])
      oracle.write(name, 1, previous ? [previous] : [])
      if (previous) { fixture.apply([fixture.write(previous, { x: 0 })]); oracle.write(previous, 0) }
    }
    for (const value of [0, 9, 1]) {
      const remote = Object.fromEntries(names.map((name, index) => [name, index === 0 ? value : 0]))
      const state = fixture.state
      const projected = fixture.project()
      expect(fixture.state).toBe(state)
      expect(projected.rows).toHaveLength(names.length)
      fixture.observe(Object.fromEntries(names.map(name => [name, { x: remote[name]! }])), fixture.state.revision + 1)
      oracle.observe(remote)
      const actual = fixture.project(), expected = oracle.project()
      for (const name of names) {
        const row = actual.rows.find(row => row.entityId === name)!
        expect(row.preview).toEqual({ x: expected[name]!.value })
        expect(row.persistence === 'blocked').toBe(expected[name]!.blocked)
        expect(actual.changes.find(change => change.entityId === name)?.after?.x ?? null).toEqual(expected[name]!.save)
      }
    }
  })

  it.each([2, 3, -1, NaN, Infinity])('rejects a noncausal prefix request %s', request => {
    const result = projection()
    expect(() => evaluatePrefixes(function* (): PrefixComputation { yield request; return result }, 2)).toThrow('strictly earlier')
  })
})
