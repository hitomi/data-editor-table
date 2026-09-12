import { createRoot } from 'react-dom/client'
import { DataGrid, createStringCodec, kernelId, type WorkspaceGridColumn } from 'data-editor-table'
import { workspaceForReactFixture } from './durable-workspace.js'

const fieldId = kernelId<'field'>('value')
const columns: readonly WorkspaceGridColumn[] = [{ id: 'name', fieldId, header: 'Name', label: 'Name', render: ({ document }) => String(document.value) }]
const editors = [{ fieldId, label: 'Name', codec: createStringCodec({ invalid: 'Enter a name.' }) }]
export function mountPersistenceConsistencyFixture(container: HTMLElement) {
  createRoot(container).render(<DataGrid workspace={workspaceForReactFixture()} viewId={kernelId<'view'>('consistency')} columns={columns} editors={editors} caption="Persistence consistency" />)
}
