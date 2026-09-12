import { expect, test } from 'vitest'
import { emptyBulkInput, readBulkInput, transformBulkText } from './workspace-bulk-editor.js'

test('bulk replacement distinguishes literal text from regex capture expansion and rejects invalid expressions', () => {
  const input = { ...emptyBulkInput, operation: 'replace' as const, find: '.', replacement: '$1' }
  expect(transformBulkText(input, 'a.b.')).toBe('a$1b$1')
  expect(transformBulkText({ ...input, useRegex: true, find: '(a)', replacement: '[$1]' }, 'a.b.a')).toBe('[a].b.[a]')
  expect(() => transformBulkText({ ...input, find: '' }, 'unchanged')).toThrow('Enter text to find.')
  expect(() => transformBulkText({ ...input, find: '[', useRegex: true }, 'unchanged')).toThrow('valid regular expression')
  expect(transformBulkText({ ...emptyBulkInput, operation: 'affix', prefix: '前', suffix: '后' }, '文')).toBe('前文后')
})

test('recovery recognizes complete versioned operation parameters and leaves unsupported input untouched', () => {
  expect(readBulkInput({ kind: 'encoded', value: emptyBulkInput })).toEqual(emptyBulkInput)
  for (const value of [{ ...emptyBulkInput, format: 'workspace-bulk:2' }, { ...emptyBulkInput, find: null }, { ...emptyBulkInput, operation: 'unknown' }, { ...emptyBulkInput, operation: ['set'] }, 'raw text']) {
    expect(readBulkInput({ kind: 'encoded', value })).toBeNull()
  }
})
