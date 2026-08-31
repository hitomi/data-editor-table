import {
  createGridController,
  type GridCellBehaviorPort,
  type GridCellTypeSignature,
  type GridDataSource,
  type GridDataSourceSnapshot,
  type GridReadyDataSourceSnapshot,
} from 'react-data-grid-ext/engine'

type Row = Readonly<{ id: number; name: string }>
type Schema = Readonly<{
  string: GridCellTypeSignature<string>
}>

let snapshot: GridDataSourceSnapshot<Row> = {
  rows: [{ id: 1, name: 'Engine only' }],
  status: 'ready',
  version: 1,
  scope: { kind: 'complete' },
}

const dataSource: GridDataSource<Row, number, Schema> = {
  columns: [
    {
      key: 'name',
      label: 'Name',
      type: 'string',
      getValue: (row) => row.name,
      setValue: (row, name) => ({ ...row, name }),
    },
  ],
  getRowKey: (row) => row.id,
  getSnapshot: () => snapshot,
  subscribe: () => () => undefined,
  persistence: {
    mode: 'manual-save',
    commit: async (request) => {
      const next = {
        rows: request.rows,
        status: 'ready',
        version: Number(request.sourceVersion) + 1,
        scope: { kind: 'complete' },
      } satisfies GridReadyDataSourceSnapshot<Row>
      snapshot = next
      return { operationId: request.operationId, applied: next }
    },
  },
}

declare const behaviors: GridCellBehaviorPort<Row>

export const controller = createGridController<Row, number, Schema>({
  dataSource,
  cellBehaviors: behaviors,
})
