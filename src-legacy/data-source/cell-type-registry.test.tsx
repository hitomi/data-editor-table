import { describe, expect, it } from 'vitest'

import { createDataGridCellTypeRegistry, registerDataGridBuiltinCellTypes, type DataGridSourceField } from './cell-type-registry.js'

type Row = { id: string; value: number }

describe('built-in fill adapters', () => {
  const field: DataGridSourceField<Row, number> = {
    key: 'value',
    label: 'Value',
    type: 'number',
    getValue: (row) => row.value,
    setValue: (row, value) => ({ ...row, value }),
  }
  const number = registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<Row>()).get('number')!

  it('continues an arithmetic sequence', () => {
    const sourceRows = [
      { id: 'a', value: 10 },
      { id: 'b', value: 20 },
    ]
    expect(number.fill?.({
      defaultValue: 10,
      field,
      sourceRows,
      sourceStartIndex: 0,
      sourceValues: [10, 20],
      targetIndex: 2,
      targetRow: { id: 'c', value: 0 },
    })).toBe(30)
  })

  it('uses the grid-provided repeating value for a non-arithmetic sequence', () => {
    const sourceRows = [
      { id: 'a', value: 1 },
      { id: 'b', value: 3 },
      { id: 'c', value: 8 },
    ]
    expect(number.fill?.({
      defaultValue: 1,
      field,
      sourceRows,
      sourceStartIndex: 0,
      sourceValues: [1, 3, 8],
      targetIndex: 3,
      targetRow: { id: 'd', value: 0 },
    })).toBe(1)
  })
})
