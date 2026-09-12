import { expect, test } from 'vitest'
import { beginChoiceBulk, readChoiceBulkInput, transformChoiceBulk } from './workspace-choice-bulk.js'
const catalog = { placeholder: '', multiple: true, options: [{ text: '1', label: 'Number' }, { text: '"1"', label: 'Text' }, { text: '"old"', label: 'Legacy', disabled: true }] }
test('mixed tags begin as keep, while equal sets retain typed values in catalog order', () => {
  expect(beginChoiceBulk([['1'], ['"1"']], catalog)).toMatchObject({ operation: 'keep', tokens: [] })
  expect(beginChoiceBulk([['"1"', '1'], ['1', '"1"']], catalog)).toMatchObject({ operation: 'replace', tokens: ['1', '"1"'] })
})
test('add deduplicates, remove permits disabled tags, and replacement cannot introduce disabled tags', () => {
  const input = { format: 'workspace-choice-bulk:1' as const, operation: 'add' as const, tokens: ['1', '"1"'] }
  expect(transformChoiceBulk(input, ['1'], catalog, 'Unavailable')).toEqual(['1', '"1"'])
  expect(transformChoiceBulk({ ...input, operation: 'remove', tokens: ['"old"'] }, ['"old"', '1'], catalog, 'Unavailable')).toEqual(['1'])
  expect(() => transformChoiceBulk({ ...input, operation: 'replace', tokens: ['"old"'] }, ['1'], catalog, 'Unavailable')).toThrow('Unavailable')
  expect(transformChoiceBulk({ ...input, operation: 'replace', tokens: ['"old"'] }, ['"old"'], catalog, 'Unavailable')).toEqual(['"old"'])
  expect(readChoiceBulkInput({ kind: 'encoded', value: input })).toEqual(input)
  expect(readChoiceBulkInput({ kind: 'encoded', value: { ...input, operation: ['add'] } })).toBeNull()
  expect(() => transformChoiceBulk({ ...input, tokens: ['unknown'] }, [], catalog, 'Unavailable')).toThrow()
})
