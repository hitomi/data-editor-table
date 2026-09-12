import { WorkspaceOpenError } from './workspace-open-error.js'
import { useEffect, useState } from 'react'
import { DataGrid, Workspace, createStringCodec, defineKernelSchema, kernelId, openIndexedDbRecovery, ownEncodedValue, useWorkspaceSnapshot,
  type OwnedInput, type TaskState, type WorkspaceGridColumn, type WorkspaceGridEditor, type WorkspaceTextCodec } from 'data-editor-table'
import { openDemoSource, type DemoSource } from './demo-source.js'
import { openImageTask } from './image-task.js'
import { openImageBatchTask } from './image-batch-task.js'
import { captureImageBatch } from './image-batch.js'
import { applyImageImport, captureImportPlan, importTargetIssue, readImportResult, type ImageImportPlan, type ImageImportResult } from './image-import-plan.js'

const imageCodec: WorkspaceTextCodec = {
  format: value => value.kind === 'missing' || value.value === null ? '' : String(value.value),
  parse: text => !text || /^(data:image\/|https?:\/\/)/.test(text) ? { kind: 'valid', value: { kind: 'value', value: text || null } } : { kind: 'invalid', message: 'Enter an image URL.' },
}
const schema = defineKernelSchema({ version: kernelId<'schema-version'>('images-v1'), codec: kernelId<'codec-version'>('json-v1'),
  fields: ['image', 'name'].map(name => ({ id: kernelId<'field'>(name), path: [name], readonly: false })),
  validate: document => typeof document.name === 'string' && (document.image === null || typeof document.image === 'string') ? [] : [{ code: 'invalid-image-row', message: 'An image row needs a name and image URL.' }],
})
type Owner = { workspace: Workspace; source: DemoSource; editors: readonly WorkspaceGridEditor[] }
let opening: Promise<Owner> | null = null
function openImport() {
  opening ??= (async () => {
    const scope = { sourceId: 'image-import-authority-v1', id: kernelId<'scope'>('images'), epoch: kernelId<'scope-epoch'>('v1') }
    const source = await openDemoSource(scope, [1, 2, 3].map(id => ({ id: `import-row-${id}`, name: '', image: null })), document => {
      if (schema.validate(document, { entityId: kernelId<'entity'>('validation'), mutation: 'update' }).length) throw new Error('Invalid image row')
    }, true)
    const single = await openImageTask('image-import-single-tasks-v1'), batch = await openImageBatchTask('image-import-batch-tasks-v1')
    const session = await openIndexedDbRecovery({ databaseName: 'image-import-workspace-v1', workspace: { id: kernelId<'workspace'>('image-import'), scope, schema: schema.version, codec: schema.codec } })
    let workspace: Workspace
    try { workspace = await Workspace.openDurable({ scope, schema, source, session, restore: (await session.load()) !== null, tasks: [single, batch],
      policy: { version: kernelId<'policy-version'>('v1'), create: true, order: true,
        defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [] }, recovery: 'manual' }) }
    catch (error) { await session.release(); throw error }
    await workspace.refresh()
    return { workspace, source, editors: [
      { fieldId: kernelId<'field'>('image'), label: 'Image', codec: imageCodec, clearInput: '', resourceTask: { kind: 'durable' as const, definition: single.ref } },
      { fieldId: kernelId<'field'>('name'), label: 'Name', codec: createStringCodec({ invalid: 'Enter a name.' }), clearInput: '' },
    ] }
  })().catch(error => { opening = null; throw error })
  return opening
}
const columns: readonly WorkspaceGridColumn[] = [
  { id: 'image', fieldId: kernelId<'field'>('image'), header: 'Image', label: 'Image', sortable: true,
    render: ({ value, document }) => value.kind === 'value' && typeof value.value === 'string' && value.value
      ? <img src={value.value} alt={String(document.name || 'Imported image')} style={{ maxWidth: 128, maxHeight: 96 }} /> : 'No image' },
  { id: 'name', fieldId: kernelId<'field'>('name'), header: 'Name', label: 'Name', sortable: true, render: ({ value }) => value.kind === 'value' ? String(value.value) : '' },
]
export function MultiImageImportPage() {
  const [owner, setOwner] = useState<Owner | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => { let active = true; void openImport().then(owner => { if (active) setOwner(owner) }, () => { if (active) setFailed(true) }); return () => { active = false } }, [attempt])
  if (!owner) return <main>{failed ? <WorkspaceOpenError databaseName="image-import-workspace-v1" message="Could not open image imports. Stored input is retained." retryLabel="Retry opening imports" retry={() => { setFailed(false); setAttempt(value => value + 1) }} /> : <p role="status">Opening images…</p>}</main>
  return <ImportPage owner={owner} />
}
function ImportPage({ owner }: { owner: Owner }) {
  const { workspace } = owner, snapshot = useWorkspaceSnapshot(workspace)
  const [start, setStart] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const unavailable = busy || snapshot.capabilities.close.lifecycle !== 'open' || snapshot.ingress.pending.length > 0 || snapshot.recovery.running
    || snapshot.storage !== null && snapshot.storage.kind !== 'idle' || snapshot.state.authority.content.kind !== 'complete'
  async function importFiles(files: readonly File[], element?: HTMLInputElement) {
    if (!files.length) return
    if (snapshot.capabilities.close.lifecycle !== 'open' || snapshot.state.authority.content.kind !== 'complete') { setError('The workspace is not ready to accept files. Try again after it opens.'); return }
    setBusy(true); setError(null)
    try {
      const plan = captureImportPlan(snapshot, start, files.length)
      const batch = captureImageBatch(files, ownEncodedValue(plan))
      const input = await workspace.registerResource(batch)
      const run = workspace.runDurableTask({ definition: { id: 'image-batch-data-url', version: 'v1' },
        owner: { kind: 'workspace', workspaceId: snapshot.state.workspace.id }, input, reads: [] })
      if ((await run.result).kind !== 'accepted') throw new Error('The batch was not confirmed. Retained files remain available.')
      if (element && element.files?.length === files.length && files.every((file, index) => element.files?.[index] === file)) element.value = ''
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not prepare the image import.') }
    finally { setBusy(false) }
  }
  return <main className="demo-example-page" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = unavailable ? 'none' : 'copy' } }}
    onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); void importFiles(Array.from(event.dataTransfer.files)) } }}>
    <header><h1>Import images</h1><p>Choose or drop up to 24 images, 8 MiB each and 48 MiB total. Review replacements and new rows before applying; save to keep the changes.</p></header>
    <section className="demo-row-actions" aria-label="Choose import files"><label>Import starting row <select value={start ?? ''} disabled={unavailable} onChange={event => setStart(event.target.value || null)}>
      <option value="">First visible row</option>{snapshot.view.rows.map((row, index) => <option key={row.entityId} value={row.entityId}>{String(row.preview?.name || `Row ${index + 1}`)}</option>)}</select></label>
      <label>Choose images to import <input type="file" multiple accept="image/*" disabled={unavailable} onChange={event => { void importFiles(Array.from(event.currentTarget.files ?? []), event.currentTarget) }} /></label>
      {busy ? <p role="status">Retaining image files…</p> : null}{error ? <p role="alert">{error}</p> : null}
      <button disabled={unavailable} onClick={() => owner.source.failNextSave()}>Fail next save</button>
    </section>
    <DataGrid workspace={workspace} viewId={kernelId<'view'>('image-import')} columns={columns} editors={owner.editors} caption="Image import rows" renderActionCandidate={(task, input) => <BatchReview key={task.id} workspace={workspace} task={task} input={input} start={start} />} />
  </main>
}
function BatchReview({ workspace, task, input, start }: { workspace: Workspace; task: TaskState; input: OwnedInput; start: string | null }) {
  const snapshot = useWorkspaceSnapshot(workspace)
  const [replacement, setReplacement] = useState<{ plan: ImageImportPlan; revision: number } | null>(null), [confirmed, setConfirmed] = useState<number | null>(null), [error, setError] = useState<string | null>(null)
  let result: ImageImportResult
  try { if (input.kind !== 'encoded') throw new Error(); result = readImportResult(input.value) }
  catch { return <section role="alert">This retained batch needs its original import editor.</section> }
  const plan = replacement?.plan ?? result.plan
  const issue = importTargetIssue(snapshot, plan), stale = replacement !== null && replacement.revision !== snapshot.state.revision
  const unavailable = task.kind === 'cancelled' || snapshot.ingress.pending.length > 0 || snapshot.storage !== null && snapshot.storage.kind !== 'idle' || snapshot.capabilities.close.lifecycle !== 'open' || snapshot.recovery.running
  return <section aria-label="Review image import">
    <h2>Review {result.images.length} images</h2>
    <ol>{result.images.map((image, index) => { const target = plan.targets[index]!; return <li key={index}>
      <img src={image.image} alt={image.name} style={{ maxWidth: 96, maxHeight: 64 }} /> <a href={image.image} download={image.fileName}>Download {image.fileName}</a> → {target.kind === 'new' ? 'New row' : `Replace ${target.before.name.kind === 'value' && target.before.name.value || 'unnamed row'}`}
    </li> })}</ol>
    {issue || stale ? <p role="alert">{issue ?? 'The workspace changed. Review the targets again.'}</p> : null}
    <button disabled={unavailable} onClick={() => { try { setReplacement({ plan: captureImportPlan(snapshot, start, result.images.length), revision: snapshot.state.revision }); setConfirmed(null); setError(null) } catch (error) { setError(String(error)) } }}>Review new targets</button>
    <label><input type="checkbox" checked={confirmed === snapshot.state.revision} disabled={unavailable || !!issue || stale} onChange={event => setConfirmed(event.target.checked ? snapshot.state.revision : null)} />Confirm these replacements and new rows</label>
    <button disabled={unavailable || !!issue || stale || confirmed !== snapshot.state.revision} onClick={async () => {
      try { await applyImageImport(workspace, task.id, snapshot.state.revision, plan) } catch (error) { setError(error instanceof Error ? error.message : 'The batch was not applied.') }
    }}>Apply image import</button>
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
