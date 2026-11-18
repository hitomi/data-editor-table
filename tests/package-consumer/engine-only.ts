import type { PersistenceSource, ScopeIdentity, ServerAuthority } from 'data-editor-table/protocol'
import {
  createGridController,
  createFieldGridDocumentModel,
  createRemoteGridDataSource,
  type GridColumnForCellTypes,
  type GridCellBehaviorPort,
  type GridCellTypeSignature,
} from 'data-editor-table/engine'

type Row = Readonly<{ id: number; name: string }>
type Schema = Readonly<{
  string: GridCellTypeSignature<string>
}>

const columns: readonly GridColumnForCellTypes<Row, Schema>[] = [{
  key: 'name', label: 'Name', type: 'string', storagePath: ['name'],
  getValue: row => row.name, setValue: (row, name) => ({ ...row, name }),
}]
export function createEngineOnlyController(
  source: PersistenceSource,
  scope: ScopeIdentity,
  initialAuthority: ServerAuthority,
  cellBehaviors: GridCellBehaviorPort<Row>,
) {
  const dataSource = createRemoteGridDataSource<Row, number, Schema>({
    columns, model: createFieldGridDocumentModel(columns),
    getRowKey: row => row.id, source, scope, initialAuthority, persistence: { mode: 'manual-save' },
  })
  return createGridController<Row, number, Schema>({ dataSource, cellBehaviors })
}
