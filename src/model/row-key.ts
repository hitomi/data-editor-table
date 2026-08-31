import type { GridRowKey } from './grid-model.js'

export function gridRowKeysEqual(
  left: GridRowKey | undefined,
  right: GridRowKey | undefined,
) {
  return left === right || (Number.isNaN(left) && Number.isNaN(right))
}
