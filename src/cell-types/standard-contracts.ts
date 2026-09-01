import type {
  GridCellTypeSignature,
  GridChoiceOption,
  GridChoiceValue,
} from './contracts.js'

export type GridStringColumnOptions = Readonly<{
  inputMode?: 'text' | 'email' | 'search' | 'tel' | 'url'
  placeholder?: string
}>

export type GridNumberColumnOptions = Readonly<{
  minimum?: number
  maximum?: number
  placeholder?: string
  format?: Intl.NumberFormatOptions
}>

export type GridIsoDateColumnOptions = Readonly<{
  placeholder?: string
  locale?: string | readonly string[]
  display?: Intl.DateTimeFormatOptions
}>

export type GridSingleSelectColumnOptions<
  Value extends GridChoiceValue = GridChoiceValue,
> = Readonly<{
  /** Static options shared by editing, filtering, validation, clipboard, and bulk editing. */
  options: readonly GridChoiceOption<Value>[]
  nullable?: boolean
  emptyLabel?: string
}>

export type GridMultiSelectColumnOptions<
  Value extends GridChoiceValue = GridChoiceValue,
> = Readonly<{
  /** Static options shared by editing, filtering, validation, clipboard, and bulk editing. */
  options: readonly GridChoiceOption<Value>[]
  emptyLabel?: string
}>

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
