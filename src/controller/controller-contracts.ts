import type { EntityId } from '../kernel/model.js'
import type {
  GridCellTypeColumnOptions,
  GridCellTypeSchema,
  GridCellTypeValue,
} from '../cell-types/contracts.js'
import type { GridKernelDataSource as GridDataSource } from '../data/kernel-data-source.js'
import type { GridCloseResult, GridCloseState } from './controller-lifecycle.js'
import type { GridSaveResult, GridSaveRecovery, GridRefreshResult } from './controller-persistence.js'
import type { GridCommandResult, GridIssueCode } from '../model/grid-result.js'
export type { GridCommandResult, GridIssue, GridIssueCode } from '../model/grid-result.js'
export type { GridCloseResult, GridCloseState, GridCloseBlocker } from './controller-lifecycle.js'
export type { GridSaveResult, GridSaveRecovery, GridRefreshResult } from './controller-persistence.js'
import type {
  GridCellBehaviorPort,
  GridColumn,
  GridColumnFilter,
  GridCommandTarget,
  GridSaveTarget,
  GridControllerSnapshot,
  GridFeedbackItem,
  GridPersistenceMode,
  GridPoint,
  GridRange,
  GridRowKey,
  GridSort,
} from '../model/grid-model.js'

declare const gridControllerSchema: unique symbol

export type { GridCommandTarget } from '../model/grid-model.js'

export type GridEffectOwner<RowKey extends GridRowKey> =
  | { kind: 'controller' }
  | { kind: 'source' }
  | { kind: 'edit' }
  | { kind: 'persistence' }
  | { kind: 'cell'; cell: GridPoint<RowKey> }
  | { kind: 'cells'; write: readonly GridPoint<RowKey>[]; read?: readonly GridPoint<RowKey>[] }

export type GridEffectRequest<RowKey extends GridRowKey, Effect> = Readonly<{
  id?: string
  owner: GridEffectOwner<RowKey>
  concurrency?: 'reject' | 'replace'
  effect: Effect
}>

export type GridIntent<RowKey extends GridRowKey, Effect = never> =
  | { type: 'effect/inspect-result'; effectId: string }
  | { type: 'effect/apply-host-result'; effectId: string }
  | { type: 'order/resolve'; resolution: 'accept-remote' | 'keep-local' }
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
  | { type: 'history/compensate-insertion'; applicationId: string }
  | { type: 'effect/reapply-cell-result'; effectId: string; target?: GridPoint<RowKey> }
  | { type: 'effect/discard-result'; effectId: string }
  | { type: 'rows/add' }
  | { type: 'rows/duplicate' }
  | { type: 'rows/delete' }
  | { type: 'view/set-global-filter'; value: string }
  | { type: 'view/set-column-filters'; filters: readonly GridColumnFilter[] }
  | { type: 'view/set-sort'; sort: readonly GridSort[] }
  | { type: 'persistence/set-mode'; mode: GridPersistenceMode }
  | { type: 'feedback/push'; item: GridFeedbackItem }
  | { type: 'feedback/dismiss'; id: string }
  | { type: 'feedback/clear' }
  | {
      type: 'controller/run-effect'
      request: GridEffectRequest<RowKey, Effect>
    }
  | { type: 'controller/cancel-effect'; id: string }

export type GridMutationValue = Readonly<{ changedCells: number; applicationId: string | null }>
export type GridEffectStarted = Readonly<{ effectId: string }>

export type GridRetainedResult<RowKey extends GridRowKey, Effect> =
  | Readonly<{ kind: 'cell'; input: unknown; target: GridPoint<RowKey>; entityId: EntityId; result: import('../model/grid-model.js').GridValueResult<unknown> }>
  | Readonly<{ kind: 'external'; state: 'completed'; request: GridEffectRequest<RowKey, Effect>; targets: readonly GridEffectTarget<RowKey>[]; result: GridEffectResult }>
  | Readonly<{ kind: 'external'; state: 'failed'; request: GridEffectRequest<RowKey, Effect>; targets: readonly GridEffectTarget<RowKey>[]; issue: import('../model/grid-result.js').GridIssue }>

/** Correlates a command with its locally accepted value, not a server receipt. */
export type GridIntentValue<RowKey extends GridRowKey, Effect, Intent extends GridIntent<RowKey, Effect>> =
  Intent extends { type: 'selection/copy' } ? Readonly<{ text: string }>
  : Intent extends { type: 'selection/paste' } ? Readonly<{ changedCells: number; createdRows: number }>
  : Intent extends { type: 'selection/clear-values' } ? Readonly<{ changedCells: number; skippedCells: number }>
  : Intent extends { type: 'cell/run-effect' | 'controller/run-effect' } ? GridEffectStarted
  : Intent extends { type: 'effect/inspect-result' } ? GridRetainedResult<RowKey, Effect>
  : Intent extends { type: 'edit/commit-and-move' } ? Readonly<{ committed: true; moved: boolean }>
  : Intent extends { type: 'cell/run-action' } ? GridMutationValue | GridEffectStarted | void
  : Intent extends { type: 'effect/reapply-cell-result' } ? GridMutationValue | GridEffectStarted
  : Intent extends { type: 'cell/set-value' | 'edit/commit' | 'selection/fill' | 'cell/revert' | 'selection/revert'
      | 'history/compensate-insertion' | 'rows/add' | 'rows/duplicate' | 'rows/delete' | 'bulk/apply' } ? GridMutationValue
  : void

export type GridTransactionIssue<RowKey extends GridRowKey> = Readonly<{
  code: GridIssueCode
  message: string
  cell?: GridPoint<RowKey>
  domainCode?: string
}>

export type GridTransactionCommit<RowKey extends GridRowKey> = Readonly<{
  applicationId: string | null
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

/** Results supply data only. Addresses and the allowed write operation are
 * fixed when the controller accepts the request. */
export type GridEffectResult =
  | Readonly<{ kind: 'value'; value: unknown }>
  | Readonly<{ kind: 'values'; values: readonly unknown[] }>
  | void

export type GridEffectTarget<RowKey extends GridRowKey> = Readonly<{
  cell: GridPoint<RowKey>
  entityId: EntityId
  access: 'read' | 'write'
}>

export type GridEffectInput<Row, RowKey extends GridRowKey> = GridEffectTarget<RowKey> & Readonly<{ row: Row; value: unknown }>

export type GridEffectPort<Row, RowKey extends GridRowKey, Effect> = Readonly<{
  run(effect: Effect, context: Readonly<{
    signal: AbortSignal
    owner: GridEffectOwner<RowKey>
    cells: readonly GridEffectInput<Row, RowKey>[]
  }>): GridEffectResult | Promise<GridEffectResult>
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
  dispatch<Intent extends GridIntent<RowKey, Effect>>(intent: Intent, target?: GridCommandTarget<RowKey>): GridCommandResult<GridIntentValue<RowKey, Effect, Intent>>
  undo(): GridCommandResult<void>
  redo(): GridCommandResult<void>
  /** Covers the actual frozen request; later work remains separately owned. */
  save(target?: GridSaveTarget<RowKey>): Promise<GridSaveResult>
  recoverSave(recovery: GridSaveRecovery): Promise<GridSaveResult>
  refresh(): Promise<GridRefreshResult>
  /** New tasks capture this port; updating it never transfers running tasks. */
  updateEffects(port: GridEffectPort<Row, RowKey, Effect> | undefined): GridCommandResult<void>
  /** Current close/switch blockers. Destruction rechecks this state atomically. */
  getCloseState(): GridCloseState
  /** Refuses to destroy unresolved operations, raw input or retained task results. */
  destroy(): GridCloseResult
}>
