import { describe, expect, it } from 'vitest'

import {
  createGridColumnHelper,
  createStandardCellTypeRegistry,
  type StandardGridCellTypeSchema,
} from '../cell-types/index.js'
import type { GridDataSource } from '../data/data-source.js'
import { createRemoteGridDataSource } from '../data/remote-data-source.js'
import { createGridController } from './grid-controller.js'
import { selectGridCell } from './grid-selectors.js'

type Row = Readonly<{
  id: string
  name: string
  quantity: number
  locked?: boolean
}>

const registry = createStandardCellTypeRegistry<Row>()
const column = createGridColumnHelper<Row>()
const nameColumn = column.field('name', {
  label: 'Name',
  type: 'string',
  filterable: true,
})
const quantityColumn = column.field('quantity', {
  label: 'Quantity',
  type: 'number',
  filterable: true,
})

describe('GridController recovery and view boundaries', () => {
  it('rejects add and duplicate operations that reuse a deleted baseline key', () => {
    const dataSource = localDataSource(
      [
        { id: 'row-a', name: 'A', quantity: 1 },
        { id: 'row-b', name: 'B', quantity: 2 },
      ],
      {
        create: () => ({ id: 'row-a', name: 'Replacement', quantity: 3 }),
        duplicate: () => ({ id: 'row-a', name: 'Copy', quantity: 4 }),
        canDelete: () => true,
      },
    )
    const controller = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource,
      cellBehaviors: registry.behaviors,
    })

    expect(controller.applyTransaction((draft) => {
      draft.deleteRows(['row-a'])
    }).accepted).toBe(true)
    expect(controller.dispatch({ type: 'rows/add' })).toMatchObject({
      accepted: false,
      reason: 'The new row key is not unique.',
    })

    controller.dispatch({
      type: 'interaction/activate',
      cell: { rowKey: 'row-b', columnKey: 'name' },
    })
    expect(controller.dispatch({ type: 'rows/duplicate' })).toMatchObject({
      accepted: false,
      reason: 'Duplicate rows must receive unique keys.',
    })
    expect(controller.getSnapshot().draft.rows.map((row) => row.id)).toEqual([
      'row-b',
    ])
    controller.destroy()
  })

  it('restores a conflicted local value before resolving keep-local', () => {
    let failClone = false
    const replayColumn = {
      key: 'name',
      label: 'Name',
      type: 'string',
      layout: { basis: 180 },
      getValue: (row: Row) => row.name,
      setValue: (row: Row, name: string) => ({ ...row, name }),
    } as const
    const dataSource = createRemoteGridDataSource<
      Row,
      string,
      StandardGridCellTypeSchema
    >({
      columns: [replayColumn],
      getRowKey: (row) => row.id,
      cloneRow: (row) => {
        if (failClone) throw new Error('Clone temporarily unavailable')
        return { ...row }
      },
      initialSnapshot: {
        rows: [{ id: 'row-a', name: 'Initial', quantity: 1 }],
        status: 'ready',
        version: 'v1',
        scope: { kind: 'complete' },
      },
      persistence: {
        mode: 'manual-save',
        mutate: async (request) => ({
          kind: 'applied',
          authority: { rows: request.rows, version: 'saved' },
        }),
      },
    })
    const controller = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource,
      cellBehaviors: registry.behaviors,
    })
    expect(controller.dispatch({
      type: 'cell/set-value',
      cell: { rowKey: 'row-a', columnKey: 'name' },
      value: 'Local',
    }).accepted).toBe(true)

    failClone = true
    dataSource.publish({
      rows: [{ id: 'row-a', name: 'Remote', quantity: 2, locked: true }],
      status: 'ready',
      version: 'v2',
      scope: { kind: 'complete' },
    })
    expect(controller.getSnapshot().draft.rows).toEqual([
      { id: 'row-a', name: 'Remote', quantity: 2, locked: true },
    ])
    expect(controller.getSnapshot().draft.conflicts).toHaveLength(1)
    expect(controller.getSnapshot().draft.conflicts[0]?.localValue).toBe('Local')

    expect(controller.dispatch({
      type: 'conflict/resolve',
      rowKey: 'row-a',
      columnKey: 'name',
      resolution: 'keep-local',
    }).accepted).toBe(false)
    expect(controller.getSnapshot().draft.conflicts).toHaveLength(1)
    expect(controller.getSnapshot().draft.conflicts[0]?.localValue).toBe('Local')

    failClone = false
    expect(controller.dispatch({
      type: 'conflict/resolve',
      rowKey: 'row-a',
      columnKey: 'name',
      resolution: 'keep-local',
    }).accepted).toBe(true)
    expect(controller.getSnapshot().draft.rows).toEqual([
      { id: 'row-a', name: 'Local', quantity: 2, locked: true },
    ])
    expect(controller.getSnapshot().draft.conflicts).toEqual([])
    expect(controller.dispatch({ type: 'history/undo' }).accepted).toBe(true)
    expect(controller.getSnapshot().draft.rows[0]?.name).toBe('Remote')
    expect(controller.getSnapshot().draft.conflicts).toHaveLength(1)
    expect(controller.dispatch({ type: 'history/redo' }).accepted).toBe(true)
    expect(controller.getSnapshot().draft.rows[0]?.name).toBe('Local')
    expect(controller.getSnapshot().draft.conflicts).toEqual([])
    controller.destroy()
  })

  it('reports commit-and-move as accepted when the edit removes its row from the view', () => {
    const controller = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: localDataSource([
        { id: 'row-a', name: 'Visible', quantity: 1 },
      ]),
      cellBehaviors: registry.behaviors,
    })
    expect(controller.dispatch({
      type: 'view/set-column-filters',
      filters: [{
        columnKey: 'name',
        operator: 'equals',
        value: 'Visible',
      }],
    }).accepted).toBe(true)
    controller.dispatch({
      type: 'interaction/activate',
      cell: { rowKey: 'row-a', columnKey: 'name' },
    })
    controller.dispatch({ type: 'edit/start' })
    controller.dispatch({ type: 'edit/change', value: 'Hidden' })

    const result = controller.dispatch({
      type: 'edit/commit-and-move',
      direction: 'next',
    })
    expect(result).toMatchObject({
      accepted: true,
      payload: { committed: true, moved: false },
    })
    expect(controller.getSnapshot().draft.rows[0]?.name).toBe('Hidden')
    expect(controller.getSnapshot().view.visibleRowKeys).toEqual([])
    expect(controller.getSnapshot().edit).toBeNull()
    controller.destroy()
  })

  it('does not treat invalid cell text as a global-search match', () => {
    const controller = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: localDataSource([
        { id: 'row-a', name: 'Alpha', quantity: Number.NaN },
        { id: 'row-b', name: 'Needle', quantity: 2 },
      ]),
      cellBehaviors: registry.behaviors,
    })

    expect(controller.dispatch({
      type: 'view/set-global-filter',
      value: 'needle',
    }).accepted).toBe(true)
    expect(controller.getSnapshot().view.visibleRowKeys).toEqual(['row-b'])
    controller.destroy()
  })

  it('does not let invalid cell values bypass an active column filter', () => {
    const controller = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: localDataSource([
        { id: 'row-a', name: 'Invalid', quantity: Number.NaN },
        { id: 'row-b', name: 'High', quantity: 20 },
        { id: 'row-c', name: 'Low', quantity: 5 },
      ]),
      cellBehaviors: registry.behaviors,
    })

    expect(controller.dispatch({
      type: 'view/set-column-filters',
      filters: [{
        columnKey: 'quantity',
        operator: 'greater-than',
        value: '10',
      }],
    }).accepted).toBe(true)
    expect(controller.getSnapshot().view.visibleRowKeys).toEqual(['row-b'])
    controller.destroy()
  })

  it('rejects oversized cell mutations before validation or setters run', () => {
    let setterCalls = 0
    const countedNameColumn = {
      key: 'name',
      label: 'Name',
      type: 'string',
      layout: { basis: 180 },
      getValue: (row: Row) => row.name,
      setValue: (row: Row, name: string) => {
        setterCalls += 1
        return { ...row, name }
      },
    } as const
    const controller = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: {
        ...localDataSource([
          { id: 'row-a', name: 'A', quantity: 1 },
          { id: 'row-b', name: 'B', quantity: 2 },
        ]),
        columns: [countedNameColumn, quantityColumn],
      },
      cellBehaviors: registry.behaviors,
      maxMutations: 1,
    })
    expect(controller.dispatch({
      type: 'interaction/set-ranges',
      ranges: [{
        anchor: { rowKey: 'row-a', columnKey: 'name' },
        focus: { rowKey: 'row-b', columnKey: 'name' },
      }],
      activeRangeIndex: 0,
    }).accepted).toBe(true)

    expect(controller.dispatch({ type: 'selection/clear-values' })).toMatchObject({
      accepted: false,
      reason: 'This operation exceeds the mutation limit.',
    })
    expect(setterCalls).toBe(0)
    expect(controller.getSnapshot().draft.rows.map((row) => row.name)).toEqual([
      'A',
      'B',
    ])
    controller.destroy()
  })

  it('indexes rows once when selecting every rendered cell in a snapshot', () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      id: `row-${index}`,
      name: `Row ${index}`,
      quantity: index,
    }))
    let getRowKeyCalls = 0
    const base = localDataSource(rows)
    const controller = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: {
        ...base,
        getRowKey: (row) => {
          getRowKeyCalls += 1
          return row.id
        },
      },
      cellBehaviors: registry.behaviors,
    })
    const snapshot = controller.getSnapshot()
    getRowKeyCalls = 0

    for (const row of rows) {
      for (const currentColumn of snapshot.columns) {
        expect(selectGridCell(snapshot, {
          rowKey: row.id,
          columnKey: currentColumn.key,
        })).not.toBeNull()
      }
    }
    expect(getRowKeyCalls).toBe(rows.length)

    for (const row of rows) {
      for (const currentColumn of snapshot.columns) {
        selectGridCell(snapshot, {
          rowKey: row.id,
          columnKey: currentColumn.key,
        })
      }
    }
    expect(getRowKeyCalls).toBe(rows.length)
    controller.destroy()
  })

  it('rejects invalid values at the public column-filter boundary', () => {
    const controller = createGridController<Row, string, StandardGridCellTypeSchema>({
      dataSource: localDataSource([
        { id: 'row-a', name: 'A', quantity: 1 },
      ]),
      cellBehaviors: registry.behaviors,
    })

    const result = controller.dispatch({
      type: 'view/set-column-filters',
      filters: [{
        columnKey: 'quantity',
        operator: 'greater-than',
        value: 'not-a-number',
      }],
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('Enter a valid number.')
    expect(controller.getSnapshot().view.columnFilters).toEqual([])
    expect(controller.getSnapshot().view.visibleRowKeys).toEqual(['row-a'])
    controller.destroy()
  })
})

function localDataSource(
  rows: readonly Row[],
  rowCapabilities?: GridDataSource<
    Row,
    string,
    StandardGridCellTypeSchema
  >['rows'],
): GridDataSource<Row, string, StandardGridCellTypeSchema> {
  return {
    columns: [nameColumn, quantityColumn],
    getRowKey: (row) => row.id,
    getSnapshot: () => ({
      rows,
      status: 'ready',
      version: 'v1',
      scope: { kind: 'complete' },
    }),
    subscribe: () => () => undefined,
    ...(rowCapabilities ? { rows: rowCapabilities } : {}),
    persistence: {
      mode: 'manual-save',
      commit: async (request) => ({
        operationId: request.operationId,
        applied: {
          rows: request.rows,
          status: 'ready',
          version: 'v2',
          scope: { kind: 'complete' },
        },
      }),
    },
  }
}
