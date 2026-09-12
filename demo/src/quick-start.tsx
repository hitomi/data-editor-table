import { WorkspaceOpenError } from './workspace-open-error.js'
import { useEffect, useState } from 'react'
import { DataGrid, Workspace, kernelId, defineKernelSchema, openIndexedDbRecovery, createStringCodec, createNumberCodec,
  createBooleanChoiceCodec, createSingleChoiceCodec, workspaceEn, type WorkspaceGridColumn, type WorkspaceGridEditor } from 'data-editor-table'
import { openDemoSource } from './demo-source.js'

const initial = [
  { name: 'Amber poster', quantity: 12, status: 'ready', active: true },
  { name: 'Blue card', quantity: 24, status: 'draft', active: false },
  { name: 'Cedar label', quantity: 36, status: 'ready', active: true },
]
const scope = { sourceId: 'quick-start-products-v1', id: kernelId<'scope'>('products'), epoch: kernelId<'scope-epoch'>('v1') }
const schema = defineKernelSchema({ version: kernelId<'schema-version'>('products-v1'), codec: kernelId<'codec-version'>('json-v1'),
  fields: ['name', 'quantity', 'status', 'active'].map(name => ({ id: kernelId<'field'>(name), path: [name], readonly: false })), validate: () => [] })
const policy = { version: kernelId<'policy-version'>('v1'), create: false, order: false,
  defaultEntity: { write: true, replace: false, delete: false, readonlyPaths: [] }, entities: [] }
const editors: readonly WorkspaceGridEditor[] = [
  { fieldId: kernelId<'field'>('name'), label: 'Name', codec: createStringCodec({ invalid: 'Enter a product name.' }) },
  { fieldId: kernelId<'field'>('quantity'), label: 'Quantity', codec: createNumberCodec({ invalid: 'Enter a non-negative whole number.', minimum: 0, integer: true }) },
  { fieldId: kernelId<'field'>('status'), label: 'Status', codec: createSingleChoiceCodec({ invalid: workspaceEn.values.choice, placeholder: 'Choose status',
    options: [{ value: 'draft', label: 'Draft' }, { value: 'ready', label: 'Ready' }] }) },
  { fieldId: kernelId<'field'>('active'), label: 'Active', codec: createBooleanChoiceCodec({ invalid: workspaceEn.values.boolean, placeholder: 'Choose active state', trueLabel: 'True', falseLabel: 'False' }) },
]
const columns: readonly WorkspaceGridColumn[] = editors.map(editor => ({ id: editor.fieldId, fieldId: editor.fieldId, header: editor.label, label: editor.label, sortable: true,
  render: ({ value }) => (editor.codec.display ?? editor.codec.format)(value) }))
// The route host retains the owner while another route is displayed. StrictMode
// and view unmount do not open a second lease or discard a session.
let opening: Promise<Workspace> | null = null
function openProducts() {
  opening ??= (async () => {
    const source = await openDemoSource(scope, initial, document => {
      if (typeof document.name !== 'string' || !document.name.trim() || typeof document.quantity !== 'number' || !Number.isSafeInteger(document.quantity) || document.quantity < 0
        || (document.status !== 'draft' && document.status !== 'ready') || typeof document.active !== 'boolean') throw new Error('Invalid product values.')
    }, false)
    const session = await openIndexedDbRecovery({ databaseName: 'quick-start-workspace-v1', workspace: { id: kernelId<'workspace'>('quick-start'), scope, schema: schema.version, codec: schema.codec } })
    let workspace: Workspace
    try { workspace = await Workspace.openDurable({ scope, schema, policy, source, session, restore: (await session.load()) !== null, recovery: 'manual' }) }
    catch (error) { await session.release(); throw error }
    await workspace.refresh()
    return workspace
  })().catch(error => { opening = null; throw error })
  return opening
}
const integration = `const workspace = await Workspace.openDurable({
  scope, schema, policy, source, session,
  restore: true, recovery: 'manual',
})
await workspace.refresh()

<DataGrid workspace={workspace} viewId={viewId}
  caption="Products" columns={columns} editors={editors} />`

export function QuickStartPage() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let attached = true
    void openProducts().then(owner => { if (attached) setWorkspace(owner) }, () => { if (attached) setFailed(true) })
    return () => { attached = false }
  }, [attempt])
  return <main className="quick-start-page">
    <header className="quick-start-header"><div><p className="demo-eyebrow">Quick start</p><h1>Products workspace</h1>
      <p>Edit products and save changes. This example stores its data in this browser.</p></div></header>
    <section className="quick-start-workspace"><div className="quick-start-grid-panel">
      {workspace ? <DataGrid workspace={workspace} viewId={kernelId<'view'>('quick-start')} columns={columns} editors={editors} caption="Quick-start products" />
        : failed ? <WorkspaceOpenError databaseName="quick-start-workspace-v1" message="Could not open products. Existing browser data has been retained." retryLabel="Retry opening products" retry={() => { setFailed(false); setAttempt(value => value + 1) }} />
          : <p role="status">Opening products…</p>}
    </div><section aria-labelledby="quick-start-code-heading" className="quick-start-code-panel">
      <h2 id="quick-start-code-heading">Workspace integration</h2>
      <p>The host supplies the schema, source and storage session. The grid edits the same Workspace.</p>
      <pre data-testid="quick-start-code"><code>{integration}</code></pre>
    </section></section>
  </main>
}
