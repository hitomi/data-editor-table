import { describe, expect, it, vi } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import type { GridCommitReceipt, GridCommitRequest, GridDataSourceSnapshot, GridReadyDataSourceSnapshot } from '../data/data-source.js'
import { createRemoteGridDataSource, type GridRemoteAuthority, type GridRemoteMutationResult } from '../data/remote-data-source.js'
import { createGridController } from './grid-controller.js'

type Row = Readonly<{ id: string; name: string; count: number }>
const columns = [{
  key: 'name', label: 'Name', type: 'string' as const,
  getValue: (row: Row) => row.name,
  setValue: (row: Row, name: string) => ({ ...row, name }),
}]
const registry = createStandardCellTypeRegistry<Row>()
const cell = { rowKey: 'a', columnKey: 'name' }
const authority = (name: string, version: string, count = 0): GridRemoteAuthority<Row> => ({
  rows: [{ id: 'a', name, count }], version,
})
const ready = (value: GridRemoteAuthority<Row>): GridReadyDataSourceSnapshot<Row> => ({
  ...value, status: 'ready', scope: { kind: 'complete' },
})
function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(load?: () => Promise<GridRemoteAuthority<Row>>, mode: 'manual-save' | 'auto-save' | 'immediate' = 'manual-save') {
  const mutation = deferred<GridRemoteMutationResult<Row, string>>()
  const mutate = vi.fn((_request: GridCommitRequest<Row, string>) => mutation.promise)
  const source = createRemoteGridDataSource({
    columns, getRowKey: (row: Row) => row.id,
    initialSnapshot: ready(authority('Initial', 'base')),
    ...(load ? { load } : {}),
    persistence: { mode, debounceMs: 1, mutate },
  })
  const grid = createGridController({ dataSource: source, cellBehaviors: registry.behaviors })
  const save = async () => {
    expect(grid.dispatch({ type: 'cell/set-value', cell, value: 'Submitted' }).accepted).toBe(true)
    if (mode === 'manual-save') expect(grid.dispatch({ type: 'persistence/save' }).accepted).toBe(true)
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    return mutate.mock.calls[0]![0].operationId
  }
  return { source, grid, mutation, mutate, save }
}

describe('persistence authority consistency across the adapter and controller', () => {
  it.each(['publication-first', 'receipt-first'] as const)('accepts a valid native receipt in %s order without a status-only rollback', async (order) => {
    const response = deferred<GridCommitReceipt<Row, string>>()
    let published: GridDataSourceSnapshot<Row> = ready(authority('Initial', 'base'))
    let notify = () => {}
    const commit = vi.fn((_request: GridCommitRequest<Row, string>) => response.promise)
    const grid = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: {
        columns, getRowKey: (row) => row.id, getSnapshot: () => published,
        subscribe: (listener) => { notify = listener; return () => {} },
        persistence: { mode: 'manual-save', commit },
      }, cellBehaviors: registry.behaviors,
    })
    try {
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Submitted' })
      grid.dispatch({ type: 'persistence/save' })
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
      const applied = ready(authority('Canonical', 'applied'))
      if (order === 'publication-first') { published = applied; notify() }
      response.resolve({ operationId: commit.mock.calls[0]![0].operationId, applied })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
      if (order === 'receipt-first') {
        published = { ...ready(authority('Initial', 'base')), status: 'refreshing' }
        notify()
        expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Canonical')
        published = applied
        notify()
      }
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Canonical')
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
      // Once the store catches up, normal authoritative updates still work.
      published = ready(authority('Later edit', 'later'))
      notify()
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Later edit')
    } finally { grid.destroy() }
  })

  it.each([false, true])('requires evidence for a native third version (proof=%s)', async (proof) => {
    const response = deferred<GridCommitReceipt<Row, string>>()
    let published: GridDataSourceSnapshot<Row> = ready(authority('Initial', 'base'))
    let notify = () => {}
    const commit = vi.fn((_request: GridCommitRequest<Row, string>) => response.promise)
    const grid = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: {
        columns, getRowKey: (row) => row.id, getSnapshot: () => published,
        subscribe: (listener) => { notify = listener; return () => {} },
        persistence: { mode: 'manual-save', commit },
      }, cellBehaviors: registry.behaviors,
    })
    try {
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Submitted' })
      grid.dispatch({ type: 'persistence/save' })
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
      const operationId = commit.mock.calls[0]![0].operationId
      published = { ...ready(authority('Initial', 'third')), ...(proof ? { afterOperationId: operationId } : {}) }
      notify()
      response.resolve({ operationId, applied: ready(authority('Submitted', 'applied')) })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe(proof ? 'idle' : 'failed'))
      // A real later server edit may intentionally restore the original value.
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe(proof ? 'Initial' : 'Submitted')
      expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(proof ? 0 : 1)
    } finally { grid.destroy() }
  })

  it.each(['manual-save', 'auto-save', 'immediate'] as const)('re-reads an intermediate publication after the write in %s mode', async (mode) => {
    const load = vi.fn(async () => authority('Canonical', 'applied', 1))
    const { source, grid, mutation, save } = fixture(load, mode)
    try {
      await save()
      source.publish(ready(authority('Initial', 'intermediate', 1)))
      mutation.resolve({ kind: 'applied', authority: authority('Canonical', 'applied', 1) })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
      expect(load).toHaveBeenCalledTimes(1)
      expect(source.getSnapshot().rows[0]?.name).toBe('Canonical')
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Canonical')
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
      expect(grid.getSnapshot().draft.conflicts).toEqual([])
    } finally { grid.destroy() }
  })

  it('retains a genuinely later external authority by reading after mutation', async () => {
    const { source, grid, mutation, save } = fixture(async () => authority('Later server edit', 'later'))
    try {
      await save()
      source.publish(ready(authority('Later server edit', 'later')))
      mutation.resolve({ kind: 'applied', authority: authority('Submitted', 'applied') })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
      expect(grid.getSnapshot().source.version).toBe('later')
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Later server edit')
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    } finally { grid.destroy() }
  })

  it('keeps an ambiguous save recoverable when no authority loader is available', async () => {
    const { source, grid, mutation, mutate, save } = fixture()
    try {
      const operationId = await save()
      source.publish(ready(authority('Initial', 'intermediate')))
      mutation.resolve({ kind: 'applied', authority: authority('Submitted', 'applied') })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
      expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(1)
      expect(grid.getSnapshot().persistence.retryOperationId).toBeNull()
      expect(grid.dispatch({ type: 'persistence/save' }).accepted).toBe(false)
      expect(grid.dispatch({ type: 'persistence/retry' }).accepted).toBe(false)
      expect(mutate).toHaveBeenCalledTimes(1)
      source.publish({ ...ready(authority('Submitted', 'applied')), afterOperationId: operationId })
      expect(grid.getSnapshot().persistence.status).toBe('idle')
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    } finally { grid.destroy() }
  })

  it.each(['before', 'during'] as const)('fences an external read started %s the write, including a late cache notification', async (when) => {
    const { source, grid, mutation, save } = fixture()
    try {
      const early = when === 'before' ? source.beginRead() : null
      await save()
      const read = early ?? source.beginRead()
      mutation.resolve({ kind: 'applied', authority: authority('Canonical', 'applied') })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
      expect(read.publish(ready(authority('Initial', 'late-old-read')))).toBe(false)
      expect(() => source.publish(ready(authority('Initial', 'late-old-read')))).toThrow('beginRead')
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Canonical')
      const fresh = source.beginRead()
      expect(fresh.publish(ready(authority('New server edit', 'later')))).toBe(true)
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('New server edit')
    } finally { grid.destroy() }
  })

  it('replays queued edits and history after an ambiguous save is reconciled', async () => {
    const { source, grid, mutation, save, mutate } = fixture(async () => authority('Submitted', 'applied', 2))
    try {
      await save()
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Queued' })
      source.publish(ready(authority('Initial', 'intermediate', 1)))
      mutation.resolve({ kind: 'applied', authority: authority('Submitted', 'applied', 2) })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
      expect(grid.getSnapshot().draft.rows).toEqual([{ id: 'a', name: 'Queued', count: 2 }])
      expect(grid.getSnapshot().draft.dirtyCells[0]?.originalValue).toBe('Submitted')
      grid.dispatch({ type: 'history/undo' })
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
      grid.dispatch({ type: 'history/redo' })
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Queued')
      expect(mutate).toHaveBeenCalledTimes(1)
    } finally { grid.destroy() }
  })

  it('does not let an idempotent retry overwrite authority published between attempts', async () => {
    const load = vi.fn(async () => authority('Newer server edit', 'newer'))
    const mutate = vi.fn<(request: GridCommitRequest<Row, string>) => Promise<GridRemoteMutationResult<Row, string>>>()
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValue({ kind: 'applied', authority: authority('Submitted', 'applied') })
    const source = createRemoteGridDataSource({
      columns, getRowKey: (row: Row) => row.id,
      initialSnapshot: ready(authority('Initial', 'base')), load,
      persistence: { mode: 'manual-save', mutate },
    })
    const grid = createGridController({ dataSource: source, cellBehaviors: registry.behaviors })
    try {
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Submitted' })
      grid.dispatch({ type: 'persistence/save' })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
      source.publish(ready(authority('Newer server edit', 'newer')))
      grid.dispatch({ type: 'persistence/retry' })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
      expect(mutate.mock.calls[1]![0]).toBe(mutate.mock.calls[0]![0])
      expect(load).toHaveBeenCalledTimes(1)
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Newer server edit')
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    } finally { grid.destroy() }
  })

  it.each(['auto-save', 'immediate'] as const)('does not automatically resend a confirmed write after a read failure in %s mode', async (mode) => {
    const { source, grid, mutation, save, mutate } = fixture(async () => { throw new Error('Read failed') }, mode)
    try {
      await save()
      mutation.resolve({ kind: 'reload' })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Queued' })
      source.publish({ ...ready(authority('Initial', 'base')), status: 'refreshing' })
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(mutate).toHaveBeenCalledTimes(1)
      expect(grid.getSnapshot().persistence.retryOperationId).toBeNull()
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Queued')
    } finally { grid.destroy() }
  })

  it('keeps confirmed writes recoverable when reload validation fails', async () => {
    const load = vi.fn<() => Promise<GridRemoteAuthority<Row>>>()
      .mockResolvedValueOnce({ rows: [{ id: 'a', name: 'Duplicate', count: 0 }, { id: 'a', name: 'Duplicate', count: 0 }], version: 'bad' })
      .mockResolvedValue(authority('Submitted', 'applied'))
    const { grid, mutation, save, mutate } = fixture(load)
    try {
      await save()
      mutation.resolve({ kind: 'reload' })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
      expect(grid.getSnapshot().persistence.retryOperationId).toBeNull()
      grid.dispatch({ type: 'source/refresh' })
      // An invalid applied snapshot must not be retained as a valid receipt.
      await vi.waitFor(() => expect(grid.getSnapshot().source.version).toBe('applied'))
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
      expect(grid.getSnapshot().draft.conflicts).toEqual([])
      expect(mutate).toHaveBeenCalledTimes(1)
    } finally { grid.destroy() }
  })

  it('rejects a refresh that returns the known pre-write base without rolling back saved data', async () => {
    const load = vi.fn<() => Promise<GridRemoteAuthority<Row>>>()
      .mockResolvedValueOnce(authority('Initial', 'base'))
      .mockResolvedValue(authority('Submitted', 'applied'))
    const { source, grid, mutation, save, mutate } = fixture(load)
    try {
      await save()
      mutation.resolve({ kind: 'applied', authority: authority('Submitted', 'applied') })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
      grid.dispatch({ type: 'source/refresh' })
      await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('error'))
      expect(source.getSnapshot().version).toBe('applied')
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
      grid.dispatch({ type: 'source/refresh' })
      await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('ready'))
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
      expect(mutate).toHaveBeenCalledTimes(1)
    } finally { grid.destroy() }
  })

  it('does not retry a confirmed write when decoding mutation metadata throws', async () => {
    const { grid, mutation, save, mutate } = fixture()
    try {
      await save()
      mutation.resolve({
        kind: 'applied', authority: authority('Submitted', 'applied'), keyRemap: 42,
      } as unknown as GridRemoteMutationResult<Row, string>)
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
      expect(grid.getSnapshot().persistence.retryOperationId).toBeNull()
      expect(grid.dispatch({ type: 'persistence/save' }).accepted).toBe(false)
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
      expect(mutate).toHaveBeenCalledTimes(1)
    } finally { grid.destroy() }
  })

  it('recovers a confirmed write after its authority reload fails without writing again', async () => {
    const load = vi.fn<() => Promise<GridRemoteAuthority<Row>>>()
      .mockRejectedValueOnce(new Error('Read unavailable'))
      .mockResolvedValue(authority('Submitted', 'applied'))
    const { grid, mutation, mutate, save } = fixture(load)
    try {
      await save()
      mutation.resolve({ kind: 'reload' })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
      expect(grid.getSnapshot().persistence.retryOperationId).toBeNull()
      expect(grid.dispatch({ type: 'persistence/retry' }).accepted).toBe(false)
      expect(grid.dispatch({ type: 'cell/set-value', cell, value: 'Queued' }).accepted).toBe(true)
      grid.dispatch({ type: 'source/refresh' })
      await vi.waitFor(() => expect(grid.getSnapshot().source.version).toBe('applied'))
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Queued')
      expect(grid.getSnapshot().draft.dirtyCells[0]?.originalValue).toBe('Submitted')
      expect(mutate).toHaveBeenCalledTimes(1)
    } finally { grid.destroy() }
  })

  it.each(['applied', 'reload'] as const)('recovers %s authority with inserted keys, deleted rows, queued edits and history', async (kind) => {
    const base = { rows: [{ id: 'a', name: 'A', count: 0 }, { id: 'b', name: 'B', count: 0 }], version: 'base' }
    const applied = { rows: [{ id: 'server', name: 'New', count: 1 }, { id: 'a', name: 'A', count: 0 }], version: 'applied' }
    const mutation = deferred<GridRemoteMutationResult<Row, string>>()
    const mutate = vi.fn((_request: GridCommitRequest<Row, string>) => mutation.promise)
    const load = vi.fn<() => Promise<GridRemoteAuthority<Row>>>()
      .mockRejectedValueOnce(new Error('Read unavailable'))
      .mockResolvedValue(applied)
    const source = createRemoteGridDataSource({
      columns, getRowKey: (row: Row) => row.id, initialSnapshot: ready(base), load,
      rows: { create: () => ({ id: 'temp', name: 'New', count: 0 }), canDelete: () => true, ordering: 'mutable' },
      persistence: { mode: 'manual-save', mutate },
    })
    const grid = createGridController({ dataSource: source, cellBehaviors: registry.behaviors })
    try {
      expect(grid.applyTransaction((draft) => {
        draft.createRow({ beforeRowKey: 'a' })
        draft.deleteRows(['b'])
      }).accepted).toBe(true)
      const inserted = { rowKey: 'temp', columnKey: 'name' }
      grid.dispatch({ type: 'interaction/activate', cell: inserted })
      grid.dispatch({ type: 'persistence/save' })
      await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
      source.publish(ready({ ...base, version: 'intermediate' }))
      const keyRemap = [{ from: 'temp', to: 'server' }]
      mutation.resolve(kind === 'applied' ? { kind, authority: applied, keyRemap } : { kind, keyRemap })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
      grid.dispatch({ type: 'cell/set-value', cell: inserted, value: 'Queued' })
      grid.dispatch({ type: 'source/refresh' })
      await vi.waitFor(() => expect(grid.getSnapshot().source.version).toBe('applied'))
      expect(grid.getSnapshot().draft.rows).toEqual([
        { id: 'server', name: 'Queued', count: 1 }, { id: 'a', name: 'A', count: 0 },
      ])
      expect(grid.getSnapshot().draft.insertedRowKeys).toEqual([])
      expect(grid.getSnapshot().draft.deletedRowKeys).toEqual([])
      expect(grid.getSnapshot().draft.orderDirty).toBe(false)
      expect(grid.getSnapshot().interaction.activeCell?.rowKey).toBe('server')
      grid.dispatch({ type: 'history/undo' })
      expect(grid.getSnapshot().draft.rows).toEqual(applied.rows)
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
      grid.dispatch({ type: 'history/redo' })
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Queued')
      expect(mutate).toHaveBeenCalledTimes(1)
    } finally { grid.destroy() }
  })

  it('does not mistake a status-only publication for recovery of a malformed receipt', async () => {
    const applied = ready(authority('Submitted', 'applied'))
    let published: GridDataSourceSnapshot<Row> = ready(authority('Initial', 'base'))
    let notify = () => {}
    const commit = vi.fn(async (request: GridCommitRequest<Row, string>): Promise<GridCommitReceipt<Row, string>> => ({
      operationId: `${request.operationId}-wrong`, applied: { ...applied, status: 'ready' },
    }))
    const grid = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: {
        columns, getRowKey: (row: Row) => row.id, getSnapshot: () => published,
        subscribe: (listener) => { notify = listener; return () => {} },
        persistence: { mode: 'manual-save', commit },
      }, cellBehaviors: registry.behaviors,
    })
    try {
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Submitted' })
      grid.dispatch({ type: 'persistence/save' })
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
      published = { ...published, status: 'refreshing' }
      notify()
      expect(grid.dispatch({ type: 'persistence/save' }).accepted).toBe(false)
      expect(commit).toHaveBeenCalledTimes(1)
    } finally { grid.destroy() }
  })
})
