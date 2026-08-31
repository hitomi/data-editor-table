import type { GridCompiledColumn, GridRowKey } from '../model/grid-model.js'

export type GridRowIndex<Row, RowKey extends GridRowKey> = Readonly<{
  rows: readonly Row[]
  keys: readonly RowKey[]
  byKey: ReadonlyMap<RowKey, Row>
  positionByKey: ReadonlyMap<RowKey, number>
}>

export function createGridRowIndex<Row, RowKey extends GridRowKey>(
  rows: readonly Row[],
  getRowKey: (row: Row) => RowKey,
): GridRowIndex<Row, RowKey> {
  const keys: RowKey[] = []
  const byKey = new Map<RowKey, Row>()
  const positionByKey = new Map<RowKey, number>()
  rows.forEach((row, index) => {
    const rowKey = getRowKey(row)
    keys.push(rowKey)
    byKey.set(rowKey, row)
    positionByKey.set(rowKey, index)
  })
  return Object.freeze({
    rows,
    keys: Object.freeze(keys),
    byKey,
    positionByKey,
  })
}

export function createGridColumnIndex<Row>(
  columns: readonly GridCompiledColumn<Row>[],
) {
  return new Map(columns.map((column) => [column.key, column] as const))
}
