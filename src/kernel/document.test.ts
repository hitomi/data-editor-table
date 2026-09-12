import { describe, expect, it } from 'vitest'
import { applyDocumentPatches, canonicalEncodedValue, encodedValuesEqual, ownDocument, ownEncodedValue, pathsOverlap, readDocument, resourceValuesEqual } from './document.js'

describe('owned kernel documents', () => {
  it('owns nested values without retaining mutable caller aliases', () => {
    const input = { name: 'Before', nested: { values: [1, null] } }
    const document = ownDocument(input)
    input.name = 'After'; input.nested.values[0] = 9
    expect(document).toEqual({ name: 'Before', nested: { values: [1, null] } })
    expect(Object.isFrozen(document)).toBe(true)
    expect(Object.isFrozen(document.nested)).toBe(true)
    expect(Object.isFrozen((document.nested as { values: readonly unknown[] }).values)).toBe(true)
  })

  it('distinguishes missing, null, empty text and false through writes and encoding', () => {
    const base = ownDocument({ nullValue: null, empty: '', boolean: false })
    expect(readDocument(base, ['absent'])).toEqual({ kind: 'missing' })
    expect(readDocument(base, ['nullValue'])).toEqual({ kind: 'value', value: null })
    expect(resourceValuesEqual(readDocument(base, ['absent']), readDocument(base, ['nullValue']))).toBe(false)
    const changed = applyDocumentPatches(base, [
      { kind: 'set', path: ['absent'], value: null },
      { kind: 'remove', path: ['nullValue'] },
    ])
    expect(canonicalEncodedValue(changed)).toBe('{"absent":null,"boolean":false,"empty":""}')
    expect(readDocument(base, ['nullValue'])).toEqual({ kind: 'value', value: null })
  })

  it('preserves complete explicit writes including hidden and prototype-named fields', () => {
    const base = ownDocument(JSON.parse('{"name":"Old","metadata":{"slug":"old"},"__proto__":{"safe":true}}'))
    const changed = applyDocumentPatches(base, [
      { kind: 'set', path: ['name'], value: 'New' },
      { kind: 'set', path: ['metadata', 'slug'], value: 'new' },
      { kind: 'set', path: ['__proto__', 'safe'], value: false },
    ])
    expect(readDocument(changed, ['metadata', 'slug'])).toEqual({ kind: 'value', value: 'new' })
    expect(readDocument(changed, ['__proto__', 'safe'])).toEqual({ kind: 'value', value: false })
    expect(Object.getPrototypeOf(changed)).toBeNull()
    expect(readDocument(base, ['metadata', 'slug'])).toEqual({ kind: 'value', value: 'old' })
  })

  it('rejects an atomic write batch without changing the original when a parent is unavailable', () => {
    const base = ownDocument({ name: 'Old', items: ['a'] })
    expect(() => applyDocumentPatches(base, [
      { kind: 'set', path: ['name'], value: 'New' },
      { kind: 'set', path: ['items', '0'], value: 'b' },
    ])).toThrow('parent')
    expect(base.name).toBe('Old')
    expect(() => applyDocumentPatches(base, [{ kind: 'set', path: ['missing', 'child'], value: 1 }])).toThrow('parent')
  })

  it('rejects lossy values without invoking accessors', () => {
    let calls = 0
    const getter = { get value() { calls++; return 1 } }
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 })
    const symbol = { [Symbol('hidden')]: 1 }
    const sparse: unknown[] = []; sparse.length = 2
    const arrayWithProperty = Object.assign([1], { hidden: 2 })
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), getter, cyclic, hidden, symbol, sparse, arrayWithProperty]) {
      expect(() => ownEncodedValue(value)).toThrow()
    }
    expect(calls).toBe(0)
  })

  it('canonicalizes object ordering but preserves array ordering and normalizes negative zero', () => {
    expect(canonicalEncodedValue({ z: [-0, 2], a: { y: 1, x: 0 } })).toBe(canonicalEncodedValue({ a: { x: 0, y: 1 }, z: [0, 2] }))
    expect(encodedValuesEqual(ownEncodedValue({ a: 1, b: 2 }), ownEncodedValue({ b: 2, a: 1 }))).toBe(true)
    expect(encodedValuesEqual([1, 2], [2, 1])).toBe(false)
    expect(pathsOverlap(['a'], ['a', 'b'])).toBe(true)
    expect(pathsOverlap(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(pathsOverlap(['a/b'], ['a', 'b'])).toBe(false)
  })
})
