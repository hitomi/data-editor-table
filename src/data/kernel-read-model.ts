import type { GridCompiledColumn, GridConflict, GridDirtyCell, GridReadModel, GridRowKey } from '../model/grid-model.js'
import type { GridIssue } from '../model/grid-result.js'
import type { KernelState } from '../kernel/state.js'
import type { EntityId } from '../kernel/model.js'
import type { GridKernelDataProjection } from './kernel-projection.js'
import type { GridCompiledDocumentModel } from './runtime-columns.js'
import { fieldResolutionIssues } from '../kernel/field-resolution.js'
import { decodeRow } from '../kernel/schema.js'
import { collectRowValidationIssues } from './row-invariants.js'
import { areGridResolvedCellValuesEqual, resolveGridCellValue } from './runtime-cell-resolver.js'
import { formatGridOriginalValue } from './safe-callback.js'

/** Compatibility projection only: no write, history or submission is derived
 * back from these rows. Save eligibility comes directly from kernel changes. */
export function projectGridReadModel<Row, RowKey extends GridRowKey>(state: KernelState, projection: GridKernelDataProjection<Row, RowKey>,
  model: GridCompiledDocumentModel<Row>, columns: readonly GridCompiledColumn<Row>[], getRowKey: (row: Row) => RowKey,
): GridReadModel<Row, RowKey> {
  const authority = state.authority.content.kind === 'complete' ? state.authority.content.snapshot : null
  let retainedKeys: Map<EntityId, RowKey> | undefined
  const keyFor = (id: EntityId): RowKey => {
    const row = projection.byId.get(id)
    if (row) return row.rowKey
    if (!retainedKeys) {
      retainedKeys = new Map()
      for (const binding of state.entities) if (binding.kind !== 'local') retainedKeys.set(binding.entityId, binding.identity.key as RowKey)
      for (const { operation } of state.journal.intents) {
        if (operation.kind === 'create' && !projection.byId.has(operation.entityId) && !retainedKeys.has(operation.entityId))
          retainedKeys.set(operation.entityId, getRowKey(decodeRow(model.codec, operation.document)))
      }
    }
    const key = retainedKeys.get(id)
    if (key !== undefined) return key
    throw new Error('A retained entity has no business identity.')
  }
  const dirtyCells: GridDirtyCell<RowKey>[] = [], conflicts: GridConflict<RowKey>[] = []
  for (const entity of projection.byId.values()) {
    if (entity.data.persistence === 'clean') continue
    for (const column of columns) {
      const value = resolveGridCellValue(entity.row, column)
      const original = entity.authority === null ? null : resolveGridCellValue(entity.authority, column)
      if (original && areGridResolvedCellValuesEqual(value, original)) continue
      dirtyCells.push(Object.freeze({ rowKey: entity.rowKey, columnKey: column.key, originalValue: original?.rawValue,
        formattedOriginalValue: original ? original.valid ? formatGridOriginalValue(column, original.value, entity.authority!) : original.fallbackText : '',
      }))
    }
  }
  const excluded: GridIssue[] = []
  for (const row of projection.data.rows) for (const issue of row.issues) {
    const kind = issue.code === 'create-key-collision' ? 'inserted-key-collision'
      : row.existence === 'remote-deleted' ? 'remote-row-deleted'
      : row.existence === 'pending-delete' ? 'local-row-deleted-remote-changed' : 'field'
    const bindings = model.columns.filter(binding => binding.fields.length === 1 && fieldResolutionIssues([issue], row.entityId, binding.fields[0]!.path).length)
    const fields = issue.comparison?.resources.every(resource => resource.kind === 'path') ? bindings : []
    const rowKey = keyFor(row.entityId), binding = bindings[0]
    excluded.push(Object.freeze({ code: issue.code === 'schema-invalid' ? 'invalid-input'
      : issue.code === 'schema-validation-failed' || issue.code === 'materialization-blocked' ? 'adapter-error'
      : issue.code === 'policy-blocked' || issue.code === 'readonly-write' ? 'permission-denied' : 'conflict',
      message: issue.message, domainCode: issue.code,
      ...(binding ? { cell: Object.freeze({ rowKey, columnKey: binding.column.key }) } : { target: Object.freeze({ kind: 'row' as const, rowKey }) }) }))
    for (const columnKey of fields.length ? fields.map(binding => binding.column.key) : [null])
      conflicts.push(Object.freeze({ kind, rowKey: keyFor(row.entityId), columnKey, message: issue.message }))
  }
  const saveableRowKeys = projection.data.changes.filter(change => change.kind !== 'delete').map(change => keyFor(change.entityId))
  const saveableDeletedRowKeys = projection.data.changes.filter(change => change.kind === 'delete').map(change => keyFor(change.entityId))
  const blockedChangedRowKeys = [...new Set(conflicts.map(conflict => conflict.rowKey))]
  for (const issue of projection.data.order.issues) excluded.push(Object.freeze({
    code: 'conflict', domainCode: issue.code, message: issue.message, target: Object.freeze({ kind: 'order' }),
  }))
  const savePlan = Object.freeze({ excluded: Object.freeze(excluded), proposedRows: Object.freeze(projection.data.changes.flatMap(change => change.after ? [decodeRow(model.codec, change.after)] : [])),
    saveableRowKeys: Object.freeze(saveableRowKeys), saveableDeletedRowKeys: Object.freeze(saveableDeletedRowKeys),
    blockedChangedRowKeys: Object.freeze(blockedChangedRowKeys), saveableRowCount: projection.data.changes.length,
    blockedRowCount: blockedChangedRowKeys.length, orderChanged: projection.data.orderChange !== null,
    canSave: projection.data.changes.length > 0 || projection.data.orderChange !== null,
  })
  return Object.freeze({ revision: state.revision, entityAt: projection.targets.entityAt, baselineVersion: authority?.version.token ?? '', baselineRows: projection.baselineRows,
    rows: projection.rows, dirtyCells: Object.freeze(dirtyCells), conflicts: Object.freeze(conflicts),
    validationIssues: collectRowValidationIssues(projection.rows, columns, getRowKey),
    insertedRowKeys: Object.freeze(projection.data.rows.filter(row => row.existence === 'local-create').map(row => keyFor(row.entityId))),
    deletedRowKeys: Object.freeze(projection.data.rows.filter(row => row.existence === 'pending-delete').map(row => keyFor(row.entityId))),
    orderConflict: projection.data.order.issues.map(issue => issue.message).join(' ') || null,
    orderDirty: projection.data.orderChange !== null || projection.data.order.issues.length > 0,
    undoStack: Object.freeze(projection.history.undo.map(action => ({ id: action.applicationId, label: action.label, revision: state.revision }))),
    redoStack: Object.freeze(projection.history.redo.map(action => ({ id: action.applicationId, label: action.label, revision: state.revision }))), savePlan,
  })
}
