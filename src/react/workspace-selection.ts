import type { EntityId, FieldId, FieldRef } from '../kernel/model.js'

/** Resolve the captured display axes, never the current visible row positions.
 * A removed column invalidates the target instead of silently narrowing it. */
export function workspaceSelectionFields(selection: Pick<WorkspaceGridSelection, 'rows' | 'columns'>,
  columns: readonly Readonly<{ id: string; fieldId: FieldId }>[]): readonly FieldRef[] | null {
  const bindings = new Map(columns.map(column => [column.id, column.fieldId]))
  if (bindings.size !== columns.length) throw new Error('Display column identities must be unique.')
  const fields = new Set<FieldId>()
  for (const column of selection.columns) {
    const field = bindings.get(column)
    if (!field) return null
    fields.add(field)
  }
  return Object.freeze(selection.rows.flatMap(entityId => [...fields].map(fieldId => Object.freeze({ entityId, fieldId }))))
}

export type WorkspaceGridCell = Readonly<{ entityId: EntityId; columnId: string }>
export type WorkspaceGridSelection = Readonly<{
  anchor: WorkspaceGridCell; focus: WorkspaceGridCell; rows: readonly EntityId[]; columns: readonly string[]
}>

/** Capture membership only at a user gesture. Reordering or filtering the view
 * must not reevaluate an old rectangle and silently select different entities. */
export function selectWorkspaceRange(rows: readonly EntityId[], columns: readonly string[], focus: WorkspaceGridCell,
  anchor: WorkspaceGridCell = focus): WorkspaceGridSelection {
  if (new Set(rows).size !== rows.length || new Set(columns).size !== columns.length || rows.some(id => !id) || columns.some(id => !id)) throw new Error('Selection axes require unique nonempty identities.')
  const endRow = rows.indexOf(focus.entityId), endColumn = columns.indexOf(focus.columnId)
  if (endRow < 0 || endColumn < 0) throw new Error('Selection requires a currently visible target.')
  let startRow = rows.indexOf(anchor.entityId), startColumn = columns.indexOf(anchor.columnId)
  if (startRow < 0 || startColumn < 0) { anchor = focus; startRow = endRow; startColumn = endColumn }
  // Fixed identity axes encode the Cartesian membership without allocating one
  // object per selected cell. Later gestures may form a new rectangle.
  return Object.freeze({ anchor: Object.freeze({ ...anchor }), focus: Object.freeze({ ...focus }),
    rows: Object.freeze(rows.slice(Math.min(startRow, endRow), Math.max(startRow, endRow) + 1)),
    columns: Object.freeze(columns.slice(Math.min(startColumn, endColumn), Math.max(startColumn, endColumn) + 1)) })
}
