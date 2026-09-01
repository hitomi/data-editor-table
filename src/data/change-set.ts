import type { GridCompiledColumn, GridRowKey } from '../model/grid-model.js'
import type {
  GridChangeSet,
  GridCommitRequest,
} from './data-source.js'
import { resolveGridCellValue } from './runtime-cell-resolver.js'

type GridChangeSetInput<Row, RowKey extends GridRowKey> = Pick<
  GridCommitRequest<Row, RowKey>,
  'acceptedRowKeys' | 'deletedRowKeys' | 'dirtyOriginals' | 'orderChanged' | 'rows'
> & Readonly<{
  sourceRows: readonly Row[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
}>

/** Derives the database/API-friendly projection of a complete grid proposal. */
export function createGridChangeSet<Row, RowKey extends GridRowKey>(
  input: GridChangeSetInput<Row, RowKey>,
): GridChangeSet<Row, RowKey> {
  const sourceByKey = new Map(
    input.sourceRows.map((row) => [input.getRowKey(row), row] as const),
  )
  const proposedByKey = new Map(
    input.rows.map((row) => [input.getRowKey(row), row] as const),
  )
  const columnsByKey = new Map(
    input.columns.map((column) => [column.key, column] as const),
  )
  const originalsByKey = new Map<RowKey, typeof input.dirtyOriginals[number][]>()
  for (const original of input.dirtyOriginals) {
    const cells = originalsByKey.get(original.rowKey)
    if (cells) cells.push(original)
    else originalsByKey.set(original.rowKey, [original])
  }

  const inserted = [] as Array<GridChangeSet<Row, RowKey>['inserted'][number]>
  const updated = [] as Array<GridChangeSet<Row, RowKey>['updated'][number]>
  for (const rowKey of input.acceptedRowKeys) {
    const after = proposedByKey.get(rowKey)
    if (after === undefined) continue
    const before = sourceByKey.get(rowKey)
    if (before === undefined) {
      inserted.push(Object.freeze({ rowKey, row: after }))
      continue
    }
    const cells = (originalsByKey.get(rowKey) ?? []).flatMap((original) => {
      const column = columnsByKey.get(original.columnKey)
      if (!column) return []
      return [Object.freeze({
        rowKey,
        columnKey: original.columnKey,
        before: original.originalValue,
        after: resolveGridCellValue(after, column).rawValue,
      })]
    })
    updated.push(Object.freeze({
      rowKey,
      before,
      after,
      cells: Object.freeze(cells),
    }))
  }

  const deleted = input.deletedRowKeys.flatMap((rowKey) => {
    const row = sourceByKey.get(rowKey)
    return row === undefined
      ? []
      : [Object.freeze({ rowKey, row })]
  })
  const order = input.orderChanged
    ? Object.freeze({
        before: Object.freeze(input.sourceRows.map(input.getRowKey)),
        after: Object.freeze(input.rows.map(input.getRowKey)),
      })
    : null

  return Object.freeze({
    inserted: Object.freeze(inserted),
    updated: Object.freeze(updated),
    deleted: Object.freeze(deleted),
    order,
  })
}
