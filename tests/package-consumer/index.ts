import {
  DataGrid,
  createCellTypeRegistry,
  createGridColumnHelper,
  createRemoteGridDataSource,
  createStringCellType,
  useDataGridBinding,
  type GridCellTypeSchemaOf,
  type GridDataSource,
  type GridDataSourceSnapshot,
  type GridReadyDataSourceSnapshot,
} from 'data-editor-table'
import { zhCN } from 'data-editor-table/locales/zh-CN'
import { createGridController } from 'data-editor-table/engine'
import 'data-editor-table/styles.css'
import 'data-editor-table/structure.css'
import 'data-editor-table/theme.css'

type Row = { id: number; name: string }

export const registry = createCellTypeRegistry<Row>()
  .register('string', createStringCellType())

type Schema = GridCellTypeSchemaOf<typeof registry>

let snapshot: GridDataSourceSnapshot<Row> = {
  rows: [{ id: 1, name: 'Ada' }],
  status: 'ready',
  version: 1,
  scope: { kind: 'complete' },
}

export const dataSource: GridDataSource<Row, number, Schema> = {
  columns: [{
    key: 'name',
    label: 'Name',
    type: 'string',
    getValue: (row) => row.name,
    setValue: (row, name) => ({ ...row, name }),
  }],
  getRowKey: (row) => row.id,
  getSnapshot: () => snapshot,
  subscribe: () => () => undefined,
  persistence: {
    mode: 'manual-save',
    commit: async (request) => {
      const next = { rows: request.rows, status: 'ready', version: Number(request.sourceVersion) + 1, scope: { kind: 'complete' } } satisfies GridReadyDataSourceSnapshot<Row>
      snapshot = next
      return { operationId: request.operationId, applied: next }
    },
  },
}

export const headlessController = createGridController<Row, number, Schema>({ dataSource, cellBehaviors: registry.behaviors })
export const TurnkeyGrid = DataGrid<Row, number, Schema>
export const createBindingHook = useDataGridBinding<Row, number, Schema>
export const chineseGridMessages = zhCN.dataGrid

export const remoteDataSource = createRemoteGridDataSource<Row, number, Schema>({
  columns: dataSource.columns,
  getRowKey: dataSource.getRowKey,
  initialSnapshot: snapshot,
  persistence: {
    mode: 'manual-save',
    mutate: async (request) => ({
      kind: 'applied',
      authority: {
        rows: request.rows,
        version: Number(request.sourceVersion) + 1,
      },
    }),
  },
})

type QuickStartProduct = {
  id: string
  name: string
  active: boolean
}

const quickStartColumn = createGridColumnHelper<QuickStartProduct>()

/** Standard columns infer the default schema without an explicit registry or schema generic. */
export const quickStartDataSource = createRemoteGridDataSource({
  columns: [
    quickStartColumn.field('name', { label: 'Name', type: 'string' }),
    quickStartColumn.field('active', { label: 'Active', type: 'boolean' }),
  ],
  getRowKey: (row) => row.id,
  initialSnapshot: {
    rows: [{ id: 'product-1', name: 'Poster', active: true }],
    status: 'ready',
    version: 1,
    scope: { kind: 'complete' },
  },
  persistence: {
    mode: 'auto-save',
    mutate: async (request) => ({
      kind: 'applied',
      authority: { rows: request.rows, version: 2 },
    }),
  },
})

const invalidDataSource: GridDataSource<Row, number, Schema> = {
  ...dataSource,
  columns: [{
    key: 'name', label: 'Name', type: 'string',
    // @ts-expect-error A registered string column cannot expose a number value.
    getValue: () => 42,
    setValue: (row, name) => ({ ...row, name }),
  }],
}
void invalidDataSource

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
