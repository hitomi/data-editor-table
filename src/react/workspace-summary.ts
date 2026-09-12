import { readDocument, resourceValuesEqual } from '../kernel/document.js'
import type { ViewPredicate } from '../kernel/model.js'
import type { KernelProjection } from '../kernel/projection.js'
import type { KernelSchema } from '../kernel/schema.js'
import { scopeView, type projectView } from '../kernel/view.js'
import type { WorkspaceGridColumn } from './workspace-grid-viewport.js'

/** User-visible changes, independent of journal length and search visibility.
 * A new row contributes its displayed fields plus the row insertion itself. */
export function workspaceChangeCount(projection: KernelProjection, schema: KernelSchema,
  columns: readonly Pick<WorkspaceGridColumn, 'fieldId'>[], view: ReturnType<typeof projectView>, rowScope?: ViewPredicate) {
  const before = projection.rows.map(row => ({ ...row, preview: row.authority, existence: 'present' as const }))
  const after = projection.rows.filter(row => row.preview && row.existence !== 'pending-delete')
  const included = (rows: typeof projection.rows) => new Set((rowScope
    ? scopeView({ ...view, rows }, { ...projection, rows }, schema, rowScope).rows
    : rows.filter(row => row.preview)).map(row => row.entityId))
  const originalRows = included(before), currentRows = included(after)
  const paths = columns.map(column => {
    const binding = schema.fields.find(field => field.id === column.fieldId)
    if (!binding) throw new Error('A summary column requires a schema field.')
    return binding.path
  })
  let changed = 0
  for (const row of projection.rows) {
    const original = originalRows.has(row.entityId), current = currentRows.has(row.entityId)
    if (original && current) {
      changed += paths.filter(path => !resourceValuesEqual(readDocument(row.authority!, path), readDocument(row.preview!, path))).length
    } else if (original) changed++
    else if (current) changed += paths.length + 1
  }
  // Inserting/deleting members does not by itself mean their relative order changed.
  if (projection.orderChange) {
    const common = (id: typeof projection.rows[number]['entityId']) => originalRows.has(id) && currentRows.has(id)
    const originalOrder = projection.order.authority.filter(common), currentOrder = projection.order.preview.filter(common)
    if (originalOrder.length !== currentOrder.length || originalOrder.some((id, index) => id !== currentOrder[index])) changed++
  }
  return changed
}
