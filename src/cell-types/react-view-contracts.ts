import type { ComponentType } from 'react'

import type {
  GridCellBehavior,
  GridCellEffectInput,
  GridCellEffectSchema,
} from './contracts.js'

export type GridCellEditActivation = 'active-cell-click' | 'enter' | 'f2' | 'printable' | 'space'

export type GridCellViewPresentation = Readonly<{
  content: 'padded' | 'edge-to-edge'
  align: 'start' | 'center' | 'end'
  editActivation: readonly GridCellEditActivation[]
}>

export type GridCellEffectHandle = Readonly<{
  id: string
  cancel: () => void
}>

export type GridCellEffectRequester<Effects extends GridCellEffectSchema> = <
  Name extends Extract<keyof Effects, string>,
>(name: Name, input: GridCellEffectInput<Effects[Name]>) => GridCellEffectHandle

export type GridCellViewProps<
  Row,
  Value,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
> = Readonly<{
  row: Row
  value: Value
  editable: boolean
  columnKey: string
  typeOptions: ColumnOptions
  displayText: string
  requestEdit: () => void
  commitValue: (value: Value) => void
  requestEffect: GridCellEffectRequester<Effects>
}>

export type GridCellEditorProps<
  Row,
  Value,
  EditDraft,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
> = Readonly<{
  row: Row
  value: Value
  draft: EditDraft
  columnKey: string
  typeOptions: ColumnOptions
  composing: boolean
  claimInitialActivation: () => boolean
  setDraft: (draft: EditDraft) => void
  setComposing: (composing: boolean, finalDraft?: EditDraft) => void
  commit: () => void
  commitAndMove: (direction: 'next' | 'previous') => void
  cancel: () => void
  requestEffect: GridCellEffectRequester<Effects>
}>

export type GridCellBulkEditorProps<BulkDraft> = Readonly<{
  draft: BulkDraft
  cellCount: number
  error: string | null
  setDraft: (draft: BulkDraft) => void
  apply: () => void
  cancel: () => void
}>

export type GridCellReactView<
  Row,
  Value,
  EditDraft = Value,
  BulkDraft = never,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
> = Readonly<{
  Cell: ComponentType<GridCellViewProps<Row, Value, ColumnOptions, Effects>>
  Editor?: ComponentType<GridCellEditorProps<Row, Value, EditDraft, ColumnOptions, Effects>>
  BulkEditor?: ComponentType<GridCellBulkEditorProps<BulkDraft>>
  presentation: GridCellViewPresentation
}>

export type GridCellTypeDefinition<
  Row,
  Value,
  EditDraft = Value,
  BulkDraft = never,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
> = Readonly<{
  behavior: GridCellBehavior<Row, Value, EditDraft, BulkDraft, ColumnOptions, Effects>
  view: GridCellReactView<Row, Value, EditDraft, BulkDraft, ColumnOptions, Effects>
}>

export type GridCellTypeFactory<
  Value,
  EditDraft = Value,
  BulkDraft = never,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
> = Readonly<{
  readonly kind: 'grid-cell-type-factory'
  create: <Row>() => GridCellTypeDefinition<
    Row,
    Value,
    EditDraft,
    BulkDraft,
    ColumnOptions,
    Effects
  >
}>

export type GridRuntimeReactView<Row> = Readonly<{
  Cell: ComponentType<GridCellViewProps<Row, unknown, unknown, GridCellEffectSchema>>
  Editor?: ComponentType<GridCellEditorProps<Row, unknown, unknown, unknown, GridCellEffectSchema>>
  BulkEditor?: ComponentType<GridCellBulkEditorProps<unknown>>
  presentation: GridCellViewPresentation
}>

export type GridCellViewPort<Row> = Readonly<{
  resolve: (type: string) => GridRuntimeReactView<Row> | undefined
}>
