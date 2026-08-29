// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createDataGridCellTypeRegistry, registerDataGridBuiltinCellTypes } from './cell-type-registry'
import type { DataGridDataSource, DataGridDataSourceSnapshot, DataGridPersistenceRequest } from './data-source'
import { DataSourceDataGrid } from './data-source-grid'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

type Row = { id: string; enabled: boolean; name: string }

function createSource(
  persistence: DataGridDataSource<Row, string>['persistence'],
) {
  let snapshot: DataGridDataSourceSnapshot<Row> = { rows: [{ id: 'one', enabled: false, name: 'First' }], state: 'ready' }
  const listeners = new Set<() => void>()
  const source: DataGridDataSource<Row, string> = {
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'toggle', sortable: true, getValue: (row) => row.enabled, setValue: (row, enabled) => ({ ...row, enabled: Boolean(enabled) }) },
      { key: 'name', label: 'Name', type: 'text', getValue: (row) => row.name, setValue: (row, name) => ({ ...row, name: String(name) }) },
    ],
    getRowKey: (row) => row.id,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    persistence,
  }
  return {
    source,
    publish(rows: readonly Row[]) { snapshot = { rows, state: 'ready' }; listeners.forEach((listener) => listener()) },
  }
}

function createRegistry() {
  const registry = registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<Row>())
  registry.register<boolean>('toggle', {
    renderCell: ({ update, value }) => <button type="button" onClick={() => update(!value)}>{value ? 'On' : 'Off'}</button>,
    actions: [{ id: 'turn-on', label: 'Turn on', disabled: ({ value }) => value, run: ({ update }) => update(true) }],
  })
  return registry
}

describe('DataSourceDataGrid', () => {
  it('runs a registered custom renderer and saves the dirty proposal through the data source', async () => {
    let adapter!: ReturnType<typeof createSource>
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => adapter.publish(request.rows))
    adapter = createSource({ mode: 'save-dirty', saveDirty })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Off' }))
    const save = screen.getByRole('button', { name: 'Save changes' })
    expect((save as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(saveDirty).toHaveBeenCalledTimes(1))
    expect(saveDirty.mock.calls[0]![0].rows[0]!.enabled).toBe(true)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true))
  })

  it('auto-saves dirty rows after the data source debounce', async () => {
    vi.useFakeTimers()
    let adapter!: ReturnType<typeof createSource>
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => adapter.publish(request.rows))
    adapter = createSource({ mode: 'auto-save', debounceMs: 25, saveDirty })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await vi.advanceTimersByTimeAsync(25)
    expect(saveDirty).toHaveBeenCalledTimes(1)
  })

  it('hands each edit to an immediate-update data source without a save control', async () => {
    let adapter!: ReturnType<typeof createSource>
    const update = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => adapter.publish(request.rows))
    adapter = createSource({ mode: 'update', update })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(update.mock.calls[0]![0].rows[0]!.enabled).toBe(true)
  })

  it('resolves type actions into the default context surface and delegates sorting', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    const updateSort = vi.fn()
    adapter.source.capabilities = { sorting: { update: updateSort } }
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Off' }), { clientX: 12, clientY: 24 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn on' }))
    expect(screen.getByRole('button', { name: 'On' })).toBeTruthy()
    fireEvent.click(screen.getByRole('columnheader', { name: 'Enabled' }))
    await waitFor(() => expect(updateSort).toHaveBeenCalled())
  })
})
