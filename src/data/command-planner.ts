import type {
  GridCompiledColumn,
  GridPoint,
  GridRange,
  GridRowKey,
} from '../model/grid-model.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import type { GridCellMutation } from './draft-transactions.js'
import {
  gridFillDirection,
  gridRangeBounds,
  positiveModulo,
} from '../controller/interaction-transitions.js'
import { selectedCells } from '../controller/selection-model.js'
import { createGridColumnIndex, createGridRowIndex } from './runtime-index.js'
import { cloneGridRow, invokeGridResult } from './safe-callback.js'
import { resolveGridCellValue } from './runtime-cell-resolver.js'

type CommandPlan<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: string }>

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
    const row = rows.byKey.get(target.rowKey)
    const column = columns.get(target.columnKey)
    const clear = column?.behavior.clear
    if (!row || !column || !clear || !column.isEditable(row)) {
      skippedCells += 1
      continue
    }
    const value = invokeGridResult(() => clear(context(row, column)))
    if (!value.ok) return { ok: false, reason: value.issue.message }
    mutations.push({ cell: target, value: value.value })
  }
  if (mutations.length === 0) {
    return { ok: false, reason: 'The selection contains no clearable cells.' }
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
    return { ok: false, reason: 'The fill range is unavailable.' }
  }
  const direction = gridFillDirection(sourceBounds, targetBounds)
  if (!direction) return { ok: true, value: Object.freeze([]) }

  const rowIndex = createGridRowIndex(options.rows, options.getRowKey)
  const columnIndex = createGridColumnIndex(options.columns)
  const resolve = (target: GridPoint<RowKey>) => {
    const row = rowIndex.byKey.get(target.rowKey)
    const column = columnIndex.get(target.columnKey)
    if (!row || !column) return null
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
        reason: 'A fill source contains an invalid cell value.',
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
      return { ok: false, reason: 'A fill target is read-only.' }
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
      return { ok: false, reason: 'The fill source is empty.' }
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
          reason: 'The source and target are not fill-compatible.',
        }
      }
      const converted = invokeGridResult(() =>
        parse(
          format(source.value, context(source.row, source.column)),
          context(resolved.row, resolved.column),
        ),
      )
      if (!converted.ok) return { ok: false, reason: converted.issue.message }
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
    if (custom && !custom.ok) return { ok: false, reason: custom.issue.message }
    mutations.push({
      cell: target,
      value: custom?.ok ? custom.value : repeated,
    })
  }
  return { ok: true, value: Object.freeze(mutations) }
}

export function planRestoreRows<Row, RowKey extends GridRowKey>(options: Readonly<{
  rows: readonly Row[]
  baselineRows: readonly Row[]
  rowKeys: readonly RowKey[]
  getRowKey: (row: Row) => RowKey
}>) {
  const chosen = new Set(options.rowKeys)
  const rows = options.rows.filter((row) => !chosen.has(options.getRowKey(row)))
  options.baselineRows.forEach((row, baselineIndex) => {
    if (!chosen.has(options.getRowKey(row))) return
    rows.splice(Math.min(baselineIndex, rows.length), 0, row)
  })
  return Object.freeze(rows)
}

export function planRestoreCells<Row, RowKey extends GridRowKey>(options: Readonly<{
  rows: readonly Row[]
  baselineRows: readonly Row[]
  targets: readonly GridPoint<RowKey>[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  cloneRow?: (row: Row) => Row
}>): CommandPlan<Readonly<{
  rows: readonly Row[]
  restored: readonly GridPoint<RowKey>[]
}>> {
  const rows = [...options.rows]
  const rowIndex = createGridRowIndex(rows, options.getRowKey)
  const baseline = createGridRowIndex(options.baselineRows, options.getRowKey)
  const columns = createGridColumnIndex(options.columns)
  const restored = new Map<string, GridPoint<RowKey>>()
  for (const target of options.targets) {
    const position = rowIndex.positionByKey.get(target.rowKey)
    const row = position === undefined ? undefined : rows[position]
    const original = baseline.byKey.get(target.rowKey)
    const column = columns.get(target.columnKey)
    if (position === undefined || !row || !original || !column?.setValue) continue
    try {
      const cloned = cloneGridRow(row, options.cloneRow)
      if (!cloned.ok) {
        return {
          ok: false,
          reason: 'This row cannot be cloned safely before editing.',
        }
      }
      const originalValue = resolveGridCellValue(original, column)
      if (!originalValue.valid) {
        return {
          ok: false,
          reason: 'The authoritative value is invalid and cannot be restored.',
        }
      }
      const next = column.setValue(cloned.value, originalValue.value)
      if (!gridRowKeysEqual(options.getRowKey(next), target.rowKey)) {
        return { ok: false, reason: 'A cell setter cannot change its row key.' }
      }
      rows[position] = next
      restored.set(encodeCellIdentity(target), target)
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (restored.size === 0) {
    return {
      ok: false,
      reason: 'The selected cells have no original value to restore.',
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      rows: Object.freeze(rows),
      restored: Object.freeze([...restored.values()]),
    }),
  }
}

function context<Row>(row: Row, column: GridCompiledColumn<Row>) {
  return Object.freeze({
    row,
    columnKey: column.key,
    typeOptions: column.typeOptions,
  })
}
