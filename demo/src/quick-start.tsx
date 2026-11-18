import { createDemoGridSource } from './demo-data-source'
import {
  DataGrid,
  createGridColumnHelper,
} from 'data-editor-table'

type Product = {
  id: string
  name: string
  quantity: number
  status: 'draft' | 'ready'
  active: boolean
}

const initialProducts: readonly Product[] = [
  { id: 'product-1', name: 'Amber poster', quantity: 12, status: 'ready', active: true },
  { id: 'product-2', name: 'Blue card', quantity: 24, status: 'draft', active: false },
  { id: 'product-3', name: 'Cedar label', quantity: 36, status: 'ready', active: true },
]

const column = createGridColumnHelper<Product>()

const createSource = () => createDemoGridSource<Product, import('data-editor-table').StandardGridCellTypeSchema>({
  name: 'quick-start', initialRows: initialProducts,
  columns: [
    column.field('name', { label: 'Name', type: 'string', sortable: true }),
    column.field('quantity', {
      label: 'Quantity',
      type: 'number',
      typeOptions: { minimum: 0 },
    }),
    column.field('status', {
      label: 'Status',
      type: 'singleSelect',
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'ready', label: 'Ready' },
      ],
    }),
    column.field('active', { label: 'Active', type: 'boolean' }),
  ],
  persistence: { mode: 'auto-save', debounceMs: 250 },
})

const sourceOwner: ReturnType<typeof createSource> = import.meta.hot?.data.sourceOwner ?? createSource()
const { dataSource } = sourceOwner
if (import.meta.hot) import.meta.hot.dispose(data => { data.sourceOwner = sourceOwner })

const shortestIntegration = `const column = createGridColumnHelper<Product>()
const columns = [
  column.field('name', { label: 'Name', type: 'string' }),
  column.field('active', { label: 'Active', type: 'boolean' }),
]

const dataSource = createRemoteGridDataSource({
  columns,
  getRowKey: row => row.id,
  model: createFieldGridDocumentModel(columns),
  scope: productsApi.scope,
  source: productsApi.persistenceSource,
  persistence: { mode: 'auto-save' },
})

<DataGrid ariaLabel="Products" dataSource={dataSource} />`

export function QuickStartPage() {
  return (
    <main className="quick-start-page">
      <header className="quick-start-header">
        <div>
          <p className="demo-eyebrow">Quick start</p>
          <h1>Minimal API-backed grid</h1>
        </div>
        <div aria-label="Example features" className="quick-start-features">
          <span>Default cell types</span>
          <span>Auto-save</span>
          <span>No registry setup</span>
        </div>
      </header>
      <section className="quick-start-workspace">
        <div className="quick-start-grid-panel">
          <DataGrid ariaLabel="Quick-start products" dataSource={dataSource} />
        </div>
        <section aria-labelledby="quick-start-code-heading" className="quick-start-code-panel">
          <div>
            <h2 id="quick-start-code-heading">Complete integration</h2>
            <a href="https://www.npmjs.com/package/data-editor-table">npm</a>
          </div>
          <pre data-testid="quick-start-code"><code>{shortestIntegration}</code></pre>
        </section>
      </section>
    </main>
  )
}
