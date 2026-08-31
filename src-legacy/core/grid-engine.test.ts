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

function dirtyFields(entries: readonly (readonly [string, unknown, string])[]) {
  return new Map(entries.map(([field, originalValue, formattedOriginalValue]) => [
    field,
    { originalValue, formattedOriginalValue },
  ]))
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
    expect(grid.getDirtyFields('a')).toEqual(dirtyFields([['name', '茶杯', '茶杯'], ['quantity', 2, '2']]))
    expect(grid.getInvalidRowKeys()).toEqual(new Set(['a']))
    expect(grid.getMetaSnapshot()).toMatchObject({ canUndo: true, dirtyCount: 1, invalidCount: 1 })
    expect(rowListener).toHaveBeenCalledTimes(1)
    expect(allRowsListener).toHaveBeenCalledTimes(1)

    grid.undo()
    expect(grid.getRowSnapshot('a')).toMatchObject({ name: '茶杯', quantity: 2 })
    expect(grid.getMetaSnapshot()).toMatchObject({ canRedo: true, dirtyCount: 0, invalidCount: 0 })
  })

  it('preserves the exact dirty baseline separately from display formatting', () => {
    const grid = engine([{ id: 'a', name: '   ', quantity: 2 }])
    grid.applyRows([{ id: 'a', name: 'Changed', quantity: 2 }])

    expect(grid.getDirtyFields('a')?.get('name')).toEqual({
      originalValue: '   ',
      formattedOriginalValue: '',
    })
  })

  it('rebases a refreshed source while retaining a local draft and exposes filtered views', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }, { id: 'b', name: '茶壶', quantity: 1 }])
    grid.applyRows([{ id: 'a', name: '本地名称', quantity: 2 }])
    grid.rebaseSource([{ id: 'a', name: '服务端名称', quantity: 3 }, { id: 'b', name: '茶壶', quantity: 1 }, { id: 'c', name: '茶盘', quantity: 4 }])
    expect(grid.getBaseline('a')).toMatchObject({ name: '服务端名称', quantity: 3 })
    expect(grid.getRowSnapshot('a')).toMatchObject({ name: '本地名称', quantity: 3 })
    expect(grid.getDirtyFields('a')).toEqual(dirtyFields([['name', '服务端名称', '服务端名称']]))

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
    expect(grid.getDirtyFields('b')).toEqual(dirtyFields([['quantity', 1, '1']]))
  })

  it('replays an edit made in flight when publishing the receipt rebases the engine first', () => {
    const grid = engine([{ id: 'a', name: 'base', quantity: 1 }])
    grid.applyRows([{ id: 'a', name: 'submitted', quantity: 1 }])
    const plan = grid.prepareCommit()
    grid.applyRows([{ id: 'a', name: 'base', quantity: 1 }])
    const draftRowsBeforeReceipt = grid.getRowsSnapshot()
    grid.rebaseSource(plan.rows)

    grid.markCommitted(plan, plan.rows, {
      acceptSourceChange: true,
      draftRowsBeforeReceipt,
    })

    expect(grid.getRowSnapshot('a')?.name).toBe('base')
    expect(grid.prepareCommit().acceptedKeys).toEqual(new Set(['a']))
  })

  it('keeps undo history for rejected rows from the same partially committed batch', () => {
    const grid = engine([{ id: 'a', name: 'A', quantity: 1 }, { id: 'b', name: 'B', quantity: 2 }])
    grid.applyRows([
      { id: 'a', name: 'Accepted', quantity: 1 },
      { id: 'b', name: 'B', quantity: -1 },
    ])
    const plan = grid.prepareCommit()
    grid.markCommitted(plan)

    grid.undo()

    expect(grid.getRowSnapshot('a')?.name).toBe('Accepted')
    expect(grid.getRowSnapshot('b')?.quantity).toBe(2)
    expect(grid.getMetaSnapshot().dirtyCount).toBe(0)
  })

  it('commits valid field edits while retaining an order draft blocked by another row', () => {
    const grid = engine([
      { id: 'a', name: '茶杯', quantity: 2 },
      { id: 'b', name: '茶壶', quantity: 1 },
      { id: 'c', name: '茶盘', quantity: 4 },
    ])
    grid.applyRows([
      { id: 'a', name: '已编辑茶杯', quantity: 2 },
      { id: 'b', name: '茶壶', quantity: -1 },
    ])
    grid.reorderRows(['c'], 'a', 'before')

    const plan = grid.prepareCommit()

    expect(plan.acceptedKeys).toEqual(new Set(['a']))
    expect(plan.orderChanged).toBe(false)
    expect(plan.rows.map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(plan.rows[0]?.name).toBe('已编辑茶杯')
    grid.markCommitted(plan)
    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['c', 'a', 'b'])
    expect(grid.getMetaSnapshot().dirtyCount).toBe(2)
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

  it('removes a newly appended then deleted row from every dirty snapshot', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }])
    grid.appendRow({ id: 'new', name: '新行', quantity: 1 })
    grid.deleteRows(['new'])

    expect(grid.getMetaSnapshot().dirtyCount).toBe(0)
    expect(grid.getDirtyByRow().has('new')).toBe(false)
    expect(grid.dirtyStore.getRowDirty('new')).toBe(false)
  })

  it('returns stable dirty snapshots across later edits', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }])
    grid.applyRows([{ id: 'a', name: '新茶杯', quantity: 2 }])
    const snapshot = grid.getDirtyByRow()

    grid.applyRows([{ id: 'a', name: '新茶杯', quantity: 3 }])

    expect(snapshot).toEqual(new Map([['a', dirtyFields([['name', '茶杯', '茶杯']])]]))
    expect(grid.getDirtyByRow()).toEqual(new Map([
      ['a', dirtyFields([['name', '茶杯', '茶杯'], ['quantity', 2, '2']])],
    ]))
  })

  it('cleans committed deletions and ordering through the explicit commit plan', () => {
    const grid = engine([
      { id: 'a', name: '茶壶', quantity: 1 },
      { id: 'b', name: '茶杯', quantity: 2 },
      { id: 'c', name: '茶盘', quantity: 3 },
    ])
    grid.deleteRows(['b'])
    grid.reorderRows(['c'], 'a', 'before')
    const plan = grid.prepareCommit()

    expect(plan.deletedKeys).toEqual(new Set(['b']))
    expect(plan.orderChanged).toBe(true)
    grid.markCommitted(plan)

    expect(grid.getRowsSnapshot().map((row) => row.id)).toEqual(['c', 'a'])
    expect(grid.getBaselineById().has('b')).toBe(false)
    expect(grid.getMetaSnapshot().dirtyCount).toBe(0)
    expect(grid.dirtyStore.getRowDirty('b')).toBe(false)
  })

  it('commits accepted rows while retaining rejected and in-flight edits', () => {
    const grid = engine([
      { id: 'a', name: '茶壶', quantity: 1 },
      { id: 'b', name: '茶杯', quantity: 2 },
    ])
    grid.applyRows([
      { id: 'a', name: '提交名称', quantity: 1 },
      { id: 'b', name: '茶杯', quantity: -1 },
    ])
    const plan = grid.prepareCommit()
    grid.applyRows([{ id: 'a', name: '提交后继续编辑', quantity: 1 }])
    grid.markCommitted(plan)

    expect(grid.getBaseline('a')?.name).toBe('提交名称')
    expect(grid.getRowSnapshot('a')?.name).toBe('提交后继续编辑')
    expect(grid.getDirtyFields('a')).toEqual(dirtyFields([['name', '提交名称', '提交名称']]))
    expect(grid.getDirtyFields('b')).toEqual(dirtyFields([['quantity', 2, '2']]))
  })

  it('merges authoritative canonical values into in-flight edits and preserves only post-plan undo', () => {
    type VersionedRow = Row & { serverVersion: number }
    const versionedFields: readonly DataGridFieldDefinition<VersionedRow>[] = [
      { kind: 'text', key: 'name', label: 'Name', getValue: (row) => row.name, setValue: (row, name) => ({ ...row, name }) },
      { kind: 'number', key: 'quantity', label: 'Quantity', getValue: (row) => row.quantity, setValue: (row, quantity) => ({ ...row, quantity: Number(quantity) }), parseInput: Number },
      { kind: 'readonly', key: 'serverVersion', label: 'Version', getValue: (row) => row.serverVersion },
    ]
    const grid = createDataGridEngine({
      fields: versionedFields,
      rows: [{ id: 'a', name: 'base', quantity: 1, serverVersion: 0 }],
      rowKeyGetter: (row) => row.id,
    })
    grid.applyRows([{ id: 'a', name: 'submitted', quantity: 1, serverVersion: 0 }])
    const plan = grid.prepareCommit()
    grid.applyRows([{ id: 'a', name: 'after-submit', quantity: 1, serverVersion: 0 }])

    grid.markCommitted(plan, [{ id: 'a', name: 'submitted', quantity: 2, serverVersion: 1 }])

    expect(grid.getRowSnapshot('a')).toEqual({ id: 'a', name: 'after-submit', quantity: 2, serverVersion: 1 })
    grid.undo()
    expect(grid.getRowSnapshot('a')).toEqual({ id: 'a', name: 'submitted', quantity: 2, serverVersion: 1 })
    expect(grid.getMetaSnapshot().canUndo).toBe(false)
  })

  it('rejects stale receipts and incomplete authoritative results without partial mutation', () => {
    const grid = engine([
      { id: 'a', name: 'A', quantity: 1 },
      { id: 'b', name: 'B', quantity: 2 },
    ])
    grid.applyRows([
      { id: 'a', name: 'A submitted', quantity: 1 },
      { id: 'b', name: 'B submitted', quantity: 2 },
    ])
    const incomplete = grid.prepareCommit()
    expect(() => grid.markCommitted(incomplete, [{ id: 'a', name: 'A submitted', quantity: 1 }])).toThrow('missing accepted row: b')
    expect(grid.getBaseline('a')?.name).toBe('A')

    const stale = grid.prepareCommit()
    grid.rebaseSource([
      { id: 'a', name: 'Remote A', quantity: 1 },
      { id: 'b', name: 'Remote B', quantity: 2 },
    ])
    expect(() => grid.markCommitted(stale)).toThrow('authoritative source has changed')
    expect(grid.getBaseline('a')?.name).toBe('Remote A')
  })

  it('reconciles a published receipt without turning a later same-field edit into a conflict', () => {
    const submitted = { id: 'a', name: 'submitted', quantity: 1 }
    const grid = engine([{ id: 'a', name: 'base', quantity: 1 }])
    grid.applyRows([submitted])
    const plan = grid.prepareCommit()
    grid.applyRows([{ id: 'a', name: 'after-submit', quantity: 1 }])
    grid.rebaseSource([submitted])
    expect(grid.getMetaSnapshot().conflictCount).toBe(1)

    grid.markCommitted(plan, [submitted])

    expect(grid.getRowSnapshot('a')?.name).toBe('after-submit')
    expect(grid.getMetaSnapshot().conflictCount).toBe(0)
    expect(grid.prepareCommit().acceptedKeys).toEqual(new Set(['a']))
  })

  it('adopts a canonical receipt order unless the user reordered again in flight', () => {
    const original = [
      { id: 'a', name: 'A', quantity: 1 },
      { id: 'b', name: 'B', quantity: 2 },
      { id: 'c', name: 'C', quantity: 3 },
    ]
    const canonical = [original[1]!, original[2]!, original[0]!]
    const settled = engine(original)
    settled.reorderRows(['c'], 'a', 'before')
    settled.markCommitted(settled.prepareCommit(), canonical)
    expect(settled.getRowsSnapshot().map((row) => row.id)).toEqual(['b', 'c', 'a'])
    expect(settled.getMetaSnapshot().dirtyCount).toBe(0)

    const continued = engine(original)
    continued.reorderRows(['c'], 'a', 'before')
    const plan = continued.prepareCommit()
    continued.reorderRows(['b'], 'c', 'before')
    continued.markCommitted(plan, canonical)
    expect(continued.getRowsSnapshot().map((row) => row.id)).toEqual(['b', 'c', 'a'])
  })

  it('preserves and blocks a local reorder when the source concurrently reorders', () => {
    const original = [
      { id: 'a', name: 'A', quantity: 1 },
      { id: 'b', name: 'B', quantity: 2 },
      { id: 'c', name: 'C', quantity: 3 },
    ]
    const grid = engine(original)
    grid.reorderRows(['c'], 'a', 'before')

    grid.rebaseSource([original[1]!, original[0]!, original[2]!])

    expect(grid.getKeysSnapshot()).toEqual(['c', 'a', 'b'])
    expect(grid.getMetaSnapshot()).toMatchObject({ conflictCount: 1, orderConflict: true })
    expect(grid.prepareCommit()).toMatchObject({ acceptedKeys: new Set(), orderChanged: false })
    expect(grid.getOrderConflict()).toEqual({
      baseline: ['a', 'b', 'c'],
      draft: ['c', 'a', 'b'],
      source: ['b', 'a', 'c'],
    })

    grid.resolveOrderConflict('source')
    expect(grid.getKeysSnapshot()).toEqual(['b', 'a', 'c'])
    expect(grid.getMetaSnapshot()).toMatchObject({ conflictCount: 0, orderConflict: false, dirtyCount: 0 })

    grid.reorderRows(['c'], 'b', 'before')
    grid.rebaseSource(original)
    grid.resolveOrderConflict('draft')
    expect(grid.getKeysSnapshot()).toEqual(['c', 'b', 'a'])
    expect(grid.prepareCommit().orderChanged).toBe(true)
  })

  it('treats a source order matching the local draft as an acknowledgement', () => {
    const original = [
      { id: 'a', name: 'A', quantity: 1 },
      { id: 'b', name: 'B', quantity: 2 },
      { id: 'c', name: 'C', quantity: 3 },
    ]
    const grid = engine(original)
    grid.reorderRows(['c'], 'a', 'before')

    grid.rebaseSource([original[2]!, original[0]!, original[1]!])

    expect(grid.getKeysSnapshot()).toEqual(['c', 'a', 'b'])
    expect(grid.getOrderConflict()).toBeNull()
    expect(grid.getMetaSnapshot()).toMatchObject({ conflictCount: 0, dirtyCount: 0, orderConflict: false })
  })

  it('restores a locally deleted baseline row when removeRows discards that change', () => {
    const grid = engine([{ id: 'a', name: 'A', quantity: 1 }, { id: 'b', name: 'B', quantity: 2 }])
    grid.deleteRows(['a'])

    grid.removeRows(['a'])

    expect(grid.getKeysSnapshot()).toEqual(['a', 'b'])
    expect(grid.getDraftById().has('a')).toBe(true)
    expect(grid.prepareCommit().deletedKeys.size).toBe(0)
    expect(grid.getMetaSnapshot().dirtyCount).toBe(0)
  })

  it('ignores readonly differences in draft and conflict tracking', () => {
    type ReadonlyRow = Row & { version: number }
    const grid = createDataGridEngine<ReadonlyRow, string>({
      fields: [{ kind: 'readonly', key: 'version', label: 'Version', getValue: (row) => row.version }],
      rows: [{ id: 'a', name: 'A', quantity: 1, version: 1 }],
      rowKeyGetter: (row) => row.id,
    })
    grid.applyRows([{ id: 'a', name: 'A', quantity: 1, version: 99 }])
    expect(grid.getMetaSnapshot().dirtyCount).toBe(0)
    grid.rebaseSource([{ id: 'a', name: 'A', quantity: 1, version: 2 }])
    expect(grid.getRowSnapshot('a')?.version).toBe(2)
    expect(grid.getMetaSnapshot().conflictCount).toBe(0)
  })

  it('keeps an unsubscribed view snapshot current when it is polled', () => {
    const grid = engine([{ id: 'a', name: 'A', quantity: 1 }])
    const view = createDataGridEngineView(grid, {})
    grid.applyRows([{ id: 'a', name: 'Updated', quantity: 1 }])
    expect(view.getRowsSnapshot()[0]?.name).toBe('Updated')
    const stop = view.subscribe(() => undefined)
    stop()
    grid.applyRows([{ id: 'a', name: 'Updated again', quantity: 1 }])
    expect(view.getRowsSnapshot()[0]?.name).toBe('Updated again')
    view.dispose()
  })

  it('drops conflicts for fields removed during configuration', () => {
    const grid = engine([{ id: 'a', name: '茶杯', quantity: 2 }])
    grid.applyRows([{ id: 'a', name: '本地名称', quantity: 2 }])
    grid.rebaseSource([{ id: 'a', name: '远端名称', quantity: 2 }])
    expect(grid.getMetaSnapshot().conflictCount).toBe(1)

    grid.configure({ fields: [fields[1]!], isRowInvalid: undefined })

    expect(grid.getConflicts('a')).toBeUndefined()
    expect(grid.getMetaSnapshot().conflictCount).toBe(0)
    expect(grid.prepareCommit().rejected).toEqual([])
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

  it('keeps repeated sparse view updates bounded without nesting proxies', () => {
    const rows = [
      { id: 'a', name: '茶杯', quantity: 1 },
      { id: 'b', name: '茶壶', quantity: 2 },
    ]
    const grid = engine(rows)
    const view = createDataGridEngineView(grid, {})
    const stop = view.subscribe(() => undefined)

    for (let quantity = 3; quantity < 20_003; quantity += 1) {
      grid.applyRows([{ id: 'b', name: '茶壶', quantity }])
    }

    expect(view.getRowsSnapshot()[0]).toBe(rows[0])
    expect(view.getRowsSnapshot()[1]?.quantity).toBe(20_002)
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
