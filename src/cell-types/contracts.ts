import type {
  GridColumn,
  GridRuntimeCellBehavior,
  GridRuntimeValueContext,
  GridValueResult,
} from '../model/grid-model.js'

export type { GridValueResult } from '../model/grid-model.js'
export type {
  GridRuntimeCellAction,
  GridRuntimeCellActionContext,
  GridRuntimeCellActionOutcome,
  GridRuntimeCellEffect,
} from '../model/grid-model.js'

export type GridCellTypeSignature<Value, ColumnOptions = undefined> = Readonly<{
  value: Value
  columnOptions: ColumnOptions
}>

export type GridCellTypeSchema = Record<string, GridCellTypeSignature<unknown, unknown>>

export type GridCellTypeValue<Entry> =
  Entry extends GridCellTypeSignature<infer Value, unknown> ? Value : never

export type GridCellTypeColumnOptions<Entry> =
  Entry extends GridCellTypeSignature<unknown, infer ColumnOptions> ? ColumnOptions : never

export type GridColumnForCellTypes<
  Row,
  Schema extends GridCellTypeSchema,
> = {
  [Name in Extract<keyof Schema, string>]: GridColumn<
    Row,
    GridCellTypeValue<Schema[Name]>,
    Name,
    GridCellTypeColumnOptions<Schema[Name]>
  >
}[Extract<keyof Schema, string>]

export type GridCellValueIssue = Readonly<{
  code: string
  message: string
}>

export type GridCellValueContext<Row, ColumnOptions = undefined> = Readonly<{
  row: Row
  columnKey: string
  typeOptions: ColumnOptions
}>

export type GridCellColumnContext<ColumnOptions = undefined> = Readonly<{
  columnKey: string
  typeOptions: ColumnOptions
}>

export type GridCellFillDirection = 'up' | 'down' | 'left' | 'right'

export type GridCellFillContext<Row, Value, ColumnOptions = undefined> = Readonly<{
  sourceValues: readonly Value[]
  repeatedValue: Value
  sourceStartIndex: number
  targetIndex: number
  targetRow: Row
  direction: GridCellFillDirection
  columnKey: string
  typeOptions: ColumnOptions
}>

export type GridCellFilterInput =
  | Readonly<{
      kind: 'text' | 'number' | 'date'
      inputMode?: 'text' | 'decimal' | 'numeric'
    }>
  | Readonly<{
      kind: 'select'
      options: readonly Readonly<{ value: string; label: string }>[]
    }>

export type GridCellFilterOperator<Row, Value, ColumnOptions = undefined> = Readonly<{
  id: string
  label: string
  requiresValue: boolean
  input?: GridCellFilterInput
  validate?: (raw: string) => string | null
  matches: (
    value: Value,
    raw: string,
    context: GridCellValueContext<Row, ColumnOptions>,
  ) => boolean
}>

export type GridCellFilter<Row, Value, ColumnOptions = undefined> = Readonly<{
  defaultOperator: string
  operators: readonly GridCellFilterOperator<Row, Value, ColumnOptions>[]
}>

export type GridCellBulkContext<Row, Value, ColumnOptions = undefined> = Readonly<{
  values: readonly Value[]
  cells: readonly GridCellValueContext<Row, ColumnOptions>[]
}>

export type GridCellBulkBehavior<Row, Value, BulkDraft, ColumnOptions = undefined> = Readonly<{
  begin: (context: GridCellBulkContext<Row, Value, ColumnOptions>) => BulkDraft
  apply: (
    current: Value,
    draft: BulkDraft,
    context: GridCellValueContext<Row, ColumnOptions>,
  ) => GridValueResult<Value>
}>

export type GridCellEffectSchema = Record<string, Readonly<{ input: unknown }>>

export type GridCellEffectInput<Effect> =
  Effect extends Readonly<{ input: infer Input }> ? Input : never

export type GridCellEffectBehavior<Row, Value, Input, ColumnOptions = undefined> = Readonly<{
  concurrency: 'replace-cell'
  run: (
    input: Input,
    context: GridCellValueContext<Row, ColumnOptions>,
    signal: AbortSignal,
  ) => GridValueResult<Value> | Promise<GridValueResult<Value>>
}>

export type GridCellEffects<
  Row,
  Value,
  ColumnOptions,
  Effects extends GridCellEffectSchema,
> = Readonly<{
  [Name in keyof Effects]: GridCellEffectBehavior<
    Row,
    Value,
    GridCellEffectInput<Effects[Name]>,
    ColumnOptions
  >
}>

export type GridCellEffectIntent<Effects extends GridCellEffectSchema> = {
  [Name in Extract<keyof Effects, string>]: Readonly<{
    kind: 'effect'
    effect: Name
    input: GridCellEffectInput<Effects[Name]>
  }>
}[Extract<keyof Effects, string>]

export type GridCellActionOutcome<Value, Effects extends GridCellEffectSchema> =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'set-value'; value: Value }>
  | GridCellEffectIntent<Effects>

export type GridCellActionContext<Row, Value, ColumnOptions = undefined> =
  GridCellValueContext<Row, ColumnOptions> & Readonly<{
    value: Value
    editable: boolean
  }>

export type GridCellActionBehavior<
  Row,
  Value,
  ColumnOptions,
  Effects extends GridCellEffectSchema,
> = Readonly<{
  id: string
  label: string | ((context: GridCellActionContext<Row, Value, ColumnOptions>) => string)
  group?: string
  destructive?: boolean
  requiresEditable?: boolean
  hidden?: (context: GridCellActionContext<Row, Value, ColumnOptions>) => boolean
  disabled?: (context: GridCellActionContext<Row, Value, ColumnOptions>) => boolean
  run: (
    context: GridCellActionContext<Row, Value, ColumnOptions>,
  ) => GridValueResult<GridCellActionOutcome<Value, Effects>>
}>

export type GridCellBehavior<
  Row,
  Value,
  EditDraft = Value,
  BulkDraft = never,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
> = Readonly<{
  value: Readonly<{
    validate: (
      value: unknown,
      context: GridCellValueContext<Row, ColumnOptions>,
    ) => GridValueResult<Value>
  }>
  text: Readonly<{
    display: (value: Value, context: GridCellValueContext<Row, ColumnOptions>) => string
    search?: (value: Value, context: GridCellValueContext<Row, ColumnOptions>) => string
    original?: (value: Value, context: GridCellValueContext<Row, ColumnOptions>) => string
  }>
  equals?: (
    left: Value,
    right: Value,
    context: GridCellColumnContext<ColumnOptions>,
  ) => boolean
  clipboard?: Readonly<{
    format: (value: Value, context: GridCellValueContext<Row, ColumnOptions>) => string
    parse?: (
      text: string,
      context: GridCellValueContext<Row, ColumnOptions>,
    ) => GridValueResult<Value>
  }>
  edit?: Readonly<{
    /** Whether unrelated grid interactions may commit this draft implicitly. */
    exit?: 'auto-commit' | 'explicit'
    begin: (value: Value, context: GridCellValueContext<Row, ColumnOptions>) => EditDraft
    commit: (
      draft: EditDraft,
      context: GridCellValueContext<Row, ColumnOptions>,
    ) => GridValueResult<Value>
  }>
  clear?: (context: GridCellValueContext<Row, ColumnOptions>) => GridValueResult<Value>
  fill?: (context: GridCellFillContext<Row, Value, ColumnOptions>) => GridValueResult<Value>
  compare?: (
    left: Value,
    right: Value,
    context: GridCellColumnContext<ColumnOptions>,
  ) => number
  filter?: GridCellFilter<Row, Value, ColumnOptions>
  bulk?: GridCellBulkBehavior<Row, Value, BulkDraft, ColumnOptions>
  actions?: readonly GridCellActionBehavior<Row, Value, ColumnOptions, Effects>[]
  effects?: GridCellEffects<Row, Value, ColumnOptions, Effects>
}>

export type GridStringBulkDraft =
  | Readonly<{ operation: 'set'; value: string }>
  | Readonly<{ operation: 'affix'; prefix: string; suffix: string }>
  | Readonly<{ operation: 'replace'; find: string; replacement: string; useRegex: boolean }>

export type GridNumberBulkDraft = Readonly<{ value: string }>

export type GridDateBulkDraft = Readonly<{ value: string }>

export type GridChoiceValue = string | number

export type GridChoiceOption<Value extends GridChoiceValue> = Readonly<{
  value: Value
  label: string
  disabled?: boolean
}>

export type GridSingleSelectBulkDraft<Value extends GridChoiceValue> =
  | Readonly<{ operation: 'keep' }>
  | Readonly<{ operation: 'set'; value: Value | null }>

export type GridMultiSelectBulkDraft<Value extends GridChoiceValue> = Readonly<{
  operation: 'keep' | 'replace' | 'add' | 'remove'
  values: readonly Value[]
}>

export type GridBooleanBulkDraft = Readonly<{ value: boolean | 'mixed' }>

export type GridRuntimeRegisteredValueContext<Row> = GridRuntimeValueContext<Row>

export type GridRuntimeFillContext<Row> = Parameters<
  NonNullable<GridRuntimeCellBehavior<Row>['fill']>
>[0]

export type GridRegisteredRuntimeCellBehavior<Row> = GridRuntimeCellBehavior<Row>

export type GridCellBehaviorProjection<Row> = Readonly<{
  resolve: (type: string) => GridRegisteredRuntimeCellBehavior<Row> | undefined
}>
