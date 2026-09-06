import { describe, expect, it } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import type { GridDraftState, GridEditSession } from '../model/grid-model.js'
import { acknowledgeGridCommit, rebaseGridAuthority, reconcileGridEditAfterAuthority, remapGridAuthorityTargets } from './source-reconciliation.js'
import { clearInteraction } from './selection-model.js'

const registry = createStandardCellTypeRegistry<number>()
const columns = compileGridColumns<number, StandardGridCellTypeSchema>([{
  key: 'value', label: 'Value', type: 'number',
  getValue: (row: number) => row,
  setValue: (_row: number, value: number) => value,
}], registry.behaviors)
const getRowKey = () => 'row'
const remote = (rows: readonly number[], version: string) => ({
  rows, version, status: 'ready' as const, scope: { kind: 'complete' as const },
})
const empty: GridDraftState<number, string> = {
  revision: 0, baselineVersion: 'base', baselineRows: [], rows: [],
  dirtyCells: [], validationIssues: [], conflicts: [], insertedRowKeys: [],
  deletedRowKeys: [], orderDirty: false, undoStack: [], redoStack: [],
}
const session: GridEditSession<string> = Object.freeze({
  revision: 4, startedRevision: 1, sourceRevision: 1,
  cell: { rowKey: 'row', columnKey: 'value' }, originalValue: 0,
  draftValue: 'recoverable input', status: 'editing', composing: false, error: null,
})

describe('source reconciliation domain', () => {
  it('remaps selection and editor targets together without changing their original objects', () => {
    const range = { anchor: session.cell, focus: session.cell }
    const interaction = { ...clearInteraction<string>(), activeCell: session.cell, ranges: [range], fillPreview: range }
    const next = remapGridAuthorityTargets({
      visibleRowKeys: ['row'], interaction, edit: session, bulk: null,
    }, [{ from: 'row', to: 'server-row' }])
    expect(next.visibleRowKeys).toEqual(['server-row'])
    expect(next.interaction.activeCell?.rowKey).toBe('server-row')
    expect(next.interaction.ranges[0]?.anchor.rowKey).toBe('server-row')
    expect(next.interaction.fillPreview?.focus.rowKey).toBe('server-row')
    expect(next.edit?.cell.rowKey).toBe('server-row')
    expect(next.edit?.draftValue).toBe(session.draftValue)
    expect(interaction.activeCell.rowKey).toBe('row')
    expect(session.cell.rowKey).toBe('row')
  })

  it('constructs a clean authority draft without adding local history', () => {
    const draft = rebaseGridAuthority({ draft: empty, remote: remote([0], 'opaque-next'), columns, getRowKey })
    expect(draft).toMatchObject({ rows: [0], baselineRows: [0], baselineVersion: 'opaque-next', revision: 1 })
    expect(draft.undoStack).toEqual([])
    expect(draft.dirtyCells).toEqual([])
    expect(empty.rows).toEqual([])
  })

  it('acknowledges a clean proposal without inventing an edit transaction', () => {
    const draft = rebaseGridAuthority({ draft: empty, remote: remote([0], 'base'), columns, getRowKey })
    const applied = remote([0], 'receipt')
    const next = acknowledgeGridCommit({
      draft, columns, getRowKey, applied, latest: applied,
      committedRows: [0], committedDraftRevision: draft.revision, keyRemap: [],
    })
    expect(next.baselineVersion).toBe('receipt')
    expect(next.rows).toEqual([0])
    expect(next.undoStack).toEqual([])
    expect(next.dirtyCells).toEqual([])
  })

  it('preserves an editor for a falsy primitive row when its original value still matches', () => {
    const next = reconcileGridEditAfterAuthority({
      session, rows: [0], columns, getRowKey, sourceRevision: 9, editRevision: 4,
    })
    expect(next).toEqual({ edit: { ...session, sourceRevision: 9 }, editRevision: 4 })
    expect(session.sourceRevision).toBe(1)
  })

  it.each([
    { rows: [] as number[], reason: 'removed remotely' },
    { rows: [2], reason: 'changed remotely' },
    { rows: [Number.NaN], reason: 'changed remotely' },
  ])('retains recoverable input when authority invalidates its target: $reason', ({ rows, reason }) => {
    const next = reconcileGridEditAfterAuthority({
      session, rows, columns, getRowKey, sourceRevision: 9, editRevision: 4,
    })
    expect(next.editRevision).toBe(5)
    expect(next.edit).toMatchObject({ status: 'invalid', draftValue: session.draftValue, originalValue: 0 })
    expect(next.edit?.error).toContain(reason)
    expect(session.status).toBe('editing')
  })
})
