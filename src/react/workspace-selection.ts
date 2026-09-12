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

export type WorkspaceSelectionSet = Readonly<{
  ranges: readonly WorkspaceGridSelection[]
  rowOrder: readonly EntityId[]
  columnOrder: readonly string[]
}>

export function updateWorkspaceSelection(previous: WorkspaceSelectionSet | null, range: WorkspaceGridSelection,
  mode: 'replace' | 'append' | 'extend', rows: readonly EntityId[], columns: readonly string[]): WorkspaceSelectionSet {
  const keep = mode !== 'replace' && previous
  return Object.freeze({
    ranges: Object.freeze(!keep ? [range] : mode === 'append' ? [...keep.ranges, range] : [...keep.ranges.slice(0, -1), range]),
    rowOrder: Object.freeze(!keep ? [...rows] : [...new Set([...keep.rowOrder, ...rows])]),
    columnOrder: Object.freeze(!keep ? [...columns] : [...new Set([...keep.columnOrder, ...columns])]),
  })
}

export function workspaceSelectionContains(ranges: readonly Pick<WorkspaceGridSelection, 'rows' | 'columns'>[], cell: WorkspaceGridCell) {
  return ranges.some(range => range.rows.includes(cell.entityId) && range.columns.includes(cell.columnId))
}

/** Union membership, never the Cartesian product of unrelated selected ranges. */
export function workspaceSelectionSetFields(ranges: readonly Pick<WorkspaceGridSelection, 'rows' | 'columns'>[],
  columns: readonly Readonly<{ id: string; fieldId: FieldId }>[]): readonly FieldRef[] | null {
  const fields = new Map<string, FieldRef>()
  for (const range of ranges) {
    const resolved = workspaceSelectionFields(range, columns)
    if (!resolved) return null
    for (const field of resolved) fields.set(JSON.stringify([field.entityId, field.fieldId]), field)
  }
  return Object.freeze([...fields.values()])
}

/** Clipboard rectangles retain blank holes between disjoint selections. The
 * mask is also retained for authoring so those holes cannot become writes. */
export function workspaceSelectionEnvelope(selection: WorkspaceSelectionSet) {
  const rows = new Set(selection.ranges.flatMap(range => range.rows)), columns = new Set(selection.ranges.flatMap(range => range.columns))
  const bounds = <T,>(order: readonly T[], selected: Set<T>) => {
    const indexes = order.flatMap((id, index) => selected.has(id) ? [index] : [])
    if (indexes.length !== selected.size || !indexes.length) throw new Error('Selection axes are unavailable.')
    return order.slice(indexes[0]!, indexes.at(-1)! + 1)
  }
  return { rows: bounds(selection.rowOrder, rows), columns: bounds(selection.columnOrder, columns),
    members: selection.ranges.flatMap(range => range.rows.flatMap(entityId => range.columns.map(columnId => ({ entityId, columnId })))) }
}

/** Count the visible union, not the rectangular envelope or hidden members.
 * Multiple display columns for one storage field are still distinct cells. */
export function workspaceSelectionSummary(ranges: readonly Pick<WorkspaceGridSelection, 'rows' | 'columns'>[],
  visibleRows: readonly EntityId[], visibleColumns: readonly string[]) {
  const rows = new Set(visibleRows), columns = new Set(visibleColumns)
  const membership = new Map<EntityId, Set<string>>(), selectedColumns = new Set<string>()
  for (const range of ranges) {
    const included = range.columns.filter(column => columns.has(column))
    if (!included.length) continue
    for (const row of range.rows) {
      if (!rows.has(row)) continue
      let selected = membership.get(row)
      if (!selected) { selected = new Set(); membership.set(row, selected) }
      for (const column of included) { selected.add(column); selectedColumns.add(column) }
    }
  }
  return { rows: membership.size, columns: selectedColumns.size,
    cells: [...membership.values()].reduce((sum, columns) => sum + columns.size, 0) }
}
