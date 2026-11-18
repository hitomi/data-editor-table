import { describe, expect, it, vi } from 'vitest'
import { testAuthority } from '../../tests/unit/authority.js'
import { cell, nameColumn, persistenceGrid, type PersistenceRow } from '../../tests/unit/persistence-grid.js'
import { createDataGridBinding } from '../react/data-grid-binding.js'
import type { GridDocumentColumnBinding } from './grid-document.js'
import { createFieldGridDocumentModel, createRemoteGridDataSource } from './remote-data-source.js'

const initial = { id: 'a', name: 'Original', count: 1 }
const setName: NonNullable<GridDocumentColumnBinding['planEdit']> = (_context, value) =>
  [{ kind: 'set', path: ['name'], value: String(value) }]

async function fixture(planEdit?: GridDocumentColumnBinding['planEdit'], column = nameColumn) {
  const server = testAuthority([initial])
  const model = createFieldGridDocumentModel<PersistenceRow>([column])
  const dataSource = createRemoteGridDataSource<PersistenceRow, string>({
    model: { ...model, columns: model.columns.map(binding => planEdit ? { ...binding, planEdit } : binding) },
    columns: [column], getRowKey: row => row.id, scope: server.scope, source: server.source,
    initialAuthority: server.current(), persistence: { mode: 'manual-save' },
  })
  const { controller } = createDataGridBinding({ dataSource })
  await controller.refresh()
  return { controller, server, dataSource }
}

const entries = ['command', 'editor', 'paste', 'bulk', 'transaction'] as const

function enterName(controller: Awaited<ReturnType<typeof fixture>>['controller'], column: typeof nameColumn,
  entry: typeof entries[number], value: string) {
  const dispatch = controller.dispatch
  switch (entry) {
    case 'command':
      expect(dispatch({ type: 'cell/set-value', cell, value }).accepted).toBe(true)
      break
    case 'editor':
      expect(dispatch({ type: 'edit/start', cell }).accepted).toBe(true)
      expect(dispatch({ type: 'edit/change', value }).accepted).toBe(true)
      expect(dispatch({ type: 'edit/commit' }).accepted).toBe(true)
      break
    case 'paste':
      dispatch({ type: 'interaction/activate', cell })
      expect(dispatch({ type: 'selection/paste', text: value }).accepted).toBe(true)
      break
    case 'bulk':
      dispatch({ type: 'interaction/activate', cell })
      expect(dispatch({ type: 'bulk/start' }).accepted).toBe(true)
      dispatch({ type: 'bulk/change', value: { operation: 'set', value } })
      expect(dispatch({ type: 'bulk/apply' }).accepted).toBe(true)
      break
    case 'transaction':
      expect(controller.applyTransaction(tx => tx.set(column, 'a', value)).accepted).toBe(true)
      break
  }
}

describe('write and read dependencies of authored cell changes', () => {
  const combinations = entries.flatMap(entry => (['field', 'planEdit'] as const).map(writer => ({ entry, writer })))
  it.each(combinations)('merges an independent server change through $entry with $writer', async ({ entry, writer }) => {
    const column = { ...nameColumn, bulkEditable: true }
    const { controller, server, dataSource } = await fixture(writer === 'planEdit' ? setName : undefined, column)
    enterName(controller, column, entry, 'Edited')
    const next = server.snapshot([{ ...initial, count: 2 }], 2)
    server.install(next)
    // Exercise both a push while dirty and a fresh authority read at write acquisition.
    if (entry === 'editor' || entry === 'paste') dataSource.publish(next)
    expect(await controller.save()).toMatchObject({ status: 'confirmed' })
    expect(controller.getSnapshot().source.rows).toEqual([{ id: 'a', name: 'Edited', count: 2 }])
    expect(controller.destroy().status).toBe('closed')
  })

  it.each(['push first', 'receipt first'] as const)('preserves peer edits and undo across canonicalization: %s', async order => {
    const { grid, open, holdWrite, server, dataSource } = await persistenceGrid()
    const peer = open()
    await peer.refresh()
    const { request, save, response } = await holdWrite()
    expect(peer.dispatch({ type: 'cell/set-value', cell: { ...cell, columnKey: 'count' }, value: 2 }).accepted).toBe(true)
    const applied = server.apply(request, { update: row => ({ ...row, name: 'Canonical' }) })
    const pushed = server.current()
    if (order === 'push first') dataSource.publish(pushed)
    response.resolve(applied)
    expect(await save).toMatchObject({ status: 'confirmed' })
    if (order === 'receipt first') dataSource.publish(pushed)
    expect(peer.getSnapshot().draft.conflicts).toEqual([])
    expect(peer.undo().accepted).toBe(true)
    expect(peer.getSnapshot().draft.rows[0]).toEqual({ id: 'a', name: 'Canonical', count: 0 })
    expect(peer.redo().accepted).toBe(true)
    expect(await peer.save()).toMatchObject({ status: 'confirmed', remaining: [] })
    expect(server.source.submit).toHaveBeenCalledTimes(2)
    for (const controller of [grid, peer]) {
      expect(controller.getSnapshot().source.rows[0]).toEqual({ id: 'a', name: 'Canonical', count: 2 })
      expect(controller.destroy().status).toBe('closed')
    }
  })

  it.each(entries)('keeps value validation independent and guards row validation through %s', async entry => {
    for (const readsRow of [false, true]) {
      const validate = vi.fn((value: string) => ({ ok: true as const, value: value.trim() }))
      const column = { ...nameColumn, bulkEditable: true, validate, ...(readsRow ? {
        validateWithRow: (value: string, row: PersistenceRow) => row.count > 0
          ? { ok: true as const, value }
          : { ok: false as const, issue: { code: 'count', message: 'A positive count is required.' } },
      } : {}) }
      const { controller, dataSource, server } = await fixture(undefined, column)
      enterName(controller, column, entry, ' Edited ')
      expect(validate.mock.calls.every(args => args.length === 1)).toBe(true)
      const next = server.snapshot([{ ...initial, count: 2 }], 2)
      server.install(next)
      if (entry === 'command' || entry === 'bulk') dataSource.publish(next)
      expect((await controller.save()).status).toBe(readsRow ? 'blocked' : 'confirmed')
      if (readsRow) {
        expect(server.source.submit).not.toHaveBeenCalled()
        expect(controller.getSnapshot().draft.rows[0]?.name).toBe('Edited')
        expect(controller.undo().accepted).toBe(true)
      } else expect(server.current().rows[0]?.document).toEqual({ ...initial, name: 'Edited', count: 2 })
      expect(controller.destroy().status).toBe('closed')
    }
  })

  it.each(['write', 'read', 'admission'] as const)('blocks a change to the actual %s dependency', async kind => {
    const plan = vi.fn<NonNullable<GridDocumentColumnBinding['planEdit']>>((context, value) => {
      if (kind === 'read') context.read(['count'])
      return setName(context, value)
    })
    const column = kind === 'admission' ? { ...nameColumn, isEditable: (row: PersistenceRow) => row.count === 1 } : nameColumn
    const { controller, dataSource, server } = await fixture(plan, column)
    expect(controller.dispatch({ type: 'cell/set-value', cell, value: 'Edited' }).accepted).toBe(true)
    const next = server.snapshot([{ ...initial, ...(kind === 'write' ? { name: 'Remote' } : { count: 2 }) }], 2)
    server.install(next)
    dataSource.publish(next)
    expect(controller.getSnapshot().draft.conflicts.length).toBeGreaterThan(0)
    expect(await controller.save()).toMatchObject({ status: 'blocked' })
    expect(plan).toHaveBeenCalledTimes(1)
    expect(server.source.submit).not.toHaveBeenCalled()
    expect(controller.undo().accepted).toBe(true)
    expect(controller.destroy().status).toBe('closed')
  })
})
