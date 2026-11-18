import { describe, expect, it, vi } from 'vitest'
import { testAuthority } from '../../tests/unit/authority.js'
import { createGridColumnHelper } from '../cell-types/column-helper.js'
import { createDataGridBinding } from '../react/data-grid-binding.js'
import { createFieldGridDocumentModel, createRemoteGridDataSource } from './remote-data-source.js'

type Row = { id: number; name: string }
const name = createGridColumnHelper<Row>().field('name', { type: 'string', label: 'Name' })

async function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, id) => ({ id, name: 'Row ' + id }))
  const server = testAuthority(rows)
  const model = createFieldGridDocumentModel<Row>([name])
  const decode = vi.fn(model.codec.decode)
  const dataSource = createRemoteGridDataSource<Row, number>({
    columns: [name], getRowKey: row => row.id, model: { ...model, codec: { ...model.codec, decode } },
    rows: { create: () => ({ id: count, name: 'Local' }), canDelete: () => true },
    scope: server.scope, source: server.source, initialAuthority: server.current(), persistence: { mode: 'manual-save' },
  })
  const { controller } = createDataGridBinding({ dataSource })
  expect(await controller.refresh()).toEqual({ status: 'refreshed' })
  decode.mockClear()
  return { controller, dataSource, server, rows, decode }
}

// Measure comparisons while the synchronous public command runs. This catches
// a per-row Array.find lookup without imposing a machine-specific time limit.
function countFindComparisons(run: () => void) {
  let comparisons = 0
  const find = Array.prototype.find
  const spy = vi.spyOn(Array.prototype, 'find').mockImplementation(function (
    this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown,
  ) {
    return find.call(this, (value, index, array) => {
      comparisons++
      return predicate.call(thisArg, value, index, array)
    })
  })
  try { run() } finally { spy.mockRestore() }
  return comparisons
}

describe('indexed grid projection', () => {
  it.each(['command', 'transaction'] as const)('bounds lookup work for a one-cell %s and decodes only its row', async entry => {
    const count = 128, last = count - 1
    const { controller, decode } = await fixture(count)
    const before = controller.getSnapshot().draft
    const comparisons = countFindComparisons(() => {
      const result = entry === 'command'
        ? controller.dispatch({ type: 'cell/set-value', cell: { rowKey: last, columnKey: name.key }, value: 'Changed' })
        : controller.applyTransaction(transaction => transaction.set(name, last, 'Changed'))
      if (!result.accepted) throw new Error('The edit was rejected')
    })
    expect(comparisons).toBeLessThan(count * 4)
    expect(new Set(decode.mock.calls.map(([document]) => document.id))).toEqual(new Set([last]))
    const after = controller.getSnapshot().draft
    expect(after.rows).toHaveLength(count)
    expect(after.rows[0]).toBe(before.rows[0])
    expect(after.rows[last]).toEqual({ id: last, name: 'Changed' })
    expect(after.baselineRows[last]).toBe(before.baselineRows[last])
    expect(after.dirtyCells.map(cell => cell.rowKey)).toEqual([last])
    expect(controller.undo().accepted).toBe(true)
    expect(controller.getSnapshot().draft.rows).toEqual(before.rows)
    expect(controller.destroy()).toEqual({ status: 'closed' })
  })

  it('keeps deleted baseline rows in authority order until the deletion is confirmed', async () => {
    const { controller, dataSource, server, rows } = await fixture(3)
    const authority = server.snapshot(rows, 2)
    const reordered = { ...authority, order: [authority.order[2]!, authority.order[0]!, authority.order[1]!] }
    server.install(reordered)
    dataSource.publish(reordered)
    expect(controller.applyTransaction(t => t.deleteRows([0])).accepted).toBe(true)
    const draft = controller.getSnapshot().draft
    expect(draft.rows.map(row => row.id)).toEqual([2, 1])
    expect(draft.baselineRows.map(row => row.id)).toEqual([2, 0, 1])
    expect(draft.deletedRowKeys).toEqual([0])
    expect((await controller.save()).status).toBe('confirmed')
    expect(controller.getSnapshot().draft.baselineRows.map(row => row.id)).toEqual([2, 1])
    expect(controller.destroy()).toEqual({ status: 'closed' })
  })

  it('keeps colliding local and server incarnations distinct until the user resolves them', async () => {
    const { controller, dataSource, server, rows } = await fixture(1)
    expect(controller.applyTransaction(t => t.createRow()).accepted).toBe(true)
    const remote = { id: 1, name: 'Remote' }
    const collision = server.snapshot([...rows, remote], 2)
    server.install(collision)
    dataSource.publish(collision)
    const draft = controller.getSnapshot().draft
    expect(draft.rows).toEqual([...rows, { id: 1, name: 'Local' }])
    expect(draft.baselineRows).toEqual([...rows, remote])
    expect(draft.conflicts).toContainEqual(expect.objectContaining({ rowKey: 1, kind: 'inserted-key-collision' }))
    expect(controller.dispatch({ type: 'conflict/resolve', rowKey: 1, columnKey: null, resolution: 'accept-remote' }).accepted).toBe(true)
    expect(controller.getSnapshot().draft.rows).toEqual([...rows, remote])
    expect(controller.getSnapshot().draft.conflicts).toEqual([])
    expect(controller.destroy()).toEqual({ status: 'closed' })
  })
})
