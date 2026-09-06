import { deriveLocalView } from '../data/local-view.js'
import { invokeGridResult } from '../data/safe-callback.js'
import type { GridCompiledColumn, GridInteractionState, GridLayoutState, GridRowKey, GridViewState } from '../model/grid-model.js'
import { resolveGridLayout } from './controller-state.js'
import { reconcileInteractionAfterViewChange } from './interaction-transitions.js'

type GridViewChanges<RowKey extends GridRowKey> = Partial<Pick<GridViewState<RowKey>, 'globalFilter' | 'columnFilters' | 'sort'>>

/** All validation and derived reads finish before the workflow can publish. */
export function transitionGridView<Row, RowKey extends GridRowKey>(input: Readonly<{
  changes: GridViewChanges<RowKey>
  view: GridViewState<RowKey>
  rows: readonly Row[]
  interaction: GridInteractionState<RowKey>
  layout: GridLayoutState
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  sizes: Readonly<{ rowHeight: number; headerHeight: number; rowIndicatorWidth: number }>
}>) {
  const { changes, columns, rows, getRowKey, sizes } = input
  const issue = gridViewChangeIssue(changes, columns)
  if (issue) return { ok: false as const, issue }
  const query = { ...input.view, ...changes }
  const view = deriveLocalView({
    rows, columns, getRowKey,
    globalFilter: query.globalFilter, columnFilters: query.columnFilters, sort: query.sort,
    revision: input.view.revision + 1,
  })
  const interaction = reconcileInteractionAfterViewChange(input.interaction, view.visibleRowKeys, columns.map((column) => column.key))
  const layout = resolveGridLayout(columns, view.visibleRowKeys.length, input.layout, sizes, input.layout.revision + 1)
  return { ok: true as const, changes: Object.freeze({ view, interaction, layout }) }
}

function gridViewChangeIssue<Row, RowKey extends GridRowKey>(
  changes: GridViewChanges<RowKey>,
  columns: readonly GridCompiledColumn<Row>[],
): string | null {
  for (const sort of changes.sort ?? []) {
    const column = columns.find((candidate) => candidate.key === sort.columnKey)
    if (!column?.sortable || !column.behavior.compare)
      return `Column "${sort.columnKey}" does not support sorting.`
  }
  for (const filter of changes.columnFilters ?? []) {
    const column = columns.find((candidate) => candidate.key === filter.columnKey)
    if (!column?.filterable || !column.behavior.filter)
      return `Column "${filter.columnKey}" does not support filtering.`
    const operator = column.behavior.filter.operators.find((candidate) => candidate.id === filter.operator)
    if (!operator) return `Filter operator "${filter.operator}" is unavailable for column "${filter.columnKey}".`
    if (operator.validate) {
      const validated = invokeGridResult(() => operator.validate!(filter.value))
      if (!validated.ok) return validated.issue.message
    }
  }
  return null
}
