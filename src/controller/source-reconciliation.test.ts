import { createGridColumnHelper } from '../cell-types/column-helper.js'
import { testGridSource } from '../../tests/unit/authority.js'
import { createDataGridBinding } from '../react/data-grid-binding.js'
import { kernelId } from '../kernel/model.js'
import { describe, expect, it } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import type { GridEditSession } from '../model/grid-model.js'
import { reconcileGridEditAfterAuthority, remapGridAuthorityTargets } from './source-reconciliation.js'
import { clearInteraction } from './selection-model.js'

const registry = createStandardCellTypeRegistry<number>()
const columns = compileGridColumns<number, StandardGridCellTypeSchema>([{
  key: 'value', label: 'Value', type: 'number',
  getValue: (row: number) => row,
  setValue: (_row: number, value: number) => value,
}], registry.behaviors)
const session: GridEditSession<string> = Object.freeze({
  id: 'edit', entityId: kernelId<'entity'>('row'), revision: 4, startedRevision: 1, sourceRevision: 1,
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

  it('installs clean authority without adding local history, including repeated reads', async () => {
    const initial = [{ id: 'row', value: 0 }]
    const column = createGridColumnHelper<typeof initial[number]>()
    const { dataSource, server } = testGridSource(initial, [column.field('value', { label: 'Value', type: 'number' })])
    const grid = createDataGridBinding({ dataSource }).controller
    await grid.refresh()
    const before = grid.getSnapshot().draft
    const remote = server.snapshot([{ id: 'row', value: 2 }], 2)
    server.install(remote)
    dataSource.publish(remote)
    expect(grid.getSnapshot().draft).toMatchObject({ rows: [{ value: 2 }], baselineVersion: 'v2', undoStack: [], dirtyCells: [] })
    expect(before.rows).toEqual(initial)
    expect(await grid.save()).toMatchObject({ status: 'no-changes' })
    expect(server.source.submit).not.toHaveBeenCalled()
    await grid.refresh()
    expect(grid.getSnapshot().draft.undoStack).toEqual([])
    grid.destroy()
  })

  it('preserves an editor for a falsy primitive row when its original value still matches', () => {
    const next = reconcileGridEditAfterAuthority({
      session, resolveRow: () => 0, columns, sourceRevision: 9, editRevision: 4,
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
      session, resolveRow: () => rows[0], columns, sourceRevision: 9, editRevision: 4,
    })
    expect(next.editRevision).toBe(5)
    expect(next.edit).toMatchObject({ status: 'invalid', draftValue: session.draftValue, originalValue: 0 })
    expect(next.edit?.error).toContain(reason)
    expect(session.status).toBe('editing')
  })
})
