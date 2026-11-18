import { encodeCellIdentity } from '../model/cell-identity.js'
import type {
  GridControllerSnapshot,
  GridRowKey,
} from '../model/grid-model.js'

export type GridSelectorIndex<Row, RowKey extends GridRowKey> = Readonly<{
  rows: ReadonlyMap<RowKey, Row>
  columns: ReadonlyMap<
    string,
    GridControllerSnapshot<Row, RowKey>['columns'][number]
  >
  dirtyCells: ReadonlyMap<
    string,
    GridControllerSnapshot<Row, RowKey>['draft']['dirtyCells'][number]
  >
  validationIssues: ReadonlyMap<
    string,
    GridControllerSnapshot<Row, RowKey>['draft']['validationIssues'][number]
  >
  cellConflicts: ReadonlyMap<
    string,
    GridControllerSnapshot<Row, RowKey>['draft']['conflicts'][number]
  >
  rowConflictMessages: ReadonlyMap<RowKey, string>
  insertedRowKeys: ReadonlySet<RowKey>
  dirtyRowKeys: ReadonlySet<RowKey>
  dirtyColumnKeys: ReadonlySet<string>
  filterCounts: ReadonlyMap<string, number>
}>

const gridSelectorIndexes = new WeakMap<object, unknown>()

export function gridSelectorIndex<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
): GridSelectorIndex<Row, RowKey> {
  const cached = gridSelectorIndexes.get(snapshot) as
    | GridSelectorIndex<Row, RowKey>
    | undefined
  if (cached) return cached

  const rows = new Map<RowKey, Row>()
  for (const row of snapshot.draft.rows) {
    const rowKey = snapshot.getRowKey(row)
    if (!rows.has(rowKey)) rows.set(rowKey, row)
  }
  const columns = new Map(
    snapshot.columns.map((column) => [column.key, column] as const),
  )
  const dirtyCells = new Map<
    string,
    (typeof snapshot.draft.dirtyCells)[number]
  >()
  const dirtyRowKeys = new Set<RowKey>()
  const dirtyColumnKeys = new Set<string>()
  for (const dirty of snapshot.draft.dirtyCells) {
    const identity = encodeCellIdentity(dirty)
    if (!dirtyCells.has(identity)) dirtyCells.set(identity, dirty)
    dirtyRowKeys.add(dirty.rowKey)
    dirtyColumnKeys.add(dirty.columnKey)
  }
  const validationIssues = new Map<
    string,
    (typeof snapshot.draft.validationIssues)[number]
  >()
  for (const issue of snapshot.draft.validationIssues) {
    const identity = encodeCellIdentity(issue)
    if (!validationIssues.has(identity)) validationIssues.set(identity, issue)
  }
  const cellConflicts = new Map<
    string,
    (typeof snapshot.draft.conflicts)[number]
  >()
  const rowConflictMessages = new Map<RowKey, string>()
  for (const conflict of snapshot.draft.conflicts) {
    if (conflict.columnKey === null) {
      if (!rowConflictMessages.has(conflict.rowKey)) {
        rowConflictMessages.set(conflict.rowKey, conflict.message)
      }
      continue
    }
    const identity = encodeCellIdentity({
      rowKey: conflict.rowKey,
      columnKey: conflict.columnKey,
    })
    if (!cellConflicts.has(identity)) cellConflicts.set(identity, conflict)
  }
  const filterCounts = new Map<string, number>()
  for (const filter of snapshot.view.columnFilters) {
    filterCounts.set(
      filter.columnKey,
      (filterCounts.get(filter.columnKey) ?? 0) + 1,
    )
  }
  const next: GridSelectorIndex<Row, RowKey> = Object.freeze({
    rows,
    columns,
    dirtyCells,
    validationIssues,
    cellConflicts,
    rowConflictMessages,
    insertedRowKeys: new Set(snapshot.draft.insertedRowKeys),
    dirtyRowKeys,
    dirtyColumnKeys,
    filterCounts,
  })
  gridSelectorIndexes.set(snapshot, next)
  return next
}
