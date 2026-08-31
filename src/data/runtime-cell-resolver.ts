import type {
  GridCompiledColumn,
  GridValueResult,
} from '../model/grid-model.js'
import {
  areGridValuesEqual,
  invokeGridCallback,
  invokeGridResult,
} from './safe-callback.js'

export type GridResolvedCellValue<Row> =
  | Readonly<{
      valid: true
      row: Row
      column: GridCompiledColumn<Row>
      rawValue: unknown
      value: unknown
    }>
  | Readonly<{
      valid: false
      row: Row
      column: GridCompiledColumn<Row>
      rawValue: unknown
      fallbackText: string
      issue: Readonly<{ code: string; message: string }>
    }>

/**
 * The single boundary between untrusted business rows and typed cell behavior.
 * A registered behavior never receives a value until its runtime validator has
 * accepted it.
 */
export function resolveGridCellValue<Row>(
  row: Row,
  column: GridCompiledColumn<Row>,
): GridResolvedCellValue<Row> {
  const read = invokeGridCallback(() => column.getValue(row))
  if (!read.ok) {
    return invalid(row, column, undefined, {
      code: 'read-exception',
      message: read.message,
    })
  }
  const context = {
    row,
    columnKey: column.key,
    typeOptions: column.typeOptions,
  }
  const validated = invokeGridResult(() =>
    column.behavior.value.validate(read.value, context),
  )
  return validated.ok
    ? Object.freeze({
        valid: true,
        row,
        column,
        rawValue: read.value,
        value: validated.value,
      })
    : invalid(row, column, read.value, validated.issue)
}

export function displayGridCellValue<Row>(
  resolved: GridResolvedCellValue<Row>,
): GridValueResult<string> {
  if (!resolved.valid) return { ok: true, value: resolved.fallbackText }
  const displayed = invokeGridCallback(() =>
    resolved.column.behavior.text.display(resolved.value, {
      row: resolved.row,
      columnKey: resolved.column.key,
      typeOptions: resolved.column.typeOptions,
    }),
  )
  return displayed.ok
    ? { ok: true, value: displayed.value }
    : {
        ok: false,
        issue: { code: 'display-exception', message: displayed.message },
      }
}

export function fallbackGridCellText(value: unknown) {
  if (value === null || value === undefined) return ''
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value)
  }
  return 'Invalid value'
}

export function areGridResolvedCellValuesEqual<Row>(
  left: GridResolvedCellValue<Row>,
  right: GridResolvedCellValue<Row>,
) {
  return left.valid && right.valid
    ? areGridValuesEqual(left.column, left.value, right.value)
    : !left.valid && !right.valid && Object.is(left.rawValue, right.rawValue)
}

function invalid<Row>(
  row: Row,
  column: GridCompiledColumn<Row>,
  rawValue: unknown,
  issue: Readonly<{ code: string; message: string }>,
): GridResolvedCellValue<Row> {
  return Object.freeze({
    valid: false,
    row,
    column,
    rawValue,
    fallbackText: fallbackGridCellText(rawValue),
    issue,
  })
}
