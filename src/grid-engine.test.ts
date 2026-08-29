import { describe, expect, it, vi } from 'vitest'
import { createDataGridEngine } from './grid-engine'
import { createDataGridEngineView } from './grid-engine-view'
import type { DataGridFieldDefinition } from './field-definition'

interface Row { id: string; name: string; quantity: number }

const fields: readonly DataGridFieldDefinition<Row>[] = [
  { key: 'name', label: '名称', kind: 'text', getValue: (row) => row.name, setValue: (row, value) => ({ ...row, name: value }) },
  { key: 'quantity', label: '数量', kind: 'number', getValue: (row) => row.quantity, setValue: (row, value) => ({ ...row, quantity: Number(value) }), parseInput: (value) => Number(value), validate: (value) => Number(value) >= 0 ? { valid: true } : { valid: false, message: '数量不能为负数。' } },
]

function engine(rows: readonly Row[]) {
  return createDataGridEngine({ fields, rows, rowKeyGetter: (row) => row.id })
}

describe('headless Grid Engine', () => {
  it('tracks baseline, dirty and invalid state with row-level notifications and atomic undo', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }, { id: 'b', name: '茶壶', quantity: 1 }])
    const rowListener = vi.fn()
    const allRowsListener = vi.fn()
    grid.subscribeRow('a', rowListener)
    grid.subscribeRows(allRowsListener)

    grid.applyRows([{ id: 'a', name: '新茶杯', quantity: -1 }])
    expect(grid.getRowSnapshot('a')).toMatchObject({ name: '新茶杯', quantity: -1 })
    expect(grid.getDirtyFields('a')).toEqual(new Map([['name', '茶杯'], ['quantity', '2']]))
    expect(grid.getInvalidRowKeys()).toEqual(new Set(['a']))
    expect(grid.getMetaSnapshot()).toMatchObject({ canUndo: true, dirtyCount: 1, invalidCount: 1 })
    expect(rowListener).toHaveBeenCalledTimes(1)
    expect(allRowsListener).toHaveBeenCalledTimes(1)

    grid.undo()
    expect(grid.getRowSnapshot('a')).toMatchObject({ name: '茶杯', quantity: 2 })
    expect(grid.getMetaSnapshot()).toMatchObject({ canRedo: true, dirtyCount: 0, invalidCount: 0 })
  })

  it('rebases a refreshed source while retaining a local draft and exposes filtered views', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }, { id: 'b', name: '茶壶', quantity: 1 }])
    grid.applyRows([{ id: 'a', name: '本地名称', quantity: 2 }])
    grid.rebaseSource([{ id: 'a', name: '服务端名称', quantity: 3 }, { id: 'b', name: '茶壶', quantity: 1 }, { id: 'c', name: '茶盘', quantity: 4 }])
    expect(grid.getBaseline('a')).toMatchObject({ name: '服务端名称', quantity: 3 })
    expect(grid.getRowSnapshot('a')).toMatchObject({ name: '本地名称', quantity: 3 })
    expect(grid.getDirtyFields('a')).toEqual(new Map([['name', '服务端名称']]))

    const view = createDataGridEngineView(grid, { filter: (row) => row.quantity >= 3, compare: (left, right) => right.quantity - left.quantity })
    expect(view.getRowsSnapshot().map((row) => row.id)).toEqual(['c', 'a'])
    view.dispose()
  })

  it('reports cell errors, partially commits safe rows, and preserves invalid drafts', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }, { id: 'b', name: '茶壶', quantity: 1 }])
    grid.applyRows([{ id: 'a', name: '新茶杯', quantity: 3 }, { id: 'b', name: '茶壶', quantity: -1 }])
    expect(grid.getCellErrors('b')).toEqual(new Map([['quantity', '数量不能为负数。']]))
    const plan = grid.prepareCommit()
    expect(plan.acceptedKeys).toEqual(new Set(['a']))
    expect(plan.rejected).toEqual([{ key: 'b', reason: 'invalid', fields: ['quantity'] }])
    expect(plan.rows).toEqual([{ id: 'a', name: '新茶杯', quantity: 3 }, { id: 'b', name: '茶壶', quantity: 1 }])
    grid.rebaseSource(plan.rows)
    expect(grid.getDirtyFields('a')).toBeUndefined()
    expect(grid.getDirtyFields('b')).toEqual(new Map([['quantity', '1']]))
  })

  it('detects same-field refresh conflicts and resolves them without losing unrelated local edits', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }])
    grid.applyRows([{ id: 'a', name: '本地名称', quantity: 2 }])
    grid.rebaseSource([{ id: 'a', name: '远端名称', quantity: 3 }])
    expect(grid.getRowSnapshot('a')).toEqual({ id: 'a', name: '本地名称', quantity: 3 })
    expect(grid.getConflicts('a')?.has('name')).toBe(true)
    expect(grid.prepareCommit().rejected).toEqual([{ key: 'a', reason: 'conflict', fields: ['name'] }])
    grid.resolveConflict('a', 'name', 'draft')
    expect(grid.prepareCommit().acceptedKeys).toEqual(new Set(['a']))
  })

  it('recovers row-level conflicts when refresh changes a locally deleted row or deletes a local draft', () => {
    const deletedLocally = engine([{ id: 'a', name: '茶杯', quantity: 2 }, { id: 'b', name: '茶壶', quantity: 1 }])
    deletedLocally.deleteRows(['a'])
    deletedLocally.rebaseSource([{ id: 'a', name: '刷新后的茶杯', quantity: 3 }, { id: 'b', name: '茶壶', quantity: 1 }])
    expect(deletedLocally.getConflicts('a')?.has('__row__')).toBe(true)
    deletedLocally.resolveConflict('a', '__row__', 'source')
    expect(deletedLocally.getRowSnapshot('a')).toEqual({ id: 'a', name: '刷新后的茶杯', quantity: 3 })
    expect(deletedLocally.prepareCommit().acceptedKeys).toEqual(new Set())

    const deletedByRefresh = engine([{ id: 'a', name: '茶杯', quantity: 2 }, { id: 'b', name: '茶壶', quantity: 1 }])
    deletedByRefresh.applyRows([{ id: 'a', name: '本地名称', quantity: 2 }])
    deletedByRefresh.rebaseSource([{ id: 'b', name: '茶壶', quantity: 1 }])
    expect(deletedByRefresh.getConflicts('a')?.has('__row__')).toBe(true)
    deletedByRefresh.resolveConflict('a', '__row__', 'draft')
    expect(deletedByRefresh.prepareCommit().acceptedKeys).toEqual(new Set(['a']))
  })

  it('keeps append and delete in local history until the commit plan is accepted', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }, { id: 'b', name: '茶壶', quantity: 1 }])
    grid.appendRow({ id: 'c', name: '茶盘', quantity: 4 })
    grid.deleteRows(['a'])
    expect(grid.getKeysSnapshot()).toEqual(['b', 'c'])
    expect(grid.prepareCommit().rows.map((row) => row.id)).toEqual(['b', 'c'])
    grid.undo()
    expect(grid.getKeysSnapshot()).toEqual(['a', 'b', 'c'])
  })

  it('publishes restored row order to a subscribed view after batch-delete undo', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }, { id: 'b', name: '茶壶', quantity: 1 }, { id: 'c', name: '茶盘', quantity: 4 }])
    const view = createDataGridEngineView(grid, {})
    const stop = view.subscribe(() => undefined)
    grid.deleteRows(['a', 'b'])
    expect(view.getRowsSnapshot().map((row) => row.id)).toEqual(['c'])
    grid.undo()
    expect(view.getRowsSnapshot().map((row) => row.id)).toEqual(['a', 'b', 'c'])
    stop()
    view.dispose()
  })

  it('appends a batch as one reversible history entry', () => {
    const grid = engine([{ id: 'a', name: '茶壶', quantity: 1 }])

    grid.appendRows([
      { id: 'b', name: '茶杯', quantity: 2 },
      { id: 'c', name: '茶盘', quantity: 3 },
    ])

    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['a', 'b', 'c'])
    grid.undo()
    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['a'])
    grid.redo()
    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('reorders existing rows as one order draft and commits the explicit sequence', () => {
    const grid = engine([
      { id: 'a', name: '茶壶', quantity: 1 },
      { id: 'b', name: '茶杯', quantity: 2 },
      { id: 'c', name: '茶盘', quantity: 3 },
    ])

    grid.reorderRows(['c'], 'a', 'before')
    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['c', 'a', 'b'])
    expect(grid.getMetaSnapshot().dirtyCount).toBe(1)
    expect(grid.prepareCommit().rows.map((row) => row.id)).toEqual(['c', 'a', 'b'])

    grid.undo()
    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(grid.getMetaSnapshot().dirtyCount).toBe(0)
    grid.redo()
    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['c', 'a', 'b'])
  })

  it('preserves source order when a reorder draft contains invalid rows', () => {
    const grid = engine([
      { id: 'a', name: '茶壶', quantity: 1 },
      { id: 'b', name: '茶杯', quantity: 2 },
      { id: 'c', name: '茶盘', quantity: 3 },
    ])
    grid.applyRows([{ id: 'b', name: '茶杯', quantity: -1 }])
    grid.reorderRows(['c'], 'a', 'before')

    const plan = grid.prepareCommit()
    expect(plan.acceptedKeys.size).toBe(0)
    expect(plan.rows.map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(plan.rejected).toEqual([{ key: 'b', reason: 'invalid', fields: ['quantity'] }])
  })

  it('preserves an order draft across a source refresh and appends new source rows', () => {
    const grid = engine([
      { id: 'a', name: '茶壶', quantity: 1 },
      { id: 'b', name: '茶杯', quantity: 2 },
      { id: 'c', name: '茶盘', quantity: 3 },
    ])
    grid.reorderRows(['c'], 'a', 'before')
    grid.rebaseSource([
      { id: 'a', name: '新茶壶', quantity: 1 },
      { id: 'b', name: '茶杯', quantity: 2 },
      { id: 'c', name: '茶盘', quantity: 3 },
      { id: 'd', name: '茶巾', quantity: 4 },
    ])

    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(grid.prepareCommit().rows.map((row) => row.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(grid.getMetaSnapshot()).toMatchObject({ canUndo: false, dirtyCount: 1 })
  })

  it('updates an unfiltered 100,000-row view without scanning or cloning the full row set', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => ({ id: `row-${index}`, name: `名称 ${index}`, quantity: index }))
    const grid = engine(rows)
    const view = createDataGridEngineView(grid, {})
    const stop = view.subscribe(() => undefined)
    const getRow = vi.spyOn(grid, 'getRowSnapshot')
    const getIndex = vi.spyOn(grid, 'getKeyIndex')
    grid.applyRows([{ ...rows[50_000]!, name: '局部更新' }])
    expect(view.getRowsSnapshot()).toHaveLength(100_000)
    expect(view.getRowsSnapshot()[50_000]?.name).toBe('局部更新')
    expect(getRow.mock.calls.length).toBeLessThanOrEqual(3)
    expect(getIndex.mock.calls.length).toBeLessThanOrEqual(1)
    stop()
    view.dispose()
  })

  it('deletes and restores a 50,000-row range with one bounded order rebuild', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => ({ id: `row-${index}`, name: `名称 ${index}`, quantity: index }))
    const grid = engine(rows)
    grid.deleteRows(rows.slice(0, 50_000).map((row) => row.id))
    expect(grid.getKeysSnapshot()).toHaveLength(50_000)
    expect(grid.getKeysSnapshot()[0]).toBe('row-50000')
    grid.undo()
    expect(grid.getKeysSnapshot()).toHaveLength(100_000)
    expect(grid.getKeysSnapshot()[49_999]).toBe('row-49999')
    expect(grid.getKeysSnapshot()[50_000]).toBe('row-50000')
  })

  it('reorders and restores one row in a 100,000-row grid without per-row value notifications', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => ({ id: `row-${index}`, name: `名称 ${index}`, quantity: index }))
    const grid = engine(rows)
    const middleRowListener = vi.fn()
    grid.subscribeRow('row-50000', middleRowListener)

    grid.reorderRows(['row-99999'], 'row-0', 'before')
    expect(grid.getKeysSnapshot().slice(0, 3)).toEqual(['row-99999', 'row-0', 'row-1'])
    expect(middleRowListener).not.toHaveBeenCalled()
    grid.undo()
    expect(grid.getKeysSnapshot()[0]).toBe('row-0')
    expect(grid.getKeysSnapshot()[99_999]).toBe('row-99999')
  })
})
