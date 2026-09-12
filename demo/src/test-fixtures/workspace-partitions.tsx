import { createRoot, type Root } from 'react-dom/client'
import { DataGrid, createStringCodec, kernelId } from 'data-editor-table'
import { workspaceForReactFixture } from './durable-workspace.js'
let root: Root | null = null
const field = kernelId<'field'>('value')
const columns = [{ id: 'value', fieldId: field, header: 'Value', label: 'Value', sortable: true,
  render: ({ value }: { value: import('data-editor-table').ResourceValue }) => value.kind === 'value' ? String(value.value) : '' }]
const editors = [{ fieldId: field, label: 'Value', codec: createStringCodec({ invalid: 'Enter a value.' }) }]
export function renderPartitions(swapped = false) {
  if (!root) {
    const demo = document.getElementById('root'); if (demo) demo.style.display = 'none'
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  }
  const workspace = workspaceForReactFixture()
  root.render(<>{['Alpha', 'Beta'].map((name, index) => <section key={name} aria-label={`${name} pane`}>
    <DataGrid workspace={workspace} viewId={kernelId<'view'>(name)} columns={columns} editors={editors} caption={`${name} rows`}
      rowScope={{ kind: 'compare', fieldId: field, operator: 'equals', value: swapped ? index === 0 ? 'Beta' : 'Alpha' : name }} />
  </section>)}</>)
}
