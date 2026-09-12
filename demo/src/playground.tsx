import { WorkspaceOpenError } from './workspace-open-error.js'
import { useEffect, useRef, useState } from 'react'
import { DataGrid, Workspace, kernelId, defineKernelSchema, openIndexedDbRecovery, useWorkspaceSnapshot, prepareRowAction,
  createStringCodec, createNumberCodec, createIsoDateCodec, createSingleChoiceCodec, createMultiChoiceCodec, createBooleanChoiceCodec, workspaceEn,
  type Document, type RowCommand, type WorkspaceGridColumn, type WorkspaceGridEditor, type WorkspaceTextCodec } from 'data-editor-table'
import { openDemoSource, type DemoSource } from './demo-source.js'
import { openImageTask } from './image-task.js'
import { initialRows } from './playground-data.js'

const messages = workspaceEn.values
const imageCodec: WorkspaceTextCodec = {
  format: value => value.kind === 'missing' || value.value === null ? '' : String(value.value),
  parse: text => !text || /^(data:image\/|https?:\/\/)/.test(text) ? { kind: 'valid', value: { kind: 'value', value: text || null } }
    : { kind: 'invalid', message: 'Paste an image URL or data URL.' },
}
const definitions: readonly WorkspaceGridEditor[] = [
  { fieldId: kernelId<'field'>('image'), label: 'Image', clearInput: '', codec: imageCodec },
  { fieldId: kernelId<'field'>('name'), label: 'Name', clearInput: '', codec: createStringCodec({ invalid: 'Enter a name.' }) },
  { fieldId: kernelId<'field'>('quantity'), label: 'Quantity', codec: createNumberCodec({ invalid: 'Enter a non-negative number.', minimum: 0 }) },
  { fieldId: kernelId<'field'>('deliveryDate'), label: 'Delivery date', codec: createIsoDateCodec({ invalid: messages.date }) },
  { fieldId: kernelId<'field'>('status'), label: 'Status', codec: createSingleChoiceCodec({ invalid: messages.choice, placeholder: 'Choose status', options: [
    { value: 'draft', label: 'Draft' }, { value: 'ready', label: 'Ready' }, { value: 'archived', label: 'Archived', disabled: true }] }) },
  { fieldId: kernelId<'field'>('tags'), label: 'Tags', clearInput: '[]', codec: createMultiChoiceCodec({ invalid: messages.choices, placeholder: 'No tags', options: [
    { value: 'featured', label: 'Featured' }, { value: 'seasonal', label: 'Seasonal' }, { value: 'wholesale', label: 'Wholesale' }, { value: 'legacy', label: 'Legacy', disabled: true }] }) },
  { fieldId: kernelId<'field'>('active'), label: 'Active', codec: createBooleanChoiceCodec({ invalid: messages.boolean, placeholder: 'Choose active state', trueLabel: 'Active', falseLabel: 'Inactive' }) },
]
const schema = defineKernelSchema({ version: kernelId<'schema-version'>('inventory-v1'), codec: kernelId<'codec-version'>('json-v1'),
  fields: definitions.map(editor => ({ id: editor.fieldId, path: [editor.fieldId], readonly: false })), validate: document => {
    const errors = []
    for (const editor of definitions) {
      try { const parsed = editor.codec.parse(editor.codec.format({ kind: 'value', value: document[editor.fieldId] ?? null }))
        if (parsed.kind === 'invalid') errors.push({ code: 'invalid-value', message: parsed.message })
      } catch { errors.push({ code: 'invalid-value', message: `Invalid ${editor.label}.` }) }
    }
    return errors
  } })
function createInventoryRow() { return { document: { id: crypto.randomUUID(), image: null, name: 'Untitled item', quantity: 0, deliveryDate: '2026-09-30', status: 'draft', tags: [], active: true } } }
const scope = { sourceId: 'playground-inventory-v1', id: kernelId<'scope'>('inventory'), epoch: kernelId<'scope-epoch'>('v1') }
const policy = { version: kernelId<'policy-version'>('v1'), create: true, order: true,
  defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [] }
type Owner = { workspace: Workspace; source: DemoSource; editors: readonly WorkspaceGridEditor[] }
let opening: Promise<Owner> | null = null
function openInventory() {
  opening ??= (async () => {
    const source = await openDemoSource(scope, initialRows, document => { if (schema.validate(document, { entityId: kernelId<'entity'>('validation'), mutation: 'update' }).length) throw new Error('Invalid inventory values.') }, true)
    const imageTask = await openImageTask('playground-image-tasks-v1')
    const session = await openIndexedDbRecovery({ databaseName: 'playground-workspace-v1', workspace: { id: kernelId<'workspace'>('playground'), scope, schema: schema.version, codec: schema.codec } })
    let workspace: Workspace
    let restore: boolean
    try { restore = (await session.load()) !== null; workspace = await Workspace.openDurable({ scope, schema, policy, source, session, restore, tasks: [imageTask], recovery: 'manual' }) }
    catch (error) { await session.release(); throw error }
    await workspace.refresh()
    if (!restore) await workspace.setSaveSchedule({ mode: 'debounced', debounceMs: 700 })
    const editors: readonly WorkspaceGridEditor[] = definitions.map(editor => editor.fieldId !== 'image' ? editor : { ...editor, resourceTask: { kind: 'durable', definition: imageTask.ref, accept: 'image/*', pickOnEdit: true, applyOnUpload: true } })
    return { workspace, source, editors }
  })().catch(error => { opening = null; throw error })
  return opening
}
const columnLayouts: Record<string, Pick<WorkspaceGridColumn, 'width' | 'minWidth' | 'flex'>> = {
  image: { width: 116, minWidth: 96 },
  name: { width: 260, minWidth: 180, flex: 2 },
  quantity: { width: 150, minWidth: 120, flex: 1 },
  deliveryDate: { width: 190, minWidth: 160, flex: 1 },
  status: { width: 150, minWidth: 120, flex: 1 },
  tags: { width: 250, minWidth: 180, flex: 2 },
  active: { width: 110, minWidth: 90 },
}
const columns: readonly WorkspaceGridColumn[] = definitions.map(editor => ({
  ...(editor.fieldId === 'quantity' ? { fill: ({ sourceValues, targetIndex }: import('data-editor-table').WorkspaceFillContext) => {
    const numbers = sourceValues.map(value => {
      if (value.kind !== 'value' || typeof value.value !== 'number') throw new Error('Quantity fill requires numbers.')
      return value.value
    })
    return { kind: 'value' as const, value: numbers[0]! + targetIndex * (numbers.length > 1 ? numbers[1]! - numbers[0]! : 1) }
  } } : {}),
  ...columnLayouts[editor.fieldId],
  ...(editor.fieldId === 'quantity' ? { align: 'end' as const } : {}),
  id: editor.fieldId, fieldId: editor.fieldId, header: editor.label, label: editor.label, sortable: editor.fieldId !== 'image',
  render: ({ value, document }) => editor.fieldId === 'image' ? <div className="data-grid-image-cell">{value.kind === 'value' && typeof value.value === 'string' && value.value
    ? <img src={value.value} alt={String(document.name)} draggable={false} /> : <span>No image</span>}</div>
    : (editor.codec.display ?? editor.codec.format)(value) }))


export function PlaygroundPage() {
  const [owner, setOwner] = useState<Owner | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => { let attached = true
    void openInventory().then(value => { if (attached) setOwner(value) }, () => { if (attached) setFailed(true) })
    return () => { attached = false }
  }, [attempt])
  if (!owner) return <main>{failed ? <WorkspaceOpenError databaseName="playground-workspace-v1" message="Could not open inventory. Stored input is retained." retryLabel="Retry opening inventory" retry={() => { setFailed(false); setAttempt(value => value + 1) }} /> : <p role="status">Opening inventory…</p>}</main>
  return <Inventory owner={owner} />
}
function Inventory({ owner: { workspace, source, editors } }: { owner: Owner }) {
  const snapshot = useWorkspaceSnapshot(workspace), { state } = snapshot
  const view = workspace.getView(kernelId<'view'>('inventory'))
  const [target, setTarget] = useState(''), [deleteReview, setDeleteReview] = useState<{ target: string; revision: number } | null>(null)
  const timing = useRef<'immediate' | 'debounced'>('debounced')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const row = view.rows.find(row => row.entityId === target) ?? view.rows[0]
  const unavailable = busy || state.authority.content.kind !== 'complete' || snapshot.capabilities.close.lifecycle !== 'open'
    || snapshot.ingress.pending.length > 0 || (snapshot.storage !== null && snapshot.storage.kind !== 'idle') || snapshot.recovery.running
  async function run(operation: () => Promise<void>) {
    if (unavailable) return
    setBusy(true); setError(null)
    try { await operation() } catch { setError('The action did not complete. Review retained work before trying again.') }
    finally { setBusy(false) }
  }
  async function configure(mode: 'manual' | 'immediate' | 'debounced') {
    const result = await workspace.setSaveSchedule({ mode, debounceMs: mode === 'debounced' ? 700 : 0 }, state.schedule.token)
    if (result.kind !== 'accepted') throw new Error('Unconfirmed save mode')
  }
  async function rowAction(kind: 'add' | 'duplicate' | 'delete' | 'up' | 'down') {
    const commands: RowCommand[] = []
    if (kind === 'add' || kind === 'duplicate') {
      const document: Document = kind === 'duplicate' && row?.preview ? { ...row.preview, id: crypto.randomUUID(), name: `${row.preview.name} copy` }
        : createInventoryRow().document
      commands.push({ kind: 'create', entityId: kernelId<'entity'>(crypto.randomUUID()), document })
    } else if (row && kind === 'delete') {
      if (deleteReview?.target !== row.entityId || deleteReview.revision !== state.revision) throw new Error('Review deletion again')
      commands.push({ kind: 'delete', entityId: row.entityId })
    } else if (row) {
      const desired = [...snapshot.projection.order.preview], index = desired.indexOf(row.entityId), destination = index + (kind === 'up' ? -1 : 1)
      if (index < 0 || destination < 0 || destination >= desired.length) return
      ;[desired[index], desired[destination]] = [desired[destination]!, desired[index]!]
      commands.push({ kind: 'order', desired })
    }
    const prepared = prepareRowAction(state, { action: { id: kernelId<'action'>(crypto.randomUUID()), applicationId: kernelId<'application'>(crypto.randomUUID()), label: kind, saveAtomicity: 'transaction' },
      commands: commands.map(command => ({ id: kernelId<'intent'>(crypto.randomUUID()), command, inputs: [], dependencies: [] })), inputs: [], cause: 'user' }, schema)
    if ((await workspace.dispatch({ kind: 'prepared-action', prepared })).kind !== 'accepted') throw new Error('Unconfirmed row action')
    setDeleteReview(null)
  }
  return <main className="demo-shell workspace-playground">
    <header className="demo-header"><h1>Inventory bulk editor</h1><div className="demo-header-actions">
      <label>Auto-save <input role="switch" aria-label="Auto-save" type="checkbox" checked={state.schedule.mode !== 'manual'} disabled={unavailable}
        onChange={event => { const enabled = event.target.checked; if (state.schedule.mode !== 'manual') timing.current = state.schedule.mode
          void run(() => configure(enabled ? timing.current : 'manual')) }} /></label>
      <label>Auto-save timing <select aria-label="Auto-save timing" disabled={unavailable || state.schedule.mode === 'manual'} value={state.schedule.mode === 'manual' ? timing.current : state.schedule.mode}
        onChange={event => { const mode = event.target.value === 'immediate' ? 'immediate' : 'debounced'; timing.current = mode; void run(() => configure(mode)) }}>
        <option value="immediate">Immediately</option><option value="debounced">After a pause</option></select></label>
      <button disabled={unavailable} onClick={() => source.failNextSave()}>Fail next save</button>
      <button disabled={unavailable} onClick={() => { void run(async () => {
        const authority = await source.readAtLeast(scope, []), first = authority.rows[0]
        if (first) await source.changeDocument(first.identity, document => ({ ...document, name: `Remote amber ${authority.version.token}` }))
        if ((await workspace.refresh()).kind !== 'accepted') throw new Error('Refresh unconfirmed')
      }) }}>Simulate remote change</button><span>{state.commits.length} saves</span>
    </div></header>
    <section className="demo-row-actions" aria-label="Row actions"><label>Row action target <select aria-label="Row action target" value={row?.entityId ?? ''} disabled={unavailable} onChange={event => { setTarget(event.target.value); setDeleteReview(null) }}>
      {view.rows.map(row => <option key={row.entityId} value={row.entityId}>{String(row.preview?.name)}</option>)}</select></label>
      <button disabled={unavailable} onClick={() => { void run(() => rowAction('add')) }}>Add row</button>
      <button disabled={unavailable || !row} onClick={() => { void run(() => rowAction('duplicate')) }}>Duplicate row</button>
      <button disabled={unavailable || !row || view.query.sort.length > 0 || view.query.filters.length > 0 || !!view.query.search?.text.trim()} onClick={() => { void run(() => rowAction('up')) }}>Move row up</button>
      <button disabled={unavailable || !row || view.query.sort.length > 0 || view.query.filters.length > 0 || !!view.query.search?.text.trim()} onClick={() => { void run(() => rowAction('down')) }}>Move row down</button>
      <label><input type="checkbox" disabled={unavailable || !row} checked={!!row && deleteReview?.target === row.entityId && deleteReview.revision === state.revision}
        onChange={event => setDeleteReview(event.target.checked && row ? { target: row.entityId, revision: state.revision } : null)} />Delete the selected row: {String(row?.preview?.name ?? '')}</label>
      <button disabled={unavailable || !row || deleteReview?.target !== row.entityId || deleteReview.revision !== state.revision} onClick={() => { void run(() => rowAction('delete')) }}>Delete row</button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
    <section className="demo-grid-panel" style={{ overflow: 'auto' }}><DataGrid workspace={workspace} viewId={kernelId<'view'>('inventory')} columns={columns} editors={editors} createRow={createInventoryRow} caption="Inventory items" /></section>
    <aside className="demo-inspector"><JsonPanel title="Authoritative JSON" value={state.authority.content.kind === 'complete' ? state.authority.content.snapshot.entities.map(entity => entity.document) : null} />
      <JsonPanel title="Dirty" value={snapshot.projection.changes} /><JsonPanel title="Conflicts" value={snapshot.projection.rows.filter(row => row.issues.length > 0)} /></aside>
  </main>
}
function JsonPanel({ title, value }: { title: string; value: unknown }) { return <section className="json-panel"><h2>{title}</h2><pre>{JSON.stringify(value, null, 2)}</pre></section> }
