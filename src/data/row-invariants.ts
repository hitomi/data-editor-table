import type {
  GridCompiledColumn,
  GridRowKey,
  GridValidationIssue,
} from '../model/grid-model.js'
import { resolveGridCellValue } from './runtime-cell-resolver.js'
import { invokeGridResult } from './safe-callback.js'

export function findRowIdentityIssue<Row, RowKey extends GridRowKey>(
  rows: readonly Row[],
  getRowKey: (row: Row) => RowKey,
) {
  const keys = new Set<RowKey>()
  for (const row of rows) {
    const rowKey = getRowKey(row)
    if (keys.has(rowKey)) return `The row key "${String(rowKey)}" is duplicated.`
    keys.add(rowKey)
  }
  return null
}

export function collectRowValidationIssues<Row, RowKey extends GridRowKey>(
  rows: readonly Row[],
  columns: readonly GridCompiledColumn<Row>[],
  getRowKey: (row: Row) => RowKey,
) {
  const issues: GridValidationIssue<RowKey>[] = []
  for (const row of rows) {
    const rowKey = getRowKey(row)
    for (const column of columns) {
      const resolved = resolveGridCellValue(row, column)
      const result = resolved.valid && column.validate
        ? invokeGridResult(() => column.validate!(resolved.value, row))
        : resolved.valid
          ? { ok: true as const, value: resolved.value }
          : { ok: false as const, issue: resolved.issue }
      if (!result.ok) {
        issues.push(Object.freeze({
          rowKey,
          columnKey: column.key,
          message: result.issue.message,
        }))
      }
    }
  }
  return Object.freeze(issues)
}
