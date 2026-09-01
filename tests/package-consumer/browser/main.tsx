import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DataGrid,
  createCellTypeRegistry,
  createRemoteGridDataSource,
  createStringCellType,
  useDataGridBinding,
  type GridCellTypeSchemaOf,
} from 'data-editor-table'
import { zhCN } from 'data-editor-table/locales/zh-CN'

const structureOnly = new URLSearchParams(window.location.search).get('styles') === 'structure'
const stylesReady = structureOnly
  ? Promise.all([
      import('data-editor-table/structure.css'),
      import('./structure-theme.css'),
    ])
  : import('data-editor-table/styles.css')

type Row = Readonly<{ id: number; name: string }>

const registry = createCellTypeRegistry<Row>()
  .register('string', createStringCellType({
    locale: zhCN.code,
    messages: zhCN.cellTypes.string,
  }))
type Schema = GridCellTypeSchemaOf<typeof registry>

const dataSource = createRemoteGridDataSource<Row, number, Schema>({
  columns: [{
    key: 'name',
    label: 'Name',
    type: 'string',
    getValue: (row) => row.name,
    setValue: (row, name) => ({ ...row, name }),
  }],
  getRowKey: (row) => row.id,
  initialSnapshot: {
    rows: [{ id: 1, name: 'Packed row' }],
    status: 'ready',
    version: 1,
    scope: { kind: 'complete' },
  },
  persistence: {
    mode: 'manual-save',
    mutate: async (request) => {
      return {
        kind: 'applied',
        authority: {
          rows: request.rows,
          version: Number(request.sourceVersion) + 1,
        },
      }
    },
  },
})

function PackedGrid() {
  const binding = useDataGridBinding({ dataSource, registry })
  if (!binding) return <div role="status">正在初始化表格…</div>
  return <DataGrid
    ariaLabel="打包产物表格"
    binding={binding}
    className={structureOnly ? 'packed-tailwind-grid' : undefined}
    messages={zhCN.dataGrid}
  />
}

void stylesReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode><PackedGrid /></StrictMode>,
  )
})
