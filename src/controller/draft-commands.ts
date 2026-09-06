import { deriveLocalView } from '../data/local-view.js'
import { areGridAuthorityRowsEqual } from '../data/authority-snapshot.js'
import { findRowIdentityIssue } from '../data/row-invariants.js'
import { sameGridRowKeyOrder } from '../data/row-order.js'
import type { GridCompiledColumn, GridDraftState, GridInteractionState, GridLayoutState, GridRowKey, GridViewState } from '../model/grid-model.js'
import { resolveGridLayout } from './controller-state.js'
import { reconcileInteractionAfterRowReorder, reconcileInteractionAfterViewChange } from './interaction-transitions.js'
import { clearInteraction, rangeForHitTarget } from './selection-model.js'

/** Draft algorithms have already applied their own history semantics at this boundary. */
export type GridDraftTransition<Row, RowKey extends GridRowKey> = Readonly<{
  draft: GridDraftState<Row, RowKey>
}> & (
  | Readonly<{ kind: 'local'; transactionCost: number; selectRows?: readonly RowKey[] }>
  | Readonly<{ kind: 'recovery'; transactionCost: number }>
  | Readonly<{ kind: 'history' }>
)

/** Derive the committed read model from a typed transition, never an arbitrary publish callback. */
export function prepareGridDraftPublication<Row, RowKey extends GridRowKey>(input: Readonly<{
  transition: GridDraftTransition<Row, RowKey>
  currentDraft: GridDraftState<Row, RowKey>
  view: GridViewState<RowKey>
  interaction: GridInteractionState<RowKey>
  layout: GridLayoutState
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  sizes: Readonly<{ rowHeight: number; headerHeight: number; rowIndicatorWidth: number }>
  maxMutations: number
}>) {
  const { transition, currentDraft, columns, getRowKey, sizes } = input
  const { draft } = transition
  if (transition.kind !== 'history') {
    if (transition.transactionCost > input.maxMutations)
      return { ok: false as const, reason: 'This operation exceeds the mutation limit.' }
    const issue = findRowIdentityIssue(draft.rows, getRowKey)
    if (issue) return { ok: false as const, reason: issue }
  }
  if (draft === currentDraft) return { ok: true as const, changes: null }
  const view = deriveLocalView({
    rows: draft.rows, columns, getRowKey,
    globalFilter: input.view.globalFilter, columnFilters: input.view.columnFilters, sort: input.view.sort,
    revision: input.view.revision + 1,
  })
  const keys = columns.map((column) => column.key)
  let interaction = input.interaction
  const selectRows = transition.kind === 'local' ? transition.selectRows : undefined
  if (selectRows) {
    interaction = clearInteraction<RowKey>()
    const ranges = selectRows.map((rowKey) => rangeForHitTarget({ kind: 'row', rowKey }, view.visibleRowKeys, keys))
      .filter((range) => range !== null)
    if (ranges.length) interaction = Object.freeze({
      ...interaction, ranges: Object.freeze(ranges), activeRangeIndex: ranges.length - 1, activeCell: ranges.at(-1)!.focus,
    })
  } else if (!sameGridRowKeyOrder(input.view.visibleRowKeys, view.visibleRowKeys)) {
    const sameRows = sameRowsIgnoringOrder(currentDraft.rows, draft.rows, getRowKey)
    const visible = new Set(view.visibleRowKeys)
    const sameKeys = input.view.visibleRowKeys.length === view.visibleRowKeys.length
      && input.view.visibleRowKeys.every((key) => visible.has(key))
    interaction = sameRows && sameKeys
      ? reconcileInteractionAfterRowReorder(interaction, view.visibleRowKeys, keys)
      : reconcileInteractionAfterViewChange(interaction, view.visibleRowKeys, keys)
  }
  const layout = resolveGridLayout(columns, view.visibleRowKeys.length, input.layout, sizes, input.layout.revision + 1)
  return { ok: true as const, changes: Object.freeze({
    draft, view, interaction, layout, ...(selectRows ? { edit: null, bulk: null } : {}),
  }) }
}

function sameRowsIgnoringOrder<Row, RowKey extends GridRowKey>(left: readonly Row[], right: readonly Row[], getRowKey: (row: Row) => RowKey) {
  if (left.length !== right.length) return false
  const rightByKey = new Map(right.map((row) => [getRowKey(row), row] as const))
  return left.every((row) => {
    const key = getRowKey(row)
    return rightByKey.has(key) && areGridAuthorityRowsEqual([row], [rightByKey.get(key) as Row], getRowKey)
  })
}
