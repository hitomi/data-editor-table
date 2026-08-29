import { describe, expect, it } from 'vitest'

import { shouldOpenDataGridEditorOnClick, type DataGridFieldDefinition } from './field-definition'

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
})
