import { ownEncodedValue } from '../kernel/document.js'
import type { WorkspaceTextCodec } from '../value-codecs.js'
import type { Document, FieldId, ResourceValue, EntityId } from '../kernel/model.js'
import type { WorkspaceGridCell } from './workspace-selection.js'

export type FillAxes = Readonly<{ rows: readonly EntityId[]; columns: readonly string[] }>
/** Repeat a literal captured pattern over the expanded rectangle. Row order
 * comes from the gesture's view, never a later query or server key lookup. */
export function expandWorkspaceFill(view: FillAxes, source: FillAxes, values: readonly (readonly string[])[], destination: WorkspaceGridCell) {
  function interval<T>(axis: readonly T[], selected: readonly T[]): readonly [number, number] {
    if (!axis.length || new Set(axis).size !== axis.length || !selected.length) throw new Error('Fill requires complete unique axes.')
    const first = axis.indexOf(selected[0]!)
    if (first < 0 || selected.some((value, index) => axis[first + index] !== value)) throw new Error('Fill source must be a consecutive visible rectangle.')
    return [first, first + selected.length - 1]
  }
  const [top, bottom] = interval(view.rows, source.rows), [left, right] = interval(view.columns, source.columns)
  if (values.length !== source.rows.length || values.some(row => row.length !== source.columns.length)) throw new Error('Fill pattern must cover the complete source selection.')
  const endRow = view.rows.indexOf(destination.entityId), endColumn = view.columns.indexOf(destination.columnId)
  if (endRow < 0 || endColumn < 0) throw new Error('Fill destination was not part of the captured view.')
  const firstRow = Math.min(top, endRow), firstColumn = Math.min(left, endColumn)
  const rows = view.rows.slice(firstRow, Math.max(bottom, endRow) + 1), columns = view.columns.slice(firstColumn, Math.max(right, endColumn) + 1)
  const modulo = (value: number, length: number) => ((value % length) + length) % length
  return Object.freeze({ rows: Object.freeze(rows), columns: Object.freeze(columns),
    values: Object.freeze(rows.map((_, row) => Object.freeze(columns.map((_, column) =>
      values[modulo(firstRow + row - top, source.rows.length)]![modulo(firstColumn + column - left, source.columns.length)]!)))) })
}

export type WorkspaceFillContext = Readonly<{
  sourceValues: readonly ResourceValue[]; repeatedValue: ResourceValue
  sourceStartIndex: 0; targetIndex: number; direction: 'up' | 'down' | 'left' | 'right'
  entityId: EntityId; document: Document; columnId: string; fieldId: FieldId
}>
/** Synchronous, pure value generation. Context belongs to the captured gesture;
 * returning a value never authorizes an immediate write. Throw to reject fill. */
export type WorkspaceFill = (context: WorkspaceFillContext) => ResourceValue
export type WorkspaceFillColumn = Readonly<{ id: string; fieldId: FieldId; codec: WorkspaceTextCodec; fill?: WorkspaceFill }>

export function resolveWorkspaceFill(view: FillAxes, source: FillAxes, values: readonly (readonly string[])[], destination: WorkspaceGridCell,
  columns: readonly WorkspaceFillColumn[], documents: ReadonlyMap<EntityId, Document>) {
  const expanded = expandWorkspaceFill(view, source, values, destination)
  const top = view.rows.indexOf(source.rows[0]!), left = view.columns.indexOf(source.columns[0]!)
  const endRow = view.rows.indexOf(destination.entityId), endColumn = view.columns.indexOf(destination.columnId)
  // A diagonal expansion extends the row sequence; horizontal-only gestures
  // extend the source row across columns with target-codec conversion.
  const vertical = endRow < top || endRow >= top + source.rows.length
  const direction = vertical ? endRow < top ? 'up' : 'down' : endColumn < left ? 'left' : 'right'
  const modulo = (value: number, length: number) => ((value % length) + length) % length
  const readEntities = new Set<EntityId>()
  const resolved = expanded.rows.map(entityId => expanded.columns.map(columnId => {
    const row = view.rows.indexOf(entityId) - top, column = view.columns.indexOf(columnId) - left
    const literal = values[modulo(row, source.rows.length)]![modulo(column, source.columns.length)]!
    if (row >= 0 && row < source.rows.length && column >= 0 && column < source.columns.length) return literal
    const definition = columns.find(candidate => candidate.id === columnId)
    if (!definition) throw new Error('Fill requires every captured destination codec.')
    if (!definition.fill) return literal
    const document = documents.get(entityId)
    if (!document) throw new Error('Fill requires the captured target document.')
    readEntities.add(entityId)
    const sequence = vertical ? values.map(cells => cells[modulo(column, source.columns.length)]!) : values[modulo(row, source.rows.length)]!
    const sourceValues = sequence.map(text => {
      const parsed = definition.codec.parse(text)
      if (parsed.kind !== 'valid') throw new Error('Fill source cannot be converted to the destination field.')
      return parsed.value
    })
    const targetIndex = vertical ? row : column
    const context = ownEncodedValue({ sourceValues, repeatedValue: sourceValues[modulo(targetIndex, sourceValues.length)]!,
      sourceStartIndex: 0, targetIndex, direction, entityId, document, columnId, fieldId: definition.fieldId }) as unknown as WorkspaceFillContext
    const result = ownEncodedValue(definition.fill(context)) as ResourceValue
    if (!result || (result.kind !== 'missing' && result.kind !== 'value') || result.kind === 'value' && !Object.hasOwn(result, 'value')) throw new Error('Fill must return an encoded field value.')
    const text = definition.codec.format(result)
    if (typeof text !== 'string') throw new Error('Fill formatting must produce editable text.')
    return text
  }))
  return Object.freeze({ rows: expanded.rows, columns: expanded.columns, readEntities: Object.freeze([...readEntities]), values: Object.freeze(resolved.map(row => Object.freeze(row))) })
}
