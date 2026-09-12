import { useState, type DragEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { DataGrid, Workspace, defineKernelSchema, kernelId, openIndexedDbRecovery, type WorkspaceGridColumn, type WorkspaceGridEditor } from 'data-editor-table'
import { openDemoSource, type DemoSource } from '../demo-source.js'
import { openImageTask } from '../image-task.js'

const fieldId = kernelId<'field'>('photo')
const schema = defineKernelSchema({ version: kernelId<'schema-version'>('v1'), codec: kernelId<'codec-version'>('json-v1'),
  fields: [{ id: fieldId, path: ['photo'], readonly: false }], validate: document => typeof document.photo === 'string' ? [] : [{ code: 'image', message: 'Enter an image URL.' }] })
const columns: readonly WorkspaceGridColumn[] = [{ id: 'photo', fieldId, header: 'Photo', label: 'Photo', render: ({ document }) => document.photo
  ? <img src={String(document.photo)} alt={`${document.name} photo`} width={32} height={32} /> : `Upload ${document.name}` }]
type Owner = { name: 'A' | 'B'; workspace: Workspace; source: DemoSource; editors: readonly WorkspaceGridEditor[] }
let owners: readonly Owner[] = []
export async function ownedUploadDiagnostics() {
  return Promise.all(owners.map(async owner => ({ name: owner.name, state: owner.workspace.getState(),
    authority: await owner.source.readAtLeast(owner.workspace.getState().workspace.scope, []) })))
}
export function cancelOwnedUploadTask(name: 'A' | 'B') {
  const workspace = owners.find(owner => owner.name === name)?.workspace, task = workspace?.getState().tasks.at(-1)
  if (!workspace || !task) throw new Error('The task owner is unavailable.')
  return workspace.dispatch({ kind: 'task-cancelled', taskId: task.id, executionId: task.executionId })
}
export async function mountOwnedUploadFixture(container: HTMLElement, databaseName: string) {
  async function open(name: 'A' | 'B'): Promise<Owner> {
    const scope = { sourceId: `${databaseName}-${name}`, id: kernelId<'scope'>('photos'), epoch: kernelId<'scope-epoch'>('v1') }
    const source = await openDemoSource(scope, [{ name, photo: '', hidden: name }], () => {}, false)
    const task = await openImageTask(`${databaseName}-${name}-tasks`)
    const session = await openIndexedDbRecovery({ databaseName: `${databaseName}-${name}-workspace`, workspace: { id: kernelId<'workspace'>(name), scope, schema: schema.version, codec: schema.codec } })
    let workspace: Workspace
    try { workspace = await Workspace.openDurable({ scope, schema, source, session, restore: (await session.load()) !== null, tasks: [task], recovery: 'manual',
      policy: { version: kernelId<'policy-version'>('v1'), create: false, order: false, defaultEntity: { write: true, replace: false, delete: false, readonlyPaths: [] }, entities: [] } }) }
    catch (error) { await session.release(); throw error }
    await workspace.refresh()
    return { name, workspace, source, editors: [{ fieldId, label: 'Photo', codec: {
      format: value => value.kind === 'missing' ? '' : String(value.value), parse: text => ({ kind: 'valid', value: { kind: 'value', value: text } }),
    }, resourceTask: { kind: 'durable', definition: task.ref } }] }
  }
  owners = [await open('A'), await open('B')]
  function Fixture() {
    const [index, setIndex] = useState(0), [error, setError] = useState<string | null>(null)
    const owner = owners[index]!
    async function switchView() {
      const result = await owner.workspace.close(owner.workspace.requestClose().ticket, 'retain')
      if (result.kind === 'retained') setIndex(index === 0 ? 1 : 0)
      else setError('View switch was not confirmed.')
    }
    async function drop(event: DragEvent) {
      if (!event.dataTransfer.files.length) return
      event.preventDefault()
      const file = event.dataTransfer.files[0]!, session = owner.workspace.getState().session
      if (!session || session.target.kind !== 'cell') { setError('Open the photo editor before dropping a file.'); return }
      const target = { kind: 'session' as const, sessionId: session.id, input: session.input }
      try {
        const input = await owner.workspace.registerResource(file)
        const result = await owner.workspace.runDurableTask({ owner: target, input, reads: [], definition: { id: 'image-data-url', version: 'v1' } }).result
        if (result.kind !== 'accepted') setError('The file is retained for recovery.')
      } catch { setError('The file could not be accepted.') }
    }
    return <main onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { void drop(event) }}>
      <button onClick={() => { void switchView() }}>View {index === 0 ? 'B' : 'A'}</button>
      <p>Other data sets keep their open work and running conversions.</p>
      {error ? <p role="alert">{error}</p> : null}
      <DataGrid workspace={owner.workspace} viewId={kernelId<'view'>(`photo-${owner.name}`)} columns={columns} editors={owner.editors} caption={`Photos ${owner.name}`} />
    </main>
  }
  createRoot(container).render(<Fixture />)
}

export function setOwnedUploadWritePermission(name: 'A' | 'B', write: boolean) {
  const workspace = owners.find(owner => owner.name === name)?.workspace
  if (!workspace) throw new Error('The task owner is unavailable.')
  const policy = workspace.getState().policy
  return workspace.dispatch({ kind: 'policy-observed', policy: { ...policy, version: kernelId<'policy-version'>(`write:${write}`),
    defaultEntity: { ...policy.defaultEntity, write } } })
}
