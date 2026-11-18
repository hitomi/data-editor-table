import type { GridRowKey } from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'

export function areGridAuthorityRowsEqual<
  Row,
  RowKey extends GridRowKey,
>(
  left: readonly Row[],
  right: readonly Row[],
  getRowKey: (row: Row) => RowKey,
) {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        gridRowKeysEqual(getRowKey(row), getRowKey(candidate)) &&
        deepEqualGridValue(row, candidate)
      )
    })
  )
}

function deepEqualGridValue(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>(),
): boolean {
  if (Object.is(left, right)) return true
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null ||
    Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
  )
    return false
  if (left instanceof Date && right instanceof Date)
    return left.getTime() === right.getTime()
  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) return false
    return [...left].every(([key, value]) =>
      right.has(key)
        ? deepEqualGridValue(value, right.get(key), seen)
        : false,
    )
  }
  if (left instanceof Set && right instanceof Set) {
    return left.size === right.size && [...left].every((value) => right.has(value))
  }
  if (seen.get(left) === right) return true
  seen.set(left, right)
  const leftKeys = Reflect.ownKeys(left)
  const rightKeys = Reflect.ownKeys(right)
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key) => !rightKeys.includes(key))
  )
    return false
  return leftKeys.every((key) =>
    deepEqualGridValue(
      (left as Record<PropertyKey, unknown>)[key],
      (right as Record<PropertyKey, unknown>)[key],
      seen,
    ),
  )
}
