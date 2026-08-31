import type { GridCellBehaviorPort, GridColumn, GridCompiledColumn, GridValueResult } from '../model/grid-model.js'
import type {
  GridCellTypeSchema,
  GridColumnForCellTypes,
} from '../cell-types/contracts.js'

export function compileGridColumns<Row, Schema extends GridCellTypeSchema>(
  columns: readonly GridColumnForCellTypes<Row, Schema>[],
  behaviors: GridCellBehaviorPort<Row>,
): readonly GridCompiledColumn<Row>[] {
  const issues: string[] = []
  const keys = new Set<string>()
  const compiled: GridCompiledColumn<Row>[] = []

  for (const definition of columns) {
    const column = eraseGridColumn(definition)
    if (column.key.trim().length === 0) issues.push('Column keys cannot be empty or whitespace.')
    if (keys.has(column.key)) issues.push(`Column key "${column.key}" is registered more than once.`)
    keys.add(column.key)
    const behavior = behaviors.resolve(column.type)
    if (!behavior) {
      issues.push(`Column "${column.key}" uses unregistered cell type "${column.type}".`)
      continue
    }
    if (column.sortable && !behavior.compare) issues.push(`Column "${column.key}" is sortable, but cell type "${column.type}" has no compare capability.`)
    if (column.filterable && !behavior.filter) issues.push(`Column "${column.key}" is filterable, but cell type "${column.type}" has no filter capability.`)
    if (column.bulkEditable && !behavior.bulk) issues.push(`Column "${column.key}" enables bulk editing, but cell type "${column.type}" has no bulk capability.`)
    validateColumnLayout(column.key, column.layout, issues)

    compiled.push(Object.freeze({
      key: column.key,
      label: column.label,
      type: column.type,
      typeOptions: column.typeOptions,
      layout: Object.freeze({ ...column.layout }),
      getValue: column.getValue,
      setValue: column.setValue ? (row: Row, value: unknown) => column.setValue!(row, value) : null,
      isEditable: (row: Row) => {
        if (column.setValue === undefined) return false
        try {
          return column.isEditable?.(row) ?? true
        } catch {
          return false
        }
      },
      validate: column.validate ? (value: unknown, row: Row) => column.validate!(value, row) as GridValueResult<unknown> : null,
      sortable: column.sortable ?? false,
      filterable: column.filterable ?? false,
      bulkEditable: column.bulkEditable ?? false,
      behavior,
    }))
  }

  if (issues.length > 0) throw new Error(`Invalid Grid configuration:\n- ${issues.join('\n- ')}`)
  return Object.freeze(compiled)
}

function eraseGridColumn<
  Row,
  Value,
  Type extends string,
  ColumnOptions,
>(column: GridColumn<Row, Value, Type, ColumnOptions>) {
  const setValue = column.setValue
  const validate = column.validate
  return {
    ...column,
    getValue: (row: Row): unknown => column.getValue(row),
    setValue: setValue
      ? (row: Row, value: unknown) => setValue(row, value as Value)
      : undefined,
    validate: validate
      ? (value: unknown, row: Row) => validate(value as Value, row)
      : undefined,
  }
}

function validateColumnLayout(
  columnKey: string,
  layout: GridColumn<unknown>['layout'],
  issues: string[],
) {
  if (!layout) return
  for (const [name, value] of Object.entries(layout)) {
    const valid =
      value === undefined ||
      (Number.isFinite(value) && (name === 'flex' ? value >= 0 : value > 0))
    if (!valid) {
      issues.push(
        `Column "${columnKey}" layout.${name} must be ${
          name === 'flex' ? 'finite and non-negative' : 'finite and positive'
        }.`,
      )
    }
  }
  if (
    layout.min !== undefined &&
    layout.max !== undefined &&
    layout.min > layout.max
  ) {
    issues.push(`Column "${columnKey}" layout.min cannot exceed layout.max.`)
  }
}
