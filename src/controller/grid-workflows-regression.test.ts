import { describe, expect, it } from 'vitest'
import { cell, nameColumn, persistenceGrid } from '../../tests/unit/persistence-grid.js'
import { rejected, testGridSource } from '../../tests/unit/authority.js'
import { createDataGridBinding } from '../react/data-grid-binding.js'

describe('grid editing and lifecycle', () => {
  it.each(['a', 'b'])('invalidates the open menu and selection when selected row %s is replaced', async key => {
    const { grid, dataSource, server } = await persistenceGrid()
    const second = { ...cell, rowKey: 'b' }
    grid.dispatch({ type: 'interaction/activate', cell, range: { anchor: cell, focus: second } })
    grid.dispatch({ type: 'interaction/open-action', target: cell, menuPosition: { x: 5, y: 5 } })
    const next = server.snapshot([{ id: 'a', name: 'Updated', count: 0 }, { id: 'b', name: 'Other', count: 0 }], 2)
    dataSource.publish(next)
    expect(grid.getSnapshot().interaction.actionSession?.target).toEqual(cell)
    const rows = next.rows.map(row => row.identity.key === key ? { ...row, identity: { ...row.identity, incarnation: 'new' } } : row)
    const replacement = { ...server.snapshot([], 3), rows, order: rows.map(row => row.identity) }
    server.install(replacement)
    dataSource.publish(replacement)
    expect(grid.getSnapshot().interaction.actionSession).toBeNull()
    expect(grid.dispatch({ type: 'rows/delete' }).accepted).toBe(false)
    expect(await grid.save()).toMatchObject({ status: 'no-changes' })
    expect(server.source.submit).not.toHaveBeenCalled()
    expect(grid.destroy().status).toBe('closed')
  })

  it('can close after a definitive rejection and undo of all dirty work', async () => {
    const { grid, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    expect(grid.destroy().status).toBe('blocked')
    response.resolve(rejected(request))
    expect(await save).toMatchObject({ status: 'failed' })
    expect(grid.getCloseState().blockers).toContain('unsaved-changes')
    expect(grid.dispatch({ type: 'history/undo' }).accepted).toBe(true)
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    expect(grid.destroy()).toEqual({ status: 'closed' })
  })

  it('round-trips a trailing blank clipboard row and ignores an external final line separator', async () => {
    const rows = ['A', '', 'B', 'C'].map((name, i) => ({ id: String(i), name, count: 0 }))
    const { dataSource } = testGridSource(rows, [nameColumn])
    const grid = createDataGridBinding({ dataSource }).controller
    await grid.refresh()
    const point = (id: number) => ({ rowKey: String(id), columnKey: 'name' })
    grid.dispatch({ type: 'interaction/activate', cell: point(0), range: { anchor: point(0), focus: point(1) } })
    const copy = grid.dispatch({ type: 'selection/copy' })
    if (!copy.accepted) throw new Error(copy.issue.message)
    grid.dispatch({ type: 'interaction/activate', cell: point(2) })
    expect(grid.dispatch({ type: 'selection/paste', text: copy.value.text }).accepted).toBe(true)
    expect(grid.getSnapshot().draft.rows.map(row => row.name)).toEqual(['A', '', 'A', ''])
    grid.dispatch({ type: 'interaction/activate', cell: point(3) })
    expect(grid.dispatch({ type: 'selection/paste', text: 'last\r\n' }).accepted).toBe(true)
    expect(grid.getSnapshot().draft.rows.at(-1)?.name).toBe('last')
    await grid.save()
    grid.destroy()
  })

  it('rejects an invalid initial debounce interval before starting the source', () => {
    const { dataSource, server } = testGridSource([{ id: 'a', name: 'Initial', count: 0 }], [nameColumn])
    expect(() => createDataGridBinding({ dataSource: { ...dataSource,
      persistence: { mode: 'auto-save', debounceMs: -1 } } })).toThrow(/schedule|debounce/i)
    expect(server.source.readAtLeast).not.toHaveBeenCalled()
  })
})
