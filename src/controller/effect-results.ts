import { copyGridInput } from '../cell-types/input-codec.js'
import type { GridCompiledDocumentModel } from '../data/runtime-columns.js'
import type { GridRowKey, GridValueResult } from '../model/grid-model.js'
import type { GridEffectResult } from './controller-contracts.js'
import type { GridExternalEffectOperation } from './controller-effects.js'

function copyEffectValue<Row>(model: GridCompiledDocumentModel<Row>, columnKey: string, value: unknown) {
  return copyGridInput(value, model.columns.find(binding => binding.column.key === columnKey)?.valueCodec)
}

export function copyGridCellEffectResult<Row>(model: GridCompiledDocumentModel<Row>, columnKey: string, result: GridValueResult<unknown>): GridValueResult<unknown> {
  return result.ok ? { ok: true, value: copyEffectValue(model, columnKey, result.value) } : structuredClone(result)
}

/** Copy only the returned values. The request supplies every destination,
 * even when a JS adapter returns extra properties or a command payload. */
export function copyGridHostEffectResult<Row, Key extends GridRowKey>(
  model: GridCompiledDocumentModel<Row>, operation: GridExternalEffectOperation<Key, unknown>, result: GridEffectResult,
): GridEffectResult {
  if (result === undefined) return
  const { owner } = operation.request
  const write = operation.active.targets.filter(target => target.access === 'write')
  if (!write.length) throw new Error('This host task has no authorized write targets.')
  if (owner.kind === 'cell' || owner.kind === 'edit') {
    if (result?.kind !== 'value' || !Object.hasOwn(result, 'value')) throw new Error('A single-cell host task must return one value.')
    return { kind: 'value', value: copyEffectValue(model, write[0]!.columnKey, result.value) }
  }
  const values = result?.kind === 'values' ? result.values : undefined
  if (!Array.isArray(values) || values.length !== write.length) throw new Error('A multi-cell host task must return one value per authorized write target.')
  return { kind: 'values', values: write.map((target, index) => {
    if (!Object.hasOwn(values, index)) throw new Error('A host task value is missing for an authorized target.')
    return copyEffectValue(model, target.columnKey, values[index])
  }) }
}
