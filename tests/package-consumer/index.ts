import { createElement } from 'react'
import { DataGrid, WorkspaceCloseControls, useWorkspaceSnapshot, kernelId, createStringCodec, createNumberCodec,
  createSingleChoiceCodec, createMultiChoiceCodec, workspaceEn, type Workspace, type DataGridProps } from 'data-editor-table'
import { workspaceZhCN } from 'data-editor-table/locales/zh-CN'
import { Workspace as HeadlessWorkspace } from 'data-editor-table/engine'
import 'data-editor-table/styles.css'
import 'data-editor-table/structure.css'
import 'data-editor-table/theme.css'

export function ProductGrid({ workspace }: { workspace: Workspace }) {
  const snapshot = useWorkspaceSnapshot(workspace)
  const props: DataGridProps = { workspace, viewId: kernelId<'view'>('products'), caption: 'Products', locale: workspaceZhCN,
    columns: [{ id: 'name', fieldId: kernelId<'field'>('name'), header: 'Name', label: 'Name', render: ({ value }) => value.kind === 'missing' ? '' : String(value.value) }],
    editors: [{ fieldId: kernelId<'field'>('name'), label: 'Name', codec: createStringCodec({ invalid: workspaceEn.values.string }) }] }
  const sameOwner: HeadlessWorkspace = workspace
  void sameOwner; void snapshot
  return createElement(DataGrid, props)
}
export const close = (workspace: Workspace) => createElement(WorkspaceCloseControls, { workspace, checkpoint: true, messages: workspaceZhCN.close,
  onClosed: (owner, result) => { const closed: 'closed' = result.kind; void closed; void owner } })
export const number = createNumberCodec({ invalid: workspaceEn.values.number, empty: 'null' })
export const choice = createSingleChoiceCodec({ invalid: workspaceEn.values.choice, placeholder: 'None', options: [{ value: 1, label: 'Number' }, { value: '1', label: 'Text' }] })
export const choices = createMultiChoiceCodec({ invalid: workspaceEn.values.choices, placeholder: 'None', options: [{ value: 1, label: 'Number' }] })
// @ts-expect-error The public DataGrid no longer accepts implicit data-source ownership.
const obsolete: DataGridProps = { dataSource: {} }
void obsolete
// @ts-expect-error Choice identities are typed scalars, not arbitrary objects.
createSingleChoiceCodec({ invalid: 'Invalid', placeholder: 'None', options: [{ value: {}, label: 'Invalid' }] })
