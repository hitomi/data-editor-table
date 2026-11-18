import { createDemoGridSource } from './demo-data-source'
import { useRef, useSyncExternalStore } from 'react'
import {
  DataGrid,
  createBooleanCellType,
  createDataGridBinding,
  createGridColumnHelper,
  createImageCellType,
  createStandardCellTypeRegistry,
  useGridSelector,
  type GridCellTypeSchemaOf,
  type GridController,
  type GridPersistenceMode,
} from 'data-editor-table'

type DemoRow = {
  id: string
  image: string | null
  name: string
  quantity: number
  deliveryDate: string
  status: 'draft' | 'ready' | 'archived'
  tags: readonly ('featured' | 'seasonal' | 'wholesale' | 'legacy')[]
  active: boolean
}

const initialRows: readonly DemoRow[] = [
  { id: 'row-1', image: null, name: 'Amber poster', quantity: 12, deliveryDate: '2026-09-02', status: 'ready', tags: ['featured', 'seasonal', 'wholesale'], active: true },
  { id: 'row-2', image: null, name: 'Blue card', quantity: 14, deliveryDate: '2026-09-05', status: 'draft', tags: ['wholesale'], active: false },
  { id: 'row-3', image: null, name: 'Cedar label', quantity: 16, deliveryDate: '2026-09-08', status: 'archived', tags: ['legacy'], active: false },
  { id: 'row-4', image: null, name: 'Dune notebook', quantity: 18, deliveryDate: '2026-09-12', status: 'ready', tags: ['featured'], active: true },
  { id: 'row-5', image: null, name: 'Ember envelope', quantity: 20, deliveryDate: '2026-09-16', status: 'draft', tags: [], active: true },
  { id: 'row-6', image: null, name: 'Fern calendar', quantity: 22, deliveryDate: '2026-09-21', status: 'ready', tags: ['seasonal'], active: true },
  ...[
    'Granite folio', 'Harbor postcard', 'Indigo planner', 'Juniper tag', 'Kite memo pad',
    'Linen folder', 'Moss invitation', 'Navy bookmark', 'Ochre sketchbook', 'Pine notecard',
    'Quartz print', 'Reed journal', 'Sienna sticker', 'Tide envelope', 'Umber catalogue',
    'Vale gift card', 'Willow checklist', 'Xenia place card', 'Yarrow receipt', 'Zinc sleeve',
    'Alpine ticket', 'Birch sign', 'Clay swatch', 'Drift brochure', 'Elm index card',
    'Flint label', 'Grove workbook', 'Haze menu', 'Iris voucher', 'Jade booklet',
  ].map((name, index): DemoRow => ({
    id: `row-${index + 7}`,
    image: null,
    name,
    quantity: 24 + index * 2,
    deliveryDate: `2026-10-${String(index % 28 + 1).padStart(2, '0')}`,
    status: index % 3 === 0 ? 'draft' : 'ready',
    tags: index % 4 === 0 ? ['featured', 'wholesale'] : index % 3 === 0 ? ['seasonal'] : [],
    active: index % 5 !== 0,
  })),
]

const registry = createStandardCellTypeRegistry<DemoRow>()
  .replace('boolean', createBooleanCellType({ trueLabel: 'Active', falseLabel: 'Inactive' }))
  .register('image', createImageCellType<DemoRow, string>({
    alt: (row) => row.name,
    label: (row) => row.image ? 'Replace image' : 'Add image',
    validate: (value) => typeof value === 'string'
      ? { ok: true, value }
      : {
          ok: false,
          issue: {
            code: 'invalid-image-value',
            message: 'The image value must be a URL or data URL.',
          },
        },
    resolveSrc: (value) => value,
    upload: ({ file, signal }) => fileToDataUrl(file, signal),
    parseClipboard: (text) => text === '' || /^(data:image\/|https?:\/\/)/.test(text)
      ? { ok: true, value: text || null }
      : {
          ok: false,
          issue: {
            code: 'invalid-image-source',
            message: 'Paste an image URL or data URL.',
          },
        },
  }))

type DemoSchema = GridCellTypeSchemaOf<typeof registry>
const column = createGridColumnHelper<DemoRow, DemoSchema>()

const createSource = () => createDemoGridSource<DemoRow, DemoSchema>({
  name: 'playground', initialRows, delay: 280,
  columns: [
    column.field('image', {
      label: 'Image',
      type: 'image',
      layout: { basis: 116, min: 96 },
      filterable: true,
    }),
    column.field('name', {
      label: 'Name',
      type: 'string',
      layout: { basis: 260, min: 180, flex: 2 },
      sortable: true,
      filterable: true,
      bulkEditable: true,
    }),
    column.field('quantity', {
      label: 'Quantity',
      type: 'number',
      typeOptions: { minimum: 0 },
      layout: { basis: 150, min: 120, flex: 1 },
      sortable: true,
      filterable: true,
      bulkEditable: true,
    }),
    column.field('deliveryDate', {
      label: 'Delivery date',
      type: 'date',
      layout: { basis: 190, min: 160, flex: 1 },
      sortable: true,
      filterable: true,
      bulkEditable: true,
    }),
    column.field('status', {
      label: 'Status',
      type: 'singleSelect',
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'ready', label: 'Ready' },
        { value: 'archived', label: 'Archived', disabled: true },
      ],
      layout: { basis: 150, min: 120, flex: 1 },
      sortable: true,
      filterable: true,
      bulkEditable: true,
    }),
    column.field('tags', {
      label: 'Tags',
      type: 'multiSelect',
      options: [
        { value: 'featured', label: 'Featured' },
        { value: 'seasonal', label: 'Seasonal' },
        { value: 'wholesale', label: 'Wholesale' },
        { value: 'legacy', label: 'Legacy', disabled: true },
      ],
      layout: { basis: 250, min: 180, flex: 2 },
      sortable: true,
      filterable: true,
      bulkEditable: true,
    }),
    column.field('active', {
      label: 'Active',
      type: 'boolean',
      layout: { basis: 110, min: 90 },
      sortable: true,
      filterable: true,
      bulkEditable: true,
    }),
  ],
  persistence: { mode: 'auto-save', debounceMs: 700 },
  rows: {
    create: () => ({
      id: `row-${crypto.randomUUID()}`,
      image: null,
      name: 'Untitled item',
      quantity: 0,
      deliveryDate: '2026-09-30',
      status: 'draft',
      tags: [],
      active: true,
    }),
    duplicate: (row) => ({
      ...row,
      id: `row-${crypto.randomUUID()}`,
      name: `${row.name} copy`,
      tags: [...row.tags],
    }),
    canDelete: () => true,
  },
})

const sourceOwner: ReturnType<typeof createSource> = import.meta.hot?.data.sourceOwner ?? createSource()
const { dataSource, store, changeRow } = sourceOwner
const binding: ReturnType<typeof createDataGridBinding<DemoRow, string, DemoSchema>> = import.meta.hot?.data.binding ?? createDataGridBinding({ dataSource, initial: { registry } })
if (import.meta.hot) import.meta.hot.dispose(data => { data.sourceOwner = sourceOwner; data.binding = binding })

export function PlaygroundPage() {
  const controller = binding.controller
  const authoritative = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot,
    () => store.snapshot,
  )
  const snapshot = useGridSelector(controller, (value) => value)
  const saveCount = useSyncExternalStore(
    store.subscribe,
    () => store.saveCount,
    () => store.saveCount,
  )

  return (
    <main className="demo-shell">
      <header className="demo-header">
        <h1>Inventory bulk editor</h1>
        <div className="demo-header-actions">
          <PersistenceMode controller={controller} mode={snapshot.persistence.mode} />
          <button type="button" onClick={() => { store.failNextSave = true }}>
            Fail next save
          </button>
          <button type="button" onClick={simulateRemoteChange}>
            Simulate remote change
          </button>
          <span>{saveCount} saves</span>
        </div>
      </header>
      <section className="demo-grid-panel">
        <DataGrid ariaLabel="Inventory items" binding={binding} />
      </section>
      <aside className="demo-inspector">
        <JsonPanel title="Authoritative JSON" value={authoritative.rows} />
        <JsonPanel title="Dirty" value={snapshot.draft.dirtyCells} />
        <JsonPanel title="Conflicts" value={snapshot.draft.conflicts} />
      </aside>
    </main>
  )
}

function PersistenceMode({ controller, mode }: {
  controller: GridController<DemoRow, string, DemoSchema>
  mode: GridPersistenceMode
}) {
  const timing = useRef<Exclude<GridPersistenceMode, 'manual-save'>>('auto-save')
  const autoSave = mode !== 'manual-save'
  const selectedTiming = autoSave ? mode : timing.current
  return (
    <span className="demo-persistence-controls">
      <label className="demo-auto-save-toggle">
        <input
          aria-label="Auto-save"
          checked={autoSave}
          role="switch"
          type="checkbox"
          onChange={(event) => {
            if (!event.currentTarget.checked) timing.current = selectedTiming
            controller.dispatch({
              type: 'persistence/set-mode',
              mode: event.currentTarget.checked ? timing.current : 'manual-save',
            })
          }}
        />
        <span>Auto-save</span>
      </label>
      <label className="demo-auto-save-timing">
        <span>Auto-save timing</span>
        <select
          aria-label="Auto-save timing"
          disabled={!autoSave}
          value={selectedTiming}
          onChange={(event) => {
            const next = event.currentTarget.value as Exclude<
              GridPersistenceMode,
              'manual-save'
            >
            timing.current = next
            controller.dispatch({ type: 'persistence/set-mode', mode: next })
          }}
        >
          <option value="immediate">Immediately</option>
          <option value="auto-save">After a pause</option>
        </select>
      </label>
    </span>
  )
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="json-panel">
      <h2>{title}</h2>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  )
}

function simulateRemoteChange() {
  void changeRow('row-1', row => ({ ...row, name: `Remote amber ${Number(store.snapshot.version) + 1}` }))
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
