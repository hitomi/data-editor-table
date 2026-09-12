import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DataGrid, Workspace, kernelId, defineKernelSchema, openIndexedDbRecovery, createStringCodec, WorkspaceCloseControls, type PersistenceSource } from 'data-editor-table'
import { workspaceZhCN } from 'data-editor-table/locales/zh-CN'

const structureOnly = new URLSearchParams(location.search).get('styles') === 'structure'
const stylesReady = structureOnly ? Promise.all([import('data-editor-table/structure.css'), import('./structure-theme.css')]) : import('data-editor-table/styles.css')
const sourceId = structureOnly ? 'packed-structure' : 'packed-theme'
const scope = { sourceId, id: kernelId<'scope'>('products'), epoch: kernelId<'scope-epoch'>('v1') }
const schema = defineKernelSchema({ version: kernelId<'schema-version'>('v1'), codec: kernelId<'codec-version'>('v1'),
  fields: [{ id: kernelId<'field'>('name'), path: ['name'], readonly: false }], validate: () => [] })
const policy = { version: kernelId<'policy-version'>('v1'), create: true, order: true, defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [] }
async function request(path: string, body: unknown) {
  const result = await fetch(`/__packed-source/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!result.ok) throw new Error('Source unavailable')
  return result.json()
}
const source: PersistenceSource = { id: sourceId, capabilities: { atomicScopeWrites: true, durableOperationLookup: true, operationIdFence: 'scope-epoch',
  authorityOrder: 'ordered', identity: 'incarnation', operationRetentionMs: 3600000, restoreDeleted: false },
  readAtLeast: (scope, frontier) => request('read', { scope, frontier }), submit: value => request('submit', value), lookupOperation: value => request('lookup', value) }
async function start() {
  await stylesReady
  const session = await openIndexedDbRecovery({ databaseName: sourceId, workspace: { id: kernelId<'workspace'>('products'), scope, schema: schema.version, codec: schema.codec } })
  const restore = (await session.load()) !== null
  const workspace = await Workspace.openDurable({ scope, schema, policy, source, session, restore, recovery: 'manual' })
  await workspace.refresh()
  const codec = createStringCodec({ invalid: workspaceZhCN.values.string })
  createRoot(document.getElementById('root')!).render(<StrictMode>
    <DataGrid workspace={workspace} viewId={kernelId<'view'>('products')} caption="打包产物表格" locale={workspaceZhCN}
      className={structureOnly ? 'packed-tailwind-grid' : ''}
      columns={[{ id: 'name', fieldId: kernelId<'field'>('name'), header: 'Name', label: 'Name', render: ({ value }) => value.kind === 'missing' ? '' : String(value.value) }]}
      editors={[{ fieldId: kernelId<'field'>('name'), label: 'Name', codec }]} />
    <WorkspaceCloseControls workspace={workspace} checkpoint messages={workspaceZhCN.close}
      onClosed={(_owner, result) => { if (result.kind === 'closed') document.body.dataset.closed = 'confirmed' }} />
  </StrictMode>)
}
void start().catch(() => { document.getElementById('root')!.textContent = 'Could not open packed Workspace.' })
