import {
  createGridController,
  createRemoteGridDataSource,
  type GridCellBehaviorPort,
  type GridCellTypeSignature,
} from 'data-editor-table/engine'

type Row = Readonly<{ id: number; name: string }>
type Schema = Readonly<{
  string: GridCellTypeSignature<string>
}>

const dataSource = createRemoteGridDataSource<Row, number, Schema>({
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
  initialSnapshot: {
    rows: [{ id: 1, name: 'Engine only' }],
    status: 'ready',
    version: 1,
    scope: { kind: 'complete' },
  },
  persistence: {
    mode: 'manual-save',
    mutate: async (request) => ({
      kind: 'applied',
      authority: {
        rows: request.rows,
        version: Number(request.sourceVersion) + 1,
      },
    }),
  },
})

declare const behaviors: GridCellBehaviorPort<Row>

export const controller = createGridController<Row, number, Schema>({
  dataSource,
  cellBehaviors: behaviors,
})
