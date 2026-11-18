import type { GridRowKey } from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'

export function sameGridRowKeyOrder<RowKey extends GridRowKey>(
  left: readonly RowKey[],
  right: readonly RowKey[],
) {
  return left.length === right.length && left.every(
    (key, index) => gridRowKeysEqual(key, right[index]),
  )
}
