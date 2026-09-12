import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DataGrid, Workspace, WorkspaceCloseControls, createStringCodec, defineKernelSchema, kernelId, openIndexedDbRecovery, workspaceEn, type WorkspaceGridColumn, type WorkspaceGridFilter } from 'data-editor-table'
import { openDemoSource } from '../demo-source.js'

const fieldId = kernelId<'field'>('name')
const schema = defineKernelSchema({ version: kernelId<'schema-version'>('v1'), codec: kernelId<'codec-version'>('json-v1'),
  fields: [{ id: fieldId, path: ['name'], readonly: false }], validate: () => [] })
const columns: readonly WorkspaceGridColumn[] = [{ id: 'name', fieldId, header: 'Name', label: 'Name', render: ({ document }) => String(document.name) }]
const editors = [{ fieldId, label: 'Name', codec: createStringCodec({ invalid: 'Enter a name.' }) }]
const filters: readonly WorkspaceGridFilter[] = [{ columnId: 'name', label: 'Name filter', codec: {
  format: predicate => predicate?.kind === 'compare' && typeof predicate.value === 'string' ? predicate.value : '',
  parse: text => ({ kind: 'valid', predicate: text ? { kind: 'compare', fieldId, operator: 'contains', value: text } : null }),
} }]
type SourceName = 'a' | 'b'
type Owner = { name: SourceName; workspace: Workspace }
const owners: Owner[] = []
export function ownedSourceSwitchLifecycles() { return owners.map(owner => ({ name: owner.name, lifecycle: owner.workspace.getSnapshot().capabilities.close.lifecycle })) }

export async function mountOwnedSourceSwitchFixture(container: HTMLElement, databaseName: string) {
  owners.length = 0
  async function open(name: SourceName): Promise<Owner> {
    const scope = { sourceId: `${databaseName}-${name}`, id: kernelId<'scope'>('rows'), epoch: kernelId<'scope-epoch'>('v1') }
    const source = await openDemoSource(scope, [{ name: `Source ${name.toUpperCase()} row`, hidden: name }], () => {}, false)
    const session = await openIndexedDbRecovery({ databaseName: `${databaseName}-${name}-workspace`, workspace: { id: kernelId<'workspace'>(name), scope, schema: schema.version, codec: schema.codec } })
    let workspace: Workspace
    try { workspace = await Workspace.openDurable({ scope, schema, source, session, restore: (await session.load()) !== null || (await session.checkpoints.load()) !== null,
      recovery: 'manual', policy: { version: kernelId<'policy-version'>('v1'), create: false, order: false, defaultEntity: { write: true, replace: false, delete: false, readonlyPaths: [] }, entities: [] } }) }
    catch (error) { await session.release(); throw error }
    await workspace.refresh()
    const owner = { name, workspace }; owners.push(owner); return owner
  }
  const first = await open('a')
  function Fixture() {
    const [owner, setOwner] = useState(first), [requested, setRequested] = useState<SourceName | null>(null)
    const [failed, setFailed] = useState(false), [opening, setOpening] = useState(false)
    async function activate(name: SourceName) {
      setOpening(true); setFailed(false)
      try { const next = await open(name); setOwner(next); setRequested(null) }
      catch { setFailed(true) }
      finally { setOpening(false) }
    }
    return <main>
      <button disabled={opening || requested !== null} onClick={() => setRequested(owner.name === 'a' ? 'b' : 'a')}>Switch data source</button>
      {requested ? <WorkspaceCloseControls key={owner.workspace.getState().workspace.id} workspace={owner.workspace} messages={workspaceEn.close} checkpoint
        onClosed={closed => { if (closed === owner.workspace) void activate(requested) }} /> : null}
      {opening ? <p role="status">Opening next data set…</p> : null}
      {failed ? <div role="alert">Could not open the next data set.<button onClick={() => { if (requested) void activate(requested) }}>Retry opening data set</button></div> : null}
      <DataGrid workspace={owner.workspace} viewId={kernelId<'view'>('source-switch')} columns={columns} editors={editors} filters={filters} caption="Owned source switch" />
    </main>
  }
  createRoot(container).render(<Fixture />)
}
