import { expect, test } from 'vitest'
import { bindMatrix, clipboardFits, resolveOperationLimits, decodeMatrix, encodeMatrix, parseMatrixValues } from './clipboard.js'
import { kernelId } from './kernel/model.js'
import { createNumberCodec, createStringCodec } from './value-codecs.js'

const a = kernelId<'entity'>('a'), b = kernelId<'entity'>('b'), x = kernelId<'field'>('x'), y = kernelId<'field'>('y')

test('clipboard limits count UTF-8 bytes and reject invalid configuration', () => {
  expect(resolveOperationLimits()).toEqual({ maxClipboardBytes: 2_000_000, maxMutations: 10_000 })
  expect(clipboardFits('汉字', 6)).toBe(true)
  expect(clipboardFits('汉字', 5)).toBe(false)
  expect(clipboardFits('😀', 3)).toBe(false)
  expect(clipboardFits('😀', 4)).toBe(true)
  for (const value of [0, -1, 1.5, Infinity, NaN]) {
    expect(() => resolveOperationLimits({ maxClipboardBytes: value })).toThrow('positive safe integer')
    expect(() => resolveOperationLimits({ maxMutations: value })).toThrow('positive safe integer')
  }
})

test('all cells must parse before a matrix exposes any write values', () => {
  const layout = { rows: [a, b], columns: [{ columnId: 'X', fieldId: x }, { columnId: 'Y', fieldId: y }] }
  const codecs = new Map([[x, createNumberCodec({ invalid: 'Invalid number' })], [y, createStringCodec({ invalid: 'Invalid text' })]])
  expect(parseMatrixValues('1\tfirst\ninvalid\tsecond', layout, codecs)).toEqual({ kind: 'invalid',
    input: { field: { entityId: b, fieldId: x }, text: 'invalid' }, message: 'Invalid number' })
  expect(parseMatrixValues('1\tfirst\n2\tsecond', layout, codecs)).toEqual({ kind: 'valid', values: [
    { field: { entityId: a, fieldId: x }, value: { kind: 'value', value: 1 } },
    { field: { entityId: a, fieldId: y }, value: { kind: 'value', value: 'first' } },
    { field: { entityId: b, fieldId: x }, value: { kind: 'value', value: 2 } },
    { field: { entityId: b, fieldId: y }, value: { kind: 'value', value: 'second' } },
  ] })
})

test('spreadsheet matrices round-trip quotes, embedded newlines, empty cells and explicit final empty rows', () => {
  for (const matrix of [[['']], [['a', '']], [['a'], ['']], [['a\tb', 'c\r\nd', '"quoted"']], [[''], ['']]]) expect(decodeMatrix(encodeMatrix(matrix))).toEqual(matrix)
  expect(decodeMatrix('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']])
  expect(decodeMatrix('a\n\n')).toEqual([['a'], ['']])
  expect(decodeMatrix('')).toEqual([['']])
})

test('ambiguous quoting is rejected instead of guessing a matrix', () => {
  for (const raw of ['"unfinished', 'a"b', '"a"trailing', '"a" "b"']) expect(() => decodeMatrix(raw)).toThrow()
  expect(() => encodeMatrix([])).toThrow()
  expect(() => encodeMatrix([[]])).toThrow()
})

test('matrix binding uses fixed identities and refuses truncation, ragged rows and conflicting aliases', () => {
  const layout = { rows: [b, a], columns: [{ columnId: 'X', fieldId: x }, { columnId: 'Y', fieldId: y }] }
  const bound = bindMatrix('b-x\tb-y\na-x\ta-y', layout)
  layout.rows.reverse()
  expect(bound).toEqual([
    { field: { entityId: b, fieldId: x }, text: 'b-x' }, { field: { entityId: b, fieldId: y }, text: 'b-y' },
    { field: { entityId: a, fieldId: x }, text: 'a-x' }, { field: { entityId: a, fieldId: y }, text: 'a-y' },
  ])
  for (const raw of ['a', 'a\tb', 'a\tb\nc', 'a\tb\nc\td\ne\tf']) expect(() => bindMatrix(raw, layout)).toThrow('dimensions')
  const aliases = { rows: [a], columns: [{ columnId: 'X', fieldId: x }, { columnId: 'copy', fieldId: x }] }
  expect(bindMatrix('same\tsame', aliases)).toEqual([{ field: { entityId: a, fieldId: x }, text: 'same' }])
  expect(() => bindMatrix('first\tsecond', aliases)).toThrow('disagree')
  expect(() => bindMatrix('a\nb', { rows: [a, a], columns: [aliases.columns[0]!] })).toThrow('identities')
})

test('matrix input recognition requires an explicit version and valid identity axes', async () => {
  const { readMatrixInput } = await import('./clipboard.js')
  const valid = { format: 'workspace-matrix:1', text: 'unparsed\ntext', layout: { rows: [a], columns: [{ columnId: 'X', fieldId: x }] } }
  expect(readMatrixInput({ kind: 'encoded', value: valid })).toEqual(valid)
  expect(readMatrixInput({ kind: 'encoded', value: { ...valid, format: 'workspace-matrix:2' } })).toBeNull()
  expect(readMatrixInput({ kind: 'encoded', value: { ...valid, layout: { ...valid.layout, rows: [a, a] } } })).toBeNull()
  expect(readMatrixInput({ kind: 'encoded', value: { ...valid, layout: { rows: [], columns: [] } } })).toBeNull()
  expect(readMatrixInput({ kind: 'encoded', value: 'ordinary text' })).toBeNull()
})

test('ragged paste binds only its captured row widths and preserves explicit empty cells', async () => {
  const { readMatrixInput } = await import('./clipboard.js')
  const layout = { rows: [a, b], columns: [{ columnId: 'X', fieldId: x }, { columnId: 'Y', fieldId: y }], rowWidths: [2, 1] }
  const input = { format: 'workspace-matrix:3', text: 'first\t\nsecond', layout }
  expect(readMatrixInput({ kind: 'encoded', value: input })).toEqual(input)
  expect(bindMatrix(input.text, layout)).toEqual([
    { field: { entityId: a, fieldId: x }, text: 'first' }, { field: { entityId: a, fieldId: y }, text: '' },
    { field: { entityId: b, fieldId: x }, text: 'second' },
  ])
  for (const text of ['first\t\nsecond\tadded', 'first\nsecond', 'first\t\nsecond\nextra']) expect(() => bindMatrix(text, layout)).toThrow('dimensions')
  expect(readMatrixInput({ kind: 'encoded', value: { ...input, format: 'workspace-matrix:1' } })).toBeNull()
  expect(readMatrixInput({ kind: 'encoded', value: { ...input, layout: { ...layout, rowWidths: [2, 0] } } })).toBeNull()
})

test('sparse matrix holes never parse or write unselected fields, including alias columns', async () => {
  const { readMatrixInput } = await import('./clipboard.js')
  const layout = { rows: [a, b], columns: [{ columnId: 'x', fieldId: x }, { columnId: 'x-copy', fieldId: x }, { columnId: 'y', fieldId: y }],
    members: [{ entityId: a, columnId: 'x' }, { entityId: b, columnId: 'y' }] }
  const input = { format: 'workspace-matrix:2', text: '1\tinvalid-alias\tignored\ninvalid-number\tignored\tkept', layout }
  expect(readMatrixInput({ kind: 'encoded', value: input })).toEqual(input)
  expect(parseMatrixValues(input.text, layout, new Map([[x, createNumberCodec({ invalid: 'Invalid number' })], [y, createStringCodec({ invalid: 'Invalid text' })]]))).toEqual({ kind: 'valid', values: [
    { field: { entityId: a, fieldId: x }, value: { kind: 'value', value: 1 } },
    { field: { entityId: b, fieldId: y }, value: { kind: 'value', value: 'kept' } },
  ] })
  expect(readMatrixInput({ kind: 'encoded', value: { ...input, format: 'workspace-matrix:1' } })).toBeNull()
  const outside = { ...layout, members: [{ entityId: a, columnId: 'missing' }] }
  expect(() => bindMatrix(input.text, outside)).toThrow('captured axes')
  expect(readMatrixInput({ kind: 'encoded', value: { ...input, layout: outside } })).toBeNull()
})
