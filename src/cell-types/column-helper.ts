import type {
  GridCellTypeColumnOptions,
  GridCellTypeKindOf,
  GridCellTypeSchema,
  GridCellTypeValue,
  GridChoiceOption,
  GridChoiceValue,
} from './contracts.js'
import type { StandardGridCellTypeSchema } from './standard-registry.js'
import type {
  GridColumn,
  GridColumnLayout,
  GridValueResult,
} from '../model/grid-model.js'

type StringKeyOf<Row> = Extract<keyof Row, string>

type Equal<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false

type CellTypeNamesForField<
  Row,
  Key extends StringKeyOf<Row>,
  Schema extends GridCellTypeSchema,
> = {
  [Name in Extract<keyof Schema, string>]:
    GridCellTypeKindOf<Schema[Name]> extends 'single-select'
      ? Row[Key] extends GridChoiceValue | null ? Name : never
      : GridCellTypeKindOf<Schema[Name]> extends 'multi-select'
        ? Row[Key] extends readonly GridChoiceValue[] ? Name : never
        : Equal<Row[Key], GridCellTypeValue<Schema[Name]>> extends true ? Name : never
}[Extract<keyof Schema, string>]

type FieldColumnCommon<Row, Value> = Readonly<{
  label: string
  /** Defaults to the field name. */
  columnKey?: string
  /** Fields are editable by default. Use false or a predicate for read-only cells. */
  editable?: boolean | ((row: Row) => boolean)
  layout?: GridColumnLayout
  validate?: (value: Value, row: Row) => GridValueResult<Value>
  sortable?: boolean
  filterable?: boolean
  bulkEditable?: boolean
}>

type OptionalTypeOptions<ColumnOptions> = undefined extends ColumnOptions
  ? Readonly<{ typeOptions?: ColumnOptions }>
  : Readonly<{ typeOptions: ColumnOptions }>

type SingleSelectOptionsForField<ColumnOptions, Value> =
  ColumnOptions extends Readonly<{ options: readonly GridChoiceOption<GridChoiceValue>[] }>
    ? Omit<ColumnOptions, 'options' | 'nullable'> & Readonly<{
        options: readonly GridChoiceOption<Extract<NonNullable<Value>, GridChoiceValue>>[]
      }> & (null extends Value
        ? Readonly<{ nullable: true }>
        : Readonly<{ nullable?: false }>)
    : never

type MultiSelectOptionsForField<ColumnOptions, Value> =
  Value extends readonly (infer Item)[]
    ? [Item] extends [GridChoiceValue]
      ? [ColumnOptions] extends [Readonly<{ options: readonly GridChoiceOption<GridChoiceValue>[] }>]
        ? Omit<ColumnOptions, 'options'> & Readonly<{
            options: readonly GridChoiceOption<Extract<Item, GridChoiceValue>>[]
          }>
        : never
      : never
    : never

type FieldColumnConfig<
  Row,
  Key extends StringKeyOf<Row>,
  Schema extends GridCellTypeSchema,
  Name extends CellTypeNamesForField<Row, Key, Schema>,
> = FieldColumnCommon<Row, Row[Key]> & Readonly<{ type: Name }> & (
  GridCellTypeKindOf<Schema[Name]> extends 'single-select'
    ? SingleSelectOptionsForField<GridCellTypeColumnOptions<Schema[Name]>, Row[Key]>
    : GridCellTypeKindOf<Schema[Name]> extends 'multi-select'
      ? MultiSelectOptionsForField<GridCellTypeColumnOptions<Schema[Name]>, Row[Key]>
      : OptionalTypeOptions<GridCellTypeColumnOptions<Schema[Name]>>
)

type FieldColumnTypeOptions<
  Row,
  Key extends StringKeyOf<Row>,
  Schema extends GridCellTypeSchema,
  Name extends CellTypeNamesForField<Row, Key, Schema>,
> = GridCellTypeKindOf<Schema[Name]> extends 'single-select'
  ? SingleSelectOptionsForField<GridCellTypeColumnOptions<Schema[Name]>, Row[Key]>
  : GridCellTypeKindOf<Schema[Name]> extends 'multi-select'
    ? MultiSelectOptionsForField<GridCellTypeColumnOptions<Schema[Name]>, Row[Key]>
    : GridCellTypeColumnOptions<Schema[Name]>

export type GridColumnHelper<
  Row,
  Schema extends GridCellTypeSchema = StandardGridCellTypeSchema,
> = Readonly<{
  field: <
    const Key extends StringKeyOf<Row>,
    const Name extends CellTypeNamesForField<Row, Key, Schema>,
  >(
    field: Key,
    config: FieldColumnConfig<Row, Key, Schema, Name>,
  ) => GridColumn<
    Row,
    Row[Key],
    Name,
    FieldColumnTypeOptions<Row, Key, Schema, Name>
  >
}>

/** Creates field-backed columns without repetitive getValue/setValue callbacks. */
export function createGridColumnHelper<
  Row,
  Schema extends GridCellTypeSchema = StandardGridCellTypeSchema,
>(): GridColumnHelper<Row, Schema> {
  const field = (
    fieldName: string,
    source: Readonly<Record<string, unknown>>,
  ) => {
    const {
      columnKey,
      editable = true,
      emptyLabel,
      nullable,
      options,
      typeOptions,
      ...column
    } = source
    const resolvedTypeOptions = options === undefined
      ? typeOptions
      : Object.freeze({
          options,
          ...(nullable === undefined ? {} : { nullable }),
          ...(emptyLabel === undefined ? {} : { emptyLabel }),
        })
    const editablePredicate = typeof editable === 'function' ? editable : undefined
    return Object.freeze({
      ...column,
      key: typeof columnKey === 'string' ? columnKey : fieldName,
      ...(resolvedTypeOptions === undefined ? {} : { typeOptions: resolvedTypeOptions }),
      getValue: (row: Record<string, unknown>) => row[fieldName],
      ...(editable === false ? {} : {
        setValue: (row: Record<string, unknown>, value: unknown) => ({ ...row, [fieldName]: value }),
      }),
      ...(editablePredicate === undefined ? {} : { isEditable: editablePredicate }),
    })
  }
  return Object.freeze({ field }) as unknown as GridColumnHelper<Row, Schema>
}
