import { describe, expect, it } from 'vitest'

import { parseDataGridClipboard } from './clipboard'

describe('parseDataGridClipboard', () => {
  it('parses quoted tabs, quotes and line breaks', () => {
    expect(parseDataGridClipboard('name\tnote\nAda\t"one\ttwo"\nLin\t"say ""hi"""')).toEqual([
      ['name', 'note'],
      ['Ada', 'one\ttwo'],
      ['Lin', 'say "hi"'],
    ])
  })

  it('rejects unterminated quotes and bounded input', () => {
    expect(() => parseDataGridClipboard('"open')).toThrow('unterminated')
    expect(() => parseDataGridClipboard('a\tb', { cellLimit: 1 })).toThrow('cell limit')
  })
})
