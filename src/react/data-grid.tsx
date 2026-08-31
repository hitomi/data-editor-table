import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridCellTypeRegistry } from '../cell-types/registry.js'
import {
  createGridController,
  type GridController,
  type GridDispatchResult,
  type GridEffectPort,
} from '../controller/grid-controller.js'
import { selectedCells } from '../controller/selection-model.js'
import type { GridDataSource } from '../data/data-source.js'
import { resolveGridCellValue } from '../data/runtime-cell-resolver.js'
import { invokeGridCallback } from '../data/safe-callback.js'
import type {
  GridControllerSnapshot,
  GridFeedbackItem,
  GridPoint,
  GridRowKey,
} from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import {
  selectGridRowDeletePlan,
  selectGridRowDuplicatePlan,
  selectGridSavePlan,
  selectGridSelectionSummary,
} from '../controller/grid-selectors.js'
import {
  reportGridRejectedAction,
  type GridRejectedActionPresenter,
  useGridSelector,
} from './controller-react.js'
import { writeGridClipboard } from './clipboard-boundary.js'
import { GridDomEffectAdapter } from './dom-effect-adapter.js'
import {
  GridContextMenu,
  GridDialog,
  GridPortalThemeBridge,
  type GridContextMenuProps,
  type GridMenuAction,
} from './grid-layers.js'
import {
  GridFilterDialog,
  GridFooter,
  GridToolbar,
  type GridFilterDialogProps,
  type GridFooterMessages,
  type GridFooterProps,
  type GridToolbarMessages,
  type GridToolbarProps,
} from './grid-surfaces.js'
import {
  GridViewport,
  type DataGridRowDropZone,
  type GridViewportMessages,
} from './grid-viewport.js'
import type { DataGridRowHeaderActions } from './grid-cells.js'

export type {
  DataGridRowHeaderActionContext,
  DataGridRowHeaderActions,
} from './grid-cells.js'
export type {
  DataGridRowDropTarget,
  DataGridRowDropZone,
} from './grid-viewport.js'

export type DataGridBinding<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
> = Readonly<{
  dataSource: GridDataSource<Row, RowKey, Schema>
  registry: GridCellTypeRegistry<Row, Schema>
  controller: GridController<Row, RowKey, Schema, Effect>
  destroy: () => void
}>

export type CreateDataGridBindingOptions<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
> = Readonly<{
  dataSource: GridDataSource<Row, RowKey, Schema>
  registry: GridCellTypeRegistry<Row, Schema>
  effects?: GridEffectPort<Row, RowKey, Effect>
  maxMutations?: number
  maxClipboardBytes?: number
  rowHeight?: number
  headerHeight?: number
  rowIndicatorWidth?: number
}>

export function createDataGridBinding<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
>({
  dataSource,
  effects,
  headerHeight,
  maxClipboardBytes,
  maxMutations,
  registry,
  rowHeight,
  rowIndicatorWidth,
}: CreateDataGridBindingOptions<Row, RowKey, Schema, Effect>): DataGridBinding<Row, RowKey, Schema, Effect> {
  const controller = createGridController<Row, RowKey, Schema, Effect>({
    dataSource,
    cellBehaviors: registry.behaviors,
    ...(effects === undefined ? {} : { effects }),
    ...(maxMutations === undefined ? {} : { maxMutations }),
    ...(maxClipboardBytes === undefined ? {} : { maxClipboardBytes }),
    ...(rowHeight === undefined ? {} : { rowHeight }),
    ...(headerHeight === undefined ? {} : { headerHeight }),
    ...(rowIndicatorWidth === undefined ? {} : { rowIndicatorWidth }),
  })
  return Object.freeze({ dataSource, registry, controller, destroy: () => controller.destroy() })
}

type DataGridCommonProps<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect> = Readonly<{
  ariaLabel: string
  className?: string
  messages?: Partial<DataGridMessages>
  surfaceRenderers?: DataGridSurfaceRenderers
  toolbarActions?: (controller: GridController<Row, RowKey, Schema, Effect>) => ReactNode
  rowHeaderActions?: DataGridRowHeaderActions<Row, RowKey, Schema, Effect>
  rowDropZone?: DataGridRowDropZone<RowKey>
}>

export type DataGridMessages = GridToolbarMessages & GridFooterMessages & GridFilterDialogProps['messages'] & GridViewportMessages & Readonly<{
  loadingData: string
  sourceConfigurationChanged: string
  detachedSourceWork: string
  rowsRefreshFailed: string
  retryRefresh: string
  changesSaveFailed: string
  refreshData: string
  retrySave: string
  editCells: (count: number) => string
  dismissMessage: string
  editCell: string
  copySelection: string
  clipboardUnavailable: string
  clipboardWriteFailed: string
  clearSelection: string
  useRemoteCell: string
  keepLocalCell: string
  useRemoteRow: string
  keepLocalRow: string
  restoreCell: string
  restoreSelection: string
  restoreRow: string
}>

export type DataGridBulkDialogProps = Readonly<{
  ariaLabel: string
  title: ReactNode
  editor: ReactNode
}>

export type DataGridFeedbackProps = Readonly<{
  item: Readonly<{ id: string; kind: GridFeedbackItem['kind']; message: string; persistent: boolean }>
  onDismiss: () => void
  dismissLabel: string
}>

export type DataGridSurfaceRenderers = Readonly<{
  toolbar?: (props: GridToolbarProps) => ReactNode
  footer?: (props: GridFooterProps) => ReactNode
  contextMenu?: (props: GridContextMenuProps) => ReactNode
  filterDialog?: (props: GridFilterDialogProps) => ReactNode
  bulkDialog?: (props: DataGridBulkDialogProps) => ReactNode
  feedback?: (props: DataGridFeedbackProps) => ReactNode
}>

const DEFAULT_MESSAGES: DataGridMessages = Object.freeze({
  loadingData: 'Loading data…',
  sourceConfigurationChanged: 'This table’s columns, sizing, or editing limits changed. Reopen it to apply the update. Your current edits remain available with the previous setup.',
  detachedSourceWork: 'Another set of data has unsaved or in-progress changes. Return to review or save them.',
  rowsRefreshFailed: 'Rows could not be refreshed.',
  retryRefresh: 'Retry refresh',
  changesSaveFailed: 'Changes could not be saved.',
  refreshData: 'Refresh data',
  retrySave: 'Retry save',
  actionsLabel: 'Grid actions',
  filterRowsLabel: 'Filter rows',
  filterRowsPlaceholder: 'Filter rows…',
  undo: 'Undo',
  redo: 'Redo',
  editSelection: 'Edit selection…',
  addRow: 'Add row',
  duplicateRows: (count) => count > 1 ? `Duplicate ${count} rows` : 'Duplicate row',
  deleteRows: (count) => count > 1 ? `Delete ${count} rows` : 'Delete row',
  deleteRowsBlocked: (blockedCount, selectedCount) => blockedCount === selectedCount
    ? selectedCount === 1
      ? 'The selected row cannot be deleted.'
      : 'The selected rows cannot be deleted.'
    : `${blockedCount} of ${selectedCount} selected rows cannot be deleted. Remove them from the selection to delete the other rows.`,
  saving: 'Saving…',
  saveChanges: 'Save changes',
  rows: (visible, total) => visible === total ? `${total} rows` : `${visible} of ${total} rows`,
  selection: (rows, columns, cells) => `${rows} rows × ${columns} columns · ${cells} cells`,
  changed: (count) => `${count} changed`,
  invalid: (count) => `${count} invalid`,
  conflicted: (count) => `${count} conflicted`,
  saveScheduled: 'Save scheduled',
  editCells: (count) => `Edit ${count} selected cells`,
  dismissMessage: 'Dismiss message',
  editCell: 'Edit cell',
  copySelection: 'Copy selection',
  clipboardUnavailable: 'Clipboard access is unavailable. Use Ctrl+C to copy the selection.',
  clipboardWriteFailed: 'The selection could not be copied. Allow clipboard access or use Ctrl+C.',
  clearSelection: 'Clear selected cells',
  useRemoteCell: 'Use remote value',
  keepLocalCell: 'Keep local value',
  useRemoteRow: 'Use remote row',
  keepLocalRow: 'Keep local row',
  restoreCell: 'Restore original cell',
  restoreSelection: 'Restore selected cells',
  restoreRow: 'Restore original row',
  dialogLabel: (column) => `Filter ${column}`,
  title: (column) => `Filter ${column}`,
  match: 'Match',
  allConditions: 'All conditions',
  anyCondition: 'Any condition',
  condition: (index) => `Condition ${index}`,
  value: (column, index, multiple) => `${column} value${multiple ? ` ${index}` : ''}`,
  removeCondition: (index) => `Remove condition ${index}`,
  clearFilter: 'Clear filter',
  addCondition: 'Add condition',
  cancel: 'Cancel',
  applyFilter: 'Apply filter',
  selectAllCells: 'Select all cells',
  columnContainsChanges: 'Column contains changes',
  filterColumn: (columnLabel) => `Filter ${columnLabel}`,
  sortColumn: (columnLabel) => `Sort ${columnLabel}`,
  sortColumnAscending: (columnLabel) => `Sort ${columnLabel} ascending`,
  sortColumnDescending: (columnLabel) => `Sort ${columnLabel} descending`,
  clearColumnSort: (columnLabel) => `Clear sorting for ${columnLabel}`,
  rowLabel: (rowNumber) => `Row ${rowNumber}`,
  selectRow: (rowLabel) => `Select ${rowLabel}`,
  rowCannotBeDeleted: () => 'Row cannot be deleted',
  rowContainsChanges: 'Row contains changes',
  rowChangedTitle: (rowLabel) => `${rowLabel} contains changes`,
  cellContainsChanges: 'Cell contains changes',
  changedCellOriginalValue: (originalValue) => `Changed. Original value: ${originalValue}`,
  emptyOriginalValue: 'Empty',
  originalValue: 'Original value',
  revertCell: 'Revert cell',
  loadingRows: 'Loading rows…',
  refreshingRows: 'Refreshing rows…',
  rowsLoadError: 'Rows could not be loaded.',
  emptyRows: 'No rows yet.',
  filteredEmptyRows: 'No rows match the current filters.',
  unknownCellType: (cellType) => `Unknown cell type: ${cellType}`,
  cancelInvalidEdit: 'Cancel edit',
  unsavedEditValue: (draftText) => `Unsaved edit: ${draftText}`,
  currentInvalidSourceValue: (fallbackText) => `Current source value: ${fallbackText}`,
  applyHiddenEdit: 'Apply edit',
  editedCellOutsideViewport: 'The edited cell is outside the visible grid.',
  editedRowHidden: 'The edited row is outside the current view.',
  editedRowUnavailable: 'The edited row is no longer available.',
  rejectedAction: (reason) => reason,
})

export type DataGridProps<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
> = DataGridCommonProps<Row, RowKey, Schema, Effect> & (
  | Readonly<{ binding: DataGridBinding<Row, RowKey, Schema, Effect>; dataSource?: never; registry?: never; effects?: never; maxMutations?: never; maxClipboardBytes?: never; rowHeight?: never; headerHeight?: never; rowIndicatorWidth?: never }>
  | Readonly<{
    binding?: never
    dataSource: GridDataSource<Row, RowKey, Schema>
    registry: GridCellTypeRegistry<Row, Schema>
    effects?: GridEffectPort<Row, RowKey, Effect>
    maxMutations?: number
    maxClipboardBytes?: number
    rowHeight?: number
    headerHeight?: number
    rowIndicatorWidth?: number
  }>
)

/**
 * Turnkey business-data editor. The controller owns all semantic state while
 * React projects its immutable snapshot into one non-virtualized scrollport.
 * A data-source identity owns one controller; its registry and layout options
 * remain fixed for that identity, while the optional effect port stays live.
 */
export function DataGrid<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
>(props: DataGridProps<Row, RowKey, Schema, Effect>) {
  if (props.binding) return <BoundDataGrid
    ariaLabel={props.ariaLabel}
    binding={props.binding}
    {...(props.className === undefined ? {} : { className: props.className })}
    {...(props.messages === undefined ? {} : { messages: props.messages })}
    {...(props.surfaceRenderers === undefined ? {} : { surfaceRenderers: props.surfaceRenderers })}
    {...(props.toolbarActions === undefined ? {} : { toolbarActions: props.toolbarActions })}
    {...(props.rowHeaderActions === undefined ? {} : { rowHeaderActions: props.rowHeaderActions })}
    {...(props.rowDropZone === undefined ? {} : { rowDropZone: props.rowDropZone })}
  />
  return <OwnedDataGrid
    ariaLabel={props.ariaLabel}
    dataSource={props.dataSource}
    {...(props.effects === undefined ? {} : { effects: props.effects })}
    {...(props.maxMutations === undefined ? {} : { maxMutations: props.maxMutations })}
    {...(props.maxClipboardBytes === undefined ? {} : { maxClipboardBytes: props.maxClipboardBytes })}
    registry={props.registry}
    {...(props.className === undefined ? {} : { className: props.className })}
    {...(props.headerHeight === undefined ? {} : { headerHeight: props.headerHeight })}
    {...(props.rowHeight === undefined ? {} : { rowHeight: props.rowHeight })}
    {...(props.rowIndicatorWidth === undefined ? {} : { rowIndicatorWidth: props.rowIndicatorWidth })}
    {...(props.messages === undefined ? {} : { messages: props.messages })}
    {...(props.surfaceRenderers === undefined ? {} : { surfaceRenderers: props.surfaceRenderers })}
    {...(props.toolbarActions === undefined ? {} : { toolbarActions: props.toolbarActions })}
    {...(props.rowHeaderActions === undefined ? {} : { rowHeaderActions: props.rowHeaderActions })}
    {...(props.rowDropZone === undefined ? {} : { rowDropZone: props.rowDropZone })}
  />
}

function OwnedDataGrid<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  ariaLabel,
  className,
  dataSource,
  effects,
  headerHeight,
  maxClipboardBytes,
  maxMutations,
  messages: messageOverrides,
  registry,
  rowHeight,
  rowIndicatorWidth,
  rowHeaderActions,
  rowDropZone,
  surfaceRenderers,
  toolbarActions,
}: DataGridCommonProps<Row, RowKey, Schema, Effect> & Readonly<{
  dataSource: GridDataSource<Row, RowKey, Schema>
  registry: GridCellTypeRegistry<Row, Schema>
  effects?: GridEffectPort<Row, RowKey, Effect>
  maxMutations?: number
  maxClipboardBytes?: number
  rowHeight?: number
  headerHeight?: number
  rowIndicatorWidth?: number
}>) {
  const ownerMessages = { ...DEFAULT_MESSAGES, ...messageOverrides }
  type OwnedEntry = Readonly<{
    dataSource: GridDataSource<Row, RowKey, Schema>
    registry: GridCellTypeRegistry<Row, Schema>
    effectsRef: { current: GridEffectPort<Row, RowKey, Effect> | undefined }
    maxMutations: number | undefined
    maxClipboardBytes: number | undefined
    rowHeight: number | undefined
    headerHeight: number | undefined
    rowIndicatorWidth: number | undefined
    binding: DataGridBinding<Row, RowKey, Schema, Effect>
  }>
  const pool = useRef<OwnedEntry[]>([])
  const [owned, setOwned] = useState<OwnedEntry | null>(null)
  const active = useRef<OwnedEntry | null>(null)
  useLayoutEffect(() => {
    const previous = active.current
    let next = pool.current.find((candidate) => candidate.dataSource === dataSource)
    if (!next) {
      const effectsRef = { current: effects }
      const effectPort: GridEffectPort<Row, RowKey, Effect> = {
        run: (effect, context) => {
          const current = effectsRef.current
          if (!current) throw new Error('No effect port is configured for this data source.')
          return current.run(effect, context)
        },
      }
      const binding = createDataGridBinding<Row, RowKey, Schema, Effect>({
        dataSource,
        registry,
        effects: effectPort,
        ...(maxMutations === undefined ? {} : { maxMutations }),
        ...(maxClipboardBytes === undefined ? {} : { maxClipboardBytes }),
        ...(rowHeight === undefined ? {} : { rowHeight }),
        ...(headerHeight === undefined ? {} : { headerHeight }),
        ...(rowIndicatorWidth === undefined ? {} : { rowIndicatorWidth }),
      })
      next = { dataSource, registry, effectsRef, maxMutations, maxClipboardBytes, rowHeight, headerHeight, rowIndicatorWidth, binding }
      pool.current.push(next)
    } else {
      next.effectsRef.current = effects
    }
    if (next.registry !== registry
      || next.maxMutations !== maxMutations
      || next.maxClipboardBytes !== maxClipboardBytes
      || next.rowHeight !== rowHeight
      || next.headerHeight !== headerHeight
      || next.rowIndicatorWidth !== rowIndicatorWidth) {
      next.binding.controller.dispatch({
        type: 'feedback/push',
        item: {
          id: 'grid:source-configuration-change',
          kind: 'warning',
          message: ownerMessages.sourceConfigurationChanged,
          persistent: true,
        },
      })
    }
    if (previous && previous !== next && hasPendingWork(previous.binding.controller.getSnapshot())) {
      next.binding.controller.dispatch({
        type: 'feedback/push',
        item: {
          id: 'grid:detached-source-work',
          kind: 'warning',
          message: ownerMessages.detachedSourceWork,
          persistent: true,
        },
      })
    }
    active.current = next
    setOwned(next)
  }, [
    dataSource,
    effects,
    headerHeight,
    maxClipboardBytes,
    maxMutations,
    ownerMessages.detachedSourceWork,
    ownerMessages.sourceConfigurationChanged,
    registry,
    rowHeight,
    rowIndicatorWidth,
  ])
  useLayoutEffect(() => () => {
    pool.current.forEach((entry) => { entry.binding.destroy() })
    pool.current.length = 0
    active.current = null
  }, [])
  const current = owned
    && owned.dataSource === dataSource
    ? owned.binding
    : null
  if (!current) return <div
    aria-busy="true"
    aria-label={ariaLabel}
    className={['business-grid', className].filter(Boolean).join(' ')}
    role="grid"
  ><div className="business-grid__initializing" role="status">{ownerMessages.loadingData}</div></div>
  return <BoundDataGrid
    ariaLabel={ariaLabel}
    binding={current}
    {...(className === undefined ? {} : { className })}
    {...(messageOverrides === undefined ? {} : { messages: messageOverrides })}
    {...(surfaceRenderers === undefined ? {} : { surfaceRenderers })}
    {...(toolbarActions === undefined ? {} : { toolbarActions })}
    {...(rowHeaderActions === undefined ? {} : { rowHeaderActions })}
    {...(rowDropZone === undefined ? {} : { rowDropZone })}
  />
}

function hasPendingWork<Row, RowKey extends GridRowKey>(snapshot: import('../model/grid-model.js').GridControllerSnapshot<Row, RowKey>) {
  return snapshot.draft.dirtyCells.length > 0
    || snapshot.draft.insertedRowKeys.length > 0
    || snapshot.draft.deletedRowKeys.length > 0
    || snapshot.draft.orderDirty
    || snapshot.draft.conflicts.length > 0
    || snapshot.edit !== null
    || snapshot.bulk !== null
    || snapshot.persistence.status === 'saving'
}

function BoundDataGridImpl<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  ariaLabel,
  binding,
  className,
  messages: messageOverrides,
  surfaceRenderers,
  toolbarActions,
  rowHeaderActions,
  rowDropZone,
}: DataGridCommonProps<Row, RowKey, Schema, Effect> & Readonly<{
  binding: DataGridBinding<Row, RowKey, Schema, Effect>
}>) {
  const { controller, dataSource, registry } = binding
  const messages = useMemo(() => ({ ...DEFAULT_MESSAGES, ...messageOverrides }), [messageOverrides])
  const dom = useMemo(() => new GridDomEffectAdapter(), [controller])
  const pointerOwner = useId()
  const root = useRef<HTMLDivElement>(null)
  const ownedPointerEvents = useRef(new WeakSet<Event>())
  useEffect(() => {
    return () => { dom.destroy() }
  }, [dom])
  useEffect(() => {
    let active = true
    const clearOutsideSelection = (event: globalThis.PointerEvent) => {
      const path = event.composedPath()
      // React portal events still travel through this Grid's component tree.
      // Defer until its capture handlers have had a chance to claim the native
      // event; DOM containment alone cannot identify a body-level portal.
      queueMicrotask(() => {
        if (!active) return
        if (
          ownedPointerEvents.current.has(event) ||
          path.some((target) =>
            target instanceof Element &&
            target.getAttribute('data-grid-pointer-owner') === pointerOwner,
          )
        ) return
        const current = controller.getSnapshot()
        const interaction = current.interaction
        if (
          interaction.activeCell === null &&
          interaction.ranges.length === 0 &&
          interaction.actionSession === null &&
          current.edit === null
        ) return
        controller.dispatch({ type: 'interaction/clear' })
      })
    }
    document.addEventListener('pointerdown', clearOutsideSelection, true)
    return () => {
      active = false
      document.removeEventListener('pointerdown', clearOutsideSelection, true)
    }
  }, [controller, pointerOwner])
  const actionSlot = toolbarActions?.(controller)
  return <GridPortalThemeBridge ownerId={pointerOwner} root={root}><div
    className={['business-grid', className].filter(Boolean).join(' ')}
    data-grid-pointer-owner={pointerOwner}
    ref={root}
    onPointerDownCapture={(event) => { ownedPointerEvents.current.add(event.nativeEvent) }}
  >
    <GridToolbarBoundary actionSlot={actionSlot} controller={controller} dataSource={dataSource} messages={messages} registry={registry} renderer={surfaceRenderers?.toolbar} />
    <GridViewport
      ariaLabel={ariaLabel}
      controller={controller}
      dom={dom}
      messages={messages}
      onOpenFilter={(columnKey) => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/open', columnKey }))}
      {...(rowHeaderActions === undefined ? {} : { rowHeaderActions })}
      {...(rowDropZone === undefined ? {} : { rowDropZone })}
      views={registry.views}
    />
    <GridFooterBoundary controller={controller} messages={messages} renderer={surfaceRenderers?.footer} />
    <GridFeedbackBoundary controller={controller} messages={messages} renderer={surfaceRenderers?.feedback} />
    <GridContextMenuBoundary controller={controller} dataSource={dataSource} dom={dom} messages={messages} registry={registry} renderer={surfaceRenderers?.contextMenu} />
    <GridBulkDialogBoundary controller={controller} messages={messages} registry={registry} renderer={surfaceRenderers?.bulkDialog} />
    <GridFilterDialogBoundary controller={controller} messages={messages} renderer={surfaceRenderers?.filterDialog} />
  </div></GridPortalThemeBridge>
}

const BoundDataGrid = memo(BoundDataGridImpl) as typeof BoundDataGridImpl

function GridToolbarBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  actionSlot,
  controller,
  dataSource,
  messages,
  registry,
  renderer,
}: {
  actionSlot: ReactNode
  controller: GridController<Row, RowKey, Schema, Effect>
  dataSource: GridDataSource<Row, RowKey, Schema>
  messages: DataGridMessages
  registry: GridCellTypeRegistry<Row, Schema>
  renderer: DataGridSurfaceRenderers['toolbar'] | undefined
}) {
  const state = useGridSelector(controller, (snapshot) => selectGridCommandState(snapshot, dataSource, registry, messages), shallowEqual)
  const props: GridToolbarProps = {
    ...(actionSlot === undefined ? {} : { actionSlot }),
    messages,
    onAddRows: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'rows/add' })),
    onBulkEdit: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'bulk/start' })),
    onDeleteRows: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'rows/delete' })),
    onDuplicateRows: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'rows/duplicate' })),
    onGlobalFilterChange: (value) => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'view/set-global-filter', value })),
    onRedo: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'history/redo' })),
    onSave: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'persistence/save' })),
    onUndo: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'history/undo' })),
    state,
  }
  return renderer ? renderer(props) : <GridToolbar {...props} />
}

function GridFooterBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  controller,
  messages,
  renderer,
}: {
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: DataGridMessages
  renderer: DataGridSurfaceRenderers['footer'] | undefined
}) {
  const state = useGridSelector(controller, (snapshot) => {
    const selection = selectGridSelectionSummary(snapshot)
    return {
      conflictCount: snapshot.draft.conflicts.length,
      dirtyCount: dirtyCount(snapshot),
      invalidCount: snapshot.draft.validationIssues.length,
      persistenceError: snapshot.persistence.error,
      persistenceRetryOperationId: snapshot.persistence.retryOperationId,
      persistenceStatus: snapshot.persistence.status,
      selectedCellCount: selection.cellCount,
      selectedColumnCount: selection.columnCount,
      selectedRowCount: selection.rowCount,
      sourceCanRefresh: snapshot.sourceOperations.canRefresh,
      sourceError: snapshot.source.error,
      sourceStatus: snapshot.source.status,
      totalRowCount: snapshot.draft.rows.length,
      visibleRowCount: snapshot.view.visibleRowKeys.length,
    } as const
  }, shallowEqual)
  const feedback = state.sourceStatus === 'refreshing' && state.visibleRowCount > 0
    ? <span>{messages.refreshingRows}</span>
    : state.sourceStatus === 'error'
      ? <><span>{state.sourceError ?? messages.rowsRefreshFailed}</span> {state.sourceCanRefresh ? <button
        className="business-grid__link-button"
        type="button"
        onClick={() => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'source/refresh' }))}
      >{messages.retryRefresh}</button> : null}</>
      : state.persistenceStatus === 'failed'
        ? <><span>{state.persistenceError ?? messages.changesSaveFailed}</span> {state.persistenceRetryOperationId !== null || state.sourceCanRefresh ? <button
          className="business-grid__link-button"
          type="button"
          onClick={() => reportRejected(controller, messages.rejectedAction, controller.dispatch(state.persistenceRetryOperationId === null
            ? { type: 'source/refresh' }
            : { type: 'persistence/retry' }))}
        >{state.persistenceRetryOperationId === null ? messages.refreshData : messages.retrySave}</button> : null}</>
        : null
  const props: GridFooterProps = {
    conflictCount: state.conflictCount,
    dirtyCount: state.dirtyCount,
    feedback,
    invalidCount: state.invalidCount,
    messages,
    persistenceStatus: state.persistenceStatus,
    selectedCellCount: state.selectedCellCount,
    selectedColumnCount: state.selectedColumnCount,
    selectedRowCount: state.selectedRowCount,
    totalRowCount: state.totalRowCount,
    visibleRowCount: state.visibleRowCount,
  }
  return renderer ? renderer(props) : <GridFooter {...props} />
}

function GridFeedbackBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  controller,
  messages,
  renderer,
}: {
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: DataGridMessages
  renderer: DataGridSurfaceRenderers['feedback'] | undefined
}) {
  const item = useGridSelector(controller, (snapshot) => snapshot.feedback.items.at(-1))
  useEffect(() => {
    if (!item || item.persistent) return
    const timer = window.setTimeout(() => {
      controller.dispatch({ type: 'feedback/dismiss', id: item.id })
    }, 4200)
    return () => { window.clearTimeout(timer) }
  }, [controller, item])
  if (!item) return null
  const props = {
    item,
    dismissLabel: messages.dismissMessage,
    onDismiss: () => { controller.dispatch({ type: 'feedback/dismiss', id: item.id }) },
  } satisfies DataGridFeedbackProps
  if (renderer) return renderer(props)
  return <div aria-live="polite" className="business-grid__feedback" data-kind={item.kind} role={item.kind === 'error' ? 'alert' : 'status'}>
    <span>{item.message}</span>
    <button aria-label={props.dismissLabel} type="button" onClick={props.onDismiss}>×</button>
  </div>
}

function GridContextMenuBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  controller,
  dataSource,
  dom,
  messages,
  registry,
  renderer,
}: {
  controller: GridController<Row, RowKey, Schema, Effect>
  dataSource: GridDataSource<Row, RowKey, Schema>
  dom: GridDomEffectAdapter
  messages: DataGridMessages
  registry: GridCellTypeRegistry<Row, Schema>
  renderer: DataGridSurfaceRenderers['contextMenu'] | undefined
}) {
  const slice = useGridSelector(controller, selectContextMenuSlice, equalContextMenuSlice)
  if (!slice) return null
  const columnKeys = slice.columns.map((column) => column.key)
  const chosenCells = selectedCells(slice.interaction.ranges, slice.view.visibleRowKeys, columnKeys)
  const rowsByKey = new Map(slice.draft.rows.map((row) => [dataSource.getRowKey(row), row] as const))
  const canClearSelection = chosenCells.some((point) => {
    const row = rowsByKey.get(point.rowKey)
    const column = slice.columns.find((candidate) => candidate.key === point.columnKey)
    return Boolean(row && column?.behavior.clear && column.isEditable(row))
  })
  const canRevertSelection = chosenCells.some((point) => slice.draft.dirtyCells.some((entry) =>
    gridRowKeysEqual(entry.rowKey, point.rowKey) && entry.columnKey === point.columnKey,
  ))
  const revertibleRowKeys = new Set<RowKey>([
    ...slice.draft.dirtyCells.map((entry) => entry.rowKey),
    ...slice.draft.insertedRowKeys,
  ])
  const actionSession = slice.interaction.actionSession
  if (!actionSession?.menuPosition) return null
  const context = resolveCell(actionSession.target, slice.draft.rows, slice.columns, dataSource.getRowKey)
  if (!context) return null
  const commandState = selectGridCommandState(slice, dataSource, registry, messages)
  const run = (intent: Parameters<typeof controller.dispatch>[0]) => reportRejected(controller, messages.rejectedAction, controller.dispatch(intent))
  const actions: GridMenuAction[] = [
    { id: 'undo', group: 'history', label: messages.undo, disabled: !commandState.canUndo, run: () => run({ type: 'history/undo' }) },
    { id: 'redo', group: 'history', label: messages.redo, disabled: !commandState.canRedo, run: () => run({ type: 'history/redo' }) },
  ]
  if (commandState.showBulkEdit) actions.push({
    id: 'edit-selection', group: 'bulk-editing', label: messages.editSelection, focusAfterRun: 'preserve',
    disabled: !commandState.canBulkEdit, run: () => run({ type: 'bulk/start' }),
  })
  if (commandState.showAddRows) actions.push({
    id: 'add-row', group: 'rows', label: messages.addRow,
    disabled: !commandState.canAddRows, run: () => run({ type: 'rows/add' }),
  })
  if (commandState.showDuplicateRows) actions.push({
    id: 'duplicate-rows', group: 'rows', label: messages.duplicateRows(commandState.selectedRowCount),
    disabled: !commandState.canDuplicateRows, run: () => run({ type: 'rows/duplicate' }),
  })
  if (commandState.showDeleteRows) actions.push({
    id: 'delete-rows', group: 'rows', label: messages.deleteRows(commandState.selectedRowCount),
    destructive: true, disabled: !commandState.canDeleteRows, disabledReason: commandState.deleteRowsDisabledReason,
    run: () => run({ type: 'rows/delete' }),
  })
  if (commandState.persistenceMode === 'manual-save') actions.push({
    id: 'save-changes', group: 'persistence',
    label: commandState.persistenceStatus === 'saving' ? messages.saving : messages.saveChanges,
    disabled: !commandState.canSave || commandState.persistenceStatus === 'saving',
    run: () => run({ type: 'persistence/save' }),
  })
  actions.push(...buildContextActions({
    context,
    controller,
    canClearSelection,
    canRevertSelection,
    conflicts: slice.draft.conflicts,
    dirtyCells: slice.draft.dirtyCells,
    messages,
    revertibleRowKeys,
    reportRejected: (result) => reportRejected(controller, messages.rejectedAction, result),
  }))
  const props = {
    actions,
    onClose: (reason = 'programmatic', action?: GridMenuAction) => {
      const target = actionSession.target
      const activeCell = controller.getSnapshot().interaction.activeCell
      controller.dispatch({ type: 'interaction/close-action' })
      if (reason === 'outside' || action?.focusAfterRun === 'preserve') return
      queueMicrotask(() => {
        if (dom.focusCell(target, false)) return
        if (activeCell && dom.focusCell(activeCell, false)) return
        dom.focusGrid()
      })
    },
    position: actionSession.menuPosition,
  } satisfies GridContextMenuProps
  return renderer ? renderer(props) : <GridContextMenu {...props} />
}

function GridBulkDialogBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  controller,
  messages,
  registry,
  renderer,
}: {
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: DataGridMessages
  registry: GridCellTypeRegistry<Row, Schema>
  renderer: DataGridSurfaceRenderers['bulkDialog'] | undefined
}) {
  const slice = useGridSelector(controller, (snapshot) => snapshot.bulk
    ? { bulk: snapshot.bulk, column: snapshot.columns.find((column) => column.key === snapshot.bulk?.columnKey) }
    : null, (left, right) => left === right || Boolean(left && right && left.bulk === right.bulk && left.column === right.column))
  if (!slice?.column) return null
  const view = registry.views.resolve(slice.column.type)
  if (!view?.BulkEditor) return null
  const Editor = view.BulkEditor
  const editor = <Editor
    apply={() => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'bulk/apply' }))}
    cancel={() => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'bulk/cancel' }))}
    cellCount={slice.bulk.targetCells.length}
    draft={slice.bulk.draft}
    error={slice.bulk.error}
    setDraft={(draft) => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'bulk/change', value: draft }))}
  />
  const props = {
    ariaLabel: messages.editCells(slice.bulk.targetCells.length),
    title: <strong>{messages.editCells(slice.bulk.targetCells.length)}</strong>,
    editor,
  } satisfies DataGridBulkDialogProps
  return renderer ? renderer(props) : <GridDialog ariaLabel={props.ariaLabel}>{props.title}{props.editor}</GridDialog>
}

function GridFilterDialogBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  controller,
  messages,
  renderer,
}: {
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: DataGridMessages
  renderer: DataGridSurfaceRenderers['filterDialog'] | undefined
}) {
  const slice = useGridSelector(controller, (snapshot) => {
    if (!snapshot.filterSession) return null
    return {
      column: snapshot.columns.find((column) => column.key === snapshot.filterSession?.columnKey),
      session: snapshot.filterSession,
    }
  }, (left, right) => left === right || Boolean(left && right
    && left.column === right.column
    && left.session === right.session))
  const filter = slice?.column?.behavior.filter
  if (!slice?.column || !filter) return null
  const column = slice.column
  const props = {
    draft: {
      columnLabel: column.label,
      operators: filter.operators,
      conditions: slice.session.conditions.map((condition) => ({
        operator: condition.operator,
        value: condition.value === null || condition.value === undefined ? '' : String(condition.value),
      })),
      combine: slice.session.combine,
      error: slice.session.error,
    },
    messages,
    onAddCondition: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/add-condition' })),
    onApply: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/apply' })),
    onCancel: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/cancel' })),
    onCombineChange: (combine: 'all' | 'any') => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/change', combine })),
    onClear: () => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/clear' })),
    onOperatorChange: (index: number, operator: string) => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/change', index, operator })),
    onRemoveCondition: (index: number) => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/remove-condition', index })),
    onValueChange: (index: number, value: string) => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'filter/change', index, value })),
  } satisfies GridFilterDialogProps
  return renderer ? renderer(props) : <GridFilterDialog {...props} />
}

function selectContextMenuSlice<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  const actionSession = snapshot.interaction.actionSession
  if (!actionSession?.menuPosition) return null
  return snapshot
}

function equalContextMenuSlice<Row, RowKey extends GridRowKey>(
  left: ReturnType<typeof selectContextMenuSlice<Row, RowKey>>,
  right: ReturnType<typeof selectContextMenuSlice<Row, RowKey>>,
) {
  if (left === right) return true
  if (!left || !right) return false
  return left === right
}

function selectGridCommandState<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
  dataSource: GridDataSource<Row, RowKey, Schema>,
  registry: GridCellTypeRegistry<Row, Schema>,
  messages: DataGridMessages,
): GridToolbarProps['state'] {
  const columnKeys = snapshot.columns.map((column) => column.key)
  const chosenCells = selectedCells(snapshot.interaction.ranges, snapshot.view.visibleRowKeys, columnKeys)
  const selectedColumnKeys = unique(chosenCells.map((point) => point.columnKey))
  const selectionSummary = selectGridSelectionSummary(snapshot)
  const duplicatePlan = selectGridRowDuplicatePlan(snapshot)
  const deletePlan = selectGridRowDeletePlan(snapshot)
  const savePlan = selectGridSavePlan(snapshot)
  const bulkColumn = selectedColumnKeys.length === 1
    ? snapshot.columns.find((column) => column.key === selectedColumnKeys[0])
    : undefined
  const bulkView = bulkColumn ? registry.views.resolve(bulkColumn.type) : undefined
  const rowsByKey = new Map(snapshot.draft.rows.map((row) => [snapshot.getRowKey(row), row] as const))
  const hasBulkTarget = Boolean(bulkColumn && chosenCells.some((point) => {
    const row = rowsByKey.get(point.rowKey)
    return row !== undefined && resolveGridCellValue(row, bulkColumn).valid && bulkColumn.isEditable(row)
  }))
  return {
    globalFilter: snapshot.view.globalFilter,
    dirtyCount: dirtyCount(snapshot),
    selectedRowCount: selectionSummary.rowCount,
    selectedCellCount: chosenCells.length,
    canAddRows: snapshot.rowOperations.canAdd,
    canDuplicateRows: duplicatePlan.canDuplicate,
    canDeleteRows: deletePlan.canDelete,
    deleteRowsDisabledReason: deletePlan.blockedCount > 0
      ? messages.deleteRowsBlocked(deletePlan.blockedCount, deletePlan.rowCount)
      : null,
    showAddRows: Boolean(dataSource.rows?.create),
    showDuplicateRows: Boolean(dataSource.rows?.duplicate),
    showDeleteRows: Boolean(dataSource.rows?.canDelete),
    canUndo: snapshot.draft.undoStack.length > 0,
    canRedo: snapshot.draft.redoStack.length > 0,
    canBulkEdit: Boolean(hasBulkTarget && bulkColumn?.bulkEditable && bulkView?.BulkEditor),
    canSave: savePlan.canSave,
    showBulkEdit: snapshot.columns.some((column) => Boolean(column.bulkEditable && registry.views.resolve(column.type)?.BulkEditor)),
    persistenceMode: snapshot.persistence.mode,
    persistenceStatus: snapshot.persistence.status,
  }
}

function dirtyCount<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  return snapshot.draft.dirtyCells.length
    + snapshot.draft.insertedRowKeys.length
    + snapshot.draft.deletedRowKeys.length
    + (snapshot.draft.orderDirty ? 1 : 0)
}

function shallowEqual<Selected extends Readonly<Record<string, unknown>>>(left: Selected, right: Selected) {
  const keys = Object.keys(left) as (keyof Selected)[]
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]))
}

function reportRejected<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  controller: GridController<Row, RowKey, Schema, Effect>,
  presenter: GridRejectedActionPresenter,
  result: GridDispatchResult,
) {
  reportGridRejectedAction(controller, result, presenter)
}

function unique<Value>(values: readonly Value[]) {
  return [...new Set(values)]
}

function resolveCell<Row, RowKey extends GridRowKey>(
  point: GridPoint<RowKey>,
  rows: readonly Row[],
  columns: readonly import('../model/grid-model.js').GridCompiledColumn<Row>[],
  getRowKey: (row: Row) => RowKey,
) {
  const row = rows.find((candidate) => gridRowKeysEqual(getRowKey(candidate), point.rowKey))
  const column = columns.find((candidate) => candidate.key === point.columnKey)
  if (!row || !column) return null
  return { point, row, column, resolved: resolveGridCellValue(row, column) }
}

function buildContextActions<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>({
  context,
  controller,
  canClearSelection,
  canRevertSelection,
  conflicts,
  dirtyCells,
  messages,
  revertibleRowKeys,
  reportRejected,
}: {
  context: NonNullable<ReturnType<typeof resolveCell<Row, RowKey>>>
  controller: GridController<Row, RowKey, Schema, Effect>
  canClearSelection: boolean
  canRevertSelection: boolean
  conflicts: readonly import('../model/grid-model.js').GridConflict<RowKey>[]
  dirtyCells: readonly import('../model/grid-model.js').GridDirtyCell<RowKey>[]
  messages: DataGridMessages
  revertibleRowKeys: ReadonlySet<RowKey>
  reportRejected: (result: GridDispatchResult) => void
}): readonly GridMenuAction[] {
  const runtimeContext = context.resolved.valid
    ? {
        row: context.row,
        columnKey: context.column.key,
        typeOptions: context.column.typeOptions,
        value: context.resolved.value,
        editable: context.column.isEditable(context.row),
      }
    : null
  const dispatch = controller.dispatch
  const cellDirty = dirtyCells.some((entry) => gridRowKeysEqual(entry.rowKey, context.point.rowKey) && entry.columnKey === context.point.columnKey)
  const rowDirty = revertibleRowKeys.has(context.point.rowKey)
  const cellConflict = conflicts.find((entry) => gridRowKeysEqual(entry.rowKey, context.point.rowKey) && entry.columnKey === context.point.columnKey)
  const rowConflict = conflicts.find((entry) => gridRowKeysEqual(entry.rowKey, context.point.rowKey) && entry.columnKey === null)
  const actions: GridMenuAction[] = [
    {
      id: 'edit-cell',
      group: 'editing',
      label: messages.editCell,
      disabled: !runtimeContext?.editable || !context.column.behavior.edit,
      focusAfterRun: 'preserve',
      run: () => reportRejected(dispatch({ type: 'edit/start', cell: context.point })),
    },
    {
      id: 'copy-selection',
      group: 'selection',
      label: messages.copySelection,
      run: () => {
        writeGridClipboard(
          dispatch({ type: 'selection/copy' }),
          reportRejected,
          {
            unavailable: messages.clipboardUnavailable,
            writeFailed: messages.clipboardWriteFailed,
          },
        )
      },
    },
    {
      id: 'clear-selection',
      group: 'selection',
      label: messages.clearSelection,
      destructive: true,
      disabled: !canClearSelection,
      run: () => reportRejected(dispatch({ type: 'selection/clear-values' })),
    },
  ]
  if (cellDirty) actions.push({
    id: 'restore-cell',
    group: 'restore',
    label: messages.restoreCell,
    run: () => reportRejected(dispatch({ type: 'cell/revert', cell: context.point })),
  })
  if (canRevertSelection) actions.push({
    id: 'restore-selection',
    group: 'restore',
    label: messages.restoreSelection,
    run: () => reportRejected(dispatch({ type: 'selection/revert' })),
  })
  if (rowDirty) actions.push({
    id: 'restore-row',
    group: 'restore',
    label: messages.restoreRow,
    run: () => reportRejected(dispatch({ type: 'rows/revert', rowKeys: [context.point.rowKey] })),
  })
  if (cellConflict) actions.push(
    {
      id: 'conflict-cell-remote',
      group: 'conflict-resolution',
      label: messages.useRemoteCell,
      run: () => reportRejected(dispatch({ type: 'conflict/resolve', rowKey: context.point.rowKey, columnKey: context.point.columnKey, resolution: 'accept-remote' })),
    },
    {
      id: 'conflict-cell-local',
      group: 'conflict-resolution',
      label: messages.keepLocalCell,
      run: () => reportRejected(dispatch({ type: 'conflict/resolve', rowKey: context.point.rowKey, columnKey: context.point.columnKey, resolution: 'keep-local' })),
    },
  )
  if (rowConflict) actions.push(
    {
      id: 'conflict-row-remote',
      group: 'conflict-resolution',
      label: messages.useRemoteRow,
      run: () => reportRejected(dispatch({ type: 'conflict/resolve', rowKey: context.point.rowKey, columnKey: null, resolution: 'accept-remote' })),
    },
    {
      id: 'conflict-row-local',
      group: 'conflict-resolution',
      label: messages.keepLocalRow,
      run: () => reportRejected(dispatch({ type: 'conflict/resolve', rowKey: context.point.rowKey, columnKey: null, resolution: 'keep-local' })),
    },
  )
  for (const action of context.column.behavior.actions ?? []) {
    if (!runtimeContext) continue
    const presentation = invokeGridCallback(() => ({
      hidden: action.hidden?.(runtimeContext) ?? false,
      disabled: action.disabled?.(runtimeContext) ?? false,
      label: typeof action.label === 'function' ? action.label(runtimeContext) : action.label,
    }))
    if (!presentation.ok || presentation.value.hidden) continue
    actions.push({
      id: `cell-action:${action.id}`,
      group: action.group ?? 'cell-action',
      label: presentation.value.label,
      destructive: action.destructive,
      disabled: Boolean(presentation.value.disabled || action.requiresEditable && !runtimeContext.editable),
      run: () => reportRejected(dispatch({ type: 'cell/run-action', cell: context.point, action: action.id })),
    })
  }
  return actions
}
