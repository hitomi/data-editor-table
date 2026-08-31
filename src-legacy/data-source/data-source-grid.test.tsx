// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SortColumn } from 'react-data-grid'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createDataGridCellTypeRegistry, registerDataGridBuiltinCellTypes, type DataGridBuiltinCellTypes } from './cell-type-registry'
import type { DataGridColumnFilterGroup, DataGridDataSource, DataGridDataSourceSnapshot, DataGridPersistenceRequest } from './data-source'
import { DataSourceDataGrid } from './data-source-grid'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

type Row = { id: string; enabled: boolean; name: string }
type TestCellTypes = DataGridBuiltinCellTypes & { toggle: boolean }

function createSource(
  persistence: DataGridDataSource<Row, string, TestCellTypes>['persistence'],
) {
  let snapshot: DataGridDataSourceSnapshot<Row> = { rows: [{ id: 'one', enabled: false, name: 'First' }], state: 'ready', version: 0 }
  const listeners = new Set<() => void>()
  const source: DataGridDataSource<Row, string, TestCellTypes> = {
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'toggle', sortable: true, getValue: (row) => row.enabled, setValue: (row, enabled) => ({ ...row, enabled: Boolean(enabled) }) },
      { key: 'name', label: 'Name', type: 'text', getValue: (row) => row.name, setValue: (row, name) => ({ ...row, name: String(name) }) },
    ],
    commitRows(result) { snapshot = { rows: result.rows, state: 'ready', version: result.version }; listeners.forEach((listener) => listener()); return snapshot },
    getRowKey: (row) => row.id,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    persistence,
  }
  return {
    source,
    publish(rows: readonly Row[]) { snapshot = { rows, state: 'ready', version: Number(snapshot.version) + 1 }; listeners.forEach((listener) => listener()) },
    publishSnapshot(next: DataGridDataSourceSnapshot<Row>) { snapshot = next; listeners.forEach((listener) => listener()) },
  }
}

function createRegistry() {
  const registry = registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<Row>())
  return registry.register<boolean, 'toggle'>('toggle', {
    renderCell: ({ update, value }) => <button type="button" onClick={() => update(!value)}>{value ? 'On' : 'Off'}</button>,
    formatClipboard: (value) => String(value),
    parseClipboard: (value) => value === 'true',
    clearValue: () => false,
    actions: [{ id: 'turn-on', label: 'Turn on', disabled: ({ value }) => value, run: ({ update }) => update(true) }],
  })
}

describe('DataSourceDataGrid', () => {
  it('runs a registered custom renderer and saves the dirty proposal through the data source', async () => {
    let adapter!: ReturnType<typeof createSource>
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }))
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
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }))
    adapter = createSource({ mode: 'auto-save', debounceMs: 25, saveDirty })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await vi.advanceTimersByTimeAsync(25)
    expect(saveDirty).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending auto-save when persistence changes to explicit save', async () => {
    vi.useFakeTimers()
    const automaticSave = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const explicitSave = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const adapter = createSource({ mode: 'auto-save', debounceMs: 25, saveDirty: automaticSave })
    const rendered = render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    adapter.source.persistence = { mode: 'save-dirty', saveDirty: explicitSave }
    rendered.rerender(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    await vi.advanceTimersByTimeAsync(25)

    expect(automaticSave).not.toHaveBeenCalled()
    expect(explicitSave).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'On' })).toBeTruthy()
  })

  it('flushes an existing dirty draft when persistence changes to immediate update', async () => {
    vi.useFakeTimers()
    const automaticSave = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const update = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const adapter = createSource({ mode: 'auto-save', debounceMs: 25, saveDirty: automaticSave })
    const rendered = render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    adapter.source.persistence = { mode: 'update', update }
    rendered.rerender(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    await Promise.resolve()
    await Promise.resolve()

    expect(automaticSave).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0].rows[0]!.enabled).toBe(true)
  })

  it('hands each edit to an immediate-update data source without a save control', async () => {
    let adapter!: ReturnType<typeof createSource>
    const update = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }))
    adapter = createSource({ mode: 'update', update })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(update.mock.calls[0]![0].rows[0]!.enabled).toBe(true)
  })

  it('serializes an in-flight update and persists a later edit that returns to the old baseline', async () => {
    const resolvers: Array<(result: { rows: readonly Row[]; version: number }) => void> = []
    const update = vi.fn((_request: DataGridPersistenceRequest<Row, string>) => new Promise<{ rows: readonly Row[]; version: number }>((next) => { resolvers.push(next) }))
    const adapter = createSource({ mode: 'update', update })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const firstRequest = update.mock.calls[0]![0]
    fireEvent.click(screen.getByRole('button', { name: 'On' }))

    expect(update).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy()
    resolvers[0]!({ rows: firstRequest.rows, version: Number(firstRequest.sourceVersion) + 1 })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    const secondRequest = update.mock.calls[1]![0]
    expect(secondRequest.sourceVersion).toBe(1)
    expect(secondRequest.rows[0]!.enabled).toBe(false)
    expect(secondRequest.operationId).not.toBe(firstRequest.operationId)
    resolvers[1]!({ rows: secondRequest.rows, version: 2 })
    await waitFor(() => expect(adapter.source.getSnapshot().rows[0]!.enabled).toBe(false))
  })

  it('keeps an in-flight follow-up dirty when persistence changes to explicit save', async () => {
    let resolveUpdate!: (result: { rows: readonly Row[]; version: number }) => void
    const update = vi.fn((_request: DataGridPersistenceRequest<Row, string>) => new Promise<{ rows: readonly Row[]; version: number }>((resolve) => { resolveUpdate = resolve }))
    const explicitSave = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 2 }))
    const adapter = createSource({ mode: 'update', update })
    const rendered = render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    adapter.source.persistence = { mode: 'save-dirty', saveDirty: explicitSave }
    rendered.rerender(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    resolveUpdate({ rows: update.mock.calls[0]![0].rows, version: 1 })

    await waitFor(() => expect(adapter.source.getSnapshot().version).toBe(1))
    expect(explicitSave).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(explicitSave).toHaveBeenCalledTimes(1))
    expect(explicitSave.mock.calls[0]![0].rows[0]!.enabled).toBe(false)
  })

  it('accepts a versioned save receipt after a same-version source refresh', async () => {
    let resolve!: (result: { rows: readonly Row[]; version: number }) => void
    const update = vi.fn((_request: DataGridPersistenceRequest<Row, string>) => new Promise<{ rows: readonly Row[]; version: number }>((next) => { resolve = next }))
    const adapter = createSource({ mode: 'update', update })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const request = update.mock.calls[0]![0]
    expect(request.sourceVersion).toBe(0)
    adapter.publishSnapshot({
      rows: [{ id: 'one', enabled: false, name: 'First' }],
      state: 'ready',
      version: 0,
    })

    resolve({ rows: request.rows, version: 1 })

    await waitFor(() => expect(screen.getByRole('button', { name: 'On' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull()
  })

  it('does not let a delayed receipt overwrite a newer authoritative snapshot', async () => {
    let resolve!: (result: { rows: readonly Row[]; version: number }) => void
    const update = vi.fn((_request: DataGridPersistenceRequest<Row, string>) => new Promise<{ rows: readonly Row[]; version: number }>((next) => { resolve = next }))
    const adapter = createSource({ mode: 'update', update })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const delayedRequest = update.mock.calls[0]![0]
    const newerRows = [{ id: 'one', enabled: false, name: 'Newer source' }]
    adapter.publishSnapshot({ rows: newerRows, state: 'ready', version: 2 })

    resolve({ rows: delayedRequest.rows, version: 1 })

    await waitFor(() => expect(adapter.source.getSnapshot().version).toBe(2))
    expect(adapter.source.getSnapshot().rows).toBe(newerRows)
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull()
  })

  it('requires commitRows to synchronously publish the returned snapshot', async () => {
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const adapter = createSource({ mode: 'save-dirty', saveDirty })
    adapter.source.commitRows = (result) => ({ rows: result.rows, state: 'ready', version: result.version })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('button', { name: 'Retry save' })).toBeTruthy()
    expect(adapter.source.getSnapshot().version).toBe(0)
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('reuses one persistence queue when returning to an in-flight data source', async () => {
    const resolvers: Array<(result: { rows: readonly Row[]; version: number }) => void> = []
    let activeA = 0
    let maxConcurrentA = 0
    const updateA = vi.fn((_request: DataGridPersistenceRequest<Row, string>) => {
      activeA += 1
      maxConcurrentA = Math.max(maxConcurrentA, activeA)
      return new Promise<{ rows: readonly Row[]; version: number }>((resolve) => {
        resolvers.push((result) => { activeA -= 1; resolve(result) })
      })
    })
    const updateB = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const adapterA = createSource({ mode: 'update', update: updateA })
    const adapterB = createSource({ mode: 'update', update: updateB })
    const rendered = render(<DataSourceDataGrid ariaLabel="People A" cellTypes={createRegistry()} dataSource={adapterA.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(updateA).toHaveBeenCalledTimes(1))
    rendered.rerender(<DataSourceDataGrid ariaLabel="People B" cellTypes={createRegistry()} dataSource={adapterB.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(updateB).toHaveBeenCalledTimes(1))
    rendered.rerender(<DataSourceDataGrid ariaLabel="People A" cellTypes={createRegistry()} dataSource={adapterA.source} />)

    expect(screen.getByRole('button', { name: 'On' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    expect(updateA).toHaveBeenCalledTimes(1)
    expect(maxConcurrentA).toBe(1)

    const firstA = updateA.mock.calls[0]![0]
    resolvers[0]!({ rows: firstA.rows, version: 1 })
    await waitFor(() => expect(updateA).toHaveBeenCalledTimes(2))
    const secondA = updateA.mock.calls[1]![0]
    expect(secondA.rows[0]!.enabled).toBe(false)
    expect(secondA.sourceVersion).toBe(1)
    expect(maxConcurrentA).toBe(1)
    resolvers[1]!({ rows: secondA.rows, version: 2 })
    await waitFor(() => expect(adapterA.source.getSnapshot().version).toBe(2))
    expect(adapterA.source.getSnapshot().rows[0]!.enabled).toBe(false)
  })

  it('restores retry for a data source that failed while it was detached', async () => {
    let rejectFirst!: (error: unknown) => void
    const onSaveError = vi.fn()
    const updateA = vi.fn((request: DataGridPersistenceRequest<Row, string>) => {
      if (updateA.mock.calls.length === 1) {
        return new Promise<{ rows: readonly Row[]; version: number }>((_resolve, reject) => { rejectFirst = reject })
      }
      return Promise.resolve({ rows: request.rows, version: 1 })
    })
    const updateB = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const adapterA = createSource({ mode: 'update', update: updateA })
    const adapterB = createSource({ mode: 'update', update: updateB })
    const rendered = render(<DataSourceDataGrid ariaLabel="People A" cellTypes={createRegistry()} dataSource={adapterA.source} onSaveError={onSaveError} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(updateA).toHaveBeenCalledTimes(1))
    const operationId = updateA.mock.calls[0]![0].operationId
    rendered.rerender(<DataSourceDataGrid ariaLabel="People B" cellTypes={createRegistry()} dataSource={adapterB.source} onSaveError={onSaveError} />)
    rejectFirst(new Error('offline'))
    await waitFor(() => expect(onSaveError).toHaveBeenCalledTimes(1))

    rendered.rerender(<DataSourceDataGrid ariaLabel="People A" cellTypes={createRegistry()} dataSource={adapterA.source} onSaveError={onSaveError} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))

    await waitFor(() => expect(updateA).toHaveBeenCalledTimes(2))
    expect(updateA.mock.calls[1]![0].operationId).toBe(operationId)
    await waitFor(() => expect(adapterA.source.getSnapshot().version).toBe(1))
  })

  it('persists context actions in immediate-update mode', async () => {
    let adapter!: ReturnType<typeof createSource>
    const update = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }))
    adapter = createSource({ mode: 'update', update })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Off' }), { clientX: 12, clientY: 24 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn on' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]![0].rows[0]!.enabled).toBe(true)
  })

  it('invalidates an open action menu when the data source changes', () => {
    const updateA = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const updateB = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const adapterA = createSource({ mode: 'update', update: updateA })
    const adapterB = createSource({ mode: 'update', update: updateB })
    const rendered = render(<DataSourceDataGrid ariaLabel="People A" cellTypes={createRegistry()} dataSource={adapterA.source} />)

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Off' }), { clientX: 12, clientY: 24 })
    expect(screen.getByRole('menuitem', { name: 'Turn on' })).toBeTruthy()
    rendered.rerender(<DataSourceDataGrid ariaLabel="People B" cellTypes={createRegistry()} dataSource={adapterB.source} />)

    expect(screen.queryByRole('menuitem', { name: 'Turn on' })).toBeNull()
    expect(updateA).not.toHaveBeenCalled()
    expect(updateB).not.toHaveBeenCalled()
  })

  it('enforces isEditable for renderer and action updates', async () => {
    const update = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }))
    const actionSideEffect = vi.fn()
    const adapter = createSource({ mode: 'update', update })
    adapter.source.fields = adapter.source.fields.map((field) => field.key === 'enabled' ? { ...field, isEditable: () => false } : field)
    const registry = registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<Row>()).register<boolean, 'toggle'>('toggle', {
      renderCell: ({ update: setValue, value }) => <button type="button" onClick={() => setValue(!value)}>{value ? 'On' : 'Off'}</button>,
      actions: [{ id: 'turn-on', label: 'Turn on', run: ({ update: setValue }) => { actionSideEffect(); setValue(true) } }],
    })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={registry} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Off' }), { clientX: 12, clientY: 24 })
    const action = screen.getByRole('menuitem', { name: 'Turn on' })
    expect((action as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(action)

    await Promise.resolve()
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
    expect(actionSideEffect).not.toHaveBeenCalled()
  })

  it('applies a delayed renderer update to the current row instead of a stale render snapshot', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    let draft: Row | undefined
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.source.observeDraft = (snapshot) => { draft = snapshot.rows[0] }
    const registry = registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<Row>()).register<boolean, 'toggle'>('toggle', {
      renderCell: ({ update, value }) => <button type="button" onClick={() => { void wait.then(() => update(true)) }}>{value ? 'Delayed on' : 'Delayed off'}</button>,
    })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={registry} dataSource={adapter.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delayed off' }))
    adapter.publish([{ id: 'one', enabled: false, name: 'Remote name' }])
    release()

    await waitFor(() => expect(draft).toMatchObject({ enabled: true, name: 'Remote name' }))
  })

  it('routes a delayed renderer update to the data source that rendered it', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const updateA = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const updateB = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const adapterA = createSource({ mode: 'update', update: updateA })
    const adapterB = createSource({ mode: 'update', update: updateB })
    const registry = registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<Row>()).register<boolean, 'toggle'>('toggle', {
      renderCell: ({ update, value }) => <button type="button" onClick={() => { void wait.then(() => update(true)) }}>{value ? 'Delayed on' : 'Delayed off'}</button>,
    })
    const rendered = render(<DataSourceDataGrid ariaLabel="People A" cellTypes={registry} dataSource={adapterA.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delayed off' }))
    rendered.rerender(<DataSourceDataGrid ariaLabel="People B" cellTypes={registry} dataSource={adapterB.source} />)
    release()

    await waitFor(() => expect(updateA).toHaveBeenCalledTimes(1))
    expect(updateB).not.toHaveBeenCalled()
    await waitFor(() => expect(adapterA.source.getSnapshot().version).toBe(1))
    expect(adapterA.source.getSnapshot().rows[0]!.enabled).toBe(true)
  })

  it('auto-saves a delayed renderer update after its data source is detached', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const saveA = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const saveB = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: 1 }))
    const adapterA = createSource({ mode: 'auto-save', debounceMs: 0, saveDirty: saveA })
    const adapterB = createSource({ mode: 'auto-save', debounceMs: 0, saveDirty: saveB })
    const registry = registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<Row>()).register<boolean, 'toggle'>('toggle', {
      renderCell: ({ update, value }) => <button type="button" onClick={() => { void wait.then(() => update(true)) }}>{value ? 'Delayed on' : 'Delayed off'}</button>,
    })
    const rendered = render(<DataSourceDataGrid ariaLabel="People A" cellTypes={registry} dataSource={adapterA.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delayed off' }))
    rendered.rerender(<DataSourceDataGrid ariaLabel="People B" cellTypes={registry} dataSource={adapterB.source} />)
    release()

    await waitFor(() => expect(saveA).toHaveBeenCalledTimes(1))
    expect(saveB).not.toHaveBeenCalled()
    await waitFor(() => expect(adapterA.source.getSnapshot().version).toBe(1))
  })

  it('submits accepted rows while exposing rejected validation details', async () => {
    let adapter!: ReturnType<typeof createSource>
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }))
    adapter = createSource({ mode: 'save-dirty', saveDirty })
    adapter.publish([
      { id: 'one', enabled: false, name: 'First' },
      { id: 'two', enabled: false, name: 'Second' },
    ])
    adapter.source.fields = adapter.source.fields.map((field) => field.type === 'toggle'
      ? { ...field, validate: (value: boolean, row: Row) => row.id === 'two' && value ? { valid: false, message: 'Second row cannot be enabled.' } : { valid: true } }
      : field)
    render(<DataSourceDataGrid
      ariaLabel="People"
      cellTypes={createRegistry()}
      dataSource={adapter.source}
      renderCommitIssues={({ cellErrorsByRow, rejected }) => <div>{rejected.length} blocked: {cellErrorsByRow.get('two')?.get('enabled')}</div>}
    />)

    screen.getAllByRole('button', { name: 'Off' }).forEach((button) => fireEvent.click(button))

    expect(await screen.findByText('1 blocked: Second row cannot be enabled.')).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save changes' })
    expect((save as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(saveDirty).toHaveBeenCalledTimes(1))
    const request = saveDirty.mock.calls[0]![0]
    expect(request.acceptedKeys).toEqual(new Set(['one']))
    expect(request.revision).toEqual(expect.any(Number))
    expect(request.rows).toEqual([
      { id: 'one', enabled: true, name: 'First' },
      { id: 'two', enabled: false, name: 'Second' },
    ])
    expect(await screen.findByText('1 blocked: Second row cannot be enabled.')).toBeTruthy()
  })

  it('renders validation details in the default commit-issues surface', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.source.fields = adapter.source.fields.map((field) => field.type === 'toggle'
      ? { ...field, validate: (value: boolean) => value ? { valid: false, message: 'Enabled is unavailable.' } : { valid: true } }
      : field)
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Enabled is unavailable.')
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('exposes conflict recovery through the commit-issues render contract', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.source.fields = [...adapter.source.fields].reverse()
    render(<DataSourceDataGrid
      ariaLabel="People"
      cellTypes={createRegistry()}
      dataSource={adapter.source}
      renderCommitIssues={({ rejected, resolveConflict }) => rejected[0]
        ? <button type="button" onClick={() => resolveConflict(rejected[0]!.key, rejected[0]!.fields[0]!, 'source')}>Use source value</button>
        : null}
    />)

    fireEvent.contextMenu(screen.getByText('First'), { clientX: 12, clientY: 24 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear text' }))
    adapter.publish([{ id: 'one', enabled: false, name: 'Remote' }])

    fireEvent.click(await screen.findByRole('button', { name: 'Use source value' }))
    expect(await screen.findByText('Remote')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use source value' })).toBeNull()
  })

  it('renders a working retry after a falsy save rejection', async () => {
    let adapter!: ReturnType<typeof createSource>
    let attempts = 0
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => {
      attempts += 1
      if (attempts === 1) throw null
      return { rows: request.rows, version: Number(request.sourceVersion) + 1 }
    })
    adapter = createSource({ mode: 'save-dirty', saveDirty })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry save' }))

    await waitFor(() => expect(saveDirty).toHaveBeenCalledTimes(2))
    expect(saveDirty.mock.calls[1]![0].operationId).toBe(saveDirty.mock.calls[0]![0].operationId)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull())
  })

  it('clears a stale save failure when an authoritative snapshot confirms the draft', async () => {
    const saveDirty = vi.fn(async (_request: DataGridPersistenceRequest<Row, string>) => { throw new Error('offline') })
    const adapter = createSource({ mode: 'save-dirty', saveDirty })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('button', { name: 'Retry save' })

    adapter.publish(saveDirty.mock.calls[0]![0].rows)

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull())
  })

  it('keeps the draft retryable if publishing the persistence result fails', async () => {
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }))
    const adapter = createSource({ mode: 'save-dirty', saveDirty })
    adapter.source.commitRows = () => { throw new Error('store publish failed') }
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await screen.findByRole('button', { name: 'Retry save' })
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(saveDirty).toHaveBeenCalledTimes(1))
  })

  it('rejects an invalid matrix paste atomically without writing NaN or valid siblings', async () => {
    type NumberRow = { id: string; quantity: number }
    const onActionError = vi.fn()
    let snapshot: DataGridDataSourceSnapshot<NumberRow> = { rows: [{ id: 'one', quantity: 12 }, { id: 'two', quantity: 7 }], state: 'ready', version: 0 }
    const listeners = new Set<() => void>()
    const source: DataGridDataSource<NumberRow, string> = {
      fields: [{ key: 'quantity', label: 'Quantity', type: 'number', getValue: (row) => row.quantity, setValue: (row, quantity) => ({ ...row, quantity }) }],
      commitRows: (result) => { snapshot = { rows: result.rows, state: 'ready', version: result.version }; listeners.forEach((listener) => listener()); return snapshot },
      getRowKey: (row) => row.id, getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      persistence: { mode: 'save-dirty', saveDirty: (request) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }) },
    }
    render(<DataSourceDataGrid ariaLabel="Numbers" cellTypes={registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<NumberRow>())} dataSource={source} onActionError={onActionError} />)
    fireEvent.mouseDown(screen.getByRole('gridcell', { name: '12' }))
    fireEvent.mouseDown(screen.getByRole('gridcell', { name: '7' }), { shiftKey: true })
    fireEvent.paste(screen.getByRole('grid', { name: 'Numbers' }), { clipboardData: { getData: () => '20\nnot-a-number', setData: vi.fn() } })

    expect(onActionError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Enter a valid number.' }))
    expect(screen.getByRole('gridcell', { name: '12' })).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: '7' })).toBeTruthy()
  })

  it('renders an authoritative failure instead of treating it as an empty result', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.publishSnapshot({ rows: [], state: 'failed-empty', error: 'Rows are unavailable.', version: 1 })

    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Rows are unavailable.')
    expect(screen.queryByText('No rows yet.')).toBeNull()
  })

  it('uses registered clipboard and clear behavior through the main grid entry', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    const toggleCell = screen.getByRole('gridcell', { name: 'Off' })
    const gridElement = screen.getByRole('grid', { name: 'People' })
    const copyClipboard = { setData: vi.fn(), getData: vi.fn() }

    fireEvent.mouseDown(toggleCell)
    fireEvent.copy(gridElement, { clipboardData: copyClipboard })
    expect(copyClipboard.setData).toHaveBeenCalledWith('text/plain', 'false')

    fireEvent.paste(gridElement, {
      clipboardData: { getData: vi.fn(() => 'true'), setData: vi.fn() },
    })
    const pastedCell = await screen.findByRole('gridcell', { name: /^On\b/ })

    fireEvent.mouseDown(pastedCell)
    fireEvent.keyDown(gridElement, { key: 'Delete' })
    await screen.findByRole('gridcell', { name: 'Off' })
  })

  it('selects a column from its header and delegates sorting only from the trailing button', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    const updateSort = vi.fn((sortColumns: readonly SortColumn[]) => {
      const next = { ...adapter.source.getSnapshot(), sortColumns }
      adapter.publishSnapshot(next)
      return next
    })
    adapter.source.capabilities = { sorting: { update: updateSort } }
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Off' }), { clientX: 12, clientY: 24 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn on' }))
    expect(screen.getByRole('button', { name: 'On' })).toBeTruthy()
    const enabledHeader = screen.getByRole('columnheader', { name: /Enabled/ })
    fireEvent.click(enabledHeader)
    expect(updateSort).not.toHaveBeenCalled()
    expect(enabledHeader.getAttribute('data-range-column-header')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Sort Enabled ascending' }))
    await waitFor(() => expect(updateSort).toHaveBeenLastCalledWith([{ columnKey: 'enabled', direction: 'ASC' }]))
    fireEvent.click(screen.getByRole('button', { name: 'Sort Enabled descending' }))
    await waitFor(() => expect(updateSort).toHaveBeenLastCalledWith([{ columnKey: 'enabled', direction: 'DESC' }]))
    fireEvent.click(screen.getByRole('button', { name: 'Clear sorting for Enabled' }))
    await waitFor(() => expect(updateSort).toHaveBeenLastCalledWith([]))
  })

  it('rejects a controlled view setter that returns without publishing its snapshot', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    const onActionError = vi.fn()
    adapter.source.capabilities = {
      sorting: {
        update: (sortColumns) => ({ ...adapter.source.getSnapshot(), sortColumns }),
      },
    }
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} onActionError={onActionError} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sort Enabled ascending' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Sorting.update must synchronously publish')
    expect(adapter.source.getSnapshot().sortColumns).toBeUndefined()
    expect(onActionError).toHaveBeenCalledTimes(1)
  })

  it('provides row indicators and field-level dirty markers by default', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    expect(screen.getByRole('button', { name: 'Select all cells' })).toBeTruthy()
    expect(screen.getAllByRole('columnheader')[0]?.textContent).not.toContain('#')
    expect(screen.getByLabelText('Row 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))

    expect(document.querySelector('[data-dirty="true"] [title="Changed. Original value: false"]')).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /Changed\. Original value: false/ })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: /Column contains changes/ }).querySelector('[title="Column contains changes"]')).toBeTruthy()
    expect(screen.getByLabelText(/Row 1 contains changes/).querySelector('[title="Row 1 contains changes"]')).toBeTruthy()
  })

  it('filters a local visible-row view while retaining the complete authoritative source', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.publish([
      { id: 'one', enabled: false, name: 'First' },
      { id: 'two', enabled: true, name: 'Second' },
    ])
    adapter.source.capabilities = {
      filtering: {
        update(filterQuery) {
          adapter.publishSnapshot({ ...adapter.source.getSnapshot(), filterQuery })
          return adapter.source.getSnapshot()
        },
      },
    }
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows…' }), { target: { value: 'Second' } })
    await waitFor(() => expect(screen.getByText('1 of 2 rows')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'On' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull()
    expect(adapter.source.getSnapshot().rows).toHaveLength(2)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows…' }), { target: { value: 'missing' } })
    expect(await screen.findByText('No rows match the current filters.')).toBeTruthy()
  })

  it('opens the turnkey bulk editor from a visible column selection and applies one batch', async () => {
    const saveDirty = vi.fn(async (request: DataGridPersistenceRequest<Row, string>) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }))
    const adapter = createSource({ mode: 'save-dirty', saveDirty })
    adapter.publish([
      { id: 'one', enabled: false, name: 'First' },
      { id: 'two', enabled: true, name: 'Second' },
    ])
    adapter.source.fields = [adapter.source.fields[1]!]
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Select all visible cells in Name' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit text…' }))
    const dialog = screen.getByRole('dialog', { name: 'Name · 2 cells' })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Unified' } })
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('dialog', { name: 'Name · 2 cells' })).toBe(dialog)
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('Unified')
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 cells' }))

    expect(screen.getAllByRole('gridcell', { name: /^Unified\b/ })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(saveDirty).toHaveBeenCalledTimes(1))
    expect(saveDirty.mock.calls[0]![0].acceptedKeys).toEqual(new Set(['one', 'two']))
  })

  it('preserves bulk input when controlled view state changes and blocks a stale apply', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.publish([
      { id: 'one', enabled: false, name: 'First' },
      { id: 'two', enabled: true, name: 'Second' },
    ])
    adapter.source.fields = [adapter.source.fields[1]!]
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Select all visible cells in Name' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit text…' }))
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'UNSAVED' } })
    adapter.publishSnapshot({ ...adapter.source.getSnapshot(), filterQuery: 'First' })

    expect(screen.getByRole('dialog', { name: 'Name · 2 cells' })).toBeTruthy()
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('UNSAVED')
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 cells' }))
    expect(within(screen.getByRole('dialog', { name: 'Name · 2 cells' })).getByRole('alert').textContent).toContain('The selection changed while the bulk editor was open.')
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('UNSAVED')
  })

  it('preserves a bulk draft but refuses to apply it to another data source', async () => {
    const adapterA = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    const adapterB = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapterA.publish([{ id: 'one', enabled: false, name: 'A one' }, { id: 'two', enabled: true, name: 'A two' }])
    adapterB.publish([{ id: 'one', enabled: false, name: 'B one' }, { id: 'two', enabled: true, name: 'B two' }])
    adapterA.source.fields = [adapterA.source.fields[1]!]
    adapterB.source.fields = [adapterB.source.fields[1]!]
    const rendered = render(<DataSourceDataGrid ariaLabel="People A" cellTypes={createRegistry()} dataSource={adapterA.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Select all visible cells in Name' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit text…' }))
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Do not cross sources' } })
    rendered.rerender(<DataSourceDataGrid ariaLabel="People B" cellTypes={createRegistry()} dataSource={adapterB.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 cells' }))

    expect(within(screen.getByRole('dialog', { name: 'Name · 2 cells' })).getByRole('alert').textContent).toContain('The selection changed while the bulk editor was open.')
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('Do not cross sources')
    expect(adapterB.source.getSnapshot().rows.map((row) => row.name)).toEqual(['B one', 'B two'])
  })

  it('preserves a filter draft but refuses to apply it to another data source', async () => {
    const adapterA = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    const adapterB = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapterA.source.fields = [adapterA.source.fields[1]!]
    adapterB.source.fields = [adapterB.source.fields[1]!]
    const updateColumnFiltersA = vi.fn((columnFilters: readonly DataGridColumnFilterGroup[]) => {
      adapterA.publishSnapshot({ ...adapterA.source.getSnapshot(), columnFilters })
      return adapterA.source.getSnapshot()
    })
    const updateColumnFiltersB = vi.fn((columnFilters: readonly DataGridColumnFilterGroup[]) => {
      adapterB.publishSnapshot({ ...adapterB.source.getSnapshot(), columnFilters })
      return adapterB.source.getSnapshot()
    })
    adapterA.source.capabilities = { filtering: { update: () => adapterA.source.getSnapshot(), updateColumnFilters: updateColumnFiltersA } }
    adapterB.source.capabilities = { filtering: { update: () => adapterB.source.getSnapshot(), updateColumnFilters: updateColumnFiltersB } }
    const rendered = render(<DataSourceDataGrid ariaLabel="People A" cellTypes={createRegistry()} dataSource={adapterA.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Filter Name' }))
    fireEvent.change(screen.getByLabelText('Name Value'), { target: { value: 'draft filter' } })
    rendered.rerender(<DataSourceDataGrid ariaLabel="People B" cellTypes={createRegistry()} dataSource={adapterB.source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

    expect(within(screen.getByRole('dialog', { name: 'Filter Name' })).getByRole('alert').textContent).toContain('The data source changed while the filter editor was open.')
    expect((screen.getByLabelText('Name Value') as HTMLInputElement).value).toBe('draft filter')
    expect(updateColumnFiltersA).not.toHaveBeenCalled()
    expect(updateColumnFiltersB).not.toHaveBeenCalled()
  })

  it('rejects a row-dependent bulk parse atomically after source rows refresh', async () => {
    type BoundedRow = { id: string; maximum: number; quantity: number }
    let snapshot: DataGridDataSourceSnapshot<BoundedRow> = {
      rows: [
        { id: 'one', maximum: 10, quantity: 1 },
        { id: 'two', maximum: 10, quantity: 2 },
      ],
      state: 'ready',
      version: 0,
    }
    const listeners = new Set<() => void>()
    const source: DataGridDataSource<BoundedRow, string, { bounded: number }> = {
      fields: [{
        key: 'quantity', label: 'Quantity', type: 'bounded',
        getValue: (row) => row.quantity,
        setValue: (row, quantity) => ({ ...row, quantity }),
      }],
      commitRows: (result) => { snapshot = { rows: result.rows, state: 'ready', version: result.version }; listeners.forEach((listener) => listener()); return snapshot },
      getRowKey: (row) => row.id,
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      persistence: { mode: 'save-dirty', saveDirty: (request) => ({ rows: request.rows, version: Number(request.sourceVersion) + 1 }) },
    }
    const registry = createDataGridCellTypeRegistry<BoundedRow>().register<number, 'bounded'>('bounded', {
      bulk: {
        kind: 'number',
        parseInput: (raw, row) => {
          const value = Number(raw)
          return Number.isFinite(value) && value <= row.maximum ? value : { error: 'Quantity exceeds this row’s maximum.' }
        },
      },
      renderCell: ({ value }) => String(value),
    })
    render(<DataSourceDataGrid ariaLabel="Bounded quantities" cellTypes={registry} dataSource={source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select all visible cells in Quantity' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Set value…' }))
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '8' } })
    snapshot = {
      rows: [
        { id: 'one', maximum: 5, quantity: 1 },
        { id: 'two', maximum: 10, quantity: 2 },
      ],
      state: 'ready',
      version: 1,
    }
    listeners.forEach((listener) => listener())

    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 cells' }))

    expect(within(screen.getByRole('dialog', { name: 'Quantity · 2 cells' })).getByRole('alert').textContent).toContain('The selection changed while the bulk editor was open.')
    expect(screen.getByRole('gridcell', { name: '1' })).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: '2' })).toBeTruthy()
    expect(screen.queryByText('8')).toBeNull()
  })

  it('applies typed column filters without replacing the authoritative rows', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.publish([
      { id: 'one', enabled: false, name: 'First' },
      { id: 'two', enabled: true, name: 'Second' },
    ])
    adapter.source.fields = [adapter.source.fields[1]!]
    adapter.source.capabilities = {
      filtering: {
        update(filterQuery) {
          const next = { ...adapter.source.getSnapshot(), filterQuery }
          adapter.publishSnapshot(next)
          return next
        },
        updateColumnFilters(columnFilters) {
          const acceptedFilters = columnFilters.map((group) => ({
            ...group,
            conditions: group.conditions.map((condition) => ({ ...condition })),
          }))
          const next = { ...adapter.source.getSnapshot(), columnFilters: acceptedFilters }
          adapter.publishSnapshot(next)
          return next
        },
      },
    }
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    fireEvent.click(screen.getByRole('button', { name: 'Filter Name' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name Value' }), { target: { value: 'Second' } })
    adapter.publishSnapshot({ ...adapter.source.getSnapshot(), sortColumns: [] })
    expect(screen.getByRole('dialog', { name: 'Filter Name' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Name Value' }) as HTMLInputElement).value).toBe('Second')
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

    await waitFor(() => expect(screen.getByText('1 of 2 rows')).toBeTruthy())
    expect(screen.getByRole('gridcell', { name: 'Second' })).toBeTruthy()
    expect(screen.queryByRole('gridcell', { name: 'First' })).toBeNull()
    expect(adapter.source.getSnapshot().rows).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Name · 1 ×' })).toBeTruthy()
  })

  it('ignores invalid conditions without disabling a valid any filter', async () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.publish([
      { id: 'one', enabled: false, name: 'First' },
      { id: 'two', enabled: true, name: 'Second' },
    ])
    adapter.source.fields = [adapter.source.fields[1]!]
    adapter.publishSnapshot({
      ...adapter.source.getSnapshot(),
      columnFilters: [{
        columnKey: 'name',
        match: 'any',
        conditions: [
          { operator: 'removed-operator', value: 'anything' },
          { operator: 'equals', value: 'Second' },
        ],
      }],
    })
    render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)

    await waitFor(() => expect(screen.getByText('1 of 2 rows')).toBeTruthy())
    expect(screen.getByRole('gridcell', { name: 'Second' })).toBeTruthy()
    expect(screen.queryByRole('gridcell', { name: 'First' })).toBeNull()

    adapter.publishSnapshot({
      ...adapter.source.getSnapshot(),
      columnFilters: [{ columnKey: 'name', match: 'any', conditions: [{ operator: 'removed-operator', value: 'anything' }] }],
    })
    await waitFor(() => expect(screen.getByText('2 rows')).toBeTruthy())
  })

  it('rejects the reserved turnkey row-indicator field key', () => {
    const adapter = createSource({ mode: 'save-dirty', saveDirty: vi.fn() })
    adapter.source.fields = [{
      key: '__rdg_ext_row_indicator__', label: 'Reserved', type: 'text',
      getValue: (row) => row.name, setValue: (row, name) => ({ ...row, name }),
    }]

    expect(() => render(<DataSourceDataGrid ariaLabel="People" cellTypes={createRegistry()} dataSource={adapter.source} />)).toThrow('is reserved')
  })
})
