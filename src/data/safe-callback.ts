import type {
  GridCompiledColumn,
  GridValueResult,
} from '../model/grid-model.js'

export type GridCallbackResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; message: string }>

export function invokeGridCallback<Value>(
  operation: () => Value,
): GridCallbackResult<Value> {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export function invokeGridResult<Value>(
  operation: () => GridValueResult<Value>,
): GridValueResult<Value> {
  const result = invokeGridCallback(operation)
  return result.ok
    ? result.value
    : {
        ok: false,
        issue: { code: 'exception', message: result.message },
      }
}

export function cloneGridRow<Row>(
  row: Row,
  clone?: (row: Row) => Row,
): GridCallbackResult<Row> {
  if (clone) {
    return invokeGridCallback(() => {
      const cloned = clone(row)
      if (
        typeof row === 'object' &&
        row !== null &&
        Object.is(cloned, row)
      ) {
        throw new Error('The data source cloneRow capability must return a distinct row object.')
      }
      return cloned
    })
  }
  return invokeGridCallback(() => {
    if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
      const prototype = Object.getPrototypeOf(row)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(
          'Rows with a custom prototype require the data source cloneRow capability.',
        )
      }
    }
    return structuredClone(row)
  })
}

export function areGridValuesEqual<Row>(
  column: GridCompiledColumn<Row>,
  left: unknown,
  right: unknown,
) {
  const equals = column.behavior.equals
  if (!equals) return Object.is(left, right)
  const result = invokeGridCallback(() =>
    equals(left, right, {
      columnKey: column.key,
      typeOptions: column.typeOptions,
    }),
  )
  return result.ok ? result.value : Object.is(left, right)
}

export function formatGridOriginalValue<Row>(
  column: GridCompiledColumn<Row>,
  value: unknown,
  row: Row,
) {
  const formatter =
    column.behavior.text.original ?? column.behavior.text.display
  const result = invokeGridCallback(() =>
    formatter(value, {
      row,
      columnKey: column.key,
      typeOptions: column.typeOptions,
    }),
  )
  return result.ok ? result.value : String(value ?? '')
}
