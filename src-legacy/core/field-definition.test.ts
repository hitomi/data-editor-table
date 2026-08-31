import { describe, expect, it } from 'vitest'

import {
  createDataGridFieldRegistry,
  isDataGridParseFailure,
  setDataGridFieldFromText,
  shouldOpenDataGridEditorOnClick,
  type DataGridFieldDefinition,
} from './field-definition'

type Row = { editable: boolean; status: string; title: string }
const select: DataGridFieldDefinition<Row> = {
  kind: 'select', key: 'status', label: 'Status', getValue: (row) => row.status,
  setValue: (row, status) => ({ ...row, status }), isEditable: (row) => row.editable,
  options: [{ label: 'Active', value: 'active' }],
}

describe('field definitions', () => {
  it('opens click editors only for editable select cells', () => {
    expect(shouldOpenDataGridEditorOnClick(select, { editable: true, status: 'active', title: '' })).toBe(true)
    expect(shouldOpenDataGridEditorOnClick(select, { editable: false, status: 'active', title: '' })).toBe(false)
  })

  it('rejects duplicate and empty registry keys instead of silently replacing fields', () => {
    expect(() => createDataGridFieldRegistry([select, { ...select }])).toThrow('Duplicate data grid field key: status')
    expect(() => createDataGridFieldRegistry([{ ...select, key: '' }])).toThrow('Data grid field keys must not be empty')
  })

  it('parses select values before labels and reports invalid or ambiguous labels', () => {
    const field: DataGridFieldDefinition<Row> = {
      ...select,
      options: [
        { label: 'Active', value: 'active' },
        { label: 'active', value: 'archived' },
        { label: 'Duplicate', value: 'one' },
        { label: 'Duplicate', value: 'two' },
      ],
    }
    const row = { editable: true, status: '', title: '' }
    expect(setDataGridFieldFromText(field, row, 'active')).toMatchObject({ status: 'active' })
    expect(isDataGridParseFailure(setDataGridFieldFromText(field, row, 'Duplicate'))).toBe(true)
    expect(isDataGridParseFailure(setDataGridFieldFromText(field, row, 'Missing'))).toBe(true)
  })
})
