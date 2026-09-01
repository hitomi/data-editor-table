import type {
  GridCellTypeSignature,
  GridChoiceValue,
} from './contracts.js'
import {
  createMultiSelectCellTypeFamily,
  createSingleSelectCellTypeFamily,
  type GridMultiSelectColumnOptions,
  type GridSingleSelectColumnOptions,
} from './choices.js'
import { createBooleanCellType } from './boolean.js'
import {
  createDateCellType,
  createNumberCellType,
  createStringCellType,
  type GridIsoDateColumnOptions,
  type GridNumberColumnOptions,
  type GridStringColumnOptions,
} from './standard.js'
import {
  createCellTypeRegistry,
  type GridCellTypeRegistry,
} from './registry.js'

export type StandardGridCellTypeSchema = {
  string: GridCellTypeSignature<string, GridStringColumnOptions | undefined>
  number: GridCellTypeSignature<number, GridNumberColumnOptions | undefined>
  date: GridCellTypeSignature<string, GridIsoDateColumnOptions | undefined>
  boolean: GridCellTypeSignature<boolean>
  singleSelect: GridCellTypeSignature<
    GridChoiceValue | null,
    GridSingleSelectColumnOptions,
    'single-select'
  >
  multiSelect: GridCellTypeSignature<
    readonly GridChoiceValue[],
    GridMultiSelectColumnOptions,
    'multi-select'
  >
}

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
