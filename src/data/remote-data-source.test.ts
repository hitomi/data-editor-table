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

  it('reuses operationId after an unknown outcome and adopts reloaded authority', async () => {
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
    expect(controller.dispatch({ type: 'persistence/retry' }).accepted).toBe(true)
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
    expect(mutationCount).toBe(1)
    controller.destroy()
  })
})
