import { expect, vi } from 'vitest'
import { createGridColumnHelper } from '../../src/cell-types/column-helper.js'
import type { GridCellTypeRegistry } from '../../src/cell-types/registry.js'
import type { StandardGridCellTypeSchema } from '../../src/cell-types/standard-contracts.js'
import { createDataGridBinding } from '../../src/react/data-grid-binding.js'
import type { GridPersistenceMode } from '../../src/model/grid-model.js'
import type { FrozenSubmission } from '../../src/kernel/model.js'
import type { SourceMutationResult } from '../../src/kernel/source.js'
import { deferred, testGridSource } from './authority.js'

export type PersistenceRow = { id: string; name: string; count: number }
const column = createGridColumnHelper<PersistenceRow>()
export const nameColumn = column.field('name', { label: 'Name', type: 'string' })
export const cell = { rowKey: 'a', columnKey: 'name' }

export async function persistenceGrid(mode: GridPersistenceMode = 'manual-save', registry?: GridCellTypeRegistry<PersistenceRow, StandardGridCellTypeSchema>) {
  const rows = [{ id: 'a', name: 'Initial', count: 0 }, { id: 'b', name: 'Other', count: 0 }]
  const { dataSource, server } = testGridSource(rows, [nameColumn, column.field('count', { label: 'Count', type: 'number' })])
  const configured = { ...dataSource, persistence: { mode, debounceMs: 15 },
    rows: { create: () => ({ id: 'temp', name: 'New', count: 0 }), canDelete: () => true, ordering: 'mutable' as const } }
  const open = () => createDataGridBinding({ dataSource: configured, ...(registry ? { initial: { registry } } : {}) }).controller
  const grid = open()
  await grid.refresh()
  function push(name: string, position: number) {
    const authority = server.snapshot([{ ...rows[0]!, name }, rows[1]!], position)
    server.install(authority)
    dataSource.publish(authority)
    return authority
  }
  function edit(name: string) {
    expect(grid.dispatch({ type: 'cell/set-value', cell, value: name }).accepted).toBe(true)
  }
  async function holdWrite() {
    const response = deferred<SourceMutationResult>()
    const sending = deferred<FrozenSubmission>()
    server.source.submit.mockImplementationOnce(request => {
      sending.resolve(request)
      return response.promise
    })
    edit('Submitted')
    const save = mode === 'manual-save' ? grid.save() : null
    const request = await sending.promise
    return { response, request, save }
  }
  return { grid, dataSource, server, open, push, edit, holdWrite }
}

export async function waitForSettled(grid: Awaited<ReturnType<typeof persistenceGrid>>['grid']) {
  await vi.waitFor(() => {
    expect(grid.getSnapshot().persistence.status).toBe('idle')
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
  })
}
