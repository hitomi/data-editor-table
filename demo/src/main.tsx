import React, { useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DataSourceDataGrid,
  createDataGridCellTypeRegistry,
  createDataGridImageCellTypeRenderer,
  registerDataGridBuiltinCellTypes,
  type DataGridDataSource,
  type DataGridDataSourceSnapshot,
  type DataGridDraftSnapshot,
  type DataGridPersistenceRequest,
} from 'react-data-grid-ext'
import './styles.css'

type DemoRow = { id: string; name: string; quantity: number; image: string | null }

const initialRows: readonly DemoRow[] = [
  { id: 'row-1', name: 'Amber poster', quantity: 12, image: null },
  { id: 'row-2', name: 'Blue card', quantity: 4, image: null },
  { id: 'row-3', name: 'Cedar label', quantity: 28, image: null },
]

class DemoStore {
  private listeners = new Set<() => void>()
  snapshot: DataGridDataSourceSnapshot<DemoRow> = { rows: initialRows, state: 'ready', sortColumns: [] }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  publish = (snapshot: DataGridDataSourceSnapshot<DemoRow>) => { this.snapshot = snapshot; this.listeners.forEach((listener) => listener()) }
}

const store = new DemoStore()

function App() {
  const authoritative = useSyncExternalStore(store.subscribe, () => store.snapshot, () => store.snapshot)
  const [draft, setDraft] = useState<DataGridDraftSnapshot<DemoRow, string> | null>(null)
  const [saveCount, setSaveCount] = useState(0)
  const registry = useMemo(() => {
    const next = registerDataGridBuiltinCellTypes(createDataGridCellTypeRegistry<DemoRow>())
    next.register('image', createDataGridImageCellTypeRenderer<DemoRow, string>({
      accept: 'image/png,image/jpeg,image/webp', alt: (row) => row.name, label: (row) => `Upload image for ${row.name}`,
      resolveSrc: (value) => value,
      upload: ({ file, signal }) => fileToDataUrl(file, signal),
    }))
    return next
  }, [])
  const dataSource = useMemo<DataGridDataSource<DemoRow, string>>(() => ({
    fields: [
      { key: 'image', label: 'Image', type: 'image', width: 92, getValue: (row) => row.image, setValue: (row, image) => ({ ...row, image: image as string | null }) },
      { key: 'name', label: 'Name', type: 'text', sortable: true, minWidth: 180, getValue: (row) => row.name, setValue: (row, name) => ({ ...row, name: String(name) }) },
      { key: 'quantity', label: 'Quantity', type: 'number', sortable: true, width: 120, getValue: (row) => row.quantity, setValue: (row, quantity) => ({ ...row, quantity: Number(quantity) }) },
    ],
    getRowKey: (row) => row.id,
    getSnapshot: () => store.snapshot,
    subscribe: store.subscribe,
    observeDraft: setDraft,
    persistence: {
      mode: 'auto-save', debounceMs: 800,
      async saveDirty(request: DataGridPersistenceRequest<DemoRow, string>) {
        await wait(300, request.signal)
        store.publish({ ...store.snapshot, rows: request.rows, state: 'ready' })
        setSaveCount((count) => count + 1)
      },
    },
    capabilities: {
      sorting: {
        update(sortColumns) {
          const [sort] = sortColumns
          const rows = sort ? [...store.snapshot.rows].sort((left, right) => {
            const a = left[sort.columnKey as keyof DemoRow]
            const b = right[sort.columnKey as keyof DemoRow]
            const order = String(a).localeCompare(String(b), undefined, { numeric: true })
            return sort.direction === 'ASC' ? order : -order
          }) : [...store.snapshot.rows]
          store.publish({ ...store.snapshot, rows, sortColumns })
        },
      },
    },
  }), [])

  const dirty = draft ? Object.fromEntries([...draft.dirtyByRow].map(([key, fields]) => [key, Object.fromEntries(fields)])) : {}
  const patch = draft ? [...draft.dirtyByRow].map(([key, fields]) => ({
    op: 'update', key,
    changes: Object.fromEntries([...fields].map(([field, before]) => [field, { before, after: String(dataSource.fields.find((candidate) => candidate.key === field)?.getValue(draft.rows.find((row) => row.id === key)!) ?? '') }])),
  })) : []

  return <main className="demo-shell">
    <header><div><h1>Data source playground</h1><p>Auto-save · registered cell types · source-controlled sorting</p></div><span data-testid="save-count">{saveCount} saves</span></header>
    <section className="demo-grid-panel">
      <DataSourceDataGrid
        ariaLabel="Demo dataset" dataSource={dataSource} cellTypes={registry}
        actionSurfaces={{ renderToolbar: ({ actions }) => <div className="demo-actions">{actions.map((action) => <button key={action.id} disabled={action.disabled} onClick={() => { void action.run() }}>{action.label}</button>)}</div> }}
      />
    </section>
    <aside>
      <JsonPanel title="Authoritative JSON" value={authoritative.rows} />
      <JsonPanel title="Dirty" value={dirty} />
      <JsonPanel title="Patch preview" value={patch} />
    </aside>
  </main>
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return <section className="json-panel"><h2>{title}</h2><pre>{JSON.stringify(value, null, 2)}</pre></section>
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { window.clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

function fileToDataUrl(file: File, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => reader.abort()
    signal.addEventListener('abort', abort, { once: true })
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.onabort = () => reject(signal.reason)
    reader.readAsDataURL(file)
  })
}

createRoot(document.getElementById('root')!).render(<App />)
