import { getGridInteractionPort } from '../controller/controller-interaction.js'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'

import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridCellTypeRegistry } from '../cell-types/registry.js'
import type { StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import type { GridController, GridCommandResult, GridSaveResult, GridRefreshResult } from '../controller/grid-controller.js'
import { selectedCells } from '../model/range-geometry.js'
import type { GridKernelDataSource as GridDataSource } from '../data/kernel-data-source.js'
import { DEFAULT_BINDING_MESSAGES, useGridBindingLifecycle, type GridAttachment } from './data-grid-lifecycle.js'
import type { CreateDataGridBindingOptions, DataGridBinding, DataGridViewOptions } from './data-grid-binding.js'
import { resolveGridCellValue } from '../data/runtime-cell-resolver.js'
import { invokeGridCallback } from '../data/safe-callback.js'
import type {
  GridControllerSnapshot,
  GridFeedbackItem,
  GridPoint,
  GridRowKey,
  GridSaveTarget,
} from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import {
  selectGridRowDeletePlan,
  selectGridRowDuplicatePlan,
  selectGridActions,
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

export { createDataGridBinding, type DataGridBinding, type CreateDataGridBindingOptions, type DataGridInitialOptions, type DataGridViewOptions } from './data-grid-binding.js'
export { useDataGridBinding, type GridAttachment, type GridAttachmentTarget } from './data-grid-lifecycle.js'

export type {
  DataGridRowHeaderActionContext,
  DataGridRowHeaderActions,
} from './grid-cells.js'
export type {
  DataGridRowDropTarget,
  DataGridRowDropZone,
} from './grid-viewport.js'

type DataGridCommonProps<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect> = Readonly<{
  ariaLabel: string
  className?: string
  messages?: Partial<DataGridMessages>
  surfaceRenderers?: DataGridSurfaceRenderers
  toolbarActions?: (controller: GridController<Row, RowKey, Schema, Effect>) => ReactNode
  rowHeaderActions?: DataGridRowHeaderActions<Row, RowKey, Schema, Effect>
  rowDropZone?: DataGridRowDropZone<RowKey>
  view?: DataGridViewOptions
  onAttachmentChange?: (attachment: GridAttachment<DataGridBinding<Row, RowKey, Schema, Effect>, GridDataSource<Row, RowKey, Schema>>) => void
}>

export type DataGridMessages = GridToolbarMessages & GridFooterMessages & GridFilterDialogProps['messages'] & GridViewportMessages & Readonly<{
  loadingData: string
  sourceConfigurationChanged: string
  detachedSourceWork: string
  rowsRefreshFailed: string
  retryRefresh: string
  retryAttachment: string
  changesSaveFailed: string
  refreshData: string
  retrySave: string
  confirmSave: string
  reviewSave: string
  applyPendingResult: string
  discardPendingResult: string
  pendingResults: (count: number) => string
  useRemoteOrder: string
  keepLocalOrder: string
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
  onCancel: () => void
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
  ...DEFAULT_BINDING_MESSAGES,
  rowsRefreshFailed: 'Rows could not be refreshed.',
  retryRefresh: 'Retry refresh',
  retryAttachment: 'Retry opening table',
  changesSaveFailed: 'Changes could not be saved.',
  refreshData: 'Refresh data',
  retrySave: 'Retry save',
  confirmSave: 'Check original save',
  reviewSave: 'Review save result',
  applyPendingResult: 'Apply or retry retained result',
  discardPendingResult: 'Discard retained result',
  pendingResults: (count) => `${count} task results to review`,
  useRemoteOrder: 'Use saved row order',
  keepLocalOrder: 'Keep local row order',
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
  chooseValue: 'Choose a value',
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
  Schema extends GridCellTypeSchema = StandardGridCellTypeSchema,
  Effect = never,
> = DataGridCommonProps<Row, RowKey, Schema, Effect> & (
  | Readonly<{ binding: DataGridBinding<Row, RowKey, Schema, Effect>; dataSource?: never; initial?: never; effects?: never }>
  | (CreateDataGridBindingOptions<Row, RowKey, Schema, Effect> & Readonly<{ binding?: never }>)
)

/**
 * Turnkey business-data editor. The controller owns all semantic state while
 * React projects its immutable snapshot into one non-virtualized scrollport.
 * React-owned sources and explicit bindings share one switch policy: pending
 * work stays visible until resolved. Only React-owned bindings are automatically
 * disposed after a clean detach; explicit bindings remain host-owned.
 */
export function DataGrid<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema = StandardGridCellTypeSchema,
  Effect = never,
>(props: DataGridProps<Row, RowKey, Schema, Effect>) {
  const attachment = useGridBindingLifecycle(props.binding
    ? { binding: props.binding }
    : { options: props }, props.messages)
  const binding = attachment.binding
  const rowHeight = props.view?.rowHeight ?? 36
  const headerHeight = props.view?.headerHeight ?? 36
  const rowIndicatorWidth = props.view?.rowIndicatorWidth ?? 48
  useLayoutEffect(() => {
    if (!binding) return
    const result = getGridInteractionPort(binding.controller).send({ type: 'viewport/configure', rowHeight, headerHeight, rowIndicatorWidth })
    if (!result.accepted) reportGridRejectedAction(binding.controller, result, reason => reason)
  }, [binding, rowHeight, headerHeight, rowIndicatorWidth])
  const notified = useRef<typeof attachment | null>(null)
  useEffect(() => {
    if (notified.current === attachment) return
    notified.current = attachment
    props.onAttachmentChange?.(attachment)
  }, [attachment, props.onAttachmentChange])
  if (!binding) return <div
    aria-busy={attachment.status === 'initializing'}
    aria-label={props.ariaLabel}
    className={['business-grid', props.className].filter(Boolean).join(' ')}
    role="grid"
  ><div className="business-grid__initializing" role={attachment.status === 'error' ? 'alert' : 'status'}>{attachment.status === 'error' ? <>
    {attachment.issue.message}
    {attachment.retry && <button type="button" onClick={attachment.retry}>{props.messages?.retryAttachment ?? props.initial?.locale?.dataGrid.retryAttachment ?? props.initial?.registry?.locale?.dataGrid.retryAttachment ?? DEFAULT_MESSAGES.retryAttachment}</button>}
  </> :
    props.messages?.loadingData ?? props.binding?.locale?.dataGrid.loadingData
      ?? props.initial?.locale?.dataGrid.loadingData ?? props.initial?.registry?.locale?.dataGrid.loadingData ?? DEFAULT_MESSAGES.loadingData
  }</div></div>
  return <BoundDataGrid
    ariaLabel={props.ariaLabel}
    binding={binding}
    {...(attachment.status === 'error' && attachment.retry ? { attachmentRetry: attachment.retry } : {})}
    {...(props.className === undefined ? {} : { className: props.className })}
    {...(props.messages === undefined ? {} : { messages: props.messages })}
    {...(props.surfaceRenderers === undefined ? {} : { surfaceRenderers: props.surfaceRenderers })}
    {...(props.toolbarActions === undefined ? {} : { toolbarActions: props.toolbarActions })}
    {...(props.rowHeaderActions === undefined ? {} : { rowHeaderActions: props.rowHeaderActions })}
    {...(props.rowDropZone === undefined ? {} : { rowDropZone: props.rowDropZone })}
  />
}

function BoundDataGridImpl<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  ariaLabel,
  attachmentRetry,
  binding,
  className,
  messages: messageOverrides,
  surfaceRenderers,
  toolbarActions,
  rowHeaderActions,
  rowDropZone,
}: DataGridCommonProps<Row, RowKey, Schema, Effect> & Readonly<{
  binding: DataGridBinding<Row, RowKey, Schema, Effect>
  attachmentRetry?: () => void
}>) {
  const { controller, dataSource, registry } = binding
  const messages = useMemo(
    () => ({ ...DEFAULT_MESSAGES, ...binding.locale?.dataGrid, ...messageOverrides }),
    [binding.locale, messageOverrides],
  )
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
        if (!active || event.defaultPrevented) return
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
    <GridFooterBoundary controller={controller} messages={messages} renderer={surfaceRenderers?.footer} {...(attachmentRetry ? { attachmentRetry } : {})} />
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
    onRedo: () => reportRejected(controller, messages.rejectedAction, controller.redo()),
    onSave: () => saveGridChanges(controller, messages.rejectedAction, state.saveTarget),
    onUndo: () => reportRejected(controller, messages.rejectedAction, controller.undo()),
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
  attachmentRetry,
  controller,
  messages,
  renderer,
}: {
  attachmentRetry?: () => void
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: DataGridMessages
  renderer: DataGridSurfaceRenderers['footer'] | undefined
}) {
  const state = useGridSelector(controller, (snapshot) => {
    const selection = selectGridSelectionSummary(snapshot)
    const { retrySave, recoverSave } = selectGridActions(snapshot)
    return {
      conflictCount: snapshot.draft.conflicts.length + (snapshot.draft.orderConflict ? 1 : 0),
      dirtyCount: dirtyCount(snapshot),
      invalidCount: snapshot.draft.validationIssues.length,
      persistenceError: snapshot.persistence.error,
      persistenceRecoveryAction: recoverSave.enabled ? recoverSave.target?.action ?? null : retrySave.enabled ? 'save' as const : null,
      saveTarget: retrySave.enabled ? retrySave.target : null,
      persistenceRecovery: recoverSave.enabled ? recoverSave.target : null,
      persistenceStatus: snapshot.persistence.status,
      pendingResultCount: snapshot.pendingEffects.length,
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
  const sourceFeedback = state.sourceStatus === 'refreshing' && state.visibleRowCount > 0
    ? <span>{messages.refreshingRows}</span>
    : state.sourceStatus === 'error'
      ? <><span>{state.sourceError ?? messages.rowsRefreshFailed}</span> {state.sourceCanRefresh ? <button
        className="business-grid__link-button"
        type="button"
        onClick={() => { void controller.refresh().then(result => reportPersistence(controller, messages.rejectedAction, result)) }}
      >{messages.retryRefresh}</button> : null}</>
      : null
  const saveFeedback = state.persistenceStatus === 'failed'
    ? <><span>{state.persistenceError ?? messages.changesSaveFailed}</span> {state.persistenceRecoveryAction !== null ? <button
      className="business-grid__link-button"
      type="button"
      onClick={() => {
        if (!state.persistenceRecovery && !state.saveTarget) return
        const operation = state.persistenceRecovery ? controller.recoverSave(state.persistenceRecovery) : controller.save(state.saveTarget!)
        void operation.then(result => reportPersistence(controller, messages.rejectedAction, result))
      }}
    >{state.persistenceRecoveryAction === 'refresh' ? messages.refreshData
      : state.persistenceRecoveryAction === 'review' ? messages.reviewSave
      : state.persistenceRecoveryAction === 'confirm' ? messages.confirmSave : messages.retrySave}</button> : null}</>
    : null
  const props: GridFooterProps = {
    conflictCount: state.conflictCount,
    dirtyCount: state.dirtyCount,
    feedback: sourceFeedback || saveFeedback || state.pendingResultCount > 0 || attachmentRetry
      ? <>{sourceFeedback}{saveFeedback}{attachmentRetry ? <button type="button" className="business-grid__link-button" onClick={attachmentRetry}>{messages.retryAttachment}</button> : null}<GridPendingResultsBoundary controller={controller} messages={messages} /></>
      : null,
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

function GridPendingResultsBoundary<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>({
  controller,
  messages,
}: {
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: DataGridMessages
}) {
  const results = useGridSelector(controller, (snapshot) => snapshot.pendingEffects)
  if (!results.length) return null
  return <span className="business-grid__pending-results" role="group" aria-label={messages.pendingResults(results.length)}>
    {results.map((result) => <span className="business-grid__pending-result" key={result.id}>
      <span>{result.cell ? `${String(result.cell.rowKey)} · ${result.cell.columnKey}: ` : ''}{result.message}</span>
      {result.cell ? <button className="business-grid__link-button" type="button" onClick={() => reportRejected(
        controller, messages.rejectedAction, controller.dispatch({ type: 'effect/reapply-cell-result', effectId: result.id }),
      )}>{messages.applyPendingResult}</button> : null}
      <button className="business-grid__link-button" type="button" onClick={() => reportRejected(
        controller, messages.rejectedAction, controller.dispatch({ type: 'effect/discard-result', effectId: result.id }),
      )}>{messages.discardPendingResult}</button>
    </span>)}
  </span>
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
  const actionSession = slice?.interaction.actionSession
  const closeContextMenu = useCallback<GridContextMenuProps['onClose']>((
    reason = 'programmatic',
    action,
  ) => {
    if (!actionSession) return
    const { actionSession: current, activeCell } = controller.getSnapshot().interaction
    if (current && current !== actionSession) return
    const target = actionSession.target
    if (current) controller.dispatch({ type: 'interaction/close-action' })
    if (reason === 'outside' || action?.focusAfterRun === 'preserve') return
    queueMicrotask(() => {
      if (dom.focusCell(target, false)) return
      if (activeCell && dom.focusCell(activeCell, false)) return
      dom.focusGrid()
    })
  }, [controller, dom, actionSession])
  if (!slice) return null
  const columnKeys = slice.columns.map((column) => column.key)
  const chosenCells = selectedCells(slice.interaction.ranges, slice.view.visibleRowKeys, columnKeys)
  const rowsByKey = new Map(slice.draft.rows.map((row) => [dataSource.getRowKey(row), row] as const))
  const canClearSelection = chosenCells.some((point) => {
    const column = slice.columns.find((candidate) => candidate.key === point.columnKey)
    if (!rowsByKey.has(point.rowKey) || !column?.behavior.clear) return false
    return column.isEditable(rowsByKey.get(point.rowKey) as Row)
  })
  const canRevertSelection = chosenCells.some((point) => slice.draft.dirtyCells.some((entry) =>
    gridRowKeysEqual(entry.rowKey, point.rowKey) && entry.columnKey === point.columnKey,
  ))
  const revertibleRowKeys = new Set<RowKey>([
    ...slice.draft.dirtyCells.map((entry) => entry.rowKey),
    ...slice.draft.insertedRowKeys,
  ])
  if (!actionSession?.menuPosition) return null
  const context = resolveCell(actionSession.target, slice.draft.rows, slice.columns, dataSource.getRowKey)
  if (!context) return null
  const commandState = selectGridCommandState(slice, dataSource, registry, messages)
  const run = (intent: Parameters<typeof controller.dispatch>[0]) => reportRejected(controller, messages.rejectedAction, controller.dispatch(intent))
  const actions: GridMenuAction[] = slice.pendingEffects.flatMap(result => [
    { id: `apply-effect:${result.id}`, group: 'task-results', label: messages.applyPendingResult,
      disabled: result.cell === null, run: () => run({ type: 'effect/reapply-cell-result', effectId: result.id, target: actionSession.target }) },
    { id: `discard-effect:${result.id}`, group: 'task-results', label: messages.discardPendingResult,
      run: () => run({ type: 'effect/discard-result', effectId: result.id }) },
  ])
  actions.push(
    { id: 'undo', group: 'history', label: messages.undo, disabled: !commandState.canUndo, run: () => run({ type: 'history/undo' }) },
    { id: 'redo', group: 'history', label: messages.redo, disabled: !commandState.canRedo, run: () => run({ type: 'history/redo' }) },
  )
  if (slice.draft.orderConflict) actions.push(
    { id: 'order-remote', group: 'conflict-resolution', label: messages.useRemoteOrder, run: () => run({ type: 'order/resolve', resolution: 'accept-remote' }) },
    { id: 'order-local', group: 'conflict-resolution', label: messages.keepLocalOrder, run: () => run({ type: 'order/resolve', resolution: 'keep-local' }) },
  )
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
    disabled: !commandState.canSave,
    run: () => saveGridChanges(controller, messages.rejectedAction, commandState.saveTarget),
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
    actions: actions.map(action => ({ ...action, run: () => {
      // Custom renderers may retain a callback beyond this menu's lifetime.
      if (controller.getSnapshot().interaction.actionSession === actionSession) action.run()
    } })),
    onClose: closeContextMenu,
    position: actionSession.menuPosition,
  } satisfies GridContextMenuProps
  return renderer ? renderer(props) : <GridContextMenu {...props} />
}

function saveGridChanges<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>(
  controller: GridController<Row, RowKey, Schema, Effect>,
  presentRejection: GridRejectedActionPresenter,
  target: GridSaveTarget<RowKey>,
) {
  void controller.save(target).then(result => reportPersistence(controller, presentRejection, result))
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
  const view = registry.views.resolve(slice.column.type, slice.column.typeOptions)
  if (!view?.BulkEditor) return null
  const Editor = view.BulkEditor
  const target = { kind: 'bulk' as const, id: slice.bulk.id }
  const cancel = () => reportRejected(
    controller,
    messages.rejectedAction,
    controller.dispatch({ type: 'bulk/cancel' }, target),
  )
  const editor = <Editor
    apply={() => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'bulk/apply' }, target))}
    cancel={cancel}
    cellCount={slice.bulk.targets.length}
    columnKey={slice.column.key}
    draft={slice.bulk.draft}
    error={slice.bulk.error}
    setDraft={(draft) => reportRejected(controller, messages.rejectedAction, controller.dispatch({ type: 'bulk/change', value: draft }, target))}
    typeOptions={slice.column.typeOptions}
  />
  const props = {
    ariaLabel: messages.editCells(slice.bulk.targets.length),
    title: <strong>{messages.editCells(slice.bulk.targets.length)}</strong>,
    editor,
    onCancel: cancel,
  } satisfies DataGridBulkDialogProps
  return renderer ? renderer(props) : <GridDialog
    ariaLabel={props.ariaLabel}
    onEscape={props.onCancel}
  >{props.title}{props.editor}</GridDialog>
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
  const target = { kind: 'filter' as const, id: slice.session.id }
  const run = (intent: Parameters<typeof controller.dispatch>[0]) =>
    reportRejected(controller, messages.rejectedAction, controller.dispatch(intent, target))
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
    onAddCondition: () => run({ type: 'filter/add-condition' }),
    onApply: () => run({ type: 'filter/apply' }),
    onCancel: () => run({ type: 'filter/cancel' }),
    onCombineChange: (combine: 'all' | 'any') => run({ type: 'filter/change', combine }),
    onClear: () => run({ type: 'filter/clear' }),
    onOperatorChange: (index: number, operator: string) => run({ type: 'filter/change', index, operator }),
    onRemoveCondition: (index: number) => run({ type: 'filter/remove-condition', index }),
    onValueChange: (index: number, value: string) => run({ type: 'filter/change', index, value }),
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
  const { save } = selectGridActions(snapshot)
  const bulkColumn = selectedColumnKeys.length === 1
    ? snapshot.columns.find((column) => column.key === selectedColumnKeys[0])
    : undefined
  const bulkView = bulkColumn ? registry.views.resolve(bulkColumn.type, bulkColumn.typeOptions) : undefined
  const rowsByKey = new Map(snapshot.draft.rows.map((row) => [snapshot.getRowKey(row), row] as const))
  const hasBulkTarget = Boolean(bulkColumn && chosenCells.some((point) => {
    if (!rowsByKey.has(point.rowKey)) return false
    const row = rowsByKey.get(point.rowKey) as Row
    return resolveGridCellValue(row, bulkColumn).valid && bulkColumn.isEditable(row)
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
    canSave: save.enabled, saveTarget: save.target,
    showBulkEdit: snapshot.columns.some((column) => Boolean(column.bulkEditable && registry.views.resolve(column.type, column.typeOptions)?.BulkEditor)),
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

function reportPersistence<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  controller: GridController<Row, RowKey, Schema, Effect>,
  presenter: GridRejectedActionPresenter,
  result: GridSaveResult | GridRefreshResult,
) {
  if ('issue' in result) reportRejected(controller, presenter, { accepted: false,
    revision: controller.getSnapshot().revision, issue: result.issue })
}

function reportRejected<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  controller: GridController<Row, RowKey, Schema, Effect>,
  presenter: GridRejectedActionPresenter,
  result: GridCommandResult,
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
  const rowPosition = rows.findIndex((candidate) =>
    gridRowKeysEqual(getRowKey(candidate), point.rowKey),
  )
  const column = columns.find((candidate) => candidate.key === point.columnKey)
  if (rowPosition < 0 || !column) return null
  const row = rows[rowPosition] as Row
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
  reportRejected: (result: GridCommandResult) => void
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
