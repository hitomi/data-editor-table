import { expect, test } from 'vitest'
import { createBooleanCodec, createIsoDateCodec, createNumberCodec, createStringCodec } from './value-codecs.js'

const invalid = 'Invalid input'
test('string authoring preserves whitespace and empty strings without converting null or absence', () => {
  const codec = createStringCodec({ invalid })
  for (const text of ['', ' ', '\n', '001']) expect(codec.parse(codec.format({ kind: 'value', value: text }))).toEqual({ kind: 'valid', value: { kind: 'value', value: text } })
  expect(() => codec.format({ kind: 'missing' })).toThrow()
  expect(() => codec.format({ kind: 'value', value: null })).toThrow()
  expect(createStringCodec({ invalid, allowEmpty: false }).parse('')).toEqual({ kind: 'invalid', message: invalid })
})

test('numeric authoring rejects implicit conversions and enforces configured bounds in both directions', () => {
  const codec = createNumberCodec({ invalid })
  for (const text of ['', ' ', ' 1', '1 ', '0x10', 'Infinity', 'NaN', '1,000', '9007199254740993', '1e999', '1e-999']) expect(codec.parse(text).kind).toBe('invalid')
  for (const [text, value] of [['.5', 0.5], ['-1.25e2', -125], ['+0', 0]] as const) expect(codec.parse(text)).toEqual({ kind: 'valid', value: { kind: 'value', value } })
  expect(codec.format({ kind: 'value', value: -0 })).toBe('-0')
  const bounded = createNumberCodec({ invalid, minimum: 1, maximum: 4, integer: true })
  for (const value of [0, 1.5, 5, Infinity]) {
    expect(bounded.parse(String(value)).kind).toBe('invalid')
    expect(() => bounded.format({ kind: 'value', value })).toThrow()
  }
  expect(() => createNumberCodec({ invalid, minimum: 5, maximum: 2 })).toThrow()
})

test('empty policies distinguish a removed field from an explicit null', () => {
  for (const create of [createNumberCodec, createBooleanCodec, createIsoDateCodec]) {
    const missing = create({ invalid, empty: 'missing' }), nullable = create({ invalid, empty: 'null' })
    expect(missing.parse('')).toEqual({ kind: 'valid', value: { kind: 'missing' } })
    expect(nullable.parse('')).toEqual({ kind: 'valid', value: { kind: 'value', value: null } })
    expect(missing.format({ kind: 'missing' })).toBe('')
    expect(nullable.format({ kind: 'value', value: null })).toBe('')
    expect(() => missing.format({ kind: 'value', value: null })).toThrow()
    expect(() => nullable.format({ kind: 'missing' })).toThrow()
  }
})

test('boolean parsing accepts explicit tokens without truthiness coercion', () => {
  const codec = createBooleanCodec({ invalid })
  expect(codec.parse('FALSE')).toEqual({ kind: 'valid', value: { kind: 'value', value: false } })
  expect(codec.parse('true')).toEqual({ kind: 'valid', value: { kind: 'value', value: true } })
  for (const text of ['0', '1', 'yes', '', ' false ']) expect(codec.parse(text).kind).toBe('invalid')
})

test('dates validate actual Gregorian days without timezone normalization', () => {
  const codec = createIsoDateCodec({ invalid })
  for (const text of ['2000-02-29', '2024-02-29', '0001-01-01', '9999-12-31']) expect(codec.parse(text)).toEqual({ kind: 'valid', value: { kind: 'value', value: text } })
  for (const text of ['1900-02-29', '2023-02-29', '2024-04-31', '0000-01-01', '2024-13-01', '2024-01-00', '2024-1-1', '2024-01-01T00:00:00Z']) expect(codec.parse(text).kind).toBe('invalid')
})

test('choice tokens preserve value types and own the catalog without parsing labels', async () => {
  const { createSingleChoiceCodec } = await import('./value-codecs.js')
  const options = [{ value: 1 as string | number, label: 'Numeric one' }, { value: '1', label: 'Text one' }, { value: '', label: 'Empty text' }]
  const codec = createSingleChoiceCodec({ invalid, placeholder: 'Choose', options, empty: 'null' })
  options[0]!.value = 2; options[0]!.label = 'Mutated'
  for (const value of [1, '1', '']) expect(codec.parse(codec.format({ kind: 'value', value }))).toEqual({ kind: 'valid', value: { kind: 'value', value } })
  expect(codec.display!({ kind: 'value', value: 1 })).toBe('Numeric one')
  expect(codec.parse('Numeric one').kind).toBe('invalid')
  expect(codec.parse('')).toEqual({ kind: 'valid', value: { kind: 'value', value: null } })
  expect(codec.choices!.options.map(option => option.text)).toEqual(['1', '"1"', '""'])
  expect(() => codec.format({ kind: 'value', value: 2 })).toThrow()
  expect(() => createSingleChoiceCodec({ invalid, placeholder: 'Choose', options: [{ value: 1, label: 'A' }, { value: 1, label: 'B' }] })).toThrow()
})

test('boolean choices display labels while preserving explicit true and false tokens', async () => {
  const { createBooleanChoiceCodec } = await import('./value-codecs.js')
  const codec = createBooleanChoiceCodec({ invalid, trueLabel: 'Yes', falseLabel: 'No', placeholder: 'Choose' })
  expect(codec.display!({ kind: 'value', value: false })).toBe('No')
  expect(codec.choices!.options).toEqual([{ text: 'true', label: 'Yes' }, { text: 'false', label: 'No' }])
  expect(codec.parse('No').kind).toBe('invalid')
  expect(codec.parse('false')).toEqual({ kind: 'valid', value: { kind: 'value', value: false } })
})

test('multi-choice preserves typed membership and order and rejects duplicate or unknown members', async () => {
  const { createMultiChoiceCodec } = await import('./value-codecs.js')
  const codec = createMultiChoiceCodec({ invalid, placeholder: 'None', options: [{ value: 1, label: 'Number' }, { value: '1', label: 'String' }] })
  for (const value of [[], [1, '1'], ['1', 1]]) expect(codec.parse(codec.format({ kind: 'value', value }))).toEqual({ kind: 'valid', value: { kind: 'value', value } })
  expect(codec.display!({ kind: 'value', value: ['1', 1] })).toBe('String, Number')
  expect(codec.choices!.multiple).toBe(true)
  for (const value of [[1, 1], ['unknown'], null]) expect(() => codec.format({ kind: 'value', value })).toThrow()
  for (const text of ['', 'null', '[1]', '["1","1"]', '["unknown"]']) expect(codec.parse(text).kind).toBe('invalid')
})
