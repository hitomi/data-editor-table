import { describe, expect, it } from 'vitest'
import { entityId, KernelFixture, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { kernelId, type Document } from './model.js'
import { decodeRow, defineKernelSchema, documentCodec, encodeRow, type DocumentCodec } from './schema.js'
import { reduceKernel } from './transition.js'

describe('fixed schema and complete candidate validation', () => {
  it('rejects an entire action when its second row violates the schema', () => {
    const schema = defineKernelSchema({ ...permissiveSchema, validate: document => typeof document.x !== 'number' || document.x < 0 ? [{ code: 'negative', message: 'x must be nonnegative' }] : [] })
    const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } }, schema)
    const prepared = fixture.prepare([fixture.write('a', { x: 1 }), fixture.write('b', { x: -1 })]), before = fixture.state
    const transition = fixture.dispatch({ kind: 'prepared-action', prepared })
    expect(transition.result).toMatchObject({ kind: 'rejected', issue: { message: 'x must be nonnegative' } })
    expect(fixture.state).toBe(before)
    expect(fixture.state.inputs).toEqual([])
    expect(prepared.inputs[0]?.input).toEqual({ kind: 'encoded', value: 'original input' })
  })

  it('revalidates the complete merged document and preserves invalid local input across refreshes', () => {
    const schema = defineKernelSchema({ ...permissiveSchema, validate: document => {
      if (typeof document.limit !== 'number') throw new Error('Unrecognized limit representation')
      return typeof document.total !== 'number' || document.total > document.limit ? [{ code: 'limit', message: 'Total exceeds limit' }] : []
    } })
    const fixture = new KernelFixture({ a: { total: 10, limit: 50 } }, schema)
    fixture.apply([fixture.write('a', { total: 20 })], 'row', '20')
    fixture.observe({ a: { total: 10, limit: 15 } }, 1)
    expect(fixture.project().rows[0]?.issues.map(issue => issue.code)).toContain('schema-invalid')
    fixture.observe({ a: { total: 20, limit: 15 } }, 2)
    expect(fixture.state.settlements).toEqual([])
    fixture.observe({ a: { total: 20, limit: null } }, 3)
    expect(fixture.project().rows[0]?.issues.map(issue => issue.code)).toContain('schema-validation-failed')
    expect(fixture.state.inputs[0]?.input).toEqual({ kind: 'encoded', value: '20' })
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
  })

  it('protects schema read-only domains for both field writes and explicit replacements', () => {
    const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: kernelId<'field'>('hidden'), path: ['hidden'], readonly: true }] })
    const fixture = new KernelFixture({ a: { x: 0, hidden: 0 } }, schema)
    for (const command of [fixture.write('a', { x: 1, hidden: 1 }), { kind: 'replace' as const, entityId: entityId('a'), document: { x: 1, hidden: 1 } }]) {
      const prepared = fixture.prepare([command]), before = fixture.state
      expect(fixture.dispatch({ kind: 'prepared-action', prepared }).result.kind).toBe('rejected')
      expect(fixture.state).toBe(before)
    }
    fixture.apply([{ kind: 'replace', entityId: entityId('a'), document: { x: 1, hidden: 0 } }])
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 1, hidden: 0 })
  })

  it('allows replacement of writable siblings while retaining a nested read-only null value', () => {
    const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: kernelId<'field'>('secret'), path: ['hidden', 'secret'], readonly: true }] })
    const before = { x: 0, hidden: { secret: null, sibling: 'old' }, omitted: true }
    const after = { x: 1, hidden: { secret: null, sibling: 'new' } }
    const fixture = new KernelFixture({ a: before }, schema)
    fixture.apply([{ kind: 'replace', entityId: entityId('a'), document: after }])
    expect(fixture.project().changes).toMatchObject([{ before, after }])
    expect(fixture.project().rows[0]?.issues).toEqual([])
  })

  it('requires fixed workspace versions and unambiguous field bindings', () => {
    const fixture = new KernelFixture({})
    const changed = defineKernelSchema({ ...permissiveSchema, version: kernelId<'schema-version'>('different') })
    expect(reduceKernel(fixture.state, { kind: 'read-started', ticket: 'read' }, changed).result.kind).toBe('rejected')
    expect(() => defineKernelSchema({ ...permissiveSchema, fields: [
      { id: kernelId<'field'>('profile'), path: ['profile'], readonly: false },
      { id: kernelId<'field'>('name'), path: ['profile', 'name'], readonly: false },
    ] })).toThrow('Overlapping')
  })
})

describe('versioned business row codecs', () => {
  type Row = { date: Date; count: number }
  const codec: DocumentCodec<Row> = {
    version: kernelId<'codec-version'>('dates'),
    copy: row => ({ date: new Date(row.date), count: row.count }),
    equals: (a, b) => a.date.getTime() === b.date.getTime() && a.count === b.count,
    encode: row => ({ date: row.date.toISOString(), count: row.count }),
    decode: document => {
      if (typeof document.date !== 'string' || typeof document.count !== 'number') throw new Error('Invalid row encoding')
      return { date: new Date(document.date), count: document.count }
    },
  }

  it('owns and round-trips custom values without storing them in kernel documents', () => {
    const source = { date: new Date('2026-09-07T00:00:00Z'), count: 2 }
    const encoded = encodeRow(codec, source), decoded = decodeRow(codec, encoded)
    expect(encoded).toEqual({ date: '2026-09-07T00:00:00.000Z', count: 2 })
    decoded.date.setUTCFullYear(2000)
    expect(source.date.getUTCFullYear()).toBe(2026)
    expect(encoded.date).toBe('2026-09-07T00:00:00.000Z')
    expect(Object.isFrozen(encoded)).toBe(true)
  })

  it('rejects mutation, nondeterminism, lossy encoding and aliasing copies', () => {
    const source = { date: new Date('2026-09-07T00:00:00Z'), count: 2 }
    expect(() => encodeRow({ ...codec, encode: row => { row.count++; return codec.encode(row) } }, source)).toThrow('mutated')
    expect(source.count).toBe(2)
    let serial = 0
    expect(() => encodeRow({ ...codec, encode: row => ({ ...(codec.encode(row) as Document), nonce: serial++ }) }, source)).toThrow('deterministic')
    expect(() => encodeRow({ ...codec, encode: row => ({ date: row.date.toISOString(), count: 0 }) }, source)).toThrow('losslessly')
    expect(() => encodeRow({ ...codec, copy: row => row }, source)).toThrow('independently')
    expect(() => decodeRow(codec, { date: source.date.toISOString(), count: 2, hidden: true })).toThrow('stored fields')
  })

  it('supports canonical document rows without erasing missing or hidden fields', () => {
    const codec = documentCodec(kernelId<'codec-version'>('documents'))
    const source = { x: null, nested: { hidden: false } }
    expect(decodeRow(codec, encodeRow(codec, source))).toEqual(source)
    expect(Object.hasOwn(encodeRow(codec, source), 'missing')).toBe(false)
  })
})
