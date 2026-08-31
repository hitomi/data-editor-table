import type {
  GridColumnFilter,
  GridCompiledColumn,
  GridRowKey,
  GridSort,
  GridViewState,
} from '../model/grid-model.js'
import { invokeGridCallback, invokeGridResult } from './safe-callback.js'
import { resolveGridCellValue } from './runtime-cell-resolver.js'

export function deriveLocalView<Row, RowKey extends GridRowKey>(
  options: Readonly<{
    rows: readonly Row[]
    columns: readonly GridCompiledColumn<Row>[]
    getRowKey: (row: Row) => RowKey
    globalFilter: string
    columnFilters: readonly GridColumnFilter[]
    sort: readonly GridSort[]
    revision: number
  }>,
): GridViewState<RowKey> {
  const query = options.globalFilter.trim().toLocaleLowerCase()
  const rows = options.rows.filter((row) => {
    if (
      query &&
      !options.columns.some((column) => {
        const text = textForSearch(column, row)
        return text === null || text.toLocaleLowerCase().includes(query)
      })
    )
      return false
    return matchesColumnFilters(row, options.columnFilters, options.columns)
  })

  const columnByKey = new Map(
    options.columns.map((column) => [column.key, column] as const),
  )
  const indexed = rows.map((row, index) => ({ row, index }))
  indexed.sort((left, right) => {
    for (const sort of options.sort) {
      const column = columnByKey.get(sort.columnKey)
      if (!column?.behavior.compare) continue
      const leftValue = resolveGridCellValue(left.row, column)
      const rightValue = resolveGridCellValue(right.row, column)
      if (!leftValue.valid || !rightValue.valid) continue
      const compared = invokeGridCallback(() =>
        column.behavior.compare!(
          leftValue.value,
          rightValue.value,
          { columnKey: column.key, typeOptions: column.typeOptions },
        ),
      )
      const comparison = compared.ok ? compared.value : 0
      if (comparison !== 0)
        return sort.direction === 'ascending' ? comparison : -comparison
    }
    return left.index - right.index
  })

  return Object.freeze({
    revision: options.revision,
    visibleRowKeys: Object.freeze(
      indexed.map(({ row }) => options.getRowKey(row)),
    ),
    globalFilter: options.globalFilter,
    columnFilters: Object.freeze([...options.columnFilters]),
    sort: Object.freeze([...options.sort]),
  })
}

function textForSearch<Row>(column: GridCompiledColumn<Row>, row: Row) {
  const resolved = resolveGridCellValue(row, column)
  if (!resolved.valid) return null
  const context = {
    row,
    columnKey: column.key,
    typeOptions: column.typeOptions,
  }
  const result = invokeGridCallback(() =>
    (column.behavior.text.search ?? column.behavior.text.display)(
      resolved.value,
      context,
    ),
  )
  return result.ok ? result.value : null
}

function matchesColumnFilters<Row>(
  row: Row,
  filters: readonly GridColumnFilter[],
  columns: readonly GridCompiledColumn<Row>[],
) {
  const byColumn = new Map<string, GridColumnFilter[]>()
  for (const filter of filters) {
    const group = byColumn.get(filter.columnKey)
    if (group) group.push(filter)
    else byColumn.set(filter.columnKey, [filter])
  }

  for (const group of byColumn.values()) {
    const applicable = group
      .map((filter) => matchesFilter(row, filter, columns))
      .filter((result): result is boolean => result !== null)
    if (applicable.length === 0) continue
    const combine = group[0]?.combine ?? 'all'
    if (
      combine === 'all'
        ? applicable.some((result) => !result)
        : applicable.every((result) => !result)
    ) {
      return false
    }
  }
  return true
}

function matchesFilter<Row>(
  row: Row,
  filter: GridColumnFilter,
  columns: readonly GridCompiledColumn<Row>[],
): boolean | null {
  const column = columns.find((candidate) => candidate.key === filter.columnKey)
  const behavior = column?.behavior.filter
  if (!column || !behavior) return null
  const operator = behavior.operators.find(
    (candidate) => candidate.id === filter.operator,
  )
  if (!operator) return null
  const resolved = resolveGridCellValue(row, column)
  if (!resolved.valid) return null
  if (operator.requiresValue) {
    const validation = operator.validate
      ? invokeGridResult(() => operator.validate!(filter.value))
      : undefined
    if (validation && !validation.ok) return null
  }
  const matched = invokeGridCallback(() =>
    operator.matches(resolved.value, filter.value, {
      row,
      columnKey: column.key,
      typeOptions: column.typeOptions,
    }),
  )
  return matched.ok ? matched.value : null
}
