import { WorkspaceOpenError } from './workspace-open-error.js'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { DataGrid, Workspace, createIsoDateCodec, createNumberCodec, createStringCodec, defineKernelSchema, kernelId, openIndexedDbRecovery, useWorkspaceSnapshot,
  type EntityId, type WorkspaceGridColumn, type WorkspaceGridEditor, type WorkspaceTextCodec } from 'data-editor-table'
import { openDemoSource, type DemoSource } from './demo-source.js'
import { openImageTask } from './image-task.js'
import { captureTransfer, transferMime, transferRows, type Side } from './partition-transfer.js'

const imageCodec: WorkspaceTextCodec = {
  format: value => value.kind === 'missing' || value.value === null ? '' : String(value.value),
  parse: text => !text || /^(data:image\/|https?:\/\/)/.test(text) ? { kind: 'valid', value: { kind: 'value', value: text || null } } : { kind: 'invalid', message: 'Enter an image URL.' },
}
const editors: readonly WorkspaceGridEditor[] = [
  { fieldId: kernelId<'field'>('image'), label: 'Image', codec: imageCodec, clearInput: '' },
  { fieldId: kernelId<'field'>('name'), label: 'Name', codec: createStringCodec({ invalid: 'Enter a name.' }), clearInput: '' },
  { fieldId: kernelId<'field'>('quantity'), label: 'Quantity', codec: createNumberCodec({ invalid: 'Enter a non-negative number.', minimum: 0 }) },
  { fieldId: kernelId<'field'>('deliveryDate'), label: 'Delivery', codec: createIsoDateCodec({ invalid: 'Enter a valid date.', allowEmpty: true }), clearInput: '' },
]
const schema = defineKernelSchema({ version: kernelId<'schema-version'>('partitioned-inventory-v1'), codec: kernelId<'codec-version'>('json-v1'),
  fields: [...editors.map(editor => ({ id: editor.fieldId, path: [editor.fieldId] as const, readonly: false })), { id: kernelId<'field'>('side'), path: ['side'], readonly: false }],
  validate: document => {
    if (!['left', 'right'].includes(String(document.side)) || !['left', 'right'].includes(String(document.homeSide)) || typeof document.deleteProtected !== 'boolean'
      || document.deleteProtected && document.side !== document.homeSide) return [{ code: 'protected-membership', message: 'Protected rows must remain in their home list.' }]
    try { for (const editor of editors) if (editor.codec.parse(editor.codec.format({ kind: 'value', value: document[editor.fieldId] ?? null })).kind !== 'valid') throw new Error() }
    catch { return [{ code: 'invalid-row', message: 'Check the transferred row values.' }] }
    return []
  },
})
const initial = [
  { id: 'left-row-1', name: 'Amber poster', quantity: 12, deliveryDate: '2026-09-02', deleteProtected: false, side: 'left' },
  { id: 'left-row-2', name: 'Blue card', quantity: 4, deliveryDate: '2026-09-05', deleteProtected: false, side: 'left' },
  { id: 'left-row-3', name: 'Cedar label', quantity: 28, deliveryDate: '2026-09-08', deleteProtected: true, side: 'left' },
  { id: 'left-row-4', name: 'Dune notebook', quantity: 8, deliveryDate: '2026-09-11', deleteProtected: false, side: 'left' },
  { id: 'right-row-1', name: 'Fern calendar', quantity: 6, deliveryDate: '2026-09-12', deleteProtected: false, side: 'right' },
  { id: 'right-row-2', name: 'Granite folio', quantity: 14, deliveryDate: '2026-09-15', deleteProtected: false, side: 'right' },
  { id: 'right-row-3', name: 'Harbor postcard', quantity: 20, deliveryDate: '2026-09-18', deleteProtected: false, side: 'right' },
].map(row => ({ ...row, image: null, homeSide: row.side }))
type Owner = { workspace: Workspace; source: DemoSource; editors: readonly WorkspaceGridEditor[] }
let opening: Promise<Owner> | null = null
function openLists() {
  opening ??= (async () => {
    const scope = { sourceId: 'partitioned-inventory-v1', id: kernelId<'scope'>('lists'), epoch: kernelId<'scope-epoch'>('v1') }
    const source = await openDemoSource(scope, initial, document => { if (schema.validate(document, { entityId: kernelId<'entity'>('validation'), mutation: 'update' }).length) throw new Error('Invalid inventory row') }, true)
    const imageTask = await openImageTask('partitioned-image-tasks-v1')
    const session = await openIndexedDbRecovery({ databaseName: 'partitioned-workspace-v1', workspace: { id: kernelId<'workspace'>('partitioned-inventory'), scope, schema: schema.version, codec: schema.codec } })
    let workspace: Workspace
    try { workspace = await Workspace.openDurable({ scope, schema, source, session, restore: (await session.load()) !== null, tasks: [imageTask], recovery: 'manual',
      policy: { version: kernelId<'policy-version'>('v1'), create: true, order: true, defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [] } }) }
    catch (error) { await session.release(); throw error }
    await workspace.refresh()
    return { workspace, source, editors: editors.map(editor => editor.fieldId === 'image' ? { ...editor, resourceTask: { kind: 'durable' as const, definition: imageTask.ref, accept: 'image/*', pickOnEdit: true, applyOnUpload: true } } : editor) }
  })().catch(error => { opening = null; throw error })
  return opening
}
const columnLayouts: Record<string, Pick<WorkspaceGridColumn, 'width' | 'minWidth' | 'flex'>> = {
  image: { width: 112, minWidth: 96 },
  name: { width: 220, minWidth: 150, flex: 2 },
  quantity: { width: 118, minWidth: 104, flex: 1 },
  deliveryDate: { width: 154, minWidth: 138, flex: 1 },
}
const columns: readonly WorkspaceGridColumn[] = editors.map(editor => ({ id: editor.fieldId, fieldId: editor.fieldId, header: editor.label, label: editor.label, sortable: true,
  ...columnLayouts[editor.fieldId],
  ...(editor.fieldId === 'quantity' ? { align: 'end' as const } : {}),
  render: ({ document, value }) => editor.fieldId === 'image' ? <div className="data-grid-image-cell">{value.kind === 'value' && typeof value.value === 'string' && value.value
    ? <img src={value.value} alt={String(document.name)} draggable={false} /> : <span>No image</span>}</div> : editor.codec.format(value),
}))
export function CrossGridDragPage() {
  const [owner, setOwner] = useState<Owner | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => { let active = true; void openLists().then(owner => { if (active) setOwner(owner) }, () => { if (active) setFailed(true) }); return () => { active = false } }, [attempt])
  if (!owner) return <main>{failed ? <WorkspaceOpenError databaseName="partitioned-workspace-v1" message="Could not open the lists. Stored work is retained." retryLabel="Retry opening lists" retry={() => { setFailed(false); setAttempt(value => value + 1) }} /> : <p role="status">Opening lists…</p>}</main>
  return <Lists owner={owner} />
}
function Lists({ owner }: { owner: Owner }) {
  const { workspace } = owner, snapshot = useWorkspaceSnapshot(workspace)
  const [mode, setMode] = useState<'copy' | 'move'>('copy'), [selected, setSelected] = useState<readonly EntityId[]>([])
  const [target, setTarget] = useState<Side>('right'), [before, setBefore] = useState<EntityId | null>(null), [error, setError] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)
  const unavailable = snapshot.capabilities.close.lifecycle !== 'open' || snapshot.ingress.pending.length > 0 || snapshot.recovery.running
    || snapshot.storage !== null && snapshot.storage.kind !== 'idle' || snapshot.state.authority.content.kind !== 'complete'
  const rows = (['left', 'right'] as const).flatMap(side => workspace.getView(kernelId<'view'>(side)).rows.filter(row => row.preview!.side === side)), byId = new Map(rows.map(row => [row.entityId, row]))
  const active = selected.filter(id => byId.has(id)), source = active[0] ? byId.get(active[0])!.preview!.side as Side : null
  const mixed = active.some(id => byId.get(id)!.preview!.side !== source)
  const protectedMove = mode === 'move' && target !== source && active.some(id => byId.get(id)!.preview!.deleteProtected === true)
  async function apply(text: string, side: Side, position: EntityId | null, trusted: boolean) {
    setError(null)
    try { if (await transferRows(workspace, text, side, position, trusted)) { setSelected([]); setBefore(null) } }
    catch (error) { setError(error instanceof Error ? error.message : 'The transfer did not complete.') }
  }
  function startDrag(event: DragEvent, id: EntityId, side: Side) {
    if (unavailable) { event.preventDefault(); return }
    try {
      const ids = active.includes(id) && !mixed ? active : [id]
      const text = captureTransfer(workspace, ids, side, mode)
      dragging.current = text; event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData(transferMime, text); event.dataTransfer.setData('text/plain', text)
    } catch (error) { event.preventDefault(); setError(String(error)) }
  }
  function drop(event: DragEvent, side: Side, position: EntityId | null) {
    if (!event.dataTransfer.types.includes(transferMime) && !event.dataTransfer.types.includes('text/plain')) return
    event.preventDefault(); event.stopPropagation()
    const text = event.dataTransfer.getData(transferMime) || event.dataTransfer.getData('text/plain'), trusted = dragging.current === text
    dragging.current = null
    if (unavailable) { setError('Wait for the current operation, then drop the rows again.'); return }
    void apply(text, side, position, trusted)
  }
  return <main className="demo-example-page">
    <h1>Transfer inventory between lists</h1><p>Both lists share one save and undo history. Select rows, then drag a handle or choose a destination below. Protected rows can be copied or reordered.</p>
    <section className="demo-row-actions" aria-label="Transfer controls">
      <button aria-pressed={mode === 'copy'} onClick={() => setMode('copy')}>Copy</button><button aria-pressed={mode === 'move'} onClick={() => setMode('move')}>Move</button>
      <label>Destination list <select value={target} disabled={unavailable} onChange={event => { setTarget(event.target.value as Side); setBefore(null) }}><option value="left">Left</option><option value="right">Right</option></select></label>
      <label>Insert before <select value={before ?? ''} disabled={unavailable} onChange={event => setBefore(event.target.value ? kernelId<'entity'>(event.target.value) : null)}>
        <option value="">End of list</option>{rows.filter(row => row.preview!.side === target).map(row => <option key={row.entityId} value={row.entityId}>{String(row.preview!.name)}</option>)}</select></label>
      <button disabled={unavailable || !active.length || mixed || protectedMove} onClick={() => {
        try { void apply(captureTransfer(workspace, active, source!, mode), target, before, true) } catch (error) { setError(String(error)) }
      }}>Transfer selected rows</button>
      <button disabled={unavailable} onClick={() => owner.source.failNextSave()}>Fail next save</button>
      {protectedMove ? <p>Protected rows cannot move to another list. Choose Copy or reorder within their current list.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
      {(['left', 'right'] as const).map(side => <section key={side} aria-label={`${side === 'left' ? 'Left' : 'Right'} list`} style={{ minWidth: 0, overflow: 'auto' }}
        onDragOver={event => { if (event.dataTransfer.types.includes(transferMime) || event.dataTransfer.types.includes('text/plain')) event.preventDefault() }} onDrop={event => drop(event, side, null)}>
        <h2>{side === 'left' ? 'Left' : 'Right'} list</h2>
        <DataGrid workspace={workspace} viewId={kernelId<'view'>(side)} columns={columns} editors={owner.editors} caption={`${side === 'left' ? 'Left' : 'Right'} inventory`}
          createRow={() => ({ document: { id: `${side}-${crypto.randomUUID()}`, image: null, name: '', quantity: 0, deliveryDate: '', deleteProtected: false, side, homeSide: side } })}
          rowScope={{ kind: 'compare', fieldId: kernelId<'field'>('side'), operator: 'equals', value: side }}
          rowHeader={{ label: 'Rows', width: 184, render: ({ entityId, document }) => <div className="demo-transfer-row-controls" onDrop={event => drop(event, side, entityId)}>
            <input type="checkbox" aria-label={`Select ${document.name}`} checked={active.includes(entityId)} disabled={unavailable} onChange={event => setSelected(event.target.checked ? [...active, entityId] : active.filter(id => id !== entityId))} />
            <button draggable={!unavailable} disabled={unavailable} aria-label={`Drag ${document.name}`} onDragStart={event => startDrag(event, entityId, side)} onDragEnd={() => { dragging.current = null }}>↕</button>
            {document.deleteProtected ? <span> Protected</span> : null}
          </div> }} />
      </section>)}
    </div>
  </main>
}
