import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from 'react'
import {
  DataGrid,
  GridCommitError,
  createCellTypeRegistry,
  createDataGridBinding,
  createDateCellType,
  createImageCellType,
  createNumberCellType,
  createStringCellType,
  selectGridFullySelectedRows,
  selectGridNaturalRowOrder,
  selectGridRowDeleteAvailability,
  useGridSelector,
  type DataGridRowDropTarget,
  type DataGridRowDropZone,
  type DataGridRowHeaderActionContext,
  type GridCellTypeSchemaOf,
  type GridColumn,
  type GridControllerSnapshot,
  type GridDataSource,
  type GridDataSourceSnapshot,
  type GridImageColumnOptions,
  type GridIsoDateColumnOptions,
  type GridNumberColumnOptions,
  type GridReadyDataSourceSnapshot,
  type GridStringColumnOptions,
} from 'react-data-grid-ext'

type GridSide = 'left' | 'right'
type TransferMode = 'copy' | 'cut'
type CrossGridRow = {
  id: string
  image: string | null
  name: string
  quantity: number
  deliveryDate: string
  deleteProtected: boolean
}
type TransferRow = Readonly<Omit<CrossGridRow, 'id' | 'deleteProtected'>>
type CrossGridPayload = Readonly<{
  kind: 'cross-grid-rows'
  version: 2
  schema: typeof TRANSFER_SCHEMA
  transferId: string
  source: GridSide
  mode: TransferMode
  sourceDraftRevision: number
  sourceRowKeys: readonly string[]
  rows: readonly TransferRow[]
}>
type InternalTransferSession = Readonly<{
  transferId: string
  source: GridSide
  mode: TransferMode
  sourceDraftRevision: number
  sourceRowKeys: readonly string[]
  sourceDeleteBlocked: boolean
}>
type CrossGridStatus = Readonly<{
  kind: 'idle' | 'dragging' | 'success' | 'error'
  message: string
}>
type MoveDirection = 'up' | 'down'

const TRANSFER_MIME = 'application/x-react-data-grid-ext-rows+json'
const TRANSFER_SCHEMA = 'inventory-edit-row/v1'
const MAX_TRANSFER_ROWS = 50
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024
const MAX_TEXT_LENGTH = 200
const CUT_DELETE_BLOCKED_MESSAGE = 'One or more selected rows cannot be deleted. Use Copy or reorder them within the source grid.'

function createRegistry() {
  return createCellTypeRegistry<CrossGridRow>()
    .register('image', createImageCellType<CrossGridRow, string>({
      alt: (row) => row.name,
      label: (row) => row.image ? 'Replace image' : 'Add image',
      validate: (value) => typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, issue: { code: 'invalid-image-value', message: 'The image value must be a URL or data URL.' } },
      resolveSrc: (value) => value,
      upload: ({ file, signal }) => readFileAsDataUrl(file, signal),
      parseClipboard: (text) => text === '' || /^(data:image\/|https?:\/\/)/.test(text)
        ? { ok: true, value: text || null }
        : { ok: false, issue: { code: 'invalid-image-source', message: 'Paste an image URL or data URL.' } },
    }))
    .register('string', createStringCellType())
    .register('number', createNumberCellType())
    .register('date', createDateCellType({ storage: 'iso-date', emptyValue: '' }))
}

const leftRegistry = createRegistry()
type CrossGridSchema = GridCellTypeSchemaOf<typeof leftRegistry>
const rightRegistry = createRegistry()

class CrossGridStore {
  readonly listeners = new Set<() => void>()
  snapshot: GridDataSourceSnapshot<CrossGridRow>
  nextId: number
  saveCount = 0

  constructor(readonly prefix: GridSide, rows: readonly CrossGridRow[]) {
    this.snapshot = { rows, status: 'ready', version: 0, scope: { kind: 'complete' } }
    this.nextId = rows.length + 1
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  publish(next: GridDataSourceSnapshot<CrossGridRow>) {
    this.snapshot = next
    this.listeners.forEach((listener) => { listener() })
  }
}

function createFixture(
  id: GridSide,
  label: string,
  rows: readonly CrossGridRow[],
  registry: typeof leftRegistry,
) {
  const store = new CrossGridStore(id, rows)
  const imageColumn = {
    key: 'image', label: 'Image', type: 'image', layout: { basis: 112, min: 96 },
    getValue: (row) => row.image, setValue: (row, image) => ({ ...row, image }),
  } satisfies GridColumn<CrossGridRow, string | null, 'image', GridImageColumnOptions<CrossGridRow, string> | undefined>
  const nameColumn = {
    key: 'name', label: 'Name', type: 'string', layout: { basis: 220, min: 150, flex: 2 }, sortable: true, filterable: true, bulkEditable: true,
    getValue: (row) => row.name, setValue: (row, name) => ({ ...row, name }),
  } satisfies GridColumn<CrossGridRow, string, 'string', GridStringColumnOptions | undefined>
  const quantityColumn = {
    key: 'quantity', label: 'Quantity', type: 'number', typeOptions: { minimum: 0 }, layout: { basis: 118, min: 104, flex: 1 }, sortable: true, bulkEditable: true,
    getValue: (row) => row.quantity, setValue: (row, quantity) => ({ ...row, quantity }),
  } satisfies GridColumn<CrossGridRow, number, 'number', GridNumberColumnOptions | undefined>
  const deliveryDateColumn = {
    key: 'deliveryDate', label: 'Delivery', type: 'date', layout: { basis: 154, min: 138, flex: 1 }, sortable: true, bulkEditable: true,
    getValue: (row) => row.deliveryDate, setValue: (row, deliveryDate) => ({ ...row, deliveryDate }),
  } satisfies GridColumn<CrossGridRow, string, 'date', GridIsoDateColumnOptions | undefined>
  const columns = { image: imageColumn, name: nameColumn, quantity: quantityColumn, deliveryDate: deliveryDateColumn }
  const dataSource: GridDataSource<CrossGridRow, string, CrossGridSchema> = {
    columns: [imageColumn, nameColumn, quantityColumn, deliveryDateColumn],
    getRowKey: (row) => row.id,
    getSnapshot: () => store.snapshot,
    subscribe: store.subscribe,
    refresh: () => { store.publish(store.snapshot) },
    persistence: {
      mode: 'auto-save', debounceMs: 350,
      commit: async (request) => {
        await wait(160)
        if (!Object.is(request.sourceVersion, store.snapshot.version)) {
          throw new GridCommitError('source-version-conflict', `${label} changed before the draft could be saved.`)
        }
        store.saveCount += 1
        const next = {
          rows: request.rows, status: 'ready', version: Number(request.sourceVersion) + 1, scope: { kind: 'complete' },
        } satisfies GridReadyDataSourceSnapshot<CrossGridRow>
        store.publish(next)
        return { operationId: request.operationId, applied: next }
      },
    },
    rows: {
      create: () => ({ id: `${store.prefix}-row-${store.nextId++}`, image: null, name: '', quantity: 0, deliveryDate: '', deleteProtected: false }),
      duplicate: (row) => ({ ...row, id: `${store.prefix}-row-${store.nextId++}`, deleteProtected: false }),
      canDelete: (row) => !row.deleteProtected,
      ordering: 'mutable',
    },
  }
  const binding = createDataGridBinding({ dataSource, registry, rowIndicatorWidth: 72 })
  return Object.freeze({ id, label, store, dataSource, binding, columns })
}

const left = createFixture('left', 'Left workspace', [
  { id: 'left-row-1', image: null, name: 'Amber poster', quantity: 12, deliveryDate: '2026-09-02', deleteProtected: false },
  { id: 'left-row-2', image: null, name: 'Blue card', quantity: 4, deliveryDate: '2026-09-05', deleteProtected: false },
  { id: 'left-row-3', image: null, name: 'Cedar label', quantity: 28, deliveryDate: '2026-09-08', deleteProtected: true },
  { id: 'left-row-4', image: null, name: 'Dune notebook', quantity: 8, deliveryDate: '2026-09-11', deleteProtected: false },
], leftRegistry)
const right = createFixture('right', 'Right workspace', [
  { id: 'right-row-1', image: null, name: 'Fern calendar', quantity: 6, deliveryDate: '2026-09-12', deleteProtected: false },
  { id: 'right-row-2', image: null, name: 'Granite folio', quantity: 14, deliveryDate: '2026-09-15', deleteProtected: false },
  { id: 'right-row-3', image: null, name: 'Harbor postcard', quantity: 20, deliveryDate: '2026-09-18', deleteProtected: false },
], rightRegistry)

type CrossGridFixture = typeof left
type RowActionContext = DataGridRowHeaderActionContext<CrossGridRow, string, CrossGridSchema, never>

if (import.meta.hot) import.meta.hot.dispose(() => { left.binding.destroy(); right.binding.destroy() })

export function CrossGridDragPage() {
  const [status, setStatus] = useState<CrossGridStatus>({
    kind: 'idle', message: 'Select complete rows, then drag a row handle or use a transfer button.',
  })
  const [mode, setMode] = useState<TransferMode>('copy')
  const [dragActive, setDragActive] = useState(false)
  const internalTransfer = useRef<InternalTransferSession | null>(null)
  const blockedDropTarget = useRef<GridSide | null>(null)
  const dropTargets = useRef<Record<GridSide, DataGridRowDropTarget<string> | null>>({ left: null, right: null })

  useEffect(() => () => {
    internalTransfer.current = null
    blockedDropTarget.current = null
    dropTargets.current.left = null
    dropTargets.current.right = null
  }, [])

  const importRows = useCallback((
    payload: unknown,
    target: CrossGridFixture,
    beforeRowKey: string | null,
    trustedTransfer: InternalTransferSession | null,
  ) => {
    const issue = validatePayload(payload)
    if (issue) {
      setStatus({ kind: 'error', message: `${issue} No rows were transferred.` })
      return false
    }
    const accepted = payload as CrossGridPayload
    const trusted = trustedTransfer !== null && matchesTransfer(trustedTransfer, accepted)
    const source = trusted ? fixtureFor(trustedTransfer.source) : null
    const effectiveMode = trusted ? trustedTransfer.mode : 'copy'
    const sourceSnapshot = source?.binding.controller.getSnapshot() ?? null
    if (sourceSnapshot && sourceSnapshot.draft.revision !== accepted.sourceDraftRevision) {
      setStatus({ kind: 'error', message: 'The source changed after dragging started. Start the drag again.' })
      return false
    }
    const sourceBlocked = sourceSnapshot ? blockedSession(sourceSnapshot) : null
    const targetBlocked = blockedSession(target.binding.controller.getSnapshot())
    if (sourceBlocked || targetBlocked) {
      setStatus({ kind: 'error', message: `${sourceBlocked ?? targetBlocked} No rows were transferred.` })
      return false
    }
    if (sourceSnapshot
      && source !== target
      && effectiveMode === 'cut'
      && rowsCannotBeDeleted(sourceSnapshot, accepted.sourceRowKeys)) {
      setStatus({ kind: 'error', message: `${CUT_DELETE_BLOCKED_MESSAGE} No rows were transferred.` })
      return false
    }

    if (source === target && effectiveMode === 'cut') {
      const moved = target.binding.controller.applyTransaction((transaction) => {
        transaction.moveRows(accepted.sourceRowKeys, { beforeRowKey })
      }, { label: `Move ${accepted.rows.length} rows` })
      if (!moved.accepted) {
        setStatus({ kind: 'error', message: `${moved.issues[0]?.message ?? 'The rows could not be moved.'} No rows were transferred.` })
        return false
      }
      if (moved.result.movedRowKeys.length === 0) {
        setStatus({ kind: 'idle', message: 'The selected rows are already at this position.' })
        return true
      }
      setStatus({
        kind: 'success',
        message: `Moved ${accepted.rows.length} ${accepted.rows.length === 1 ? 'row' : 'rows'} within the ${sideLabel(target.id)} draft.`,
      })
      return true
    }

    const inserted = source === target
      ? duplicateRows(target, accepted, beforeRowKey)
      : insertRows(target, accepted, beforeRowKey, effectiveMode)
    if (!inserted.accepted) {
      setStatus({ kind: 'error', message: `${inserted.issues[0]?.message ?? 'The target rejected the rows.'} No rows were transferred.` })
      return false
    }
    if (effectiveMode === 'cut' && source && source !== target) {
      const deleted = source.binding.controller.applyTransaction((transaction) => {
        transaction.deleteRows(accepted.sourceRowKeys)
      }, { label: `Cut ${accepted.rows.length} rows to ${sideLabel(target.id)}` })
      if (!deleted.accepted) {
        const compensated = target.binding.controller.dispatch({ type: 'history/undo' })
        if (compensated.accepted) {
          setStatus({
            kind: 'error',
            message: `${deleted.issues[0]?.message ?? 'The source rows could not be removed.'} The target insertion was undone.`,
          })
        } else {
          setStatus({
            kind: 'error',
            message: 'Rows were copied to the target, but the source was not removed. Review both drafts before saving.',
          })
        }
        return false
      }
      setStatus({
        kind: 'success',
        message: `Cut ${accepted.rows.length} ${accepted.rows.length === 1 ? 'row' : 'rows'} to the ${sideLabel(target.id)} draft.`,
      })
      return true
    }
    setStatus({
      kind: 'success',
      message: `${trusted ? 'Copied' : 'Imported'} ${accepted.rows.length} ${accepted.rows.length === 1 ? 'row' : 'rows'} to the ${sideLabel(target.id)} draft.`,
    })
    return true
  }, [])

  const transferSelected = useCallback((source: CrossGridFixture, target: CrossGridFixture) => {
    const snapshot = source.binding.controller.getSnapshot()
    const blocked = blockedSession(snapshot)
    if (blocked) {
      setStatus({ kind: 'error', message: `${blocked} No rows were transferred.` })
      return
    }
    const selected = selectGridFullySelectedRows(snapshot)
    if (selected.rows.length === 0) {
      setStatus({ kind: 'error', message: `Select one or more complete rows in ${source.label} first.` })
      return
    }
    const sourceDeleteBlocked = rowsCannotBeDeleted(snapshot, selected.rowKeys)
    if (mode === 'cut' && sourceDeleteBlocked) {
      setStatus({ kind: 'error', message: `${CUT_DELETE_BLOCKED_MESSAGE} No rows were transferred.` })
      return
    }
    const transfer = createTransfer(source.id, mode, snapshot.draft.revision, selected.rowKeys, sourceDeleteBlocked)
    const encoded = encodePayload(transfer, selected.rows)
    if (!encoded.ok) {
      setStatus({ kind: 'error', message: `${encoded.message} No rows were transferred.` })
      return
    }
    importRows(encoded.payload, target, null, transfer)
  }, [importRows, mode])

  const moveSelected = useCallback((fixture: CrossGridFixture, direction: MoveDirection) => {
    const snapshot = fixture.binding.controller.getSnapshot()
    const blocked = blockedSession(snapshot)
    const selected = selectGridFullySelectedRows(snapshot)
    const natural = selectGridNaturalRowOrder(snapshot)
    if (blocked || !natural.eligible || selected.rowKeys.length === 0) {
      setStatus({ kind: 'error', message: `${blocked ?? 'Select one or more complete rows first.'} No rows were moved.` })
      return
    }
    const operations = rowMoveOperations(natural.rowKeys, selected.rowKeys, direction)
    if (operations.length === 0) return
    const moved = fixture.binding.controller.applyTransaction((transaction) => {
      for (const operation of operations) {
        transaction.moveRows(operation.rowKeys, { beforeRowKey: operation.beforeRowKey })
      }
    }, { label: `Move ${selected.rowKeys.length} rows ${direction}` })
    if (!moved.accepted) {
      setStatus({ kind: 'error', message: `${moved.issues[0]?.message ?? 'The selected rows could not be moved.'} No rows were moved.` })
      return
    }
    setStatus({
      kind: 'success',
      message: `Moved ${selected.rowKeys.length} ${selected.rowKeys.length === 1 ? 'row' : 'rows'} ${direction} in the ${sideLabel(fixture.id)} draft.`,
    })
  }, [])

  const startDrag = useCallback((source: CrossGridFixture, context: RowActionContext, event: DragEvent<HTMLButtonElement>) => {
    const snapshot = source.binding.controller.getSnapshot()
    const blocked = blockedSession(snapshot)
    if (blocked) {
      event.preventDefault()
      setStatus({ kind: 'error', message: `${blocked} Dragging did not start.` })
      return
    }
    const fullySelected = selectGridFullySelectedRows(snapshot)
    const partOfSelection = fullySelected.rowKeys.includes(context.rowKey)
    const rows = partOfSelection ? fullySelected.rows : [context.row]
    if (!partOfSelection) {
      const selected = context.selectRow()
      if (!selected.accepted) {
        event.preventDefault()
        setStatus({ kind: 'error', message: `${selected.reason ?? 'This row could not be selected.'} Dragging did not start.` })
        return
      }
    }
    const rowKeys = partOfSelection ? fullySelected.rowKeys : [context.rowKey]
    const sourceRevision = partOfSelection
      ? snapshot.draft.revision
      : source.binding.controller.getSnapshot().draft.revision
    const sourceDeleteBlocked = partOfSelection
      ? rowsCannotBeDeleted(snapshot, rowKeys)
      : context.deleteAvailability !== 'allowed'
    const transfer = createTransfer(source.id, mode, sourceRevision, rowKeys, sourceDeleteBlocked)
    const encoded = encodePayload(transfer, rows)
    if (!encoded.ok) {
      event.preventDefault()
      setStatus({ kind: 'error', message: `${encoded.message} Dragging did not start.` })
      return
    }
    if (!writeTransfer(event.dataTransfer, encoded.serialized, encoded.payload.rows)) {
      event.preventDefault()
      setStatus({ kind: 'error', message: 'The browser could not start this row drag.' })
      return
    }
    internalTransfer.current = transfer
    blockedDropTarget.current = null
    setDragActive(true)
    try { event.dataTransfer.effectAllowed = mode === 'cut' ? 'copyMove' : 'copy' } catch { /* Browser owns this hint. */ }
    setCompactDragImage(event.dataTransfer, mode, encoded.payload.rows)
    setStatus({ kind: 'dragging', message: `${mode === 'copy' ? 'Copying' : 'Cutting'} ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} from ${source.label}.` })
  }, [mode])

  const endDrag = useCallback(() => {
    internalTransfer.current = null
    blockedDropTarget.current = null
    dropTargets.current.left = null
    dropTargets.current.right = null
    setDragActive(false)
    setStatus((current) => current.kind === 'dragging'
      ? { kind: 'idle', message: 'Row drag cancelled.' }
      : current)
  }, [])

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!hasTransferType(event.dataTransfer)) return
    event.preventDefault()
    setDragActive(true)
  }
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasTransferType(event.dataTransfer)) return
    event.preventDefault()
    const trusted = internalTransfer.current
    const target = event.target instanceof Element ? event.target : null
    const targetPanel = target?.closest<HTMLElement>('[data-cross-grid-target]')
    const targetSide = targetPanel?.dataset.crossGridTarget
    const deleteBlocked = (targetSide === 'left' || targetSide === 'right')
      && crossGridCutDeleteBlocked(trusted, targetSide)
    const available = (targetSide === 'left' || targetSide === 'right')
      && dropTargets.current[targetSide] !== null
      && blockedSession(fixtureFor(targetSide).binding.controller.getSnapshot()) === null
      && !deleteBlocked
    if (deleteBlocked && blockedDropTarget.current !== targetSide) {
      blockedDropTarget.current = targetSide
      setStatus({ kind: 'error', message: `${CUT_DELETE_BLOCKED_MESSAGE} No rows were transferred.` })
    } else if (!deleteBlocked && blockedDropTarget.current !== null) {
      blockedDropTarget.current = null
      if (trusted) {
        setStatus({
          kind: 'dragging',
          message: `${trusted.mode === 'copy' ? 'Copying' : 'Cutting'} ${trusted.sourceRowKeys.length} ${trusted.sourceRowKeys.length === 1 ? 'row' : 'rows'} from ${fixtureFor(trusted.source).label}.`,
        })
      }
    }
    try {
      event.dataTransfer.dropEffect = available
        ? trusted?.mode === 'cut' ? 'move' : 'copy'
        : 'none'
    } catch { /* Browser owns this hint. */ }
  }
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!hasTransferType(event.dataTransfer)) return
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom) return
    dropTargets.current.left = null
    dropTargets.current.right = null
    blockedDropTarget.current = null
    setDragActive(false)
  }
  const handleDrop = (target: CrossGridFixture, event: DragEvent<HTMLElement>) => {
    if (!hasTransferType(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const insertion = dropTargets.current[target.id]
    const trusted = internalTransfer.current
    internalTransfer.current = null
    blockedDropTarget.current = null
    dropTargets.current.left = null
    dropTargets.current.right = null
    setDragActive(false)
    if (!insertion) {
      const blocked = blockedSession(target.binding.controller.getSnapshot())
      setStatus({
        kind: 'error',
        message: `${crossGridCutDeleteBlocked(trusted, target.id)
          ? CUT_DELETE_BLOCKED_MESSAGE
          : blocked ?? 'Drop rows between rows in a grid.'} No rows were transferred.`,
      })
      return
    }
    const decoded = decodePayload(event.dataTransfer)
    if (!decoded.ok) {
      setStatus({ kind: 'error', message: `${decoded.message} No rows were transferred.` })
      return
    }
    importRows(decoded.payload, target, insertion.placement.beforeRowKey, trusted)
  }

  const updateDropTarget = useCallback((side: GridSide, target: DataGridRowDropTarget<string> | null) => {
    dropTargets.current[side] = target
  }, [])

  return (
    <main
      className="cross-grid-page"
      onDragEnterCapture={handleDragEnter}
      onDragLeaveCapture={handleDragLeave}
      onDragOver={handleDragOver}
    >
      <header className="cross-grid-header">
        <div>
          <p className="demo-eyebrow">Business workflow example</p>
          <h1>Cross-grid row transfer</h1>
          <p>Place copied or cut rows exactly where they belong. Each grid keeps an independent draft and save lifecycle.</p>
          <p className="cross-grid-coordinator-note">This demo coordinates local drafts. Production Cut across data sources needs a backend transaction or outbox.</p>
        </div>
        <div aria-label="Transfer mode" className="cross-grid-mode-switch" role="group">
          <button aria-pressed={mode === 'copy'} onClick={() => { setMode('copy') }} type="button">Copy</button>
          <button aria-pressed={mode === 'cut'} onClick={() => { setMode('cut') }} type="button">Cut</button>
        </div>
      </header>
      <section aria-atomic="true" aria-live="polite" className="cross-grid-status" data-kind={status.kind} role="status">
        <span aria-hidden="true" />{status.message}
      </section>
      <div className="cross-grid-workspace">
        <CrossGridPanel
          dragActive={dragActive}
          dropBlocked={crossGridCutDeleteBlocked(internalTransfer.current, 'left')}
          fixture={left}
          mode={mode}
          onDragEnd={endDrag}
          onDragStart={startDrag}
          onDrop={(event) => { handleDrop(left, event) }}
          onDropTargetChange={(target) => { updateDropTarget('left', target) }}
          onMove={(direction) => { moveSelected(left, direction) }}
          onTransfer={() => { transferSelected(left, right) }}
          targetFixture={right}
          targetLabel="Right"
        />
        <CrossGridPanel
          dragActive={dragActive}
          dropBlocked={crossGridCutDeleteBlocked(internalTransfer.current, 'right')}
          fixture={right}
          mode={mode}
          onDragEnd={endDrag}
          onDragStart={startDrag}
          onDrop={(event) => { handleDrop(right, event) }}
          onDropTargetChange={(target) => { updateDropTarget('right', target) }}
          onMove={(direction) => { moveSelected(right, direction) }}
          onTransfer={() => { transferSelected(right, left) }}
          targetFixture={left}
          targetLabel="Left"
        />
      </div>
    </main>
  )
}

function CrossGridPanel({
  dragActive,
  dropBlocked,
  fixture,
  mode,
  onDragEnd,
  onDragStart,
  onDrop,
  onDropTargetChange,
  onMove,
  onTransfer,
  targetFixture,
  targetLabel,
}: Readonly<{
  dragActive: boolean
  dropBlocked: boolean
  fixture: CrossGridFixture
  mode: TransferMode
  onDragEnd: () => void
  onDragStart: (fixture: CrossGridFixture, context: RowActionContext, event: DragEvent<HTMLButtonElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onDropTargetChange: (target: DataGridRowDropTarget<string> | null) => void
  onMove: (direction: MoveDirection) => void
  onTransfer: () => void
  targetFixture: CrossGridFixture
  targetLabel: string
}>) {
  const panel = useGridSelector(fixture.binding.controller, selectCrossGridPanel, equalCrossGridPanel)
  const targetBlocked = useGridSelector(targetFixture.binding.controller, blockedSession)
  const saveCount = useSyncExternalStore(fixture.store.subscribe, () => fixture.store.saveCount, () => fixture.store.saveCount)
  const movement = rowMovementAvailability(panel.naturalRowKeys, panel.selectedRowKeys)
  const rowDropZone = useMemo<DataGridRowDropZone<string>>(() => ({
    active: dragActive && panel.blocked === null && !dropBlocked,
    onTargetChange: onDropTargetChange,
  }), [dragActive, dropBlocked, onDropTargetChange, panel.blocked])
  const rowHeaderActions = useCallback((context: RowActionContext) => (
    <button
      aria-label={`Select or drag ${context.rowLabel} from ${fixture.label}`}
      className="cross-grid-drag-handle"
      draggable
      onClick={() => {
        const selectedRow = context.selectRow()
        if (!selectedRow.accepted) return
      }}
      onDragEnd={onDragEnd}
      onDragStart={(event) => { onDragStart(fixture, context, event) }}
      title={mode === 'cut' && context.deleteAvailability !== 'allowed'
        ? `${context.rowLabel} can be reordered here but cannot be cut to the other grid.`
        : `${mode === 'copy' ? 'Copy' : 'Cut'} ${context.rowLabel} or the selected rows`}
      type="button"
    ><span aria-hidden="true">⠿</span></button>
  ), [fixture, mode, onDragEnd, onDragStart])
  const transferBlocked = panel.selectedRowKeys.length === 0
    || panel.blocked !== null
    || targetBlocked !== null
    || (mode === 'cut' && panel.selectedDeleteBlocked)
  const transferTitle = panel.blocked
    ?? targetBlocked
    ?? (mode === 'cut' && panel.selectedDeleteBlocked ? CUT_DELETE_BLOCKED_MESSAGE : null)
    ?? (panel.selectedRowKeys.length === 0 ? 'Select complete rows first.' : undefined)
  const toolbarActions = useCallback(() => <span className="cross-grid-toolbar-actions">
    <button
      aria-label={`Move selected rows up in ${fixture.label}`}
      className="business-grid__icon-button"
      disabled={panel.blocked !== null || !movement.up}
      onClick={() => { onMove('up') }}
      title={panel.blocked ?? (movement.up ? 'Move selected rows up' : 'The selected rows cannot move farther up.')}
      type="button"
    >↑</button>
    <button
      aria-label={`Move selected rows down in ${fixture.label}`}
      className="business-grid__icon-button"
      disabled={panel.blocked !== null || !movement.down}
      onClick={() => { onMove('down') }}
      title={panel.blocked ?? (movement.down ? 'Move selected rows down' : 'The selected rows cannot move farther down.')}
      type="button"
    >↓</button>
    <button
      aria-label={`${mode === 'copy' ? 'Copy' : 'Cut'} selected rows to ${targetLabel}`}
      className="business-grid__button"
      disabled={transferBlocked}
      onClick={onTransfer}
      title={transferTitle}
      type="button"
    >{mode === 'copy' ? 'Copy' : 'Cut'} → {targetLabel}</button>
  </span>, [
    fixture.label,
    mode,
    movement.down,
    movement.up,
    onMove,
    onTransfer,
    panel.blocked,
    targetLabel,
    transferBlocked,
    transferTitle,
  ])
  return (
    <section className="cross-grid-panel" data-cross-grid-target={fixture.id} onDropCapture={onDrop}>
      <header>
        <div><h2>{fixture.label}</h2><span>{panel.selectedRowKeys.length} complete {panel.selectedRowKeys.length === 1 ? 'row' : 'rows'} selected</span></div>
        <div className="cross-grid-panel-actions">
          <span>{saveState(panel.persistenceStatus, panel.persistenceError, saveCount)}</span>
        </div>
      </header>
      <div className="cross-grid-grid-panel">
        <DataGrid
          ariaLabel={`${fixture.label} rows`}
          binding={fixture.binding}
          rowDropZone={rowDropZone}
          rowHeaderActions={rowHeaderActions}
          toolbarActions={toolbarActions}
        />
      </div>
    </section>
  )
}

function insertRows(
  target: CrossGridFixture,
  payload: CrossGridPayload,
  beforeRowKey: string | null,
  mode: TransferMode,
) {
  return target.binding.controller.applyTransaction((transaction) => {
    for (const row of payload.rows) {
      const rowKey = transaction.createRow({ beforeRowKey })
      transaction.set(target.columns.image, rowKey, row.image)
      transaction.set(target.columns.name, rowKey, row.name)
      transaction.set(target.columns.quantity, rowKey, row.quantity)
      transaction.set(target.columns.deliveryDate, rowKey, row.deliveryDate)
    }
  }, {
    label: `${mode === 'copy' ? 'Copy' : 'Cut'} ${payload.rows.length} rows from ${sideLabel(payload.source)}`,
  })
}

function duplicateRows(target: CrossGridFixture, payload: CrossGridPayload, beforeRowKey: string | null) {
  return target.binding.controller.applyTransaction((transaction) => {
    for (const sourceRowKey of payload.sourceRowKeys) {
      transaction.duplicateRow(sourceRowKey, { beforeRowKey })
    }
  }, { label: `Copy ${payload.rows.length} rows within ${sideLabel(target.id)}` })
}

function selectCrossGridPanel(snapshot: GridControllerSnapshot<CrossGridRow, string>) {
  const selected = selectGridFullySelectedRows(snapshot)
  const natural = selectGridNaturalRowOrder(snapshot)
  return Object.freeze({
    selectedRowKeys: selected.rowKeys,
    selectedDeleteBlocked: rowsCannotBeDeleted(snapshot, selected.rowKeys),
    naturalRowKeys: natural.rowKeys,
    blocked: blockedSession(snapshot),
    persistenceStatus: snapshot.persistence.status,
    persistenceError: snapshot.persistence.error,
  })
}

function equalCrossGridPanel(
  leftPanel: ReturnType<typeof selectCrossGridPanel>,
  rightPanel: ReturnType<typeof selectCrossGridPanel>,
) {
  return leftPanel.blocked === rightPanel.blocked
    && leftPanel.persistenceStatus === rightPanel.persistenceStatus
    && leftPanel.persistenceError === rightPanel.persistenceError
    && leftPanel.selectedDeleteBlocked === rightPanel.selectedDeleteBlocked
    && sameStrings(leftPanel.selectedRowKeys, rightPanel.selectedRowKeys)
    && sameStrings(leftPanel.naturalRowKeys, rightPanel.naturalRowKeys)
}

function rowMovementAvailability(order: readonly string[], selectedRowKeys: readonly string[]) {
  if (order.length === 0 || selectedRowKeys.length === 0) return { up: false, down: false }
  const selected = new Set(selectedRowKeys)
  return {
    up: order.some((rowKey, index) => selected.has(rowKey) && index > 0 && !selected.has(order[index - 1]!)),
    down: order.some((rowKey, index) => selected.has(rowKey) && index < order.length - 1 && !selected.has(order[index + 1]!)),
  }
}

function rowMoveOperations(
  order: readonly string[],
  selectedRowKeys: readonly string[],
  direction: MoveDirection,
) {
  const selected = new Set(selectedRowKeys)
  const blocks: Array<{ start: number; end: number; rowKeys: string[] }> = []
  for (let index = 0; index < order.length; index += 1) {
    if (!selected.has(order[index]!)) continue
    const previous = blocks.at(-1)
    if (previous && previous.end === index - 1) {
      previous.end = index
      previous.rowKeys.push(order[index]!)
    } else {
      blocks.push({ start: index, end: index, rowKeys: [order[index]!] })
    }
  }
  return blocks.flatMap((block) => {
    if (direction === 'up') {
      return block.start === 0
        ? []
        : [{ rowKeys: block.rowKeys, beforeRowKey: order[block.start - 1]! }]
    }
    return block.end === order.length - 1
      ? []
      : [{ rowKeys: block.rowKeys, beforeRowKey: order[block.end + 2] ?? null }]
  })
}

function sameStrings(leftStrings: readonly string[], rightStrings: readonly string[]) {
  return leftStrings.length === rightStrings.length
    && leftStrings.every((value, index) => value === rightStrings[index])
}

function createTransfer(
  source: GridSide,
  mode: TransferMode,
  sourceDraftRevision: number,
  sourceRowKeys: readonly string[],
  sourceDeleteBlocked: boolean,
): InternalTransferSession {
  return Object.freeze({
    transferId: typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    source,
    mode,
    sourceDraftRevision,
    sourceRowKeys: Object.freeze([...sourceRowKeys]),
    sourceDeleteBlocked,
  })
}

function encodePayload(transfer: InternalTransferSession, rows: readonly CrossGridRow[]) {
  const payload: CrossGridPayload = Object.freeze({
    kind: 'cross-grid-rows',
    version: 2,
    schema: TRANSFER_SCHEMA,
    transferId: transfer.transferId,
    source: transfer.source,
    mode: transfer.mode,
    sourceDraftRevision: transfer.sourceDraftRevision,
    sourceRowKeys: transfer.sourceRowKeys,
    rows: Object.freeze(rows.map((row) => Object.freeze({
      image: row.image, name: row.name, quantity: row.quantity, deliveryDate: row.deliveryDate,
    }))),
  })
  const issue = validatePayload(payload)
  if (issue) return { ok: false as const, message: issue }
  const serialized = JSON.stringify(payload)
  if (byteLength(serialized) > MAX_TRANSFER_BYTES) {
    return { ok: false as const, message: `The selected rows exceed the ${formatBytes(MAX_TRANSFER_BYTES)} transfer limit.` }
  }
  return { ok: true as const, payload, serialized }
}

function decodePayload(dataTransfer: DataTransfer) {
  if (!hasTransferType(dataTransfer)) return { ok: false as const, message: 'This drag does not contain compatible grid rows.' }
  let serialized = ''
  try {
    serialized = dataTransfer.getData(TRANSFER_MIME)
  } catch {
    return { ok: false as const, message: 'The browser did not provide the row transfer.' }
  }
  if (serialized === '') return { ok: false as const, message: 'The row transfer is empty.' }
  if (byteLength(serialized) > MAX_TRANSFER_BYTES) return { ok: false as const, message: `The row transfer exceeds the ${formatBytes(MAX_TRANSFER_BYTES)} limit.` }
  try {
    const payload: unknown = JSON.parse(serialized)
    const issue = validatePayload(payload)
    return issue ? { ok: false as const, message: issue } : { ok: true as const, payload: payload as CrossGridPayload }
  } catch {
    return { ok: false as const, message: 'The row transfer is not valid JSON.' }
  }
}

function validatePayload(payload: unknown) {
  if (!isRecord(payload) || payload.kind !== 'cross-grid-rows') return 'This drag does not contain compatible grid rows.'
  if (payload.version !== 2) return 'This row-transfer version is not supported.'
  if (payload.schema !== TRANSFER_SCHEMA) return 'These rows use a different grid schema.'
  if (typeof payload.transferId !== 'string' || payload.transferId === '' || payload.transferId.length > 200) {
    return 'The row-transfer identifier is invalid.'
  }
  if (payload.source !== 'left' && payload.source !== 'right') return 'The row-transfer source is invalid.'
  if (payload.mode !== 'copy' && payload.mode !== 'cut') return 'The row-transfer mode is invalid.'
  if (typeof payload.sourceDraftRevision !== 'number'
    || !Number.isSafeInteger(payload.sourceDraftRevision)
    || payload.sourceDraftRevision < 0) {
    return 'The source draft revision is invalid.'
  }
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) return 'The row transfer does not contain any rows.'
  if (payload.rows.length > MAX_TRANSFER_ROWS) return `Transfer no more than ${MAX_TRANSFER_ROWS} rows at once.`
  if (!Array.isArray(payload.sourceRowKeys) || payload.sourceRowKeys.length !== payload.rows.length) {
    return 'The source row keys do not match the transferred rows.'
  }
  const sourceKeys = new Set<string>()
  for (const rowKey of payload.sourceRowKeys) {
    if (typeof rowKey !== 'string' || rowKey === '' || sourceKeys.has(rowKey)) {
      return 'The source row keys are invalid.'
    }
    sourceKeys.add(rowKey)
  }
  for (const row of payload.rows) {
    if (!isRecord(row)) return 'A transferred row has an invalid shape.'
    if (row.image !== null && (typeof row.image !== 'string' || !/^(data:image\/|https?:\/\/)/.test(row.image))) return 'A transferred image must be an image URL, data URL, or empty.'
    if (typeof row.name !== 'string' || row.name.length > MAX_TEXT_LENGTH) return `A transferred name must be text no longer than ${MAX_TEXT_LENGTH} characters.`
    if (typeof row.quantity !== 'number' || !Number.isFinite(row.quantity)) return 'A transferred quantity must be a finite number.'
    if (typeof row.deliveryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.deliveryDate)) return 'A transferred delivery date must use YYYY-MM-DD format.'
  }
  return null
}

function blockedSession(snapshot: GridControllerSnapshot<CrossGridRow, string>) {
  if (snapshot.edit) return 'Finish or cancel the active cell edit first.'
  if (snapshot.bulk) return 'Finish or cancel the bulk edit first.'
  if (snapshot.filterSession) return 'Apply or cancel the open filter first.'
  if (!selectGridNaturalRowOrder(snapshot).eligible) return 'Clear sorting and filters before positioning rows.'
  return null
}
function rowsCannotBeDeleted(
  snapshot: GridControllerSnapshot<CrossGridRow, string>,
  rowKeys: readonly string[],
) {
  return rowKeys.some((rowKey) => selectGridRowDeleteAvailability(snapshot, rowKey) !== 'allowed')
}
function crossGridCutDeleteBlocked(
  session: InternalTransferSession | null,
  target: GridSide,
) {
  return session !== null
    && session.mode === 'cut'
    && session.source !== target
    && session.sourceDeleteBlocked
}
function hasTransferType(dataTransfer: DataTransfer) {
  try { return [...dataTransfer.types].includes(TRANSFER_MIME) } catch { return false }
}
function fixtureFor(side: GridSide) { return side === 'left' ? left : right }
function sideLabel(side: GridSide) { return side === 'left' ? 'Left' : 'Right' }
function matchesTransfer(session: InternalTransferSession, payload: CrossGridPayload) {
  return session.transferId === payload.transferId
    && session.source === payload.source
    && session.mode === payload.mode
    && session.sourceDraftRevision === payload.sourceDraftRevision
    && session.sourceRowKeys.length === payload.sourceRowKeys.length
    && session.sourceRowKeys.every((rowKey, index) => rowKey === payload.sourceRowKeys[index])
}
function textFallback(rows: readonly TransferRow[]) {
  return rows.map((row) => [row.name, String(row.quantity), row.deliveryDate, row.image ?? ''].join('\t')).join('\n')
}
function writeTransfer(dataTransfer: DataTransfer, serialized: string, rows: readonly TransferRow[]) {
  try {
    dataTransfer.setData(TRANSFER_MIME, serialized)
    dataTransfer.setData('text/plain', textFallback(rows))
    return true
  } catch {
    return false
  }
}
function setCompactDragImage(
  dataTransfer: DataTransfer,
  mode: TransferMode,
  rows: readonly TransferRow[],
) {
  const image = document.createElement('div')
  image.className = 'cross-grid-drag-image'
  image.setAttribute('aria-hidden', 'true')
  const heading = document.createElement('div')
  heading.className = 'cross-grid-drag-image__heading'
  heading.textContent = `${mode === 'copy' ? 'Copy' : 'Cut'} ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`
  const first = rows[0]
  const data = document.createElement('div')
  data.className = 'cross-grid-drag-image__data'
  for (const value of [first?.name ?? '', first ? String(first.quantity) : '', first?.deliveryDate ?? '']) {
    const cell = document.createElement('span')
    cell.textContent = value
    data.append(cell)
  }
  image.append(heading, data)
  if (rows.length > 1) {
    const more = document.createElement('span')
    more.className = 'cross-grid-drag-image__more'
    more.textContent = `+${rows.length - 1}`
    image.append(more)
  }
  document.body.append(image)
  try { dataTransfer.setDragImage(image, 18, 18) } catch { /* Native fallback remains usable. */ }
  requestAnimationFrame(() => { image.remove() })
}
function saveState(status: 'idle' | 'scheduled' | 'saving' | 'failed', error: string | null, saveCount: number) {
  if (status === 'scheduled') return 'Save queued'
  if (status === 'saving') return 'Saving…'
  if (status === 'failed') return error ?? 'Save failed'
  return saveCount === 0 ? 'No transfers saved' : `${saveCount} saved`
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function byteLength(value: string) { return new TextEncoder().encode(value).byteLength }
function formatBytes(bytes: number) { return `${Math.round(bytes / (1024 * 1024))} MB` }
function wait(ms: number) { return new Promise<void>((resolve) => { window.setTimeout(resolve, ms) }) }
function readFileAsDataUrl(file: File, signal: AbortSignal) {
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
