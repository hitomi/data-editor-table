import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from 'react'
import {
  DataGrid,
  GridCommitError,
  createCellTypeRegistry,
  createDataGridBinding,
  createImageCellType,
  createStringCellType,
  useGridSelector,
  type GridCellTypeSchemaOf,
  type GridColumn,
  type GridDataSource,
  type GridDataSourceSnapshot,
  type GridImageColumnOptions,
  type GridReadyDataSourceSnapshot,
  type GridStringColumnOptions,
} from 'data-editor-table'

type ImportRow = {
  id: string
  image: string | null
  name: string
}

type PreparedImage = Readonly<{
  dataUrl: string
  name: string
}>

type ImportTargetPlan = Readonly<{
  sourceRevision: number
  draftRevision: number
  viewRevision: number
  visibleRowKeys: readonly string[]
  startIndex: number
}>

type ImportStatus =
  | Readonly<{ kind: 'idle'; message: string }>
  | Readonly<{ kind: 'processing'; message: string }>
  | Readonly<{ kind: 'success'; message: string }>
  | Readonly<{ kind: 'cancelled'; message: string }>
  | Readonly<{ kind: 'error'; message: string }>

const MAX_FILES = 24
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_BATCH_BYTES = 48 * 1024 * 1024

const initialRows: readonly ImportRow[] = [
  { id: 'import-row-1', image: null, name: '' },
  { id: 'import-row-2', image: null, name: '' },
  { id: 'import-row-3', image: null, name: '' },
]

const registry = createCellTypeRegistry<ImportRow>()
  .register('image', createImageCellType<ImportRow, string>({
    alt: (row) => row.name || 'Imported image',
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
    upload: ({ file, signal }) => readFileAsDataUrl(file, signal),
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
  .register('string', createStringCellType())

type ImportSchema = GridCellTypeSchemaOf<typeof registry>

const imageColumn = {
  key: 'image',
  label: 'Image',
  type: 'image',
  layout: { basis: 148, min: 116 },
  filterable: true,
  getValue: (row) => row.image,
  setValue: (row, image) => ({ ...row, image }),
} satisfies GridColumn<
  ImportRow,
  string | null,
  'image',
  GridImageColumnOptions<ImportRow, string> | undefined
>

const nameColumn = {
  key: 'name',
  label: 'Name',
  type: 'string',
  layout: { basis: 420, min: 220, flex: 1 },
  sortable: true,
  filterable: true,
  bulkEditable: true,
  getValue: (row) => row.name,
  setValue: (row, name) => ({ ...row, name }),
} satisfies GridColumn<
  ImportRow,
  string,
  'string',
  GridStringColumnOptions | undefined
>

class ImportStore {
  readonly listeners = new Set<() => void>()
  snapshot: GridDataSourceSnapshot<ImportRow> = {
    rows: initialRows,
    status: 'ready',
    version: 0,
    scope: { kind: 'complete' },
  }
  nextId = 4
  saveCount = 0
  failNextSave = false

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(next: GridDataSourceSnapshot<ImportRow>) {
    this.snapshot = next
    this.listeners.forEach((listener) => { listener() })
  }
}

const store = new ImportStore()

const dataSource: GridDataSource<ImportRow, string, ImportSchema> = {
  columns: [imageColumn, nameColumn],
  getRowKey: (row) => row.id,
  getSnapshot: () => store.snapshot,
  subscribe: store.subscribe,
  refresh: () => { store.publish(store.snapshot) },
  persistence: {
    mode: 'auto-save',
    debounceMs: 350,
    commit: async (request) => {
      await wait(180)
      if (store.failNextSave) {
        store.failNextSave = false
        throw new GridCommitError(
          'transient',
          'The simulated save failed. The imported draft is still available to retry.',
        )
      }
      if (!Object.is(request.sourceVersion, store.snapshot.version)) {
        throw new GridCommitError(
          'source-version-conflict',
          'The import could not be saved because the source changed.',
        )
      }
      store.saveCount += 1
      const next = {
        rows: request.rows,
        status: 'ready',
        version: Number(request.sourceVersion) + 1,
        scope: { kind: 'complete' },
      } satisfies GridReadyDataSourceSnapshot<ImportRow>
      store.publish(next)
      return { operationId: request.operationId, applied: next }
    },
  },
  rows: {
    create: () => ({
      id: `import-row-${store.nextId++}`,
      image: null,
      name: '',
    }),
    duplicate: (row) => ({
      ...row,
      id: `import-row-${store.nextId++}`,
      name: row.name ? `${row.name} copy` : '',
    }),
    canDelete: () => true,
  },
}

const binding = createDataGridBinding({ dataSource, registry })
if (import.meta.hot) import.meta.hot.dispose(() => { binding.destroy() })

export function MultiImageImportPage() {
  const controller = binding.controller
  const snapshot = useGridSelector(controller, (value) => value)
  const authoritative = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot,
    () => store.snapshot,
  )
  const saveCount = useSyncExternalStore(
    store.subscribe,
    () => store.saveCount,
    () => store.saveCount,
  )
  const [status, setStatus] = useState<ImportStatus>({
    kind: 'idle',
    message: 'Ready for image files.',
  })
  const [dropActive, setDropActive] = useState(false)
  const activeBatch = useRef<AbortController | null>(null)
  const batchRevision = useRef(0)
  const dragDepth = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      batchRevision.current += 1
      activeBatch.current?.abort()
      activeBatch.current = null
    }
  }, [])

  const importFiles = useCallback(async (files: readonly File[]) => {
    const revision = batchRevision.current + 1
    batchRevision.current = revision
    activeBatch.current?.abort()
    const batch = new AbortController()
    activeBatch.current = batch

    const issue = validateBatch(files)
    if (issue) {
      activeBatch.current = null
      if (mounted.current && batchRevision.current === revision) {
        setStatus({ kind: 'error', message: `${issue} No rows were changed.` })
      }
      return
    }

    const targetPlan = captureTargetPlan(controller)

    setStatus({
      kind: 'processing',
      message: `Reading ${files.length} ${files.length === 1 ? 'image' : 'images'}…`,
    })
    try {
      const prepared = await Promise.all(
        files.map(async (file): Promise<PreparedImage> => ({
          dataUrl: await readFileAsDataUrl(file, batch.signal),
          name: nameWithoutFinalExtension(file.name),
        })),
      )
      if (!isCurrentBatch(revision, batch, batchRevision, activeBatch, mounted)) return

      const result = controller.applyTransaction((transaction) => {
        if (!matchesTargetPlan(transaction.base, targetPlan)) {
          transaction.abort({
            code: 'stale-import-target',
            message: 'The grid changed while the images were being read. Drop the files again.',
          })
        }

        for (let index = 0; index < prepared.length; index += 1) {
          const item = prepared[index]!
          const rowKey = targetPlan.visibleRowKeys[targetPlan.startIndex + index]
            ?? transaction.createRow()
          transaction.set(imageColumn, rowKey, item.dataUrl)
          transaction.set(nameColumn, rowKey, item.name)
        }
      }, { label: `Import ${prepared.length} images` })

      if (!isCurrentBatch(revision, batch, batchRevision, activeBatch, mounted)) return
      activeBatch.current = null
      if (!result.accepted) {
        setStatus({
          kind: 'error',
          message: `${result.issues[0]?.message ?? 'The grid rejected the import.'} No rows were changed.`,
        })
        return
      }
      setStatus({
        kind: 'success',
        message: `Imported ${prepared.length} ${prepared.length === 1 ? 'image' : 'images'} as one transaction.`,
      })
    } catch (error) {
      if (!isOwnedBatch(revision, batch, batchRevision, activeBatch, mounted)) return
      const message = errorMessage(error)
      batch.abort()
      activeBatch.current = null
      setStatus({
        kind: 'error',
        message: `${message} No rows were changed.`,
      })
    }
  }, [controller])

  const cancelImport = useCallback(() => {
    if (!activeBatch.current) return
    batchRevision.current += 1
    activeBatch.current.abort()
    activeBatch.current = null
    setStatus({
      kind: 'cancelled',
      message: 'Import cancelled. No rows were changed.',
    })
  }, [])

  useEffect(() => {
    const consume = (event: globalThis.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    const onDragEnter = (event: globalThis.DragEvent) => {
      if (!hasFilePayload(event)) return
      consume(event)
      dragDepth.current += 1
      setDropActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent) => {
      if (!hasFilePayload(event)) return
      consume(event)
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: globalThis.DragEvent) => {
      if (!hasFilePayload(event)) return
      consume(event)
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDropActive(false)
    }
    const onDrop = (event: globalThis.DragEvent) => {
      if (!hasFilePayload(event)) return
      consume(event)
      dragDepth.current = 0
      setDropActive(false)
      void importFiles(Array.from(event.dataTransfer?.files ?? []))
    }
    window.addEventListener('dragenter', onDragEnter, { capture: true })
    window.addEventListener('dragover', onDragOver, { capture: true })
    window.addEventListener('dragleave', onDragLeave, { capture: true })
    window.addEventListener('drop', onDrop, { capture: true })
    return () => {
      window.removeEventListener('dragenter', onDragEnter, { capture: true })
      window.removeEventListener('dragover', onDragOver, { capture: true })
      window.removeEventListener('dragleave', onDragLeave, { capture: true })
      window.removeEventListener('drop', onDrop, { capture: true })
      dragDepth.current = 0
    }
  }, [importFiles])

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    void importFiles(files)
  }

  const saveLabel = persistenceLabel(
    snapshot.persistence.status,
    snapshot.persistence.error,
    saveCount,
  )

  return (
    <main className="image-import-page">
      <header className="image-import-header">
        <div>
          <p className="demo-eyebrow">Business workflow example</p>
          <h1>Multi-image drop import</h1>
          <p>
            Drop image files anywhere on this page. Import starts at the active row and follows the current row order.
          </p>
        </div>
        <div className="image-import-actions">
          <label className="image-import-picker">
            <input
              accept="image/*"
              aria-label="Choose images to import"
              multiple
              onChange={handleFileInput}
              type="file"
            />
            Choose images
          </label>
          {status.kind === 'processing' ? (
            <button type="button" onClick={cancelImport}>Cancel import</button>
          ) : null}
        </div>
      </header>

      <section
        aria-live="polite"
        className="image-import-status"
        data-kind={status.kind}
        role={status.kind === 'error' ? 'alert' : 'status'}
      >
        <span className="image-import-status-dot" aria-hidden="true" />
        <span>{status.message}</span>
      </section>

      <div className="image-import-workspace">
        <section className="demo-grid-panel image-import-grid-panel">
          <DataGrid ariaLabel="Image import rows" binding={binding} />
        </section>
        <aside className="image-import-sidebar">
          <section className="image-import-card">
            <h2>Import policy</h2>
            <dl>
              <div><dt>Mapping</dt><dd>Image + filename</dd></div>
              <div><dt>Order</dt><dd>File picker order</dd></div>
              <div><dt>Capacity</dt><dd>{MAX_FILES} files, {formatBytes(MAX_FILE_BYTES)} each</dd></div>
              <div><dt>Save</dt><dd>{saveLabel}</dd></div>
            </dl>
            <button
              type="button"
              onClick={() => { store.failNextSave = true }}
            >
              Fail next save
            </button>
          </section>
          <section className="image-import-card image-import-note">
            <h2>Why this is a separate example</h2>
            <p>
              File-to-row allocation is a business policy, not image-cell behavior. A future multi-image cell can register a collection as one value and submit it through the same transaction API.
            </p>
          </section>
          <section className="json-panel image-import-json">
            <h2>Authoritative JSON</h2>
            <pre>{JSON.stringify(authoritative.rows, null, 2)}</pre>
          </section>
        </aside>
      </div>

      {dropActive ? (
        <div aria-hidden="true" className="image-import-drop-overlay">
          <div>
            <strong>Drop images to import</strong>
            <span>They will fill Image and Name in file order.</span>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function validateBatch(files: readonly File[]) {
  if (files.length === 0) return 'Choose at least one image file.'
  if (files.length > MAX_FILES) return `Choose no more than ${MAX_FILES} files at once.`
  const nonImage = files.find((file) => !file.type.startsWith('image/'))
  if (nonImage) return `“${nonImage.name}” is not an image file.`
  const oversized = files.find((file) => file.size > MAX_FILE_BYTES)
  if (oversized) return `“${oversized.name}” is larger than ${formatBytes(MAX_FILE_BYTES)}.`
  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  if (totalBytes > MAX_BATCH_BYTES) {
    return `The batch is larger than ${formatBytes(MAX_BATCH_BYTES)}.`
  }
  return null
}

function hasFilePayload(event: globalThis.DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function nameWithoutFinalExtension(fileName: string) {
  const lastDot = fileName.lastIndexOf('.')
  return lastDot > 0 ? fileName.slice(0, lastDot) : fileName
}

function readFileAsDataUrl(file: File, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      reader.onload = null
      reader.onerror = null
      reader.onabort = null
    }
    const abort = () => reader.abort()
    signal.addEventListener('abort', abort, { once: true })
    reader.onload = () => {
      const result = reader.result
      cleanup()
      if (typeof result === 'string') resolve(result)
      else reject(new Error(`“${file.name}” could not be read as an image.`))
    }
    reader.onerror = () => {
      const error = reader.error
      cleanup()
      reject(error ?? new Error(`“${file.name}” could not be read.`))
    }
    reader.onabort = () => {
      cleanup()
      reject(signal.reason)
    }
    reader.readAsDataURL(file)
  })
}

function isCurrentBatch(
  revision: number,
  batch: AbortController,
  revisionRef: Readonly<{ current: number }>,
  batchRef: Readonly<{ current: AbortController | null }>,
  mountedRef: Readonly<{ current: boolean }>,
) {
  return mountedRef.current &&
    revisionRef.current === revision &&
    batchRef.current === batch &&
    !batch.signal.aborted
}

function isOwnedBatch(
  revision: number,
  batch: AbortController,
  revisionRef: Readonly<{ current: number }>,
  batchRef: Readonly<{ current: AbortController | null }>,
  mountedRef: Readonly<{ current: boolean }>,
) {
  return mountedRef.current &&
    revisionRef.current === revision &&
    batchRef.current === batch
}

function captureTargetPlan(
  controller: typeof binding.controller,
): ImportTargetPlan {
  const snapshot = controller.getSnapshot()
  const activeRowKey = snapshot.interaction.activeCell?.rowKey
  const activeIndex = activeRowKey === undefined
    ? -1
    : snapshot.view.visibleRowKeys.indexOf(activeRowKey)
  return Object.freeze({
    sourceRevision: snapshot.source.revision,
    draftRevision: snapshot.draft.revision,
    viewRevision: snapshot.view.revision,
    visibleRowKeys: Object.freeze([...snapshot.view.visibleRowKeys]),
    startIndex: activeIndex >= 0 ? activeIndex : 0,
  })
}

function matchesTargetPlan(
  snapshot: ReturnType<typeof binding.controller.getSnapshot>,
  plan: ImportTargetPlan,
) {
  return snapshot.source.revision === plan.sourceRevision &&
    snapshot.draft.revision === plan.draftRevision &&
    snapshot.view.revision === plan.viewRevision &&
    snapshot.view.visibleRowKeys.length === plan.visibleRowKeys.length &&
    snapshot.view.visibleRowKeys.every((rowKey, index) => (
      rowKey === plan.visibleRowKeys[index]
    ))
}

function errorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The import was cancelled.'
  }
  return error instanceof Error ? error.message : 'The image files could not be read.'
}

function persistenceLabel(
  status: 'idle' | 'scheduled' | 'saving' | 'failed',
  error: string | null,
  saveCount: number,
) {
  if (status === 'scheduled') return 'Queued'
  if (status === 'saving') return 'Saving…'
  if (status === 'failed') return error ?? 'Save failed'
  return saveCount === 0 ? 'No imports saved yet' : `${saveCount} saved`
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function wait(ms: number) {
  return new Promise<void>((resolve) => { window.setTimeout(resolve, ms) })
}
