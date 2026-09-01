import { createRoot } from 'react-dom/client'
import {
  DataGrid,
  createCellTypeRegistry,
  createStringCellType,
  type GridCellTypeSchemaOf,
  type GridDataSource,
  type GridDataSourceSnapshot,
  type GridReadyDataSourceSnapshot,
} from 'data-editor-table'

const structureOnly = new URLSearchParams(window.location.search).get('styles') === 'structure'
const stylesReady = structureOnly
  ? Promise.all([
      import('data-editor-table/structure.css'),
      import('./structure-theme.css'),
    ])
  : import('data-editor-table/styles.css')

type Row = Readonly<{ id: number; name: string }>

const registry = createCellTypeRegistry<Row>()
  .register('string', createStringCellType())
type Schema = GridCellTypeSchemaOf<typeof registry>

let snapshot: GridDataSourceSnapshot<Row> = {
  rows: [{ id: 1, name: 'Packed row' }],
  status: 'ready',
  version: 1,
  scope: { kind: 'complete' },
}
const listeners = new Set<() => void>()

const dataSource: GridDataSource<Row, number, Schema> = {
  columns: [{
    key: 'name',
    label: 'Name',
    type: 'string',
    getValue: (row) => row.name,
    setValue: (row, name) => ({ ...row, name }),
  }],
  getRowKey: (row) => row.id,
  getSnapshot: () => snapshot,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
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
      listeners.forEach((listener) => { listener() })
      return { operationId: request.operationId, applied: next }
    },
  },
}

void stylesReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <DataGrid
      ariaLabel="Packed package grid"
      className={structureOnly ? 'packed-tailwind-grid' : undefined}
      dataSource={dataSource}
      registry={registry}
    />,
  )
})
