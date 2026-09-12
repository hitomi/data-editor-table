import { workspaceZhCN } from '../../../src/locales/workspace-zh-cn.js'
import { workspaceEn, createNumberCodec, createSingleChoiceCodec, createMultiChoiceCodec } from 'data-editor-table'
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { kernelId } from '../../../src/kernel/model.js'
import { WorkspaceGridViewport, type WorkspaceGridColumn, DataGrid as WorkspaceDataGrid, type WorkspaceGridEditor, type WorkspaceGridFilter, WorkspaceCloseControls } from 'data-editor-table'
import { workspaceForReactFixture } from './durable-workspace.js'

let root: Root | null = null
function createFixtureRoot(container: HTMLElement) {
  // Isolate the fixture's accessible controls from the real Quick start route.
  const demo = document.getElementById('root'); if (demo) demo.style.display = 'none'
  return createRoot(container)
}
let closedOwners: string[] = []
export function workspaceClosedOwners() { return closedOwners }
export function mountClosableWorkspaceGrid(container: HTMLElement) {
  root ??= createFixtureRoot(container)
  closedOwners = []
  root.render(<StrictMode><EditableGrid /><WorkspaceCloseControls workspace={workspaceForReactFixture()} messages={workspaceEn.close} checkpoint
    onClosed={(owner, result) => { if (result.assessment.lifecycle !== 'closed') throw new Error('Close callback ran before release.')
      closedOwners.push(owner.getState().workspace.id) }} /></StrictMode>)
}
const columns: readonly WorkspaceGridColumn[] = [{ id: 'value-column', fieldId: kernelId<'field'>('value'), header: 'Value', label: 'Value', sortable: true,
  render: ({ value }) => value.kind === 'missing' ? '(missing)' : typeof value.value === 'string' ? value.value : JSON.stringify(value.value) }]
const messages = workspaceEn.grid.viewport
export function mountWorkspaceGrid(container: HTMLElement) {
  root ??= createFixtureRoot(container)
  root.render(<StrictMode><WorkspaceGridViewport workspace={workspaceForReactFixture()} columns={columns} caption="Workspace rows" messages={messages} /></StrictMode>)
}
export function unmountWorkspaceGrid() { root?.unmount(); root = null }
const repeatedColumns = [...columns, { ...columns[0]!, id: 'value-copy', header: 'Value copy', label: 'Value copy' }]
function EditableGrid({ repeated = false, numeric = false, choice = false }: { repeated?: boolean; numeric?: boolean; choice?: boolean | 'multiple' }) {
  return <WorkspaceDataGrid workspace={workspaceForReactFixture()} viewId={kernelId<'view'>('grid-editor')} columns={repeated ? repeatedColumns : columns} editors={choice === 'multiple' ? multiChoiceEditors : choice ? choiceEditors : numeric ? numericEditors : editors} filters={filters} caption="Workspace rows" />
}
const editors: readonly WorkspaceGridEditor[] = [{ fieldId: kernelId<'field'>('value'), label: 'Edit value', codec: {
  format: value => value.kind === 'missing' ? '' : String(value.value), parse: text => text.trim()
    ? { kind: 'valid', value: { kind: 'value', value: text } } : { kind: 'invalid', message: 'Enter a value.' },
} }]
export function mountEditableWorkspaceGrid(container: HTMLElement, repeated = false, numeric = false, choice: boolean | 'multiple' = false) {
  root ??= createFixtureRoot(container)
  root.render(<StrictMode><EditableGrid repeated={repeated} numeric={numeric} choice={choice} /></StrictMode>)
}
export async function filterWorkspaceGrid(value: string | null) {
  const workspace = workspaceForReactFixture()
  return workspace.dispatch({ kind: 'view-query-set', expectedVersion: workspace.getState().view.version,
    filters: value === null ? [] : [{ columnId: 'value-column', predicate: { kind: 'compare', fieldId: kernelId<'field'>('value'), operator: 'contains', value } }],
    sort: [{ fieldId: kernelId<'field'>('value'), direction: 'asc' }] })
}
export function refreshWorkspaceGrid() { return workspaceForReactFixture().refresh() }

const filters: readonly WorkspaceGridFilter[] = [{ columnId: 'value-column', label: 'Value filter', codec: {
  format: predicate => {
    if (predicate === null) return ''
    if (predicate.kind !== 'compare' || predicate.fieldId !== 'value' || predicate.operator !== 'contains' || typeof predicate.value !== 'string') throw new Error('Unsupported filter.')
    return predicate.value
  },
  parse: text => text.includes('*') ? { kind: 'invalid', message: 'Enter literal text without wildcards.' }
    : { kind: 'valid', predicate: text ? { kind: 'compare', fieldId: kernelId<'field'>('value'), operator: 'contains', value: text } : null },
} }]

const numericEditors: readonly WorkspaceGridEditor[] = [{ fieldId: kernelId<'field'>('value'), label: 'Edit value', codec: createNumberCodec({ invalid: workspaceEn.values.number, empty: 'null' }) }]

const choiceEditors: readonly WorkspaceGridEditor[] = [{ fieldId: kernelId<'field'>('value'), label: 'Edit value', codec: createSingleChoiceCodec({ invalid: workspaceEn.values.choice, placeholder: 'No value', empty: 'null',
  options: [{ value: 1, label: 'Numeric one' }, { value: '1', label: 'Text one' }] }) }]

const multiChoiceEditors: readonly WorkspaceGridEditor[] = [{ fieldId: kernelId<'field'>('value'), label: 'Edit value', codec: createMultiChoiceCodec({ invalid: workspaceEn.values.choices, placeholder: 'No values',
  options: [{ value: 1, label: 'Numeric one' }, { value: '1', label: 'Text one' }, { value: 'other', label: 'Other value' }] }) }]

export function mountChineseWorkspaceGrid(container: HTMLElement) {
  root ??= createFixtureRoot(container)
  root.render(<StrictMode><WorkspaceDataGrid workspace={workspaceForReactFixture()} viewId={kernelId<'view'>('grid-editor')} locale={workspaceZhCN}
    caption="工作区数据" columns={[{ ...columns[0]!, header: '数量', label: '数量' }]}
    editors={[{ fieldId: kernelId<'field'>('value'), label: '数量', codec: createNumberCodec({ invalid: workspaceZhCN.values.number, empty: 'null' }) }]} /></StrictMode>)
}

const resourceEditors: readonly WorkspaceGridEditor[] = [{ ...editors[0]!, resourceTask: { kind: 'durable', definition: { id: 'upload', version: 'v1' } } }]
export function mountResourceWorkspaceGrid(container: HTMLElement) {
  root ??= createFixtureRoot(container)
  root.render(<StrictMode><WorkspaceDataGrid workspace={workspaceForReactFixture()} viewId={kernelId<'view'>('grid-editor')} columns={columns}
    editors={resourceEditors} caption="Workspace rows" /></StrictMode>)
}
