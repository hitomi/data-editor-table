import type { GridRowKey } from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'

/**
 * Structural insert/delete state is tracked separately. Order is dirty when
 * surviving baseline rows changed relative order, or when a new row was
 * positioned before a surviving baseline row instead of being appended.
 */
export function isGridRowOrderDirty<Row, RowKey extends GridRowKey>(
  baselineRows: readonly Row[],
  rows: readonly Row[],
  getRowKey: (row: Row) => RowKey,
) {
  const baselineKeys = baselineRows.map(getRowKey)
  const currentKeys = rows.map(getRowKey)
  const baselineSet = new Set(baselineKeys)
  const currentSet = new Set(currentKeys)
  const baselineSurvivors = baselineKeys.filter((key) => currentSet.has(key))
  const currentBaselineRows = currentKeys.filter((key) => baselineSet.has(key))
  if (!sameGridRowKeyOrder(baselineSurvivors, currentBaselineRows)) return true
  const firstInserted = currentKeys.findIndex((key) => !baselineSet.has(key))
  return firstInserted >= 0 && currentKeys
    .slice(firstInserted + 1)
    .some((key) => baselineSet.has(key))
}

export function sameGridRowKeyOrder<RowKey extends GridRowKey>(
  left: readonly RowKey[],
  right: readonly RowKey[],
) {
  return left.length === right.length && left.every(
    (key, index) => gridRowKeysEqual(key, right[index]),
  )
}

/**
 * Reapplies the relative order of all surviving intended rows while leaving
 * rows known only to the new authority in their existing slots.
 */
export function applyGridRowOrder<Row, RowKey extends GridRowKey>(
  rows: Row[],
  intendedRows: readonly Row[],
  getRowKey: (row: Row) => RowKey,
) {
  const rowByKey = new Map(
    rows.map((row) => [getRowKey(row), row] as const),
  )
  const intendedKeys = intendedRows
    .map(getRowKey)
    .filter((rowKey) => rowByKey.has(rowKey))
  const intended = new Set(intendedKeys)
  const slots = rows.flatMap((row, index) =>
    intended.has(getRowKey(row)) ? [index] : [],
  )
  intendedKeys.forEach((rowKey, index) => {
    rows[slots[index]!] = rowByKey.get(rowKey)!
  })
}
