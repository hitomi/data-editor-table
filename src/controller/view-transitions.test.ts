import { describe, expect, it } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import { resolveGridLayout } from './controller-state.js'
import { clearInteraction } from './selection-model.js'
import { transitionGridView } from './view-transitions.js'

const registry = createStandardCellTypeRegistry<number>()
const columns = compileGridColumns<number, StandardGridCellTypeSchema>([{
  key: 'value', label: 'Value', type: 'number', filterable: true, sortable: true,
  getValue: (row) => row, setValue: (_row, value) => value,
}], registry.behaviors)
const sizes = { rowHeight: 36, headerHeight: 36, rowIndicatorWidth: 48 }
const input = {
  rows: [0, 1, 2], columns, getRowKey: (row: number) => row, sizes,
  view: { revision: 0, visibleRowKeys: [0, 1, 2], globalFilter: '', columnFilters: [], sort: [] },
  interaction: { ...clearInteraction<number>(), activeCell: { rowKey: 0, columnKey: 'value' } },
  layout: resolveGridLayout(columns, 3, { viewportWidth: 400, viewportHeight: 300, scrollLeft: 0, scrollTop: 0 }, sizes, 0),
}

describe('view transition', () => {
  it('returns query, derived order, selection and layout as one unpublished result', () => {
    const next = transitionGridView({ ...input, changes: { globalFilter: '1' } })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.changes.view.visibleRowKeys).toEqual([1])
    expect(next.changes.view.globalFilter).toBe('1')
    expect(next.changes.interaction.activeCell?.rowKey).not.toBe(0)
    expect(next.changes.layout.revision).toBe(1)
    expect(input.view.visibleRowKeys).toEqual([0, 1, 2])
    expect(input.interaction.activeCell.rowKey).toBe(0)
  })

  it('rejects unsupported sort and filter operators before deriving a replacement view', () => {
    expect(transitionGridView({ ...input, changes: { sort: [{ columnKey: 'missing', direction: 'ascending' }] } })).toMatchObject({ ok: false })
    expect(transitionGridView({ ...input, changes: { columnFilters: [{ columnKey: 'value', operator: 'missing', value: '1' }] } })).toMatchObject({ ok: false })
    expect(input.view.revision).toBe(0)
  })
})
