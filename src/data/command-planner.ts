import type {
  GridCompiledColumn,
  GridPoint,
  GridRange,
  GridRowKey,
} from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import { gridValueIssue, type GridIssue } from '../model/grid-result.js'
export type GridCellMutation<RowKey extends GridRowKey> = Readonly<{ cell: GridPoint<RowKey>; value: unknown }>
import {
  gridFillDirection,
  gridRangeBounds,
  positiveModulo,
  selectedCells,
} from '../model/range-geometry.js'
import { createGridColumnIndex, createGridRowIndex } from './runtime-index.js'
import { invokeGridResult } from './safe-callback.js'
import { resolveGridCellValue } from './runtime-cell-resolver.js'

type CommandPlan<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; issue: GridIssue }>

export function planGridClear<Row, RowKey extends GridRowKey>(options: Readonly<{
  targets: readonly GridPoint<RowKey>[]
  rows: readonly Row[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
}>): CommandPlan<Readonly<{
  mutations: readonly GridCellMutation<RowKey>[]
  skippedCells: number
}>> {
  const rows = createGridRowIndex(options.rows, options.getRowKey)
  const columns = createGridColumnIndex(options.columns)
  const mutations: GridCellMutation<RowKey>[] = []
  let skippedCells = 0
  for (const target of options.targets) {
    const column = columns.get(target.columnKey)
    const clear = column?.behavior.clear
    if (!rows.byKey.has(target.rowKey) || !column || !clear) {
      skippedCells += 1
      continue
    }
    const row = rows.byKey.get(target.rowKey) as Row
    if (!column.isEditable(row)) {
      skippedCells += 1
      continue
    }
    const value = invokeGridResult(() => clear(context(row, column)))
    if (!value.ok) return { ok: false, issue: gridValueIssue(value.issue) }
    mutations.push({ cell: target, value: value.value })
  }
  if (mutations.length === 0) {
    return { ok: false, issue: { code: 'permission-denied', message: 'The selection contains no clearable cells.' } }
  }
  return {
    ok: true,
    value: Object.freeze({ mutations: Object.freeze(mutations), skippedCells }),
  }
}

export function planGridFill<Row, RowKey extends GridRowKey>(options: Readonly<{
  source: GridRange<RowKey>
  target: GridRange<RowKey>
  visibleRowKeys: readonly RowKey[]
  rows: readonly Row[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
}>): CommandPlan<readonly GridCellMutation<RowKey>[]> {
  const columnKeys = options.columns.map((column) => column.key)
  const sourceBounds = gridRangeBounds(
    options.source,
    options.visibleRowKeys,
    columnKeys,
  )
  const targetBounds = gridRangeBounds(
    options.target,
    options.visibleRowKeys,
    columnKeys,
  )
  if (!sourceBounds || !targetBounds) {
    return { ok: false, issue: { code: 'invalid-input', message: 'The fill range is unavailable.' } }
  }
  const direction = gridFillDirection(sourceBounds, targetBounds)
  if (!direction) return { ok: true, value: Object.freeze([]) }

  const rowIndex = createGridRowIndex(options.rows, options.getRowKey)
  const columnIndex = createGridColumnIndex(options.columns)
  const resolve = (target: GridPoint<RowKey>) => {
    const column = columnIndex.get(target.columnKey)
    if (!rowIndex.byKey.has(target.rowKey) || !column) return null
    const row = rowIndex.byKey.get(target.rowKey) as Row
    const resolved = resolveGridCellValue(row, column)
    return resolved.valid
      ? { cell: target, row, column, value: resolved.value }
      : null
  }
  const sourceMatrix: NonNullable<ReturnType<typeof resolve>>[] = []
  for (const source of selectedCells(
    [options.source],
    options.visibleRowKeys,
    columnKeys,
  )) {
    const resolved = resolve(source)
    if (!resolved) {
      return {
        ok: false,
        issue: { code: 'invalid-input', message: 'A fill source contains an invalid cell value.' },
      }
    }
    sourceMatrix.push(resolved)
  }
  const mutations: GridCellMutation<RowKey>[] = []
  for (const target of selectedCells(
    [options.target],
    options.visibleRowKeys,
    columnKeys,
  )) {
    const resolved = resolve(target)
    if (!resolved || !resolved.column.isEditable(resolved.row)) {
      return { ok: false, issue: { code: 'permission-denied', message: 'A fill target is read-only.' } }
    }
    const targetRow = options.visibleRowKeys.findIndex((key) =>
      gridRowKeysEqual(key, target.rowKey),
    )
    const targetColumn = columnKeys.indexOf(target.columnKey)
    const sequence = sourceMatrix.filter((sourceCell) =>
      direction === 'up' || direction === 'down'
        ? columnKeys.indexOf(sourceCell.cell.columnKey) - sourceBounds.minColumn ===
          (targetColumn - sourceBounds.minColumn) % sourceBounds.columnCount
        : options.visibleRowKeys.findIndex((key) =>
              gridRowKeysEqual(key, sourceCell.cell.rowKey),
            ) - sourceBounds.minRow ===
          (targetRow - sourceBounds.minRow) % sourceBounds.rowCount,
    )
    if (sequence.length === 0) {
      return { ok: false, issue: { code: 'invalid-input', message: 'The fill source is empty.' } }
    }
    const logicalIndex =
      direction === 'down'
        ? sequence.length + targetRow - sourceBounds.maxRow - 1
        : direction === 'up'
          ? -(sourceBounds.minRow - targetRow)
          : direction === 'right'
            ? sequence.length + targetColumn - sourceBounds.maxColumn - 1
            : -(sourceBounds.minColumn - targetColumn)
    const convertedValues: unknown[] = []
    for (const source of sequence) {
      if (source.column.key === resolved.column.key) {
        convertedValues.push(source.value)
        continue
      }
      const format = source.column.behavior.clipboard?.format
      const parse = resolved.column.behavior.clipboard?.parse
      if (!format || !parse) {
        return {
          ok: false,
          issue: { code: 'invalid-input', message: 'The source and target are not fill-compatible.' },
        }
      }
      const converted = invokeGridResult(() =>
        parse(
          format(source.value, context(source.row, source.column)),
          context(resolved.row, resolved.column),
        ),
      )
      if (!converted.ok) return { ok: false, issue: gridValueIssue(converted.issue) }
      convertedValues.push(converted.value)
    }
    const repeated =
      convertedValues[positiveModulo(logicalIndex, convertedValues.length)]
    const custom = resolved.column.behavior.fill
      ? invokeGridResult(() =>
          resolved.column.behavior.fill!({
            sourceValues: convertedValues,
            repeatedValue: repeated,
            sourceStartIndex: 0,
            targetIndex: logicalIndex,
            targetRow: resolved.row,
            direction,
            column: {
              columnKey: resolved.column.key,
              typeOptions: resolved.column.typeOptions,
            },
          }),
        )
      : undefined
    if (custom && !custom.ok) return { ok: false, issue: gridValueIssue(custom.issue) }
    mutations.push({
      cell: target,
      value: custom?.ok ? custom.value : repeated,
    })
  }
  return { ok: true, value: Object.freeze(mutations) }
}

function context<Row>(row: Row, column: GridCompiledColumn<Row>) {
  return Object.freeze({
    row,
    columnKey: column.key,
    typeOptions: column.typeOptions,
  })
}
