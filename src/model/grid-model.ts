export type GridRowKey = string | number
export type GridSourceVersion = string | number

export type GridPoint<RowKey extends GridRowKey> = Readonly<{
  rowKey: RowKey
  columnKey: string
}>

export type GridRange<RowKey extends GridRowKey> = Readonly<{
  anchor: GridPoint<RowKey>
  focus: GridPoint<RowKey>
}>

export type GridSelectionGesture = Readonly<{
  kind: 'select'
  pointerId: number
  mode: 'replace' | 'extend' | 'append'
  origin: 'cell' | 'row' | 'column' | 'corner'
}>

export type GridFillGesture = Readonly<{
  kind: 'fill'
  pointerId: number
  sourceRangeIndex: number
  axis: 'vertical' | 'horizontal' | null
}>

export type GridInteractionState<RowKey extends GridRowKey> = Readonly<{
  activeCell: GridPoint<RowKey> | null
  ranges: readonly GridRange<RowKey>[]
  activeRangeIndex: number | null
  gesture: GridSelectionGesture | GridFillGesture | null
  fillPreview: GridRange<RowKey> | null
  actionSession: Readonly<{
    target: GridPoint<RowKey>
    menuPosition: Readonly<{ x: number; y: number }> | null
  }> | null
}>

export type GridHitTarget<RowKey extends GridRowKey> =
  | Readonly<{ kind: 'cell'; rowKey: RowKey; columnKey: string }>
  | Readonly<{ kind: 'row'; rowKey: RowKey }>
  | Readonly<{ kind: 'column'; columnKey: string }>
  | Readonly<{ kind: 'corner' }>
  | Readonly<{ kind: 'fill-handle' }>

export type GridPointerModifiers = Readonly<{
  shift: boolean
  additive: boolean
}>

export type GridEditStatus = 'editing' | 'validating' | 'committing' | 'invalid'

export type GridEditSession<RowKey extends GridRowKey> = Readonly<{
  revision: number
  startedRevision: number
  sourceRevision: number
  cell: GridPoint<RowKey>
  originalValue: unknown
  draftValue: unknown
  status: GridEditStatus
  composing: boolean
  error: string | null
}>

export type GridSourceStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export type GridSourceState<Row> = Readonly<{
  revision: number
  status: GridSourceStatus
  rows: readonly Row[]
  version: GridSourceVersion
  scope: Readonly<{ kind: 'complete' }>
  error: string | null
}>

export type GridDirtyCell<RowKey extends GridRowKey> = Readonly<{
  rowKey: RowKey
  columnKey: string
  originalValue: unknown
  formattedOriginalValue: string
}>

export type GridValidationIssue<RowKey extends GridRowKey> = Readonly<{
  rowKey: RowKey
  columnKey: string
  message: string
}>

export type GridConflict<RowKey extends GridRowKey> = Readonly<{
  kind:
    | 'field'
    | 'remote-row-deleted'
    | 'local-row-deleted-remote-changed'
    | 'inserted-key-collision'
  rowKey: RowKey
  columnKey: string | null
  message: string
  localValue?: unknown
  remoteValue?: unknown
}>

export type GridHistoryEntry<Row, RowKey extends GridRowKey> = Readonly<{
  id: string
  label: string
  revision: number
  beforeRows: readonly Row[]
  afterRows: readonly Row[]
  beforeDirtyCells: readonly GridDirtyCell<RowKey>[]
  afterDirtyCells: readonly GridDirtyCell<RowKey>[]
  beforeInsertedRowKeys: readonly RowKey[]
  afterInsertedRowKeys: readonly RowKey[]
  beforeDeletedRowKeys: readonly RowKey[]
  afterDeletedRowKeys: readonly RowKey[]
  beforeOrderDirty: boolean
  afterOrderDirty: boolean
  beforeConflicts: readonly GridConflict<RowKey>[]
  afterConflicts: readonly GridConflict<RowKey>[]
  beforeValidationIssues: readonly GridValidationIssue<RowKey>[]
  afterValidationIssues: readonly GridValidationIssue<RowKey>[]
}>

export type GridDraftState<Row, RowKey extends GridRowKey> = Readonly<{
  revision: number
  baselineVersion: GridSourceVersion
  baselineRows: readonly Row[]
  rows: readonly Row[]
  dirtyCells: readonly GridDirtyCell<RowKey>[]
  validationIssues: readonly GridValidationIssue<RowKey>[]
  conflicts: readonly GridConflict<RowKey>[]
  insertedRowKeys: readonly RowKey[]
  deletedRowKeys: readonly RowKey[]
  orderDirty: boolean
  undoStack: readonly GridHistoryEntry<Row, RowKey>[]
  redoStack: readonly GridHistoryEntry<Row, RowKey>[]
}>

export type GridSort = Readonly<{
  columnKey: string
  direction: 'ascending' | 'descending'
}>

export type GridColumnFilter = Readonly<{
  columnKey: string
  operator: string
  value: unknown
  combine?: 'all' | 'any'
}>

export type GridViewState<RowKey extends GridRowKey> = Readonly<{
  revision: number
  visibleRowKeys: readonly RowKey[]
  globalFilter: string
  columnFilters: readonly GridColumnFilter[]
  sort: readonly GridSort[]
}>

export type GridPersistenceMode = 'immediate' | 'manual-save' | 'auto-save'
export type GridPersistenceStatus = 'idle' | 'scheduled' | 'saving' | 'failed'

export type GridPersistenceState = Readonly<{
  revision: number
  mode: GridPersistenceMode
  status: GridPersistenceStatus
  inFlightOperationId: string | null
  pendingDraftRevision: number | null
  error: string | null
  retryOperationId: string | null
}>

export type GridFeedbackItem = Readonly<{
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  persistent: boolean
}>

export type GridFeedbackState = Readonly<{
  revision: number
  items: readonly GridFeedbackItem[]
}>

export type GridBulkSession<RowKey extends GridRowKey> = Readonly<{
  revision: number
  sourceRevision: number
  draftRevision: number
  viewRevision: number
  selectionSignature: string
  columnKey: string
  targetCells: readonly GridPoint<RowKey>[]
  draft: unknown
  error: string | null
}> | null

export type GridFilterSession = Readonly<{
  revision: number
  columnKey: string
  conditions: readonly Readonly<{ operator: string; value: unknown }>[]
  combine: 'all' | 'any'
  error: string | null
}> | null

export type GridControllerSnapshot<Row, RowKey extends GridRowKey> = Readonly<{
  revision: number
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  rowOperations: Readonly<{
    canAdd: boolean
    canDuplicate: boolean
    canOrder: boolean
    canDelete: ((row: Row) => boolean) | null
  }>
  sourceOperations: Readonly<{
    canRefresh: boolean
  }>
  source: GridSourceState<Row>
  draft: GridDraftState<Row, RowKey>
  view: GridViewState<RowKey>
  layout: GridLayoutState
  interaction: GridInteractionState<RowKey>
  edit: GridEditSession<RowKey> | null
  bulk: GridBulkSession<RowKey>
  filterSession: GridFilterSession
  persistence: GridPersistenceState
  feedback: GridFeedbackState
}>

export type GridLayoutColumn = Readonly<{
  key: string
  index: number
  offset: number
  width: number
}>

export type GridLayoutState = Readonly<{
  revision: number
  viewportWidth: number
  viewportHeight: number
  scrollLeft: number
  scrollTop: number
  rowHeight: number
  headerHeight: number
  rowIndicatorWidth: number
  contentWidth: number
  contentHeight: number
  columns: readonly GridLayoutColumn[]
}>

export type GridColumnLayout = Readonly<{
  basis?: number
  min?: number
  max?: number
  flex?: number
}>

type GridColumnTypeOptions<ColumnOptions> = undefined extends ColumnOptions
  ? Readonly<{ typeOptions?: ColumnOptions }>
  : Readonly<{ typeOptions: ColumnOptions }>

export type GridColumn<
  Row,
  Value = unknown,
  Type extends string = string,
  ColumnOptions = undefined,
> = Readonly<{
  key: string
  label: string
  type: Type
  layout?: GridColumnLayout
  getValue: (row: Row) => Value
  setValue?: (row: Row, value: Value) => Row
  isEditable?: (row: Row) => boolean
  validate?: (value: Value, row: Row) => GridValueResult<Value>
  sortable?: boolean
  filterable?: boolean
  bulkEditable?: boolean
}> &
  GridColumnTypeOptions<ColumnOptions>

export type GridRuntimeValueContext<Row> = Readonly<{
  row: Row
  columnKey: string
  typeOptions: unknown
}>

export type GridRuntimeColumnContext = Readonly<{
  columnKey: string
  typeOptions: unknown
}>

export type GridValueResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; issue: Readonly<{ code: string; message: string }> }>

/**
 * Type-erased, React-free behavior consumed by the controller. The cell-type
 * registry owns the single checked conversion from its public typed schema to
 * this runtime projection.
 */
export type GridRuntimeCellBehavior<Row> = Readonly<{
  value: Readonly<{
    validate: (
      value: unknown,
      context: GridRuntimeValueContext<Row>,
    ) => GridValueResult<unknown>
  }>
  text: Readonly<{
    display: (value: unknown, context: GridRuntimeValueContext<Row>) => string
    search?: (value: unknown, context: GridRuntimeValueContext<Row>) => string
    original?: (value: unknown, context: GridRuntimeValueContext<Row>) => string
  }>
  equals?: (
    left: unknown,
    right: unknown,
    context: GridRuntimeColumnContext,
  ) => boolean
  clipboard?: Readonly<{
    format: (value: unknown, context: GridRuntimeValueContext<Row>) => string
    parse?: (
      text: string,
      context: GridRuntimeValueContext<Row>,
    ) => GridValueResult<unknown>
  }>
  edit?: Readonly<{
    begin: (value: unknown, context: GridRuntimeValueContext<Row>) => unknown
    commit: (
      draft: unknown,
      context: GridRuntimeValueContext<Row>,
    ) => GridValueResult<unknown>
  }>
  clear?: (context: GridRuntimeValueContext<Row>) => GridValueResult<unknown>
  fill?: (
    context: Readonly<{
      sourceValues: readonly unknown[]
      repeatedValue: unknown
      sourceStartIndex: number
      targetIndex: number
      targetRow: Row
      direction: 'up' | 'down' | 'left' | 'right'
      column: GridRuntimeColumnContext
    }>,
  ) => GridValueResult<unknown>
  compare?: (
    left: unknown,
    right: unknown,
    context: GridRuntimeColumnContext,
  ) => number
  filter?: Readonly<{
    defaultOperator: string
    operators: readonly Readonly<{
      id: string
      label: string
      requiresValue: boolean
      inputMode?: 'text' | 'numeric' | 'decimal' | 'date'
      validate?: (value: unknown) => GridValueResult<unknown>
      matches: (
        cellValue: unknown,
        filterValue: unknown,
        context: GridRuntimeValueContext<Row>,
      ) => boolean
    }>[]
  }>
  bulk?: Readonly<{
    begin: (
      values: readonly unknown[],
      contexts: readonly GridRuntimeValueContext<Row>[],
    ) => unknown
    apply: (
      current: unknown,
      draft: unknown,
      context: GridRuntimeValueContext<Row>,
    ) => GridValueResult<unknown>
  }>
  actions?: readonly GridRuntimeCellAction<Row>[]
  effects?: Readonly<{
    resolve: (id: string) => GridRuntimeCellEffect<Row> | undefined
  }>
}>

export type GridRuntimeCellActionOutcome =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'set-value'; value: unknown }>
  | Readonly<{ kind: 'effect'; effect: string; input: unknown }>

export type GridRuntimeCellActionContext<Row> = GridRuntimeValueContext<Row> &
  Readonly<{
    value: unknown
    editable: boolean
  }>

export type GridRuntimeCellAction<Row> = Readonly<{
  id: string
  label:
    | string
    | ((context: GridRuntimeCellActionContext<Row>) => string)
  group?: string
  destructive: boolean
  requiresEditable: boolean
  hidden?: (context: GridRuntimeCellActionContext<Row>) => boolean
  disabled?: (context: GridRuntimeCellActionContext<Row>) => boolean
  run: (
    context: GridRuntimeCellActionContext<Row>,
  ) => GridValueResult<GridRuntimeCellActionOutcome>
}>

export type GridRuntimeCellEffect<Row> = Readonly<{
  id: string
  concurrency: 'replace-cell'
  run: (
    input: unknown,
    context: GridRuntimeValueContext<Row>,
    signal: AbortSignal,
  ) => Promise<GridValueResult<unknown>>
}>

export type GridCellBehaviorPort<Row> = Readonly<{
  resolve: (type: string) => GridRuntimeCellBehavior<Row> | undefined
}>

export type GridCompiledColumn<Row> = Readonly<{
  key: string
  label: string
  type: string
  typeOptions: unknown
  layout: GridColumnLayout
  getValue: (row: Row) => unknown
  setValue: ((row: Row, value: unknown) => Row) | null
  isEditable: (row: Row) => boolean
  validate: ((value: unknown, row: Row) => GridValueResult<unknown>) | null
  sortable: boolean
  filterable: boolean
  bulkEditable: boolean
  behavior: GridRuntimeCellBehavior<Row>
}>
