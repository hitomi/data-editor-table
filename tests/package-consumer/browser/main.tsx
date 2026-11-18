import { createRowAuthority } from './row-authority'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DataGrid,
  createGridColumnHelper,
  createFieldGridDocumentModel,
  createRemoteGridDataSource,
  useDataGridBinding,
  type StandardGridCellTypeSchema,
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

const column = createGridColumnHelper<Row>()

const columns = [column.field('name', { label: 'Name', type: 'string' })]
const server = createRowAuthority(`packed-${structureOnly ? 'structure' : 'theme'}`, { id: 1, name: 'Packed row' })
const dataSource = createRemoteGridDataSource<Row, number, StandardGridCellTypeSchema>({
  columns, model: createFieldGridDocumentModel(columns),
  getRowKey: row => row.id, scope: server.scope, source: server.source,
  initialAuthority: server.snapshot(), persistence: { mode: 'manual-save' },
})

function PackedGrid() {
  const attachment = useDataGridBinding({ dataSource, initial: { locale: zhCN } })
  if (attachment.status === 'error') return <div role="alert">{attachment.issue.message}</div>
  if (!attachment.binding) return <div role="status">正在初始化表格…</div>
  return <DataGrid
    ariaLabel="打包产物表格"
    binding={attachment.binding}
    {...(structureOnly ? { className: 'packed-tailwind-grid' } : {})}
  />
}

void stylesReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode><PackedGrid /></StrictMode>,
  )
})
