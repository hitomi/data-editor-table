import { describe, expect, it } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import type { GridDraftState } from '../model/grid-model.js'
import { resolveGridLayout } from './controller-state.js'
import { prepareGridDraftPublication } from './draft-commands.js'
import { clearInteraction } from './selection-model.js'

const registry = createStandardCellTypeRegistry<number>()
const columns = compileGridColumns<number, StandardGridCellTypeSchema>([{
  key: 'value', label: 'Value', type: 'number', getValue: (row) => row,
}], registry.behaviors)
const draft: GridDraftState<number, number> = {
  revision: 0, rows: [0, 1], baselineRows: [0, 1], baselineVersion: 'base',
  dirtyCells: [], validationIssues: [], conflicts: [], insertedRowKeys: [], deletedRowKeys: [],
  orderDirty: false, undoStack: [], redoStack: [],
}
const sizes = { rowHeight: 36, headerHeight: 36, rowIndicatorWidth: 48 }
const input = {
  currentDraft: draft, columns, getRowKey: (row: number) => row, sizes, maxMutations: 1,
  view: { revision: 0, visibleRowKeys: [0, 1], globalFilter: '', columnFilters: [], sort: [] },
  interaction: clearInteraction<number>(),
  layout: resolveGridLayout(columns, 2, { viewportWidth: 400, viewportHeight: 300, scrollLeft: 0, scrollTop: 0 }, sizes, 0),
}

describe('typed Draft publication', () => {
  it('keeps a no-op draft unchanged without constructing a new read model', () => {
    expect(prepareGridDraftPublication({ ...input, transition: { kind: 'local', draft, transactionCost: 0 } })).toEqual({ ok: true, changes: null })
  })

  it('publishes a row transaction with explicit row selection but does not recreate its history', () => {
    const next = { ...draft, revision: 1, rows: [0, 1, 2], insertedRowKeys: [2] }
    const result = prepareGridDraftPublication({ ...input, transition: { kind: 'local', draft: next, transactionCost: 1, selectRows: [2] } })
    if (!result.ok || !result.changes) throw new Error('Expected a prepared row transition')
    expect(result.changes.draft).toBe(next)
    expect(result.changes.draft.undoStack).toBe(next.undoStack)
    expect(result.changes.view.visibleRowKeys).toEqual([0, 1, 2])
    expect(result.changes.interaction.activeCell?.rowKey).toBe(2)
    expect(result.changes).toMatchObject({ edit: null, bulk: null })
    expect(input.view.visibleRowKeys).toEqual([0, 1])
  })

  it('preserves history restoration as a distinct protocol from limited local writes', () => {
    const restored = { ...draft, revision: 1, rows: [0] }
    expect(prepareGridDraftPublication({ ...input, maxMutations: 0, transition: { kind: 'local', draft: restored, transactionCost: 1 } }).ok).toBe(false)
    const result = prepareGridDraftPublication({ ...input, maxMutations: 0, transition: { kind: 'history', draft: restored } })
    if (!result.ok || !result.changes) throw new Error('Expected history restoration')
    expect(result.changes.draft).toBe(restored)
    expect(result.changes.draft.undoStack).toBe(restored.undoStack)
  })
})
