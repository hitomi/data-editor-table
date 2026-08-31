import {
  DataGrid,
  createCellTypeRegistry,
  createStringCellType,
  type GridCellTypeSchemaOf,
  type GridDataSource,
  type GridDataSourceSnapshot,
  type GridReadyDataSourceSnapshot,
} from 'react-data-grid-ext'
import { createGridController } from 'react-data-grid-ext/engine'
import 'react-data-grid-ext/styles.css'

type Row = { id: number; name: string }

export const registry = createCellTypeRegistry<Row>()
  .register('string', createStringCellType())

type Schema = GridCellTypeSchemaOf<typeof registry>

let snapshot: GridDataSourceSnapshot<Row> = {
  rows: [{ id: 1, name: 'Ada' }],
  status: 'ready',
  version: 1,
  scope: { kind: 'complete' },
}

export const dataSource: GridDataSource<Row, number, Schema> = {
  columns: [{
    key: 'name',
    label: 'Name',
    type: 'string',
    getValue: (row) => row.name,
    setValue: (row, name) => ({ ...row, name }),
  }],
  getRowKey: (row) => row.id,
  getSnapshot: () => snapshot,
  subscribe: () => () => undefined,
  persistence: {
    mode: 'manual-save',
    commit: async (request) => {
      const next = { rows: request.rows, status: 'ready', version: Number(request.sourceVersion) + 1, scope: { kind: 'complete' } } satisfies GridReadyDataSourceSnapshot<Row>
      snapshot = next
      return { operationId: request.operationId, applied: next }
    },
  },
}

export const headlessController = createGridController<Row, number, Schema>({ dataSource, cellBehaviors: registry.behaviors })
export const TurnkeyGrid = DataGrid<Row, number, Schema>

const invalidDataSource: GridDataSource<Row, number, Schema> = {
  ...dataSource,
  columns: [{
    key: 'name', label: 'Name', type: 'string',
    // @ts-expect-error A registered string column cannot expose a number value.
    getValue: () => 42,
    setValue: (row, name) => ({ ...row, name }),
  }],
}
void invalidDataSource
