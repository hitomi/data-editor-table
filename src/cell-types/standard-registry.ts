import type {
  StandardGridCellTypeSchema,
} from './contracts.js'
export type { StandardGridCellTypeSchema } from './contracts.js'
import {
  createMultiSelectCellTypeFamily,
  createSingleSelectCellTypeFamily,
} from './choices.js'
import { createBooleanCellType } from './boolean.js'
import {
  createDateCellType,
  createNumberCellType,
  createStringCellType,
} from './standard.js'
import {
  createCellTypeRegistry,
  type GridCellTypeRegistry,
} from './registry.js'

/**
 * Creates the batteries-included registry used by DataGrid when `registry` is omitted.
 * Register a new name for an extension, or use `replace` to override a standard type.
 */
export function createStandardCellTypeRegistry<Row>(): GridCellTypeRegistry<
  Row,
  StandardGridCellTypeSchema
> {
  return createCellTypeRegistry<Row>()
    .register('string', createStringCellType())
    .register('number', createNumberCellType())
    .register('date', createDateCellType({ storage: 'iso-date', emptyValue: '' }))
    .register('boolean', createBooleanCellType())
    .register('singleSelect', createSingleSelectCellTypeFamily())
    .register('multiSelect', createMultiSelectCellTypeFamily())
}
