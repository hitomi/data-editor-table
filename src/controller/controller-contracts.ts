import type {
  GridCellTypeColumnOptions,
  GridCellTypeSchema,
  GridCellTypeValue,
} from '../cell-types/contracts.js'
import type { GridDataSource } from '../data/data-source.js'
import type {
  GridCellBehaviorPort,
  GridColumn,
  GridColumnFilter,
  GridControllerSnapshot,
  GridEditStatus,
  GridFeedbackItem,
  GridHitTarget,
  GridPersistenceMode,
  GridPoint,
  GridPointerModifiers,
  GridRange,
  GridRowKey,
  GridSort,
} from '../model/grid-model.js'

declare const gridControllerSchema: unique symbol

export type GridKeyboardCommand =
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'edit'
  | 'commit-edit'
  | 'cancel'
  | 'clear'
  | 'undo'
  | 'redo'

export type GridEffectOwner<RowKey extends GridRowKey> =
  | { kind: 'controller' }
  | { kind: 'source' }
  | { kind: 'edit' }
  | { kind: 'persistence' }
  | { kind: 'cell'; cell: GridPoint<RowKey> }

export type GridEffectRequest<RowKey extends GridRowKey, Effect> = Readonly<{
  id?: string
  owner: GridEffectOwner<RowKey>
  concurrency?: 'reject' | 'replace'
  effect: Effect
}>

export type GridIntent<RowKey extends GridRowKey, Effect = never> =
  | { type: 'source/refresh' }
  | { type: 'viewport/resized'; width: number; height: number }
  | { type: 'viewport/scrolled'; scrollLeft: number; scrollTop: number }
  | {
      type: 'pointer/start'
      pointerId: number
      target: GridHitTarget<RowKey>
      modifiers: GridPointerModifiers
    }
  | { type: 'pointer/move'; pointerId: number; target: GridHitTarget<RowKey> }
  | { type: 'pointer/end'; pointerId: number; target?: GridHitTarget<RowKey> }
  | { type: 'pointer/cancel'; pointerId: number }
  | { type: 'keyboard/command'; command: GridKeyboardCommand; extend?: boolean }
  | {
      type: 'interaction/activate'
      cell: GridPoint<RowKey>
      range?: GridRange<RowKey>
    }
  | {
      type: 'interaction/set-ranges'
      ranges: readonly GridRange<RowKey>[]
      activeRangeIndex: number | null
    }
  | {
      type: 'interaction/open-action'
      target: GridPoint<RowKey>
      menuPosition: Readonly<{ x: number; y: number }> | null
    }
  | { type: 'interaction/close-action' }
  | { type: 'interaction/clear' }
  | { type: 'edit/start'; cell?: GridPoint<RowKey> }
  | { type: 'edit/change'; value: unknown }
  | { type: 'edit/set-composing'; composing: boolean; finalValue?: unknown }
  | { type: 'edit/set-status'; status: GridEditStatus; error?: string | null }
  | { type: 'edit/commit' }
  | { type: 'edit/cancel' }
  | { type: 'edit/commit-and-move'; direction: 'next' | 'previous' | 'down' }
  | {
      type: 'cell/set-value'
      cell: GridPoint<RowKey>
      value: unknown
      label?: string
    }
  | {
      type: 'cell/run-effect'
      cell: GridPoint<RowKey>
      effect: string
      input: unknown
    }
  | { type: 'cell/cancel-effect'; effectId: string }
  | { type: 'cell/run-action'; cell: GridPoint<RowKey>; action: string }
  | { type: 'selection/copy' }
  | { type: 'selection/paste'; text: string }
  | { type: 'selection/clear-values' }
  | { type: 'selection/fill'; target: GridRange<RowKey> }
  | { type: 'cell/revert'; cell: GridPoint<RowKey> }
  | { type: 'selection/revert' }
  | { type: 'rows/revert'; rowKeys?: readonly RowKey[] }
  | {
      type: 'conflict/resolve'
      rowKey: RowKey
      columnKey: string | null
      resolution: 'accept-remote' | 'keep-local'
    }
  | { type: 'bulk/start'; columnKey?: string }
  | { type: 'bulk/change'; value: unknown }
  | { type: 'bulk/apply' }
  | { type: 'bulk/cancel' }
  | { type: 'filter/open'; columnKey: string }
  | {
      type: 'filter/change'
      index?: number
      operator?: string
      value?: unknown
      combine?: 'all' | 'any'
    }
  | { type: 'filter/add-condition' }
  | { type: 'filter/remove-condition'; index: number }
  | { type: 'filter/apply' }
  | { type: 'filter/clear' }
  | { type: 'filter/cancel' }
  | { type: 'history/undo' }
  | { type: 'history/redo' }
  | { type: 'rows/add' }
  | { type: 'rows/duplicate' }
  | { type: 'rows/delete' }
  | { type: 'view/set-global-filter'; value: string }
  | { type: 'view/set-column-filters'; filters: readonly GridColumnFilter[] }
  | { type: 'view/set-sort'; sort: readonly GridSort[] }
  | { type: 'persistence/set-mode'; mode: GridPersistenceMode }
  | { type: 'persistence/save' }
  | { type: 'persistence/retry' }
  | { type: 'feedback/push'; item: GridFeedbackItem }
  | { type: 'feedback/dismiss'; id: string }
  | { type: 'feedback/clear' }
  | {
      type: 'controller/run-effect'
      request: GridEffectRequest<RowKey, Effect>
    }
  | { type: 'controller/cancel-effect'; id: string }

export type GridDispatchResult = Readonly<{
  accepted: boolean
  revision: number
  reason?: string
  payload?: unknown
}>

export type GridTransactionIssue<RowKey extends GridRowKey> = Readonly<{
  code: string
  message: string
  cell?: GridPoint<RowKey>
}>

export type GridTransactionCommit<RowKey extends GridRowKey> = Readonly<{
  createdRowKeys: readonly RowKey[]
  deletedRowKeys: readonly RowKey[]
  movedRowKeys: readonly RowKey[]
  changedCells: readonly GridPoint<RowKey>[]
}>

export type GridTransactionRowPosition<RowKey extends GridRowKey> = Readonly<{
  /** Insert before this staged row. Omit or pass null to append. */
  beforeRowKey?: RowKey | null
}>

export type GridTransactionResult<RowKey extends GridRowKey> =
  | Readonly<{
      accepted: true
      revision: number
      result: GridTransactionCommit<RowKey>
      issues: readonly []
    }>
  | Readonly<{
      accepted: false
      revision: number
      result: null
      issues: readonly [GridTransactionIssue<RowKey>, ...GridTransactionIssue<RowKey>[]]
    }>

export type GridApplyTransactionOptions = Readonly<{
  label?: string
}>

export type GridTransactionContext<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
> = Readonly<{
  /** The exact controller snapshot captured before the transaction builder ran. */
  base: GridControllerSnapshot<Row, RowKey>
  /**
   * Stage one row from the data source's synchronous row factory. Placement
   * addresses staged draft order, never a filtered or sorted visible index.
   */
  createRow(position?: GridTransactionRowPosition<RowKey>): RowKey
  /** Duplicate a complete staged row through the data source's row factory. */
  duplicateRow(
    sourceRowKey: RowKey,
    position?: GridTransactionRowPosition<RowKey>,
  ): RowKey
  /**
   * Move staged rows as one contiguous group, preserving their current draft
   * order. An anchor inside the group is an intentional no-op.
   */
  moveRows(
    rowKeys: readonly RowKey[],
    position?: GridTransactionRowPosition<RowKey>,
  ): void
  /** Delete rows atomically after every row passes the data-source policy. */
  deleteRows(rowKeys: readonly RowKey[]): void
  /** Stage a value for a configured column. Each cell may be targeted once. */
  set<Name extends Extract<keyof Schema, string>>(
    column: GridColumn<
      Row,
      GridCellTypeValue<Schema[Name]>,
      Name,
      GridCellTypeColumnOptions<Schema[Name]>
    >,
    rowKey: RowKey,
    value: NoInfer<GridCellTypeValue<Schema[Name]>>,
  ): void
  /** Stop the builder immediately. Nothing staged by it is published. */
  abort(issue: GridTransactionIssue<RowKey> | string): never
}>

export type GridTransactionBuilder<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
> = (transaction: GridTransactionContext<Row, RowKey, Schema>) => void

export type GridEffectResult<RowKey extends GridRowKey, Effect> =
  | GridIntent<RowKey, Effect>
  | readonly GridIntent<RowKey, Effect>[]
  | void

export type GridEffectPort<Row, RowKey extends GridRowKey, Effect> = Readonly<{
  run(
    effect: Effect,
    context: Readonly<{
      signal: AbortSignal
      getSnapshot(): GridControllerSnapshot<Row, RowKey>
    }>,
  ):
    | GridEffectResult<RowKey, Effect>
    | Promise<GridEffectResult<RowKey, Effect>>
}>

export type GridControllerOptions<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
> = Readonly<{
  dataSource: GridDataSource<Row, RowKey, Schema>
  cellBehaviors: GridCellBehaviorPort<Row>
  effects?: GridEffectPort<Row, RowKey, Effect>
  rowHeight?: number
  headerHeight?: number
  rowIndicatorWidth?: number
  maxMutations?: number
  maxClipboardBytes?: number
}>

export type GridController<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
> = Readonly<{
  readonly [gridControllerSchema]?: Schema
  getSnapshot(): GridControllerSnapshot<Row, RowKey>
  subscribe(listener: () => void): () => void
  subscribeSelector<Selected>(
    selector: (snapshot: GridControllerSnapshot<Row, RowKey>) => Selected,
    listener: () => void,
    isEqual?: (left: Selected, right: Selected) => boolean,
  ): () => void
  applyTransaction(
    build: GridTransactionBuilder<Row, RowKey, Schema>,
    options?: GridApplyTransactionOptions,
  ): GridTransactionResult<RowKey>
  dispatch(intent: GridIntent<RowKey, Effect>): GridDispatchResult
  destroy(): void
}>
