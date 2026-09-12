import { createNumberCodec } from '../value-codecs.js'
import { expect, it } from 'vitest'
import { expandWorkspaceFill, resolveWorkspaceFill, type WorkspaceFillContext } from './workspace-fill.js'
import { kernelId } from '../kernel/model.js'
const rows = ['a', 'b', 'c', 'd', 'e'].map(value => kernelId<'entity'>(value)), columns = ['x', 'y', 'z']

it('repeats literal values including empty strings in both directions without changing the captured view', () => {
  const source = { rows: rows.slice(1, 3), columns: columns.slice(1) }, values = [['one', ''], ['two', 'three']]
  const before = JSON.stringify({ rows, columns, values })
  expect(expandWorkspaceFill({ rows, columns }, source, values, { entityId: rows[0]!, columnId: 'x' }).values)
    .toEqual([['three', 'two', 'three'], ['', 'one', ''], ['three', 'two', 'three']])
  const result = expandWorkspaceFill({ rows, columns }, source, values, { entityId: rows[4]!, columnId: 'z' })
  expect(result.rows).toEqual(rows.slice(1))
  expect(result.values).toEqual([['one', ''], ['two', 'three'], ['one', ''], ['two', 'three']])
  expect(JSON.stringify({ rows, columns, values })).toBe(before)
})

it('rejects missing destinations, changed source membership and incomplete patterns rather than filling partial targets', () => {
  const view = { rows, columns }, source = { rows: rows.slice(0, 2), columns: ['x'] }
  expect(() => expandWorkspaceFill(view, source, [['a']], { entityId: rows[2]!, columnId: 'x' })).toThrow('complete source')
  expect(() => expandWorkspaceFill(view, { ...source, rows: [rows[0]!, rows[2]!] }, [['a'], ['b']], { entityId: rows[3]!, columnId: 'x' })).toThrow('consecutive')
  expect(() => expandWorkspaceFill(view, source, [['a'], ['b']], { entityId: kernelId<'entity'>('missing'), columnId: 'x' })).toThrow('captured view')
})


it('extends numeric series in all directions using frozen captured documents and target codecs', () => {
  const codec = createNumberCodec({ invalid: 'Number required.' }), seen: WorkspaceFillContext[] = []
  const definitions = columns.map(id => ({ id, fieldId: kernelId<'field'>(id), codec, fill: (context: WorkspaceFillContext) => {
    seen.push(context)
    expect(Object.isFrozen(context.document)).toBe(true)
    expect(Object.isFrozen(context.sourceValues)).toBe(true)
    const first = context.sourceValues[0]!, second = context.sourceValues[1]!
    if (first.kind !== 'value' || second.kind !== 'value') throw new Error('Missing series values')
    return { kind: 'value' as const, value: Number(first.value) + context.targetIndex * (Number(second.value) - Number(first.value)) }
  } }))
  const documents = new Map(rows.map(entity => [entity, { hidden: 7 }]))
  const vertical = { rows: rows.slice(1, 3), columns: ['y'] }
  expect(resolveWorkspaceFill({ rows, columns }, vertical, [['10'], ['12']], { entityId: rows[0]!, columnId: 'y' }, definitions, documents).values).toEqual([['8'], ['10'], ['12']])
  expect(resolveWorkspaceFill({ rows, columns }, vertical, [['10'], ['12']], { entityId: rows[0]!, columnId: 'y' }, definitions, documents).readEntities).toEqual([rows[0]])
  expect(seen.at(-1)).toMatchObject({ direction: 'up', targetIndex: -1, sourceStartIndex: 0, document: { hidden: 7 } })
  expect(resolveWorkspaceFill({ rows, columns }, vertical, [['10'], ['12']], { entityId: rows[4]!, columnId: 'y' }, definitions, documents).values).toEqual([['10'], ['12'], ['14'], ['16']])
  expect(seen.at(-1)).toMatchObject({ direction: 'down', targetIndex: 3 })
  expect(resolveWorkspaceFill({ rows, columns }, { rows: [rows[1]!], columns: ['y', 'z'] }, [['10', '12']], { entityId: rows[1]!, columnId: 'x' }, definitions, documents).values).toEqual([['8', '10', '12']])
  expect(seen.at(-1)).toMatchObject({ direction: 'left', targetIndex: -1 })
  expect(resolveWorkspaceFill({ rows, columns }, { rows: [rows[1]!], columns: ['x', 'y'] }, [['10', '12']], { entityId: rows[1]!, columnId: 'z' }, definitions, documents).values).toEqual([['10', '12', '14']])
  expect(seen.at(-1)).toMatchObject({ direction: 'right', targetIndex: 2 })
  expect([...documents.values()]).toEqual(rows.map(() => ({ hidden: 7 })))
})

it('rejects an entire custom fill on conversion or callback failure without mutating its source', () => {
  const codec = createNumberCodec({ invalid: 'Number required.' }), source = { rows: [rows[0]!], columns: ['x'] }
  const values = [['2']], documents = new Map(rows.map(entity => [entity, { hidden: 7 }]))
  const definitions = [{ id: 'x', fieldId: kernelId<'field'>('x'), codec, fill: ({ targetIndex }: WorkspaceFillContext) => {
    if (targetIndex === 2) throw new Error('Cannot produce this destination')
    return { kind: 'value' as const, value: 3 }
  } }]
  expect(() => resolveWorkspaceFill({ rows, columns }, source, values, { entityId: rows[2]!, columnId: 'x' }, definitions, documents)).toThrow('Cannot produce')
  expect(() => resolveWorkspaceFill({ rows, columns }, source, [['not a number']], { entityId: rows[1]!, columnId: 'x' }, definitions, documents)).toThrow('converted')
  expect(values).toEqual([['2']])
  expect([...documents.values()]).toEqual(rows.map(() => ({ hidden: 7 })))
})
