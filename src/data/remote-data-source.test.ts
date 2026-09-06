import {
  createCellTypeRegistry,
  createStringCellType,
  type GridCellTypeSchemaOf,
} from '../cell-types/index.js'
import { createGridController } from '../controller/grid-controller.js'
import type { GridCommitRequest } from './data-source.js'
import {
  createGridIdempotencyHeaders,
  createRemoteGridDataSource,
  type GridRemoteMutationResult,
} from './remote-data-source.js'
import { describe, expect, it, vi } from 'vitest'

type Row = Readonly<{ id: string; name: string }>

const registry = createCellTypeRegistry<Row>()
  .register('string', createStringCellType())
type Schema = GridCellTypeSchemaOf<typeof registry>

const nameColumn = {
  key: 'name',
  label: 'Name',
  type: 'string',
  layout: { basis: 200 },
  getValue: (row: Row) => row.name,
  setValue: (row: Row, name: string) => ({ ...row, name }),
} as const

describe('createRemoteGridDataSource', () => {
  it('does not let stale refreshes overwrite newer authority publications', async () => {
    const loads: Array<{
      resolve: (authority: Readonly<{ rows: readonly Row[]; version: string }>) => void
    }> = []
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      load: () => new Promise((resolve) => { loads.push({ resolve }) }),
      persistence: {
        mode: 'manual-save',
        mutate: async () => ({ kind: 'reload' }),
      },
    })

    const first = dataSource.refresh!({ signal: new AbortController().signal })
    const second = dataSource.refresh!({ signal: new AbortController().signal })
    loads[1]!.resolve({
      rows: [{ id: 'row-a', name: 'Newest' }],
      version: 'v3',
    })
    await second
    loads[0]!.resolve({
      rows: [{ id: 'row-a', name: 'Older' }],
      version: 'v2',
    })
    await first

    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Newest' }],
      status: 'ready',
      version: 'v3',
    })
  })

  it('restores the previous snapshot when refresh is aborted', async () => {
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      async load() {
        await Promise.resolve()
        return { rows: [{ id: 'row-a', name: 'Unused' }], version: 'v2' }
      },
      persistence: {
        mode: 'manual-save',
        mutate: async () => ({ kind: 'reload' }),
      },
    })
    const abort = new AbortController()
    const refreshing = dataSource.refresh!({ signal: abort.signal })
    abort.abort()
    await refreshing

    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Initial' }],
      status: 'ready',
      version: 'v1',
    })
  })

  it('keeps an active refresh alive when an external publication is rejected', async () => {
    let finishLoad!: (
      authority: Readonly<{ rows: readonly Row[]; version: string }>,
    ) => void
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      load: () => new Promise((resolve) => { finishLoad = resolve }),
      persistence: {
        mode: 'manual-save',
        mutate: async () => ({ kind: 'reload' }),
      },
    })

    const refreshing = dataSource.refresh!({
      signal: new AbortController().signal,
    })
    expect(() => dataSource.publish({
      rows: [{ id: 'row-a', name: 'Invalid same-version update' }],
      status: 'ready',
      version: 'v1',
      scope: { kind: 'complete' },
    })).toThrow(
      'A remote data source cannot reuse one version for different authoritative rows.',
    )

    finishLoad({
      rows: [{ id: 'row-a', name: 'Refreshed' }],
      version: 'v2',
    })
    await refreshing

    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Refreshed' }],
      status: 'ready',
      version: 'v2',
    })
  })

  it('does not let a commit completion overwrite an external publication', async () => {
    let finishMutation!: (result: GridRemoteMutationResult<Row, string>) => void
    const mutation = new Promise<GridRemoteMutationResult<Row, string>>(
      (resolve) => { finishMutation = resolve },
    )
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      persistence: {
        mode: 'manual-save',
        mutate: async () => mutation,
      },
    })
    const committing = dataSource.persistence.commit(commitRequest())
    dataSource.publish({
      rows: [{ id: 'row-a', name: 'Externally newer' }],
      status: 'ready',
      version: 'v3',
      scope: { kind: 'complete' },
    })
    finishMutation({
      kind: 'applied',
      authority: {
        rows: [{ id: 'row-a', name: 'Commit result' }],
        version: 'v2',
      },
    })
    const receipt = await committing

    expect(receipt.applied.version).toBe('v2')
    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Externally newer' }],
      version: 'v3',
    })
  })

  it('does not treat a status-only publication as newer authority', async () => {
    let finishMutation!: (result: GridRemoteMutationResult<Row, string>) => void
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      persistence: {
        mode: 'manual-save',
        mutate: () => new Promise((resolve) => { finishMutation = resolve }),
      },
    })
    const committing = dataSource.persistence.commit(commitRequest())
    dataSource.publish({
      rows: [{ id: 'row-a', name: 'Initial' }],
      status: 'refreshing',
      version: 'v1',
      scope: { kind: 'complete' },
    })
    finishMutation({
      kind: 'applied',
      authority: {
        rows: [{ id: 'row-a', name: 'Committed' }],
        version: 'v2',
      },
    })

    await expect(committing).resolves.toMatchObject({
      operationId: 'operation-1',
      applied: { version: 'v2' },
    })
    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Committed' }],
      status: 'ready',
      version: 'v2',
    })
  })

  it('serializes concurrent commits and publishes every successful result', async () => {
    const calls: string[] = []
    const finishes = new Map<
      string,
      (result: GridRemoteMutationResult<Row, string>) => void
    >()
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      persistence: {
        mode: 'manual-save',
        mutate: (request) => new Promise((resolve) => {
          calls.push(request.operationId)
          finishes.set(request.operationId, resolve)
        }),
      },
    })
    const first = dataSource.persistence.commit(commitRequest('operation-1'))
    const second = dataSource.persistence.commit(commitRequest('operation-2'))

    expect(calls).toEqual(['operation-1'])
    finishes.get('operation-1')!({
      kind: 'applied',
      authority: {
        rows: [{ id: 'row-a', name: 'First' }],
        version: 'v2',
      },
    })
    await vi.waitFor(() => expect(calls).toEqual([
      'operation-1',
      'operation-2',
    ]))
    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'First' }],
      version: 'v2',
    })
    finishes.get('operation-2')!({
      kind: 'applied',
      authority: {
        rows: [{ id: 'row-a', name: 'Second' }],
        version: 'v3',
      },
    })

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { operationId: 'operation-1', applied: { version: 'v2' } },
      { operationId: 'operation-2', applied: { version: 'v3' } },
    ])
    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Second' }],
      status: 'ready',
      version: 'v3',
    })
  })

  it('continues the commit queue after an earlier mutation fails', async () => {
    const calls: string[] = []
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      persistence: {
        mode: 'manual-save',
        async mutate(request) {
          calls.push(request.operationId)
          if (request.operationId === 'operation-1') {
            throw new Error('First failed')
          }
          return {
            kind: 'applied',
            authority: {
              rows: [{ id: 'row-a', name: 'Recovered' }],
              version: 'v2',
            },
          }
        },
      },
    })

    const first = dataSource.persistence.commit(commitRequest('operation-1'))
    const second = dataSource.persistence.commit(commitRequest('operation-2'))
    await expect(first).rejects.toThrow('First failed')
    await expect(second).resolves.toMatchObject({ operationId: 'operation-2' })
    expect(calls).toEqual(['operation-1', 'operation-2'])
    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Recovered' }],
      version: 'v2',
    })
  })

  it('gives a commit authority precedence over an earlier in-flight refresh', async () => {
    let finishLoad!: (
      authority: Readonly<{ rows: readonly Row[]; version: string }>,
    ) => void
    let finishMutation!: (result: GridRemoteMutationResult<Row, string>) => void
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      load: () => new Promise((resolve) => { finishLoad = resolve }),
      persistence: {
        mode: 'manual-save',
        mutate: () => new Promise((resolve) => { finishMutation = resolve }),
      },
    })
    const refreshing = dataSource.refresh!({
      signal: new AbortController().signal,
    })
    const committing = dataSource.persistence.commit(commitRequest())
    finishLoad({
      rows: [{ id: 'row-a', name: 'Refresh result' }],
      version: 'v2',
    })
    await refreshing
    finishMutation({
      kind: 'applied',
      authority: {
        rows: [{ id: 'row-a', name: 'Committed' }],
        version: 'v3',
      },
    })
    await committing

    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Committed' }],
      status: 'ready',
      version: 'v3',
    })
  })

  it('does not leave refresh state behind when an overlapping commit fails', async () => {
    let finishLoad!: (
      authority: Readonly<{ rows: readonly Row[]; version: string }>,
    ) => void
    let failMutation!: (error: Error) => void
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      load: () => new Promise((resolve) => { finishLoad = resolve }),
      persistence: {
        mode: 'manual-save',
        mutate: () => new Promise((_resolve, reject) => {
          failMutation = reject
        }),
      },
    })
    const refreshing = dataSource.refresh!({
      signal: new AbortController().signal,
    })
    const committing = dataSource.persistence.commit(commitRequest())
    finishLoad({
      rows: [{ id: 'row-a', name: 'Suppressed refresh' }],
      version: 'v2',
    })
    await refreshing
    failMutation(new Error('Write failed'))
    await expect(committing).rejects.toThrow('Write failed')

    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Initial' }],
      status: 'ready',
      version: 'v1',
    })
  })

  it('starts a requested refresh after an active commit settles', async () => {
    let finishMutation!: (result: GridRemoteMutationResult<Row, string>) => void
    let loadCount = 0
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      async load() {
        loadCount += 1
        return {
          rows: [{ id: 'row-a', name: 'Refreshed after commit' }],
          version: 'v3',
        }
      },
      persistence: {
        mode: 'manual-save',
        mutate: () => new Promise((resolve) => { finishMutation = resolve }),
      },
    })
    const committing = dataSource.persistence.commit(commitRequest())
    const refreshing = dataSource.refresh!({
      signal: new AbortController().signal,
    })
    expect(loadCount).toBe(0)
    finishMutation({
      kind: 'applied',
      authority: {
        rows: [{ id: 'row-a', name: 'Committed' }],
        version: 'v2',
      },
    })
    await committing
    await refreshing

    expect(loadCount).toBe(1)
    expect(dataSource.getSnapshot()).toMatchObject({
      rows: [{ id: 'row-a', name: 'Refreshed after commit' }],
      status: 'ready',
      version: 'v3',
    })
  })

  it('projects CRUD changes and replays edits onto a server-assigned key', async () => {
    let request: GridCommitRequest<Row, string> | null = null
    let finishMutation!: (
      result: GridRemoteMutationResult<Row, string>,
    ) => void
    const mutation = new Promise<GridRemoteMutationResult<Row, string>>(
      (resolve) => {
        finishMutation = resolve
      },
    )
    let temporaryKey = ''
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [
          { id: 'row-a', name: 'A' },
          { id: 'row-b', name: 'B' },
        ],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      rows: {
        create: () => ({ id: 'temp-1', name: '' }),
        canDelete: () => true,
        ordering: 'mutable',
      },
      persistence: {
        mode: 'manual-save',
        async mutate(next) {
          request = next
          return mutation
        },
      },
    })
    const controller = createGridController<Row, string, Schema>({
      dataSource,
      cellBehaviors: registry.behaviors,
    })

    const transaction = controller.applyTransaction((draft) => {
      temporaryKey = draft.createRow({ beforeRowKey: 'row-a' })
      draft.set(nameColumn, temporaryKey, 'New')
      draft.set(nameColumn, 'row-a', 'A2')
      draft.deleteRows(['row-b'])
    })
    expect(transaction.accepted).toBe(true)
    controller.dispatch({
      type: 'interaction/activate',
      cell: { rowKey: temporaryKey, columnKey: 'name' },
    })
    expect(controller.dispatch({ type: 'persistence/save' }).accepted).toBe(true)
    await vi.waitFor(() => expect(request).not.toBeNull())

    expect(request!.changes).toEqual({
      inserted: [{ rowKey: 'temp-1', row: { id: 'temp-1', name: 'New' } }],
      updated: [{
        rowKey: 'row-a',
        before: { id: 'row-a', name: 'A' },
        after: { id: 'row-a', name: 'A2' },
        cells: [{
          rowKey: 'row-a',
          columnKey: 'name',
          before: 'A',
          after: 'A2',
        }],
      }],
      deleted: [{ rowKey: 'row-b', row: { id: 'row-b', name: 'B' } }],
      order: {
        before: ['row-a', 'row-b'],
        after: ['temp-1', 'row-a'],
      },
    })

    expect(controller.dispatch({
      type: 'cell/set-value',
      cell: { rowKey: temporaryKey, columnKey: 'name' },
      value: 'Changed while saving',
    }).accepted).toBe(true)
    finishMutation({
      kind: 'applied',
      authority: {
        rows: [
          { id: 'server-42', name: 'New' },
          { id: 'row-a', name: 'A2' },
        ],
        version: 'v2',
      },
      keyRemap: [{ from: 'temp-1', to: 'server-42' }],
    })

    await vi.waitFor(() => {
      expect(controller.getSnapshot().persistence.status).toBe('idle')
    })
    const snapshot = controller.getSnapshot()
    expect(snapshot.source.rows).toEqual([
      { id: 'server-42', name: 'New' },
      { id: 'row-a', name: 'A2' },
    ])
    expect(snapshot.draft.rows).toEqual([
      { id: 'server-42', name: 'Changed while saving' },
      { id: 'row-a', name: 'A2' },
    ])
    expect(snapshot.draft.dirtyCells).toEqual([{
      rowKey: 'server-42',
      columnKey: 'name',
      originalValue: 'New',
      formattedOriginalValue: 'New',
    }])
    expect(snapshot.interaction.activeCell?.rowKey).toBe('server-42')
    expect(controller.dispatch({ type: 'history/undo' }).accepted).toBe(true)
    expect(controller.getSnapshot().draft.rows[0]).toEqual({
      id: 'server-42',
      name: 'New',
    })
    expect(controller.getSnapshot().draft.dirtyCells).toEqual([])
    expect(controller.dispatch({ type: 'history/redo' }).accepted).toBe(true)
    expect(controller.getSnapshot().draft.rows[0]).toEqual({
      id: 'server-42',
      name: 'Changed while saving',
    })
    controller.destroy()
  })

  it.each(['persistence/retry', 'persistence/save'] as const)('reuses operationId after an unknown outcome via %s and adopts reloaded authority', async (retryIntent) => {
    const operationIds: string[] = []
    let mutationAttempt = 0
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Before' }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      async load(context) {
        expect(context.reason).toBe('after-mutation')
        expect(context.operationId).toBe(operationIds[0])
        return {
          rows: [{ id: 'row-a', name: 'Server normalized' }],
          version: 'v2',
        }
      },
      persistence: {
        mode: 'manual-save',
        async mutate(request) {
          operationIds.push(request.operationId)
          mutationAttempt += 1
          if (mutationAttempt === 1) throw new Error('Connection lost after write')
          return { kind: 'reload' }
        },
      },
    })
    const controller = createGridController<Row, string, Schema>({
      dataSource,
      cellBehaviors: registry.behaviors,
    })
    controller.dispatch({
      type: 'cell/set-value',
      cell: { rowKey: 'row-a', columnKey: 'name' },
      value: 'Client proposal',
    })
    controller.dispatch({ type: 'persistence/save' })
    await vi.waitFor(() => {
      expect(controller.getSnapshot().persistence.status).toBe('failed')
    })
    expect(controller.dispatch({ type: retryIntent }).accepted).toBe(true)
    await vi.waitFor(() => {
      expect(controller.getSnapshot().persistence.status).toBe('idle')
    })

    expect(operationIds).toHaveLength(2)
    expect(operationIds[1]).toBe(operationIds[0])
    expect(createGridIdempotencyHeaders(operationIds[0]!)).toEqual({
      'Idempotency-Key': operationIds[0],
    })
    expect(controller.getSnapshot().source.rows).toEqual([
      { id: 'row-a', name: 'Server normalized' },
    ])
    expect(controller.getSnapshot().draft.rows).toEqual([
      { id: 'row-a', name: 'Server normalized' },
    ])
    controller.destroy()
  })

  it('rejects an invalid server key remap without retrying an applied operation', async () => {
    let mutationCount = 0
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      rows: { create: () => ({ id: 'temp-1', name: 'New' }) },
      persistence: {
        mode: 'manual-save',
        async mutate() {
          mutationCount += 1
          return {
            kind: 'applied',
            authority: {
              rows: [{ id: 'server-42', name: 'New' }],
              version: 'v2',
            },
            keyRemap: [{ from: 'temp-1', to: 'missing-server-key' }],
          }
        },
      },
    })
    const controller = createGridController<Row, string, Schema>({
      dataSource,
      cellBehaviors: registry.behaviors,
    })
    controller.dispatch({ type: 'rows/add' })
    controller.dispatch({ type: 'persistence/save' })
    await vi.waitFor(() => {
      expect(controller.getSnapshot().persistence.status).toBe('failed')
    })

    const persistence = controller.getSnapshot().persistence
    expect(persistence.error).toContain('does not contain remapped row key')
    expect(persistence.retryOperationId).toBeNull()
    expect(controller.dispatch({ type: 'persistence/retry' }).accepted).toBe(false)
    expect(controller.dispatch({ type: 'persistence/save' }).accepted).toBe(false)
    expect(mutationCount).toBe(1)
    controller.destroy()
  })

  it('rejects a missing server key remap without retrying an applied operation', async () => {
    const dataSource = createRemoteGridDataSource<Row, string, Schema>({
      columns: [nameColumn],
      getRowKey: (row) => row.id,
      initialSnapshot: {
        rows: [],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      rows: { create: () => ({ id: 'temp-1', name: 'New' }) },
      persistence: {
        mode: 'manual-save',
        async mutate() {
          return {
            kind: 'applied',
            authority: {
              rows: [{ id: 'server-42', name: 'New' }],
              version: 'v2',
            },
          }
        },
      },
    })
    const controller = createGridController<Row, string, Schema>({
      dataSource,
      cellBehaviors: registry.behaviors,
    })
    controller.dispatch({ type: 'rows/add' })
    controller.dispatch({ type: 'persistence/save' })
    await vi.waitFor(() => {
      expect(controller.getSnapshot().persistence.status).toBe('failed')
    })

    const persistence = controller.getSnapshot().persistence
    expect(persistence.error).toContain('without a server row-key remap')
    expect(persistence.retryOperationId).toBeNull()
    expect(controller.getSnapshot().draft.rows).toEqual([
      { id: 'temp-1', name: 'New' },
    ])
    controller.destroy()
  })
})

function commitRequest(operationId = 'operation-1'): GridCommitRequest<Row, string> {
  return Object.freeze({
    rows: Object.freeze([{ id: 'row-a', name: 'Commit result' }]),
    changes: Object.freeze({
      inserted: Object.freeze([]),
      updated: Object.freeze([]),
      deleted: Object.freeze([]),
      order: null,
    }),
    acceptedRowKeys: Object.freeze([]),
    deletedRowKeys: Object.freeze([]),
    orderChanged: false,
    dirtyOriginals: Object.freeze([]),
    draftRevision: 1,
    sourceVersion: 'v1',
    operationId,
  })
}
