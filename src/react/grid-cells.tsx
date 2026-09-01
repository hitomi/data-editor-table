import { memo, useCallback, useMemo, type ReactNode, type Ref } from 'react'

import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridRuntimeReactView } from '../cell-types/react-view-contracts.js'
import type { GridController, GridDispatchResult } from '../controller/grid-controller.js'
import {
  selectGridCell,
  selectGridRowDeleteAvailability,
  type GridRowDeleteAvailability,
} from '../controller/grid-selectors.js'
import { isGridCellSelected } from '../controller/selection-model.js'
import { invokeGridCallback } from '../data/safe-callback.js'
import type {
  GridCompiledColumn,
  GridControllerSnapshot,
  GridPoint,
  GridRowKey,
} from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import {
  reportGridRejectedAction,
  type GridRejectedActionPresenter,
  useGridSelector,
} from './controller-react.js'
import type { GridDomEffectAdapter } from './dom-effect-adapter.js'
import { GridDirtyCellPopover } from './grid-layers.js'

const missingDraftRow = Symbol('missing-grid-draft-row')

export type GridCellMessages = Readonly<{
  selectAllCells: string
  columnContainsChanges: string
  filterColumn: (columnLabel: string) => string
  sortColumn: (columnLabel: string) => string
  sortColumnAscending: (columnLabel: string) => string
  sortColumnDescending: (columnLabel: string) => string
  clearColumnSort: (columnLabel: string) => string
  rowLabel: (rowNumber: number) => string
  selectRow: (rowLabel: string) => string
  rowCannotBeDeleted: (rowLabel: string) => string
  rowContainsChanges: string
  rowChangedTitle: (rowLabel: string) => string
  cellContainsChanges: string
  changedCellOriginalValue: (originalValue: string) => string
  emptyOriginalValue: string
  originalValue: string
  revertCell: string
  rejectedAction: GridRejectedActionPresenter
}>

export type DataGridRowHeaderActionContext<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
> = Readonly<{
  controller: GridController<Row, RowKey, Schema, Effect>
  row: Row
  rowKey: RowKey
  visibleRowIndex: number
  rowLabel: string
  selected: boolean
  deleteAvailability: GridRowDeleteAvailability
  selectRow: () => GridDispatchResult
}>

export type DataGridRowHeaderActions<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
> = (context: DataGridRowHeaderActionContext<Row, RowKey, Schema, Effect>) => ReactNode

export function GridHeaderRow<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  columns,
  controller,
  messages,
}: {
  columns: readonly GridCompiledColumn<Row>[]
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: GridCellMessages
}) {
  return <div aria-rowindex={1} className="business-grid__header-row" role="row">
    <GridCornerHeader controller={controller} messages={messages} />
    {columns.map((column, index) => <GridColumnHeader
      column={column}
      columnIndex={index}
      controller={controller}
      key={column.key}
      messages={messages}
    />)}
  </div>
}

function GridCornerHeader<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({ controller, messages }: {
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: GridCellMessages
}) {
  const allSelected = useGridSelector(controller, selectAllCellsSelected)
  return <div
    aria-colindex={1}
    aria-label={messages.selectAllCells}
    aria-selected={allSelected}
    className="business-grid__corner"
    data-grid-hit="corner"
    data-selected={allSelected || undefined}
    role="columnheader"
    title={messages.selectAllCells}
  />
}

function GridColumnHeaderImpl<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  column,
  columnIndex,
  controller,
  messages,
}: {
  column: GridCompiledColumn<Row>
  columnIndex: number
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: GridCellMessages
}) {
  const selector = useMemo(() => (
    snapshot: GridControllerSnapshot<Row, RowKey>,
  ) => selectColumnHeader(snapshot, column.key), [column.key])
  const { dirty, filterCount, selected, sortDirection } = useGridSelector(
    controller,
    selector,
    equalColumnHeader,
  )
  return <div
    aria-colindex={columnIndex + 2}
    aria-label={`${column.label}${dirty ? `. ${messages.columnContainsChanges}.` : ''}`}
    aria-selected={selected}
    aria-sort={sortDirection ?? 'none'}
    className="business-grid__column-header"
    data-column-key={column.key}
    data-grid-hit="column"
    data-selected={selected || undefined}
    role="columnheader"
  >
    <span className="business-grid__column-label" title={column.label}>{column.label}</span>
    {dirty ? <span aria-hidden="true" className="business-grid__dirty-marker" title={messages.columnContainsChanges} /> : null}
    <span className="business-grid__header-actions">
      {column.filterable ? <button
        aria-label={messages.filterColumn(column.label)}
        data-active={filterCount > 0 || undefined}
        data-column-key={column.key}
        data-grid-header-action="filter"
        title={messages.filterColumn(column.label)}
        type="button"
      ><FilterIcon />
        {filterCount > 0 ? <span aria-hidden="true" className="business-grid__header-action-badge">{filterCount}</span> : null}
      </button> : null}
      {column.sortable ? <button
        aria-label={sortDirection === 'ascending'
          ? messages.sortColumnDescending(column.label)
          : sortDirection === 'descending'
            ? messages.clearColumnSort(column.label)
            : messages.sortColumnAscending(column.label)}
        data-active={sortDirection !== undefined || undefined}
        data-column-key={column.key}
        data-grid-header-action="sort"
        title={messages.sortColumn(column.label)}
        type="button"
      ><SortIcon direction={sortDirection} /></button> : null}
    </span>
  </div>
}

function FilterIcon() {
  return <svg
    aria-hidden="true"
    className="business-grid__header-action-icon"
    fill="none"
    viewBox="0 0 16 16"
  >
    <path d="M2.5 3h11L9.25 7.8v3.45l-2.5 1.5V7.8L2.5 3Z" />
  </svg>
}

function SortIcon({ direction }: { direction: 'ascending' | 'descending' | undefined }) {
  if (direction === 'ascending') {
    return <svg aria-hidden="true" className="business-grid__header-action-icon" fill="none" viewBox="0 0 16 16">
      <path d="M4.25 13V3m0 0L2 5.25M4.25 3 6.5 5.25M8.5 4h5M8.5 8h3.5m-3.5 4H11" />
    </svg>
  }
  if (direction === 'descending') {
    return <svg aria-hidden="true" className="business-grid__header-action-icon" fill="none" viewBox="0 0 16 16">
      <path d="M4.25 3v10m0 0L2 10.75M4.25 13l2.25-2.25M8.5 4H11M8.5 8H12m-3.5 4h5" />
    </svg>
  }
  return <svg aria-hidden="true" className="business-grid__header-action-icon" fill="none" viewBox="0 0 16 16">
    <path d="M5 2.5v11m0-11L2.75 4.75M5 2.5l2.25 2.25m3.75 8.75v-11m0 11-2.25-2.25M11 13.5l2.25-2.25" />
  </svg>
}

const GridColumnHeader = memo(GridColumnHeaderImpl) as typeof GridColumnHeaderImpl

export function GridDataRow<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  cells,
  controller,
  messages,
  rowIndex,
  rowKey,
  rowHeaderActions,
}: {
  cells: ReactNode
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: GridCellMessages
  rowIndex: number
  rowKey: RowKey
  rowHeaderActions?: DataGridRowHeaderActions<Row, RowKey, Schema, Effect>
}) {
  return <div aria-rowindex={rowIndex + 2} className="business-grid__row" data-grid-row={rowIndex} data-grid-row-key={String(rowKey)} role="row">
    <GridRowIndicator
      controller={controller}
      messages={messages}
      rowIndex={rowIndex}
      rowKey={rowKey}
      {...(rowHeaderActions === undefined ? {} : { rowHeaderActions })}
    />
    {cells}
  </div>
}

function GridRowIndicator<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  controller,
  messages,
  rowIndex,
  rowKey,
  rowHeaderActions,
}: {
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: GridCellMessages
  rowIndex: number
  rowKey: RowKey
  rowHeaderActions?: DataGridRowHeaderActions<Row, RowKey, Schema, Effect>
}) {
  const selector = useMemo(() => (
    snapshot: GridControllerSnapshot<Row, RowKey>,
  ) => selectRowIndicator(snapshot, rowKey), [rowKey])
  const { conflict, deleteAvailability, dirty, selected } = useGridSelector(
    controller,
    selector,
    equalRowIndicator,
  )
  const deleteBlocked = deleteAvailability === 'blocked'
  const label = messages.rowLabel(rowIndex + 1)
  const changedTitle = messages.rowChangedTitle(label)
  const deleteBlockedTitle = messages.rowCannotBeDeleted(label)
  return <div
    aria-colindex={1}
    aria-label={`${label}${deleteBlocked ? `. ${deleteBlockedTitle}.` : ''}${dirty ? `. ${messages.rowContainsChanges}.` : ''}${conflict ? `. ${conflict}` : ''}`}
    aria-selected={selected}
    className="business-grid__row-indicator"
    data-grid-hit="row"
    data-grid-row-index={rowIndex}
    data-conflict={conflict === null ? undefined : 'true'}
    data-delete-blocked={deleteBlocked || undefined}
    data-dirty={dirty || undefined}
    data-has-row-actions={rowHeaderActions ? 'true' : undefined}
    data-selected={selected || undefined}
    role="rowheader"
    title={`${messages.selectRow(label)}${deleteBlocked ? `. ${deleteBlockedTitle}.` : ''}`}
  >
    <span className="business-grid__row-number">{rowIndex + 1}</span>
    {rowHeaderActions ? <GridRowHeaderActionsBoundary
      actions={rowHeaderActions}
      controller={controller}
      rowIndex={rowIndex}
      rowKey={rowKey}
      rowLabel={label}
      selected={selected}
      deleteAvailability={deleteAvailability}
    /> : null}
    {deleteBlocked ? <span
      aria-hidden="true"
      className="business-grid__row-delete-status"
      title={deleteBlockedTitle}
    ><svg aria-hidden="true" viewBox="0 0 12 12">
      <path d="M3.25 3.25h5.5M4.25 3.25l.35-1h2.8l.35 1M4 4.75l.3 5h3.4l.3-5M2 10 10 2" />
    </svg></span> : null}
    {dirty ? <span aria-hidden="true" className="business-grid__dirty-marker" title={changedTitle} /> : null}
    {conflict ? <span className="business-grid__visually-hidden">{conflict}</span> : null}
  </div>
}

function GridRowHeaderActionsBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  actions,
  controller,
  rowIndex,
  rowKey,
  rowLabel,
  selected,
  deleteAvailability,
}: {
  actions: DataGridRowHeaderActions<Row, RowKey, Schema, Effect>
  controller: GridController<Row, RowKey, Schema, Effect>
  rowIndex: number
  rowKey: RowKey
  rowLabel: string
  selected: boolean
  deleteAvailability: GridRowDeleteAvailability
}) {
  const selector = useMemo(() => (
    snapshot: GridControllerSnapshot<Row, RowKey>,
  ) => selectDraftRow(snapshot, rowKey), [rowKey])
  const row = useGridSelector(controller, selector)
  if (row === missingDraftRow) return null
  const selectRow = () => {
    const snapshot = controller.getSnapshot()
    const firstColumn = snapshot.columns[0]?.key
    const lastColumn = snapshot.columns.at(-1)?.key
    if (firstColumn === undefined || lastColumn === undefined) {
      return {
        accepted: false,
        revision: snapshot.revision,
        reason: 'This row cannot be selected because the grid has no columns.',
      }
    }
    const cell = { rowKey, columnKey: firstColumn }
    return controller.dispatch({
      type: 'interaction/activate',
      cell,
      range: {
        anchor: cell,
        focus: { rowKey, columnKey: lastColumn },
      },
    })
  }
  return <span className="business-grid__row-header-actions" data-grid-row-header-actions="">{actions({
    controller,
    row,
    rowKey,
    visibleRowIndex: rowIndex,
    rowLabel,
    selected,
    deleteAvailability,
    selectRow,
  })}</span>
}

function GridCellImpl<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  column,
  columnIndex,
  controller,
  dom,
  messages,
  rowIndex,
  rowKey,
  view,
}: {
  column: GridCompiledColumn<Row>
  columnIndex: number
  controller: GridController<Row, RowKey, Schema, Effect>
  dom: GridDomEffectAdapter
  messages: GridCellMessages
  rowIndex: number
  rowKey: RowKey
  view: GridRuntimeReactView<Row>
}) {
  const point = useMemo(() => ({ rowKey, columnKey: column.key } as const), [column.key, rowKey])
  const selector = useMemo(() => createCellSelector<Row, RowKey>(point), [point])
  const cell = useGridSelector(controller, selector, equalCellSelection)
  const registerCell = useCallback((node: HTMLElement | null) => {
    dom.registerCell(point, node)
  }, [dom, point])
  if (!cell) return null

  const reportRejected = (result: GridDispatchResult) => {
    reportGridRejectedAction(controller, result, messages.rejectedAction)
  }
  const requestEffect = (name: string, input: unknown) => {
    const result = controller.dispatch({ type: 'cell/run-effect', cell: point, effect: name, input })
    reportRejected(result)
    const id = effectId(result)
    let cancelled = false
    return { id, cancel: () => {
      if (cancelled || !id) return
      cancelled = true
      controller.dispatch({ type: 'cell/cancel-effect', effectId: id })
    } }
  }
  const CellView = view.Cell
  const dirtyOriginal = cell.dirty?.formattedOriginalValue ?? null
  const displayedOriginal = dirtyOriginal === null
    ? ''
    : dirtyOriginal === ''
      ? messages.emptyOriginalValue
      : dirtyOriginal
  const invalid = cell.validation?.message ?? null
  const conflict = cell.conflict?.message ?? null
  const dirtyStatus = dirtyOriginal === null
    ? null
    : cell.dirtyOriginalAvailable
      ? messages.changedCellOriginalValue(displayedOriginal)
      : messages.cellContainsChanges
  const status = [
    dirtyStatus,
    invalid,
    conflict,
  ].filter(Boolean).join(' ')
  const accessibleName = status ? `${cell.displayText}. ${status}` : cell.displayText
  return <div
    aria-colindex={columnIndex + 2}
    aria-label={accessibleName}
    aria-selected={cell.selected}
    className="business-grid__cell"
    data-active={cell.active || undefined}
    data-column-key={column.key}
    data-conflict={conflict === null ? undefined : 'true'}
    data-dirty={dirtyOriginal === null ? undefined : 'true'}
    data-grid-hit="cell"
    data-grid-row-index={rowIndex}
    data-invalid={invalid === null ? undefined : 'true'}
    data-selected={cell.selected || undefined}
    ref={registerCell}
    role="gridcell"
    tabIndex={cell.tabIndex}
    title={invalid ?? undefined}
  >
    <div
      className="business-grid__cell-content"
      data-align={cell.valid ? view.presentation.align : 'start'}
      data-content={cell.valid ? view.presentation.content : 'text'}
    >
      {cell.valid ? <CellView
        columnKey={column.key}
        commitValue={(value) => reportRejected(controller.dispatch({ type: 'cell/set-value', cell: point, value }))}
        displayText={cell.displayText}
        editable={cell.editable}
        requestEdit={() => reportRejected(controller.dispatch({ type: 'edit/start', cell: point }))}
        requestEffect={requestEffect}
        row={cell.row}
        typeOptions={column.typeOptions}
        value={cell.value}
      /> : <span>{cell.displayText}</span>}
    </div>
    {dirtyOriginal !== null && cell.dirtyOriginalAvailable ? <GridDirtyCellPopover
      originalValue={displayedOriginal}
      originalValueLabel={messages.originalValue}
      revertLabel={messages.revertCell}
      triggerLabel={messages.changedCellOriginalValue(displayedOriginal)}
      onRevert={() => {
        const activeCell = controller.getSnapshot().interaction.activeCell
        const result = controller.dispatch({ type: 'cell/revert', cell: point })
        reportRejected(result)
        if (result.accepted) queueMicrotask(() => {
          if (!activeCell || !dom.focusCell(activeCell, false)) dom.focusGrid()
        })
        return result.accepted
      }}
    /> : dirtyOriginal !== null
      ? <span aria-hidden="true" className="business-grid__dirty-marker" title={messages.cellContainsChanges} />
      : null}
    {status ? <span className="business-grid__visually-hidden">{status}</span> : null}
  </div>
}

export const GridCell = memo(GridCellImpl) as typeof GridCellImpl

function createCellSelector<Row, RowKey extends GridRowKey>(point: GridPoint<RowKey>) {
  let previous: Readonly<{
    columns: GridControllerSnapshot<Row, RowKey>['columns']
    draft: GridControllerSnapshot<Row, RowKey>['draft']
    interaction: GridControllerSnapshot<Row, RowKey>['interaction']
    view: GridControllerSnapshot<Row, RowKey>['view']
  }> | null = null
  let selected: ReturnType<typeof selectGridCell<Row, RowKey>> = null
  return (snapshot: GridControllerSnapshot<Row, RowKey>) => {
    if (previous
      && previous.columns === snapshot.columns
      && previous.draft === snapshot.draft
      && previous.interaction === snapshot.interaction
      && previous.view === snapshot.view) return selected
    previous = {
      columns: snapshot.columns,
      draft: snapshot.draft,
      interaction: snapshot.interaction,
      view: snapshot.view,
    }
    selected = selectGridCell(snapshot, point)
    return selected
  }
}

function selectAllCellsSelected<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  return snapshot.columns.length > 0
    && snapshot.view.visibleRowKeys.length > 0
    && snapshot.view.visibleRowKeys.every((rowKey) => snapshot.columns.every((column) => isGridCellSelected(snapshot, rowKey, column.key)))
}

function selectColumnHeader<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>, columnKey: string) {
  const sort = snapshot.view.sort.find((entry) => entry.columnKey === columnKey)
  return {
    dirty: snapshot.draft.dirtyCells.some((entry) => entry.columnKey === columnKey),
    filterCount: snapshot.view.columnFilters.filter((entry) => entry.columnKey === columnKey).length,
    selected: snapshot.view.visibleRowKeys.length > 0
      && snapshot.view.visibleRowKeys.every((rowKey) => isGridCellSelected(snapshot, rowKey, columnKey)),
    sortDirection: sort?.direction,
  } as const
}

function selectRowIndicator<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>, rowKey: RowKey) {
  const conflict = snapshot.draft.conflicts.find((entry) => gridRowKeysEqual(entry.rowKey, rowKey) && entry.columnKey === null)
  return {
    conflict: conflict?.message ?? null,
    deleteAvailability: selectGridRowDeleteAvailability(snapshot, rowKey),
    dirty: snapshot.draft.insertedRowKeys.some((key) => gridRowKeysEqual(key, rowKey))
      || snapshot.draft.dirtyCells.some((entry) => gridRowKeysEqual(entry.rowKey, rowKey)),
    selected: snapshot.columns.length > 0
      && snapshot.columns.every((column) => isGridCellSelected(snapshot, rowKey, column.key)),
  } as const
}

function selectDraftRow<Row, RowKey extends GridRowKey>(
  snapshot: GridControllerSnapshot<Row, RowKey>,
  rowKey: RowKey,
) {
  for (const row of snapshot.draft.rows) {
    const resolved = invokeGridCallback(() => snapshot.getRowKey(row))
    if (resolved.ok && gridRowKeysEqual(resolved.value, rowKey)) return row
  }
  return missingDraftRow
}

function equalColumnHeader(
  left: ReturnType<typeof selectColumnHeader>,
  right: ReturnType<typeof selectColumnHeader>,
) {
  return left.dirty === right.dirty
    && left.filterCount === right.filterCount
    && left.selected === right.selected
    && left.sortDirection === right.sortDirection
}

function equalRowIndicator(
  left: ReturnType<typeof selectRowIndicator>,
  right: ReturnType<typeof selectRowIndicator>,
) {
  return left.conflict === right.conflict
    && left.deleteAvailability === right.deleteAvailability
    && left.dirty === right.dirty
    && left.selected === right.selected
}

function equalCellSelection<Row, RowKey extends GridRowKey>(
  left: ReturnType<typeof selectGridCell<Row, RowKey>>,
  right: ReturnType<typeof selectGridCell<Row, RowKey>>,
) {
  if (left === right) return true
  if (!left || !right) return false
  return left.row === right.row
    && left.column === right.column
    && left.valid === right.valid
    && Object.is(left.value, right.value)
    && left.displayText === right.displayText
    && left.editable === right.editable
    && left.active === right.active
    && left.selected === right.selected
    && left.dirty === right.dirty
    && left.dirtyOriginalAvailable === right.dirtyOriginalAvailable
    && equalCellIssue(left.validation, right.validation)
    && left.conflict === right.conflict
    && left.tabIndex === right.tabIndex
}

function equalCellIssue<RowKey extends GridRowKey>(
  left: Readonly<{ rowKey: RowKey; columnKey: string; message: string }> | null,
  right: Readonly<{ rowKey: RowKey; columnKey: string; message: string }> | null,
) {
  return left === right || Boolean(left && right
    && gridRowKeysEqual(left.rowKey, right.rowKey)
    && left.columnKey === right.columnKey
    && left.message === right.message)
}

function effectId(result: GridDispatchResult) {
  if (!result.accepted || typeof result.payload !== 'object' || result.payload === null || !('effectId' in result.payload)) return ''
  const value = (result.payload as { effectId?: unknown }).effectId
  return typeof value === 'string' ? value : ''
}

export type GridCellRef<RowKey extends GridRowKey> = Ref<HTMLElement> | ((point: GridPoint<RowKey>, node: HTMLElement | null) => void)
