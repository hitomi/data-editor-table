import {
  DataGrid,
  createCellTypeRegistry,
  createGridColumnHelper,
  createFieldGridDocumentModel,
  createRemoteGridDataSource,
  createStringCellType,
  selectGridActions,
  useDataGridBinding,
  type GridCellTypeSchemaOf,
  type GridCellTypeSchema,
  type GridColumnForCellTypes,
  type GridDataSource,
} from 'data-editor-table'
import type { DefinitiveResult, PersistenceSource, ScopeIdentity, ServerAuthority } from 'data-editor-table/protocol'
import { zhCN } from 'data-editor-table/locales/zh-CN'
import { createGridController, type GridCommandTarget } from 'data-editor-table/engine'
import 'data-editor-table/styles.css'
import 'data-editor-table/structure.css'
import 'data-editor-table/theme.css'

type Row = { id: number; name: string }

export const registry = createCellTypeRegistry<Row>()
  .register('string', createStringCellType())

type Schema = GridCellTypeSchemaOf<typeof registry>

// A consumer can reuse the same model factory for custom and standard registries.
export function fieldModel<Row extends object, Schema extends GridCellTypeSchema>(
  columns: readonly GridColumnForCellTypes<Row, Schema>[],
) {
  return createFieldGridDocumentModel(columns)
}

type AuthorityOptions = Readonly<{
  source: PersistenceSource
  scope: ScopeIdentity
  initialAuthority: ServerAuthority
}>

export function createCustomConsumer(authority: AuthorityOptions) {
  const columns = [createGridColumnHelper<Row, Schema>().field('name', { label: 'Name', type: 'string' })]
  const remote = createRemoteGridDataSource<Row, number, Schema>({
    ...authority, columns, model: createFieldGridDocumentModel(columns),
    getRowKey: row => row.id, persistence: { mode: 'manual-save' },
  })
  const dataSource: GridDataSource<Row, number, Schema> = remote
  const controller = createGridController<Row, number, Schema>({ dataSource, cellBehaviors: registry.behaviors })
  const publishRemoteRead: (snapshot: ServerAuthority) => void = remote.publish
  function bindRename(rowKey: number) {
    const entityId = controller.getSnapshot().draft.entityAt(rowKey)
    if (!entityId) return null
    const target: GridCommandTarget<number> = { kind: 'row', rowKey, entityId }
    return (value: string) => controller.dispatch({ type: 'cell/set-value', cell: { rowKey, columnKey: 'name' }, value }, target)
  }
  function bindSave() {
    const { save } = selectGridActions(controller.getSnapshot())
    return save.enabled ? () => controller.save(save.target) : null
  }
  function resolveDispute(id: string, verified: DefinitiveResult) {
    if (remote.getDispute(id)) remote.resolveDispute(id, verified)
  }
  return { controller, bindRename, bindSave, resolveDispute, publishRemoteRead, refreshRemoteRead: () => controller.refresh() }
}
export const TurnkeyGrid = DataGrid<Row, number, Schema>
export const createBindingHook = useDataGridBinding<Row, number, Schema>
export const chineseGridMessages = zhCN.dataGrid

type QuickStartProduct = {
  id: string
  name: string
  active: boolean
}

const quickStartColumn = createGridColumnHelper<QuickStartProduct>()

/** Standard columns infer the default schema without an explicit registry or schema generic. */
const quickStartColumns = [
  quickStartColumn.field('name', { label: 'Name', type: 'string',
    validate: value => ({ ok: true, value: value.trim() }),
    validateWithRow: (value, row) => row.active ? { ok: true, value } : { ok: false, issue: { code: 'inactive', message: 'Inactive product' } },
  }),
  quickStartColumn.field('active', { label: 'Active', type: 'boolean' }),
]
export function createQuickStartSource(authority: AuthorityOptions) {
  return createRemoteGridDataSource({
    ...authority, columns: quickStartColumns, model: createFieldGridDocumentModel(quickStartColumns),
    getRowKey: row => row.id, persistence: { mode: 'auto-save' },
  })
}

const invalidColumns: GridDataSource<Row, number, Schema>['columns'] = [{
  key: 'name', label: 'Name', type: 'string',
  // @ts-expect-error A registered string column cannot expose a number value.
  getValue: () => 42,
  setValue: (row, name) => ({ ...row, name }),
}]
void invalidColumns

type ChoiceRow = {
  status: 'draft' | 'ready'
  nullableStatus: 'draft' | 'ready' | null
  tags: readonly ('featured' | 'seasonal')[]
}

const choiceColumn = createGridColumnHelper<ChoiceRow>()
choiceColumn.field('status', {
  label: 'Status',
  type: 'singleSelect',
  options: [
    { value: 'draft', label: 'Draft' },
    { value: 'ready', label: 'Ready' },
  ],
})
choiceColumn.field('tags', {
  label: 'Tags',
  type: 'multiSelect',
  options: [
    { value: 'featured', label: 'Featured' },
    { value: 'seasonal', label: 'Seasonal' },
  ],
})
choiceColumn.field('status', {
  label: 'Invalid status',
  type: 'singleSelect',
  options: [
    // @ts-expect-error Column options must fit the exact field value union.
    { value: 'archived', label: 'Archived' },
  ],
})
// @ts-expect-error Nullable select fields must opt in explicitly.
choiceColumn.field('nullableStatus', {
  label: 'Nullable status',
  type: 'singleSelect',
  options: [{ value: 'draft', label: 'Draft' }],
})
