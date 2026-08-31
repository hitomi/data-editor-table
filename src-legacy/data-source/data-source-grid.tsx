import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { type CellMouseEvent, type Column, type PositionChangeArgs, type RenderCellProps, type RenderEditCellProps, type RenderHeaderCellProps, type RowsChangeData, type SortColumn } from 'react-data-grid'

import { DefaultDataGridContextActions, resolveDataGridCellActions, type DataGridActionSurfaces, type DataGridCellActionContext, type DataGridCellActionSurfaceProps, type DataGridSelectionActionContext, type DataGridSelectionActionSurfaceProps, type ResolvedDataGridCellAction } from './actions.js'
import { DataGridBulkEditor, getDataGridBulkActionLabel, type DataGridBulkEditorMessages, type DataGridBulkSelection } from '../ui/bulk-editor.js'
import { isDataGridSourceFieldEditable, renderRegisteredCell, renderRegisteredEditor, updateDataGridSourceField, type DataGridBuiltinCellTypes, type DataGridCellTypeRegistry, type DataGridCellTypeRenderer, type DataGridSourceField } from './cell-type-registry.js'
import { classNames } from '../ui/class-names.js'
import { DataSourceFilterPanel, type DataSourceFilterPanelMessages } from './data-source-filter-panel.js'
import type { DataGridColumnFilterGroup, DataGridDataSource, DataGridPersistenceRequest, DataGridPersistenceResult } from './data-source.js'
import { useDataGridColumnDirty, useDataGridOriginalValue, useDataGridRowDirty } from '../react/dirty-store-react.js'
import type { DataGridDirtyStore } from '../core/dirty-store.js'
import { createDataGridFieldRegistry, type DataGridDirtyByRow, type DataGridFieldDefinition } from '../core/field-definition.js'
import type { DataGridCommitPlan, DataGridCommitRejection, DataGridConflict, DataGridEngine, DataGridOrderConflict } from '../core/grid-engine.js'
import { useDataGridEngine, useDataGridEngineView } from '../react/grid-engine-react.js'
import { OperationalDataGrid } from '../ui/operational-data-grid.js'
import { useDataGridRangeSelection } from '../ui/range-selection.js'
import { DataGridSelectionOverlay } from '../ui/selection-overlay.js'
import type { GridRowKey } from '../core/types.js'

export type { DataSourceFilterPanelMessages } from './data-source-filter-panel.js'

export type DataSourceDataGridMessages = {
  empty: ReactNode
  filteredEmpty: ReactNode
  loading: ReactNode
  save: string
  saving: string
  changed: (count: number) => ReactNode
  saveFailed: (error: unknown) => ReactNode
  retry?: string
  blockedChanges?: (count: number) => ReactNode
  conflict?: (fieldLabel: string) => ReactNode
  keepDraft?: string
  useSource?: string
  orderConflict?: ReactNode
  searchPlaceholder?: string
  selection?: (rows: number, columns: number, cells: number) => ReactNode
  visibleRows?: (visible: number, total: number) => ReactNode
  originalValue?: (value: string) => string
  rowNumber?: (index: number) => string
  selectionTooLarge?: (selectedCellCount: number, limit: number) => string
  clipboardUnreadable?: string
  clearSelection?: string
  columnChanged?: string
  rowChanged?: (rowLabel: string) => string
  invalid?: (count: number) => ReactNode
  conflicted?: (count: number) => ReactNode
  selectColumn?: (columnLabel: string) => string
  sortColumn?: (columnLabel: string, nextDirection: 'ASC' | 'DESC' | null) => string
  filterColumn?: (columnLabel: string) => string
  addRow?: string
  duplicateRow?: string
  duplicateRows?: (count: number) => ReactNode
  selectRow?: (rowLabel: string) => string
  selectAll?: string
}

export type DataSourceDataGridCommitIssues<Row, RowKey extends GridRowKey> = {
  rejected: readonly DataGridCommitRejection<RowKey>[]
  cellErrorsByRow: ReadonlyMap<RowKey, ReadonlyMap<string, string>>
  conflictsByRow: ReadonlyMap<RowKey, ReadonlyMap<string, DataGridConflict<Row>>>
  fieldLabels: ReadonlyMap<string, string>
  resolveConflict: (key: RowKey, fieldKey: string, resolution: 'draft' | 'source') => void
  orderConflict: DataGridOrderConflict<RowKey> | null
  resolveOrderConflict: (resolution: 'draft' | 'source') => void
}

const DEFAULT_MESSAGES: DataSourceDataGridMessages = {
  empty: 'No rows yet.', filteredEmpty: 'No rows match the current filters.', loading: 'Loading rows…',
  save: 'Save changes', saving: 'Saving…', changed: (count) => `${count} changed`,
  saveFailed: () => 'Changes could not be saved.', retry: 'Retry save',
  blockedChanges: (count) => `${count} ${count === 1 ? 'row needs' : 'rows need'} attention.`,
  conflict: (fieldLabel) => `“${fieldLabel}” changed in the source.`,
  keepDraft: 'Keep draft', useSource: 'Use source',
  orderConflict: 'Row order changed in the source.',
  searchPlaceholder: 'Filter rows…',
  selection: (rows, columns, cells) => `${rows} rows × ${columns} columns · ${cells} cells`,
  visibleRows: (visible, total) => visible === total ? `${total} rows` : `${visible} of ${total} rows`,
  originalValue: (value) => `Changed. Original value: ${value}`,
  rowNumber: (index) => `Row ${index}`,
  selectionTooLarge: (selected, limit) => `The selection contains ${selected.toLocaleString()} cells. A single operation can process up to ${limit.toLocaleString()}.`,
  clipboardUnreadable: 'The clipboard content could not be read.',
  columnChanged: 'Column contains changes',
  rowChanged: (rowLabel) => `${rowLabel} contains changes`,
  invalid: (count) => `${count} invalid`,
  conflicted: (count) => `${count} conflicted`,
  selectColumn: (columnLabel) => `Select all visible cells in ${columnLabel}`,
  filterColumn: (columnLabel) => `Filter ${columnLabel}`,
  addRow: 'Add row', duplicateRow: 'Duplicate row', duplicateRows: (count) => `Duplicate ${count} rows`,
  selectRow: (rowLabel) => `Select ${rowLabel}`, selectAll: 'Select all cells',
}

const ROW_INDICATOR_COLUMN_KEY = '__rdg_ext_row_indicator__'

export function DataSourceDataGrid<
  Row extends object,
  RowKey extends GridRowKey,
  CellTypes extends object = DataGridBuiltinCellTypes,
>({
  actionSurfaces, ariaLabel, bulkEditorMessages, cellTypes, className, columnFilterMessages, dataSource, messages = DEFAULT_MESSAGES, onActionError, onSaveError, renderCommitIssues,
}: {
  actionSurfaces?: DataGridActionSurfaces<Row>
  ariaLabel: string
  bulkEditorMessages?: DataGridBulkEditorMessages
  cellTypes: DataGridCellTypeRegistry<Row, CellTypes>
  className?: string
  columnFilterMessages?: DataSourceFilterPanelMessages
  dataSource: DataGridDataSource<Row, RowKey, CellTypes>
  messages?: DataSourceDataGridMessages
  onActionError?: (error: unknown) => void
  onSaveError?: (error: unknown) => void
  renderCommitIssues?: (issues: DataSourceDataGridCommitIssues<Row, RowKey>) => ReactNode
}) {
  const snapshot = useSyncExternalStore(dataSource.subscribe, dataSource.getSnapshot, dataSource.getSnapshot)
  const fieldRuntimes = useMemo(() => {
    const runtimes = new Map<string, { field: DataGridSourceField<Row, unknown>; renderer: DataGridCellTypeRenderer<Row, unknown> }>()
    dataSource.fields.forEach((field) => {
      if (!field.key.trim()) throw new Error('A data source field key is required.')
      if (field.key === ROW_INDICATOR_COLUMN_KEY) {
        throw new Error(`The field key "${ROW_INDICATOR_COLUMN_KEY}" is reserved by DataSourceDataGrid.`)
      }
      if (runtimes.has(field.key)) throw new Error(`Data source field key "${field.key}" is duplicated.`)
      const erasedField = field as DataGridSourceField<Row, unknown>
      const renderer = cellTypes.get(field.type) as DataGridCellTypeRenderer<Row, unknown> | undefined
      if (!renderer) throw new Error(`No renderer is registered for cell type "${field.type}".`)
      runtimes.set(field.key, { field: erasedField, renderer })
    })
    return runtimes
  }, [cellTypes, dataSource.fields])
  const engineFields = useMemo(
    () => {
      const fields = [...fieldRuntimes.values()].map(({ field, renderer }) => toEngineField(field, renderer))
      createDataGridFieldRegistry(fields)
      return fields
    },
    [fieldRuntimes],
  )
  const grid = useDataGridEngine(
    { fields: engineFields, rowKeyGetter: dataSource.getRowKey, rows: snapshot.rows },
    { identity: dataSource, materializeRows: false },
  )
  type PersistenceAttempt = {
    dataSource: DataGridDataSource<Row, RowKey, CellTypes>
    engine: DataGridEngine<Row, RowKey>
    persistence: DataGridDataSource<Row, RowKey, CellTypes>['persistence']
    plan: DataGridCommitPlan<Row, RowKey>
    request: DataGridPersistenceRequest<Row, RowKey>
    result?: DataGridPersistenceResult<Row>
    draftRowsBeforeReceipt?: readonly Row[]
  }
  type PersistenceOwner = Pick<PersistenceAttempt, 'dataSource' | 'engine'>
  type PersistenceCoordinator = PersistenceOwner & {
    active: PersistenceAttempt | null
    autoSaveTimer: number | null
    failure: { error: unknown } | null
    followUpPersistence: DataGridDataSource<Row, RowKey, CellTypes>['persistence'] | null
    mounted: boolean
    running: Promise<void> | null
  }
  const persistenceCoordinatorsRef = useRef<WeakMap<DataGridDataSource<Row, RowKey, CellTypes>, PersistenceCoordinator> | null>(null)
  persistenceCoordinatorsRef.current ??= new WeakMap()
  let persistenceCoordinator = persistenceCoordinatorsRef.current.get(dataSource)
  if (!persistenceCoordinator || persistenceCoordinator.engine !== grid.engine) {
    persistenceCoordinator = {
      dataSource,
      engine: grid.engine,
      active: null,
      autoSaveTimer: null,
      failure: null,
      followUpPersistence: null,
      mounted: false,
      running: null,
    }
    persistenceCoordinatorsRef.current.set(dataSource, persistenceCoordinator)
  }
  const committedPersistenceCoordinatorRef = useRef<PersistenceCoordinator | null>(null)
  const [, setPersistenceUiRevision] = useState(0)
  const saving = persistenceCoordinator.running !== null
  const currentSaveFailure = persistenceCoordinator.failure
  const persistRef = useRef<((owner: PersistenceCoordinator, trigger?: 'automatic' | 'manual' | 'retry') => Promise<void>) | null>(null)
  const scheduleAutomaticPersistence = useCallback((owner: PersistenceCoordinator) => {
    const persistence = owner.dataSource.persistence
    if (persistence.mode === 'update') {
      void persistRef.current?.(owner)
      return
    }
    if (persistence.mode !== 'auto-save') return
    if (owner.autoSaveTimer !== null) window.clearTimeout(owner.autoSaveTimer)
    const scheduledPersistence = persistence
    owner.autoSaveTimer = window.setTimeout(() => {
      owner.autoSaveTimer = null
      if (owner.dataSource.persistence !== scheduledPersistence || owner.dataSource.persistence.mode !== 'auto-save') return
      void persistRef.current?.(owner)
    }, persistence.debounceMs ?? 500)
  }, [])
  type CellActionTarget = { dataSource: DataGridDataSource<Row, RowKey, CellTypes>; fieldKey: string; rowKey: RowKey }
  type CellActionSession = { contextMenu: { x: number; y: number } | null; target: CellActionTarget }
  const [cellActionSession, setCellActionSession] = useState<CellActionSession | null>(null)
  const clearActiveActions = useCallback(() => {
    setCellActionSession(null)
  }, [])
  const closeContextMenu = useCallback(() => {
    setCellActionSession((current) => current?.contextMenu ? { ...current, contextMenu: null } : current)
  }, [])
  const [cellOperationError, setCellOperationError] = useState<string | null>(null)
  const [bulkEditorSession, setBulkEditorSession] = useState<(DataGridBulkSelection<Row> & {
    dataSource: DataGridDataSource<Row, RowKey, CellTypes>
    field: DataGridFieldDefinition<Row>
    sourceVersion: DataGridPersistenceRequest<Row, RowKey>['sourceVersion']
    viewStateKey: string
  }) | null>(null)
  const [bulkEditorError, setBulkEditorError] = useState<string | null>(null)
  const [filterEditorSession, setFilterEditorSession] = useState<{
    current?: DataGridColumnFilterGroup
    dataSource: DataGridDataSource<Row, RowKey, CellTypes>
    fieldKey: string
    fieldLabel: string
    filter: NonNullable<DataGridCellTypeRenderer<Row, unknown>['filter']>
  } | null>(null)
  const [filterEditorError, setFilterEditorError] = useState<string | null>(null)
  const selectVisibleColumnRef = useRef<(fieldKey: string, options?: { additive?: boolean; extend?: boolean }) => void>(() => undefined)
  const selectVisibleRowRef = useRef<(rowKey: RowKey, options?: { additive?: boolean; extend?: boolean }) => void>(() => undefined)
  const beginVisibleColumnSelectionRef = useRef<(fieldKey: string, options?: { additive?: boolean; extend?: boolean }) => boolean>(() => false)
  const extendVisibleColumnSelectionRef = useRef<(fieldKey: string) => boolean>(() => false)
  const beginVisibleRowSelectionRef = useRef<(rowKey: RowKey, options?: { additive?: boolean; extend?: boolean }) => boolean>(() => false)
  const extendVisibleRowSelectionRef = useRef<(rowKey: RowKey) => boolean>(() => false)
  const endSelectionGestureRef = useRef<() => void>(() => undefined)
  const selectAllVisibleRef = useRef<() => void>(() => undefined)
  const visibleRowsRef = useRef<readonly Row[]>([])
  const axisPointerSelectionRef = useRef<
    | { axis: 'column'; lastColumnKey: string; pointerId: number }
    | { axis: 'row'; lastRowKey: RowKey; pointerId: number }
    | null
  >(null)
  const suppressAxisClickRef = useRef(false)

  const deferredFilterQuery = useDeferredValue(snapshot.filterQuery?.trim() ?? '')
  const viewOptions = useMemo(() => {
    const filtering = dataSource.capabilities?.filtering
    const normalizedQuery = deferredFilterQuery.toLocaleLowerCase()
    const columnFilters = snapshot.columnFilters ?? []
    const filter = normalizedQuery || columnFilters.length > 0
      ? (row: Row) => {
        const matchesQuery = !normalizedQuery || (filtering?.matches?.(row, deferredFilterQuery) ?? [...fieldRuntimes.values()].some(({ field, renderer }) => {
        if (field.filterable === false) return false
        return formatSourceFieldValue(field, renderer, row).toLocaleLowerCase().includes(normalizedQuery)
        }))
        return matchesQuery && matchesDataGridColumnFilters(row, columnFilters, fieldRuntimes)
      }
      : undefined
    const sortColumns = snapshot.sortColumns ?? []
    const compare = sortColumns.length > 0
      ? (left: Row, right: Row) => {
        for (const sort of sortColumns) {
          const runtime = fieldRuntimes.get(sort.columnKey)
          if (!runtime) continue
          const compared = dataSource.capabilities?.sorting?.compare?.(left, right, sort.columnKey)
            ?? compareDataGridValues(runtime.field.getValue(left), runtime.field.getValue(right))
          if (compared !== 0) return sort.direction === 'ASC' ? compared : -compared
        }
        return 0
      }
      : undefined
    return { ...(filter ? { filter } : {}), ...(compare ? { compare } : {}) }
  }, [dataSource.capabilities?.filtering, dataSource.capabilities?.sorting, deferredFilterQuery, fieldRuntimes, snapshot.columnFilters, snapshot.sortColumns])
  const visibleRows = useDataGridEngineView(grid.engine, viewOptions)
  useLayoutEffect(() => {
    visibleRowsRef.current = visibleRows
  }, [visibleRows])
  const draftRowCount = grid.engine.getRowsSnapshot().length
  const requirePublishedViewSnapshot = useCallback((
    updated: ReturnType<typeof dataSource.getSnapshot> | undefined,
    accepts: (candidate: ReturnType<typeof dataSource.getSnapshot>) => boolean,
    contractMessage: string,
  ) => {
    if (!updated || dataSource.getSnapshot() !== updated || !accepts(updated)) throw new Error(contractMessage)
    return updated
  }, [dataSource])
  const publishViewUpdate = useCallback((
    update: () => ReturnType<typeof dataSource.getSnapshot> | undefined,
    accepts: (candidate: ReturnType<typeof dataSource.getSnapshot>) => boolean,
    contractMessage: string,
    fallbackMessage: string,
  ) => {
    try {
      requirePublishedViewSnapshot(update(), accepts, contractMessage)
      setCellOperationError(null)
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : fallbackMessage
      setCellOperationError(message)
      onActionError?.(error)
      return message
    }
  }, [onActionError, requirePublishedViewSnapshot])
  const runSort = useCallback((sortColumns: readonly SortColumn[]) => {
    publishViewUpdate(
      () => dataSource.capabilities?.sorting?.update(sortColumns),
      (candidate) => sortColumnsEqual(candidate.sortColumns ?? [], sortColumns),
      'Sorting.update must synchronously publish and return a snapshot with the requested sortColumns.',
      'Rows could not be sorted.',
    )
  }, [dataSource.capabilities?.sorting, publishViewUpdate])

  const startRowPointerSelection = useCallback((rowKey: RowKey, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || axisPointerSelectionRef.current) return
    const started = beginVisibleRowSelectionRef.current(rowKey, {
      additive: event.ctrlKey || event.metaKey,
      extend: event.shiftKey,
    })
    if (!started) return
    axisPointerSelectionRef.current = {
      axis: 'row',
      lastRowKey: rowKey,
      pointerId: event.pointerId,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])
  const startColumnPointerSelection = useCallback((columnKey: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || axisPointerSelectionRef.current) return
    const started = beginVisibleColumnSelectionRef.current(columnKey, {
      additive: event.ctrlKey || event.metaKey,
      extend: event.shiftKey,
    })
    if (!started) return
    axisPointerSelectionRef.current = {
      axis: 'column',
      lastColumnKey: columnKey,
      pointerId: event.pointerId,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])
  const updateAxisPointerSelection = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointer = axisPointerSelectionRef.current
    if (!pointer || pointer.pointerId !== event.pointerId || (event.buttons & 1) === 0) return
    const target = document.elementFromPoint(event.clientX, event.clientY)
    if (pointer.axis === 'row') {
      const rowIndex = Number(target?.closest<HTMLElement>('.operational-data-grid-row-indicator-button')?.dataset.rowIndex)
      const row = Number.isInteger(rowIndex) ? visibleRowsRef.current[rowIndex] : undefined
      if (!row) return
      const rowKey = dataSource.getRowKey(row)
      if (Object.is(rowKey, pointer.lastRowKey) || !extendVisibleRowSelectionRef.current(rowKey)) return
      pointer.lastRowKey = rowKey
    } else {
      const columnKey = target?.closest<HTMLElement>('.operational-data-grid-header-select')?.dataset.columnKey
      if (!columnKey || columnKey === pointer.lastColumnKey || !extendVisibleColumnSelectionRef.current(columnKey)) return
      pointer.lastColumnKey = columnKey
    }
    event.preventDefault()
  }, [dataSource])
  const endAxisPointerSelection = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointer = axisPointerSelectionRef.current
    if (!pointer || pointer.pointerId !== event.pointerId) return
    axisPointerSelectionRef.current = null
    endSelectionGestureRef.current()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    suppressAxisClickRef.current = true
    window.setTimeout(() => { suppressAxisClickRef.current = false }, 0)
    event.preventDefault()
  }, [])
  const cancelAxisPointerSelection = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointer = axisPointerSelectionRef.current
    if (!pointer || pointer.pointerId !== event.pointerId) return
    axisPointerSelectionRef.current = null
    endSelectionGestureRef.current()
  }, [])

  const mutateDraft = useCallback((mutation: () => void) => {
    mutation()
    scheduleAutomaticPersistence(persistenceCoordinator)
  }, [persistenceCoordinator, scheduleAutomaticPersistence])

  const updateSourceField = useCallback((field: DataGridSourceField<Row, unknown>, rowKey: RowKey, next: unknown) => {
    const currentRow = grid.engine.getRowSnapshot(rowKey)
    if (!currentRow) return false
    return updateDataGridSourceField(field, currentRow, next, (row) => {
      mutateDraft(() => grid.applyRows([row]))
    })
  }, [grid, mutateDraft])

  const columns = useMemo<readonly Column<Row>[]>(() => [{
    key: ROW_INDICATOR_COLUMN_KEY,
    name: '#',
    width: 52,
    minWidth: 52,
    maxWidth: 52,
    frozen: true,
    resizable: false,
    sortable: false,
    headerCellClass: 'operational-data-grid-row-indicator-header',
    cellClass: 'operational-data-grid-row-indicator-cell',
    renderHeaderCell: () => <button
      aria-label={messages.selectAll ?? 'Select all cells'}
      className="operational-data-grid-select-all"
      data-grid-selection-action="true"
      type="button"
      onClick={(event) => { event.stopPropagation(); selectAllVisibleRef.current() }}
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}
    ><span aria-hidden="true">◩</span></button>,
    renderCell: ({ row, rowIdx }: RenderCellProps<Row>) => <DataSourceRowIndicator
      dirtyStore={grid.dirtyStore}
      label={messages.rowNumber?.(rowIdx + 1) ?? `Row ${rowIdx + 1}`}
      messages={messages}
      rowIndex={rowIdx + 1}
      rowKey={dataSource.getRowKey(row)}
      onPointerCancel={cancelAxisPointerSelection}
      onPointerDown={(event) => startRowPointerSelection(dataSource.getRowKey(row), event)}
      onPointerMove={updateAxisPointerSelection}
      onPointerUp={endAxisPointerSelection}
      onSelectRow={(event) => {
        if (suppressAxisClickRef.current) {
          event.preventDefault()
          return
        }
        selectVisibleRowRef.current(dataSource.getRowKey(row), { additive: event.ctrlKey || event.metaKey, extend: event.shiftKey })
      }}
    />,
  }, ...dataSource.fields.map((field) => {
    const runtime = fieldRuntimes.get(field.key)
    if (!runtime) throw new Error(`No field runtime is registered for "${field.key}".`)
    const { field: erasedField, renderer } = runtime
    const numeric = field.type === 'number'
    return {
      key: field.key, name: field.label, width: field.width, minWidth: field.minWidth, maxWidth: field.maxWidth, sortable: false,
      headerCellClass: classNames('operational-data-grid-data-header', numeric && 'operational-data-grid-numeric-cell'),
      cellClass: (row: Row) => {
        const rowKey = dataSource.getRowKey(row)
        return classNames(
          'operational-data-grid-data-cell',
          numeric && 'operational-data-grid-numeric-cell',
          grid.engine.getCellErrors(rowKey)?.has(field.key) && 'operational-data-grid-cell-invalid',
          grid.engine.getConflicts(rowKey)?.has(field.key) && 'operational-data-grid-cell-conflict',
        )
      },
      editable: (row: Row) => isDataGridSourceFieldEditable(erasedField, row),
      editorOptions: { closeOnExternalRowChange: false },
      renderHeaderCell: (props: RenderHeaderCellProps<Row>) => <DataSourceDirtyHeader
        dirtyStore={grid.dirtyStore}
        filterCount={(snapshot.columnFilters ?? []).find((group) => group.columnKey === field.key)?.conditions.length ?? 0}
        fieldKey={field.key}
        messages={messages}
        onPointerCancel={cancelAxisPointerSelection}
        onPointerDown={(event) => startColumnPointerSelection(field.key, event)}
        onPointerMove={updateAxisPointerSelection}
        onPointerUp={endAxisPointerSelection}
        {...(field.sortable && dataSource.capabilities?.sorting
          ? { onSortColumn: (event: ReactMouseEvent<HTMLButtonElement>) => runSort(nextDataGridSortColumns(snapshot.sortColumns ?? [], field.key, event.ctrlKey || event.metaKey)) }
          : {})}
        {...(renderer.filter && dataSource.capabilities?.filtering?.updateColumnFilters
          ? { onFilterColumn: () => {
            if (!renderer.filter) return
            setFilterEditorError(null)
            const current = (snapshot.columnFilters ?? []).find((group) => group.columnKey === field.key)
            setFilterEditorSession({
              dataSource,
              fieldKey: field.key,
              fieldLabel: field.label,
              filter: renderer.filter,
              ...(current === undefined ? {} : { current }),
            })
          } }
          : {})}
        onSelectColumn={(event) => {
          if (suppressAxisClickRef.current) {
            event.preventDefault()
            return
          }
          selectVisibleColumnRef.current(field.key, { additive: event.ctrlKey || event.metaKey, extend: event.shiftKey })
        }}
        props={props}
      />,
      renderCell: (props: RenderCellProps<Row>) => {
        const rowKey = dataSource.getRowKey(props.row)
        const update = (next: unknown) => { updateSourceField(erasedField, rowKey, next) }
        const { actions, context } = resolveSourceCellActions(erasedField, renderer, props.row, update, onActionError)
        return <DataSourceDirtyCell dirtyStore={grid.dirtyStore} fieldKey={field.key} messages={messages} rowKey={rowKey}>
          <div className="operational-data-grid-cell-content">{renderRegisteredCell(renderer, erasedField, props, update)}{actions.length > 0 && actionSurfaces?.renderCell ? actionSurfaces.renderCell({ scope: 'cell', actions, context }) : null}</div>
        </DataSourceDirtyCell>
      },
      renderEditCell: renderer.renderEditor && field.setValue ? (props: RenderEditCellProps<Row>) => renderRegisteredEditor(
        renderer,
        erasedField,
        props,
        () => grid.engine.getRowSnapshot(dataSource.getRowKey(props.row)),
      ) : undefined,
    }
  })], [actionSurfaces, cancelAxisPointerSelection, dataSource.capabilities?.filtering?.updateColumnFilters, dataSource.capabilities?.sorting, dataSource.fields, dataSource.getRowKey, endAxisPointerSelection, fieldRuntimes, grid.dirtyStore, grid.engine, messages, onActionError, runSort, snapshot.columnFilters, snapshot.sortColumns, startColumnPointerSelection, startRowPointerSelection, updateAxisPointerSelection, updateSourceField])

  const createPersistenceAttempt = useCallback((owner: PersistenceOwner): PersistenceAttempt | null => {
    const sourceSnapshot = owner.dataSource.getSnapshot()
    // Detached owners do not have an active React subscription. Rebase them
    // before a follow-up so an external publication cannot be overwritten by
    // a proposal prepared from the source that was visible before detaching.
    owner.engine.rebaseSource(sourceSnapshot.rows)
    const plan = owner.engine.prepareCommit()
    if (plan.acceptedKeys.size === 0) return null
    return { dataSource: owner.dataSource, engine: owner.engine, persistence: owner.dataSource.persistence, plan, request: {
      rows: plan.rows,
      acceptedKeys: plan.acceptedKeys,
      deletedKeys: plan.deletedKeys,
      dirtyByRow: plan.dirtyByRow,
      orderChanged: plan.orderChanged,
      revision: plan.revision,
      sourceVersion: sourceSnapshot.version,
      operationId: createPersistenceOperationId(),
    } }
  }, [])
  const createPersistenceAttemptRef = useRef(createPersistenceAttempt)
  createPersistenceAttemptRef.current = createPersistenceAttempt

  const persist = useCallback((coordinator: PersistenceCoordinator, trigger: 'automatic' | 'manual' | 'retry' = 'automatic') => {
    if (coordinator.running) {
      if (trigger === 'automatic') {
        coordinator.followUpPersistence = coordinator.dataSource.persistence
        if (coordinator.active) {
          coordinator.active.draftRowsBeforeReceipt = coordinator.engine.getRowsSnapshot()
        }
      }
      return coordinator.running
    }
    if (coordinator.active && trigger === 'automatic') {
      coordinator.followUpPersistence = coordinator.dataSource.persistence
      coordinator.active.draftRowsBeforeReceipt = coordinator.engine.getRowsSnapshot()
      return Promise.resolve()
    }
    coordinator.active ??= createPersistenceAttemptRef.current(coordinator)
    if (!coordinator.active) {
      coordinator.failure = null
      if (coordinator.mounted) setPersistenceUiRevision((revision) => revision + 1)
      return Promise.resolve()
    }

    const running = (async () => {
      coordinator.failure = null
      if (coordinator.mounted) setPersistenceUiRevision((revision) => revision + 1)
      while (coordinator.active) {
        const attempt = coordinator.active
        try {
          if (!attempt.result) {
            const persistence = attempt.persistence
            attempt.result = persistence.mode === 'update'
              ? await persistence.update(attempt.request)
              : await persistence.saveDirty(attempt.request)
          }
          const result = attempt.result
          const sourceSnapshot = attempt.dataSource.getSnapshot()
          const resultAlreadyPublished = sourceSnapshot.rows === result.rows
            && Object.is(sourceSnapshot.version, result.version)
          if (!Object.is(sourceSnapshot.version, attempt.request.sourceVersion) && !resultAlreadyPublished) {
            // A newer authoritative publication wins over this delayed receipt.
            // The engine has already rebased that source update; update/auto-save
            // owners may prepare a fresh proposal instead of rolling it back.
            coordinator.active = null
            coordinator.followUpPersistence = null
            coordinator.failure = null
            if (coordinator.mounted) setPersistenceUiRevision((revision) => revision + 1)
            if (
              attempt.dataSource.persistence.mode !== 'save-dirty'
              && attempt.engine.prepareCommit().acceptedKeys.size > 0
            ) {
              coordinator.active = createPersistenceAttemptRef.current(attempt)
            }
            continue
          }
          attempt.draftRowsBeforeReceipt ??= attempt.engine.getRowsSnapshot()
          attempt.engine.validateCommit(attempt.plan, result.rows, { acceptSourceChange: true })
          let committedSnapshot = sourceSnapshot
          if (!resultAlreadyPublished) {
            try {
              committedSnapshot = attempt.dataSource.commitRows(result)
            } catch (error) {
              const publishedSnapshot = attempt.dataSource.getSnapshot()
              if (publishedSnapshot.rows !== result.rows || !Object.is(publishedSnapshot.version, result.version)) throw error
              committedSnapshot = publishedSnapshot
            }
          }
          if (
            committedSnapshot.rows !== result.rows
            || !Object.is(committedSnapshot.version, result.version)
            || attempt.dataSource.getSnapshot() !== committedSnapshot
          ) {
            throw new Error('DataGridDataSource.commitRows must synchronously publish and return the exact persistence result.')
          }
          attempt.engine.markCommitted(attempt.plan, result.rows, {
            acceptSourceChange: true,
            draftRowsBeforeReceipt: attempt.draftRowsBeforeReceipt,
          })
          coordinator.active = null
          coordinator.failure = null
          if (coordinator.mounted) setPersistenceUiRevision((revision) => revision + 1)

          const currentPersistence = attempt.dataSource.persistence
          const followUpRequested = (currentPersistence.mode !== 'save-dirty'
            && coordinator.followUpPersistence === currentPersistence)
            || (currentPersistence.mode === 'update'
              && attempt.engine.prepareCommit().acceptedKeys.size > 0)
          coordinator.followUpPersistence = null
          if (!followUpRequested) break
          coordinator.active = createPersistenceAttemptRef.current(attempt)
        } catch (error) {
          coordinator.failure = { error }
          if (coordinator.mounted) setPersistenceUiRevision((revision) => revision + 1)
          onSaveError?.(error)
          break
        }
      }
    })().finally(() => {
      if (coordinator.running === running) coordinator.running = null
      if (coordinator.mounted) setPersistenceUiRevision((revision) => revision + 1)
    })
    coordinator.running = running
    return running
  }, [onSaveError])
  persistRef.current = persist

  useLayoutEffect(() => {
    const previous = committedPersistenceCoordinatorRef.current
    if (previous && previous !== persistenceCoordinator) previous.mounted = false
    persistenceCoordinator.mounted = true
    committedPersistenceCoordinatorRef.current = persistenceCoordinator
    return () => {
      persistenceCoordinator.mounted = false
      if (committedPersistenceCoordinatorRef.current === persistenceCoordinator) {
        committedPersistenceCoordinatorRef.current = null
      }
    }
  }, [persistenceCoordinator])
  const revision = grid.engine.getRevision()
  const commitPlan = grid.engine.prepareCommit()
  const commitIssues = createCommitIssues(grid.engine, commitPlan.rejected)
  useEffect(() => {
    const coordinator = persistenceCoordinator
    const failedAttempt = coordinator.active
    if (!currentSaveFailure || !failedAttempt || grid.dirtyCount !== 0) return
    if (Object.is(snapshot.version, failedAttempt.request.sourceVersion)) return
    coordinator.active = null
    coordinator.failure = null
    coordinator.followUpPersistence = null
    setPersistenceUiRevision((revision) => revision + 1)
  }, [currentSaveFailure, grid.dirtyCount, persistenceCoordinator, snapshot.version])
  useEffect(() => {
    dataSource.observeDraft?.({
      rows: grid.engine.getRowsSnapshot(), dirtyByRow: snapshotDirtyByRow(grid.engine.getDirtyByRow()),
      dirtyCount: grid.dirtyCount, invalidCount: grid.invalidCount, conflictCount: grid.conflictCount,
      rejected: commitPlan.rejected, cellErrorsByRow: commitIssues.cellErrorsByRow, conflictsByRow: commitIssues.conflictsByRow,
      orderConflict: commitPlan.orderConflict,
    })
  }, [dataSource, grid.conflictCount, grid.derivedVersion, grid.dirtyCount, grid.engine, grid.invalidCount, revision])
  useEffect(() => {
    if (dataSource.persistence.mode === 'auto-save') {
      if (grid.dirtyCount > 0) scheduleAutomaticPersistence(persistenceCoordinator)
      return
    }
    if (persistenceCoordinator.autoSaveTimer !== null) {
      window.clearTimeout(persistenceCoordinator.autoSaveTimer)
      persistenceCoordinator.autoSaveTimer = null
    }
    if (dataSource.persistence.mode === 'save-dirty') {
      persistenceCoordinator.followUpPersistence = null
    }
    if (dataSource.persistence.mode === 'update' && grid.dirtyCount > 0) {
      scheduleAutomaticPersistence(persistenceCoordinator)
    }
  }, [dataSource.persistence, grid.derivedVersion, grid.dirtyCount, persistenceCoordinator, revision, scheduleAutomaticPersistence])

  const onRowsChange = useCallback((rows: Row[], change: RowsChangeData<Row>) => {
    mutateDraft(() => {
      grid.applyRows(change.indexes.flatMap((index) => rows[index] ? [rows[index]!] : []))
    })
  }, [grid, mutateDraft])

  const applyRangeRows = useCallback((rows: readonly Row[]) => {
    mutateDraft(() => grid.applyRows(rows))
  }, [grid, mutateDraft])
  const selectableColumnKeys = useMemo(() => new Set(dataSource.fields.map((field) => field.key)), [dataSource.fields])
  const range = useDataGridRangeSelection<Row, RowKey>({
    rows: visibleRows,
    columns,
    selectableColumnKeys,
    preserveSelectionOnOutsideInteraction: bulkEditorSession !== null || filterEditorSession !== null,
    onSelectionCleared: clearActiveActions,
    getRowId: (row) => dataSource.getRowKey(row),
    applyRows: (rows) => applyRangeRows(rows),
    updateRows: (rows) => applyRangeRows(rows),
    getCellText: (row, fieldKey) => {
      const runtime = fieldRuntimes.get(fieldKey)
      return runtime ? formatSourceFieldValue(runtime.field, runtime.renderer, row) : ''
    },
    cellValuesEqual: (left, right, fieldKey) => {
      const field = fieldRuntimes.get(fieldKey)?.field
      if (!field) return true
      const equals = field.valuesEqual ?? Object.is
      return equals(field.getValue(left), field.getValue(right))
    },
    applyCellText: (row, fieldKey, text) => {
      const runtime = fieldRuntimes.get(fieldKey)
      if (!runtime || !runtime.renderer.parseClipboard || !isDataGridSourceFieldEditable(runtime.field, row)) return row
      try {
        return runtime.field.setValue?.(row, runtime.renderer.parseClipboard(text, row, runtime.field)) ?? row
      } catch (error) {
        onActionError?.(error)
        throw error
      }
    },
    clearCell: (row, fieldKey) => {
      const runtime = fieldRuntimes.get(fieldKey)
      if (!runtime || !runtime.renderer.clearValue || !isDataGridSourceFieldEditable(runtime.field, row)) return row
      try {
        return runtime.field.setValue?.(row, runtime.renderer.clearValue(row, runtime.field)) ?? row
      } catch (error) {
        onActionError?.(error)
        throw error
      }
    },
    messages: {
      ...(messages.selectionTooLarge === undefined ? {} : { operationCellLimitExceeded: messages.selectionTooLarge }),
      ...(messages.clipboardUnreadable === undefined ? {} : { clipboardUnreadable: messages.clipboardUnreadable }),
    },
  })
  selectVisibleColumnRef.current = range.selectVisibleColumn
  selectVisibleRowRef.current = range.selectVisibleRow
  beginVisibleColumnSelectionRef.current = range.beginVisibleColumnSelection
  extendVisibleColumnSelectionRef.current = range.extendVisibleColumnSelection
  beginVisibleRowSelectionRef.current = range.beginVisibleRowSelection
  extendVisibleRowSelectionRef.current = range.extendVisibleRowSelection
  endSelectionGestureRef.current = range.endSelectionGesture
  selectAllVisibleRef.current = range.selectAllVisible

  const bulkField = range.singleColumnSelection
    ? engineFields.find((field) => field.key === range.singleColumnSelection?.columnKey)
    : undefined
  const bulkSelection = range.singleColumnSelection
    ? {
        cellCount: range.singleColumnSelection.cellCount,
        columnKey: range.singleColumnSelection.columnKey,
        columnLabel: range.singleColumnSelection.columnLabel,
        hasMixedValues: range.singleColumnSelection.hasMixedValues,
        hasReadOnlyCells: range.singleColumnSelection.hasReadOnlyCells,
        rows: range.singleColumnSelection.rows,
        sessionKey: range.singleColumnSelection.sessionKey,
      }
    : null
  const selectionViewStateKey = createSelectionViewStateKey(snapshot)
  const bulkEditingAvailable = Boolean(
    bulkSelection && bulkSelection.cellCount > 1 && bulkField
    && bulkField.kind !== 'readonly' && bulkField.kind !== 'custom' && bulkField.kind !== 'image',
  )
  const duplicateSourceRows = useMemo(() => {
    const selectedRowIds = new Set(range.selectedRowIds)
    return visibleRows.filter((row) => selectedRowIds.has(dataSource.getRowKey(row)))
  }, [dataSource, range.selectedRowIds, visibleRows])

  const appendRows = useCallback((createRows: () => readonly Row[], failureMessage: string) => {
    try {
      range.commitActiveEditor()
      mutateDraft(() => grid.appendRows(createRows()))
      range.clearSelection()
      setCellOperationError(null)
    } catch (error) {
      setCellOperationError(error instanceof Error ? error.message : failureMessage)
      onActionError?.(error)
    }
  }, [grid, mutateDraft, onActionError, range])
  const appendRow = useCallback((createRow: () => Row) => {
    appendRows(() => [createRow()], 'The row could not be added.')
  }, [appendRows])

  useEffect(() => {
    range.clearSelection()
  }, [dataSource, snapshot.columnFilters, snapshot.filterQuery, snapshot.sortColumns, range.clearSelection])
  const runFilter = useCallback((query: string) => {
    publishViewUpdate(
      () => dataSource.capabilities?.filtering?.update(query),
      (candidate) => (candidate.filterQuery ?? '') === query,
      'Filtering.update must synchronously publish and return a snapshot with the requested filterQuery.',
      'Rows could not be filtered.',
    )
  }, [dataSource.capabilities?.filtering, publishViewUpdate])
  const updateColumnFilters = useCallback((groups: readonly DataGridColumnFilterGroup[]) => {
    const error = publishViewUpdate(
      () => dataSource.capabilities?.filtering?.updateColumnFilters?.(groups),
      (candidate) => columnFilterGroupsEqual(candidate.columnFilters ?? [], groups),
      'Filtering.updateColumnFilters must synchronously publish and return a snapshot with the requested columnFilters.',
      'Column filters could not be updated.',
    )
    if (error === null) {
      setFilterEditorError(null)
      setFilterEditorSession(null)
    } else {
      setFilterEditorError(error)
    }
  }, [dataSource.capabilities?.filtering, publishViewUpdate])
  const errorContent = currentSaveFailure
    ? <div className="operational-data-grid-save-failure"><div>{messages.saveFailed(currentSaveFailure.error)}</div><button type="button" disabled={saving} onClick={() => { void persist(persistenceCoordinator, 'retry') }}>{messages.retry ?? 'Retry save'}</button></div>
    : snapshot.error
  const collectionState = currentSaveFailure
    ? (draftRowCount > 0 ? 'failed-with-data' : 'failed-empty')
    : snapshot.state === 'ready' && draftRowCount > 0 && visibleRows.length === 0
      ? 'filtered-empty'
      : snapshot.state
  const resolveCellActionTarget = useCallback((args: { column: { key: string }; row: Row }) => {
    const runtime = fieldRuntimes.get(args.column.key)
    if (!runtime) return null
    const rowKey = dataSource.getRowKey(args.row)
    return { runtime, target: { dataSource, fieldKey: runtime.field.key, rowKey } }
  }, [dataSource, fieldRuntimes])
  const setCellActionTarget = useCallback((args: { column: { key: string }; row: Row }) => {
    const resolved = resolveCellActionTarget(args)
    if (!resolved) {
      clearActiveActions()
      return
    }
    setCellActionSession((current) => current?.target.dataSource === dataSource
      && current.target.fieldKey === resolved.target.fieldKey
      && Object.is(current.target.rowKey, resolved.target.rowKey)
      ? current
      : { target: resolved.target, contextMenu: null })
  }, [clearActiveActions, dataSource, resolveCellActionTarget])
  const activateCellActions = useCallback((args: { column: { key: string }; row: Row }, event: CellMouseEvent) => {
    const resolved = resolveCellActionTarget(args)
    if (!resolved) {
      clearActiveActions()
      return
    }
    const { actions } = resolveSourceCellActions(resolved.runtime.field, resolved.runtime.renderer, args.row, () => undefined, onActionError)
    const showContextMenu = actions.length > 0 || (range.selectionSummary?.cellCount ?? 0) > 1
    setCellActionSession({
      target: resolved.target,
      contextMenu: showContextMenu ? { x: event.clientX, y: event.clientY } : null,
    })
    if (showContextMenu) {
      event.preventGridDefault()
      event.preventDefault()
    }
  }, [clearActiveActions, onActionError, range.selectionSummary?.cellCount, resolveCellActionTarget])
  const activeActions = useMemo(() => {
    const activeActionTarget = cellActionSession?.target
    if (!activeActionTarget || activeActionTarget.dataSource !== dataSource) return null
    const runtime = fieldRuntimes.get(activeActionTarget.fieldKey)
    const row = grid.engine.getRowSnapshot(activeActionTarget.rowKey)
    if (!runtime || !row) return null
    const { actions, context } = resolveSourceCellActions(
      runtime.field,
      runtime.renderer,
      row,
      (next) => { updateSourceField(runtime.field, activeActionTarget.rowKey, next) },
      onActionError,
    )
    return {
      scope: 'cell' as const,
      context,
      actions,
    }
  }, [cellActionSession?.target, dataSource, fieldRuntimes, grid.engine, onActionError, revision, updateSourceField])
  const selectionActionContext = useMemo<DataGridSelectionActionContext<Row> | null>(() => {
    const summary = range.selectionSummary
    if (!summary) return null
    const cells = range.selectedCells.map(({ columnKey, row }) => {
      const runtime = fieldRuntimes.get(columnKey)
      const editable = Boolean(runtime?.field.setValue) && Boolean(runtime && isDataGridSourceFieldEditable(runtime.field, row))
      const clearable = editable && Boolean(runtime?.renderer.clearValue)
      return { clearable, columnKey, editable, row }
    })
    return {
      cells,
      cellCount: summary.cellCount,
      clearableCellCount: cells.filter((cell) => cell.clearable).length,
      columnCount: summary.columnCount,
      operationBlocked: summary.operationBlocked ?? false,
      rowCount: summary.rowCount,
    }
  }, [fieldRuntimes, range.selectedCells, range.selectionSummary])
  const selectionActionSurface: DataGridSelectionActionSurfaceProps<Row> | null = selectionActionContext
    ? {
        scope: 'selection',
        context: selectionActionContext,
        actions: [{
          scope: 'selection',
          id: 'clear-selection',
          label: messages.clearSelection ?? 'Clear selection',
          destructive: true,
          disabled: selectionActionContext.operationBlocked || selectionActionContext.clearableCellCount === 0,
          run: () => { range.clearSelectedCells() },
          context: selectionActionContext,
        }],
      }
    : null
  const surfacedActiveActions: DataGridCellActionSurfaceProps<Row> | DataGridSelectionActionSurfaceProps<Row> | null = selectionActionSurface ?? activeActions
  const contextActions = surfacedActiveActions && cellActionSession?.contextMenu && surfacedActiveActions.actions.length > 0
    ? (actionSurfaces?.renderContext ?? ((props) => <DefaultDataGridContextActions {...props} />))({ ...surfacedActiveActions, ...cellActionSession.contextMenu, close: closeContextMenu })
    : null
  const toolbarActions = surfacedActiveActions && surfacedActiveActions.actions.length > 0 && actionSurfaces?.renderToolbar
    ? <span className="operational-data-grid-action-surface" data-grid-selection-action="true">{actionSurfaces.renderToolbar(surfacedActiveActions)}</span>
    : null
  const handleActivePositionChange = useCallback((args: PositionChangeArgs<Row>) => {
    range.onActivePositionChange(args)
    if (!args.row || !args.column || args.rowIdx < 0) {
      clearActiveActions()
      return
    }
    setCellActionTarget({ row: args.row, column: args.column })
  }, [clearActiveActions, range.onActivePositionChange, setCellActionTarget])
  const toolbar = dataSource.capabilities?.filtering || dataSource.capabilities?.rows || (snapshot.columnFilters?.length ?? 0) > 0 || dataSource.persistence.mode === 'save-dirty' || bulkEditingAvailable || toolbarActions
    ? <div className="operational-data-grid-source-toolbar">
      {dataSource.capabilities?.filtering ? <label className="operational-data-grid-filter">
        <span className="operational-data-grid-visually-hidden">{messages.searchPlaceholder ?? 'Filter rows…'}</span>
        <input
          aria-label={messages.searchPlaceholder ?? 'Filter rows…'}
          placeholder={dataSource.capabilities.filtering.placeholder ?? messages.searchPlaceholder ?? 'Filter rows…'}
          type="search"
          value={snapshot.filterQuery ?? ''}
          onChange={(event) => runFilter(event.target.value)}
        />
      </label> : null}
      {(snapshot.columnFilters ?? []).map((group) => {
        const field = fieldRuntimes.get(group.columnKey)?.field
        const label = <>{field?.label ?? group.columnKey} · {group.conditions.length}{dataSource.capabilities?.filtering?.updateColumnFilters ? ' ×' : ''}</>
        return dataSource.capabilities?.filtering?.updateColumnFilters
          ? <button className="operational-data-grid-filter-chip" key={group.columnKey} type="button" onClick={() => updateColumnFilters((snapshot.columnFilters ?? []).filter((candidate) => candidate !== group))}>{label}</button>
          : <span className="operational-data-grid-filter-chip" key={group.columnKey}>{label}</span>
      })}
      {toolbarActions}
      <span className="operational-data-grid-toolbar-spacer" />
      {dataSource.capabilities?.rows ? <button data-grid-selection-action="true" type="button" onClick={() => appendRow(dataSource.capabilities!.rows!.create)}>{messages.addRow ?? 'Add row'}</button> : null}
      {dataSource.capabilities?.rows?.duplicate ? <button data-grid-selection-action="true" type="button" disabled={duplicateSourceRows.length === 0} onClick={() => {
        if (duplicateSourceRows.length > 0) appendRows(
          () => duplicateSourceRows.map((row) => dataSource.capabilities!.rows!.duplicate!(row)),
          'The selected rows could not be duplicated.',
        )
      }}>{duplicateSourceRows.length > 1
        ? messages.duplicateRows?.(duplicateSourceRows.length) ?? `Duplicate ${duplicateSourceRows.length} rows`
        : messages.duplicateRow ?? 'Duplicate row'}</button> : null}
      {bulkEditingAvailable && bulkField && bulkSelection ? <button data-grid-selection-action="true" type="button" onClick={() => {
        range.commitActiveEditor()
        setBulkEditorError(null)
        setBulkEditorSession({ ...bulkSelection, dataSource, field: bulkField, sourceVersion: snapshot.version, viewStateKey: selectionViewStateKey })
      }}>{getDataGridBulkActionLabel(bulkField)}</button> : null}
      <span>{grid.dirtyCount ? messages.changed(grid.dirtyCount) : null}</span>
      {dataSource.persistence.mode === 'save-dirty' ? <button type="button" disabled={commitPlan.acceptedKeys.size === 0 || saving} onClick={() => { void persist(persistenceCoordinator, 'manual') }}>{saving ? messages.saving : messages.save}</button> : null}
    </div>
    : null

  const resolveCommitConflict = (key: RowKey, fieldKey: string, resolution: 'draft' | 'source') => {
    mutateDraft(() => grid.resolveConflict(key, fieldKey, resolution))
  }
  const resolveCommitOrderConflict = (resolution: 'draft' | 'source') => {
    mutateDraft(() => grid.engine.resolveOrderConflict(resolution))
  }
  const issues = {
    ...commitIssues,
    rejected: commitPlan.rejected,
    fieldLabels: new Map(dataSource.fields.map((field) => [field.key, field.label])),
    resolveConflict: resolveCommitConflict,
    orderConflict: commitPlan.orderConflict,
    resolveOrderConflict: resolveCommitOrderConflict,
  }
  const issueContent = commitPlan.rejected.length > 0 || commitPlan.orderConflict
    ? renderCommitIssues?.(issues) ?? <DefaultDataSourceDataGridCommitIssues issues={issues} messages={messages} />
    : null
  const selectionSummary = range.selectionSummary
  const footer = <div className="operational-data-grid-source-footer">
    <span>{messages.visibleRows?.(visibleRows.length, draftRowCount) ?? `${visibleRows.length} of ${draftRowCount} rows`}</span>
    {selectionSummary ? <span data-testid="range-selection-summary">{messages.selection?.(
      selectionSummary.rowCount,
      selectionSummary.columnCount,
      selectionSummary.cellCount,
    ) ?? `${selectionSummary.rowCount} rows × ${selectionSummary.columnCount} columns · ${selectionSummary.cellCount} cells`}</span> : null}
    {grid.dirtyCount > 0 ? <span>{messages.changed(grid.dirtyCount)}</span> : null}
    {grid.invalidCount > 0 ? <span>{messages.invalid?.(grid.invalidCount) ?? `${grid.invalidCount} invalid`}</span> : null}
    {grid.conflictCount > 0 ? <span>{messages.conflicted?.(grid.conflictCount) ?? `${grid.conflictCount} conflicted`}</span> : null}
    {range.rangeOperationError || cellOperationError ? <span role="alert">{range.rangeOperationError ?? cellOperationError}</span> : null}
  </div>
  const overlay = range.selectionOverlayStyle ? <DataGridSelectionOverlay
    animated={range.selectionOverlayAnimated}
    fillHandleRef={range.fillHandleVisualRef}
    fillHandleVisible={range.fillHandleEnabled}
    overlayRef={range.selectionOverlayRef}
    style={range.selectionOverlayStyle}
  /> : null
  const onFill = ({ columnKey, sourceRow, targetRow }: { columnKey: string; sourceRow: Row; targetRow: Row }) => {
    if (!range.fillHandleEnabled) return targetRow
    const runtime = fieldRuntimes.get(columnKey)
    const field = runtime?.field
    if (!field?.setValue || !isDataGridSourceFieldEditable(field, targetRow)) return targetRow
    const selection = range.singleColumnSelection?.columnKey === columnKey
      ? range.singleColumnSelection
      : null
    const sourceRows = selection?.rows.length ? selection.rows : [sourceRow]
    const sourceValues = sourceRows.map((row) => field.getValue(row))
    const sourceStartIndex = visibleRows.findIndex((row) => dataSource.getRowKey(row) === dataSource.getRowKey(sourceRows[0]!))
    const targetIndex = visibleRows.findIndex((row) => dataSource.getRowKey(row) === dataSource.getRowKey(targetRow))
    const sequenceOffset = positiveModulo(targetIndex - sourceStartIndex, sourceValues.length)
    const defaultValue = sourceValues[sequenceOffset]
    const value = runtime?.renderer.fill?.({
      defaultValue,
      field,
      sourceRows,
      sourceStartIndex,
      sourceValues,
      targetIndex,
      targetRow,
    }) ?? defaultValue
    return field.setValue(targetRow, value)
  }

  const bulkEditorField = bulkEditorSession?.field
  const bulkEditor = bulkEditorSession
    ? <DataSourceModal ariaLabel={`${bulkEditorSession.columnLabel} · ${bulkEditorSession.cellCount} cells`}>
      <DataGridBulkEditor
        {...(bulkEditorField === undefined ? {} : { field: bulkEditorField })}
        footer={bulkEditorError ? <p role="alert">{bulkEditorError}</p> : null}
        {...(bulkEditorMessages === undefined ? {} : { messages: bulkEditorMessages })}
        onApplyRowTransform={(transform) => {
          try {
            if (
              bulkEditorSession.dataSource !== dataSource
              || !Object.is(dataSource.getSnapshot().version, bulkEditorSession.sourceVersion)
              || createSelectionViewStateKey(dataSource.getSnapshot()) !== bulkEditorSession.viewStateKey
            ) {
              throw new Error('The selection changed while the bulk editor was open. Select the cells again to apply this change.')
            }
            const currentSelection = range.singleColumnSelection
            if (!currentSelection || currentSelection.sessionKey !== bulkEditorSession.sessionKey) {
              throw new Error('The selection changed while the bulk editor was open. Select the cells again to apply this change.')
            }
            if (currentSelection.hasReadOnlyCells) {
              throw new Error('The selection now includes read-only cells. Review the selection before applying this change.')
            }
            const result = range.applyRowTransform(transform)
            if (!result.applied) throw new Error(result.error)
            setCellOperationError(null)
            setBulkEditorError(null)
            setBulkEditorSession(null)
          } catch (error) {
            const message = error instanceof Error ? error.message : 'The selected cells could not be updated.'
            setCellOperationError(message)
            setBulkEditorError(message)
            onActionError?.(error)
          }
        }}
        onCancel={() => { setBulkEditorError(null); setBulkEditorSession(null) }}
        selection={bulkEditorSession}
      />
    </DataSourceModal>
    : null
  const filterEditor = filterEditorSession
    ? <DataSourceModal ariaLabel={columnFilterMessages?.title(filterEditorSession.fieldLabel) ?? `Filter ${filterEditorSession.fieldLabel}`} onEscape={() => setFilterEditorSession(null)}>
      <>
      <DataSourceFilterPanel
        columnKey={filterEditorSession.fieldKey}
        columnLabel={filterEditorSession.fieldLabel}
        {...(filterEditorSession.current === undefined ? {} : { current: filterEditorSession.current })}
        filter={filterEditorSession.filter}
        {...(columnFilterMessages === undefined ? {} : { messages: columnFilterMessages })}
        onApply={(group) => {
          if (filterEditorSession.dataSource !== dataSource) {
            const error = new Error('The data source changed while the filter editor was open. Return to the original data source or cancel this edit.')
            setFilterEditorError(error.message)
            setCellOperationError(error.message)
            onActionError?.(error)
            return
          }
          updateColumnFilters([
            ...(snapshot.columnFilters ?? []).filter((candidate) => candidate.columnKey !== filterEditorSession.fieldKey),
            ...(group ? [group] : []),
          ])
        }}
        onCancel={() => { setFilterEditorError(null); setFilterEditorSession(null) }}
      />
      {filterEditorError ? <p role="alert">{filterEditorError}</p> : null}
      </>
    </DataSourceModal>
    : null

  return <div className="operational-data-grid-source" onPasteCapture={range.onPasteCapture}><div className="operational-data-grid-source-adornments">{issueContent}</div><OperationalDataGrid ariaLabel={ariaLabel} {...(className === undefined ? {} : { className })} columns={columns} rows={visibleRows}
    sourceRowCount={draftRowCount} gridRef={range.gridRef} viewportRef={range.gridContainerRef} renderers={range.renderers} overlay={overlay} footer={footer}
    rowKeyGetter={dataSource.getRowKey} onRowsChange={onRowsChange} {...(collectionState === undefined ? {} : { collectionState })}
    sortColumns={snapshot.sortColumns ?? []} onSortColumnsChange={runSort}
    onCellMouseDown={range.onCellMouseDown} onCellContextMenu={(args, event) => { range.onCellContextMenu(args, event); activateCellActions(args, event) }}
    onActivePositionChange={handleActivePositionChange} onCellCopy={range.onCellCopy} onCellKeyDown={range.onCellKeyDown}
    onScroll={range.onGridScroll} onColumnResize={range.onColumnResize} {...(range.fillHandleEnabled ? { onFill } : {})}
    loadingContent={messages.loading} emptyContent={messages.empty} filteredEmptyContent={messages.filteredEmpty}
    errorContent={errorContent} toolbar={toolbar} />{contextActions}{bulkEditor}{filterEditor}</div>
}

function DataSourceModal({ ariaLabel, children, onEscape }: {
  ariaLabel: string
  children: ReactNode
  onEscape?: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    return () => {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close()
      else dialog.removeAttribute('open')
    }
  }, [])
  return <dialog aria-label={ariaLabel} className="operational-data-grid-modal" data-grid-selection-action="true" ref={dialogRef} onCancel={(event) => { event.preventDefault(); onEscape?.() }}>{children}</dialog>
}

function createPersistenceOperationId() {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') return `rdg-ext-${crypto.randomUUID()}`
  if (typeof crypto?.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return `rdg-ext-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  throw new Error('Secure random values are required to create a persistence operation id.')
}

function createSelectionViewStateKey(snapshot: {
  filterQuery?: string
  columnFilters?: readonly DataGridColumnFilterGroup[]
  sortColumns?: readonly SortColumn[]
}) {
  return JSON.stringify([
    snapshot.filterQuery ?? '',
    snapshot.columnFilters ?? [],
    snapshot.sortColumns ?? [],
  ])
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor
}

function DataSourceDirtyHeader<Row extends object, RowKey extends GridRowKey>({
  dirtyStore,
  filterCount,
  fieldKey,
  messages,
  onFilterColumn,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onSelectColumn,
  onSortColumn,
  props,
}: {
  dirtyStore: DataGridDirtyStore<RowKey>
  filterCount: number
  fieldKey: string
  messages: DataSourceDataGridMessages
  onFilterColumn?: () => void
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onSelectColumn: (event: ReactMouseEvent<HTMLElement>) => void
  onSortColumn?: (event: ReactMouseEvent<HTMLButtonElement>) => void
  props: RenderHeaderCellProps<Row>
}) {
  const dirty = useDataGridColumnDirty(dirtyStore, fieldKey)
  const label = messages.columnChanged ?? 'Column contains changes'
  const selectLabel = messages.selectColumn?.(String(props.column.name)) ?? `Select all visible cells in ${String(props.column.name)}`
  const filterLabel = messages.filterColumn?.(String(props.column.name)) ?? `Filter ${String(props.column.name)}`
  const nextSortDirection = props.sortDirection === undefined ? 'ASC' : props.sortDirection === 'ASC' ? 'DESC' : null
  const sortLabel = messages.sortColumn?.(String(props.column.name), nextSortDirection)
    ?? (nextSortDirection === null
      ? `Clear sorting for ${String(props.column.name)}`
      : `Sort ${String(props.column.name)} ${nextSortDirection === 'ASC' ? 'ascending' : 'descending'}`)
  return <div className="operational-data-grid-header-content" onClick={(event) => { event.stopPropagation(); onSelectColumn(event) }}>
    <button
      aria-label={selectLabel}
      className="operational-data-grid-header-select"
      data-column-key={props.column.key}
      data-grid-selection-action="true"
      tabIndex={props.tabIndex}
      title={selectLabel}
      type="button"
      onKeyDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation() }}
      onPointerCancel={(event) => { event.stopPropagation(); onPointerCancel(event) }}
      onPointerDown={(event) => { event.stopPropagation(); onPointerDown(event) }}
      onPointerMove={(event) => { event.stopPropagation(); onPointerMove(event) }}
      onPointerUp={(event) => { event.stopPropagation(); onPointerUp(event) }}
    ><span>{props.column.name}</span></button>
    {dirty ? <span className="operational-data-grid-visually-hidden">{label}</span> : null}
    <span className="operational-data-grid-header-indicators">
      {dirty ? <span aria-hidden="true" className="operational-data-grid-dirty-marker" title={label} /> : null}
      {onFilterColumn ? <button aria-label={filterLabel} className="operational-data-grid-filter-column" data-active={filterCount > 0 ? 'true' : undefined} data-grid-selection-action="true" title={filterLabel} type="button" onClick={(event) => { event.stopPropagation(); onFilterColumn() }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}><span aria-hidden="true">{filterCount > 0 ? filterCount : '≡'}</span></button> : null}
      {onSortColumn ? <button aria-label={sortLabel} className="operational-data-grid-sort-column" data-grid-selection-action="true" title={sortLabel} type="button" onClick={(event) => { event.stopPropagation(); onSortColumn(event) }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}><span aria-hidden="true">{props.sortDirection === 'ASC' ? '↑' : props.sortDirection === 'DESC' ? '↓' : '↕'}</span></button> : null}
    </span>
  </div>
}

function DataSourceDirtyCell<RowKey extends GridRowKey>({
  children,
  dirtyStore,
  fieldKey,
  messages,
  rowKey,
}: {
  children: ReactNode
  dirtyStore: DataGridDirtyStore<RowKey>
  fieldKey: string
  messages: DataSourceDataGridMessages
  rowKey: RowKey
}) {
  const originalValue = useDataGridOriginalValue(dirtyStore, rowKey, fieldKey)
  const label = originalValue === undefined
    ? null
    : messages.originalValue?.(originalValue) ?? `Changed. Original value: ${originalValue}`
  return <div className="operational-data-grid-dirty-cell" data-dirty={originalValue === undefined ? undefined : 'true'}>
    {children}
    {label ? <span className="operational-data-grid-visually-hidden">{label}</span> : null}
    {label ? <span aria-hidden="true" className="operational-data-grid-dirty-marker operational-data-grid-dirty-cell-marker" title={label} /> : null}
  </div>
}

function DataSourceRowIndicator<RowKey extends GridRowKey>({
  dirtyStore,
  label,
  messages,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onSelectRow,
  rowIndex,
  rowKey,
}: {
  dirtyStore: DataGridDirtyStore<RowKey>
  label: string
  messages: DataSourceDataGridMessages
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onSelectRow: (event: ReactMouseEvent<HTMLButtonElement>) => void
  rowIndex: number
  rowKey: RowKey
}) {
  const dirty = useDataGridRowDirty(dirtyStore, rowKey)
  const dirtyLabel = messages.rowChanged?.(label) ?? `${label} contains changes`
  const selectLabel = messages.selectRow?.(label) ?? `Select ${label}`
  const rowStatusLabel = dirty ? `${label}. ${dirtyLabel}` : label
  return <div aria-label={rowStatusLabel} className="operational-data-grid-row-indicator">
    <button
      aria-label={selectLabel}
      className="operational-data-grid-row-indicator-button"
      data-grid-selection-action="true"
      data-row-index={rowIndex - 1}
      type="button"
      onClick={(event) => { event.stopPropagation(); onSelectRow(event) }}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation() }}
      onPointerCancel={(event) => { event.stopPropagation(); onPointerCancel(event) }}
      onPointerDown={(event) => { event.stopPropagation(); onPointerDown(event) }}
      onPointerMove={(event) => { event.stopPropagation(); onPointerMove(event) }}
      onPointerUp={(event) => { event.stopPropagation(); onPointerUp(event) }}
    >
      <span>{rowIndex}</span>
      {dirty ? <span aria-hidden="true" className="operational-data-grid-dirty-marker" title={dirtyLabel} /> : null}
    </button>
  </div>
}

function formatSourceFieldValue<Row>(
  field: DataGridSourceField<Row, unknown>,
  renderer: DataGridCellTypeRenderer<Row, unknown>,
  row: Row,
) {
  const value = field.getValue(row)
  return renderer.formatClipboard?.(value, row, field) ?? (value == null ? '' : String(value))
}

function compareDataGridValues(left: unknown, right: unknown) {
  if (Object.is(left, right)) return 0
  if (left == null) return -1
  if (right == null) return 1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime()
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
}

function matchesDataGridColumnFilters<Row>(
  row: Row,
  groups: readonly DataGridColumnFilterGroup[],
  fieldRuntimes: ReadonlyMap<string, {
    field: DataGridSourceField<Row, unknown>
    renderer: DataGridCellTypeRenderer<Row, unknown>
  }>,
) {
  return groups.every((group) => {
    const runtime = fieldRuntimes.get(group.columnKey)
    const filter = runtime?.renderer.filter
    if (!runtime || !filter || group.conditions.length === 0) return true
    const results = group.conditions.flatMap((condition) => {
      const operator = filter.operators.find((candidate) => candidate.key === condition.operator)
      if (!operator || (operator.requiresValue && (!condition.value.trim() || operator.validate?.(condition.value)))) return []
      return [operator.matches(runtime.field.getValue(row), condition.value, row, runtime.field)]
    })
    if (results.length === 0) return true
    return group.match === 'any' ? results.some(Boolean) : results.every(Boolean)
  })
}

function sortColumnsEqual(left: readonly SortColumn[], right: readonly SortColumn[]) {
  return left.length === right.length && left.every((column, index) => {
    const candidate = right[index]
    return candidate?.columnKey === column.columnKey && candidate.direction === column.direction
  })
}

function columnFilterGroupsEqual(left: readonly DataGridColumnFilterGroup[], right: readonly DataGridColumnFilterGroup[]) {
  return left.length === right.length && left.every((group, groupIndex) => {
    const candidate = right[groupIndex]
    return candidate?.columnKey === group.columnKey
      && candidate.match === group.match
      && candidate.conditions.length === group.conditions.length
      && group.conditions.every((condition, conditionIndex) => {
        const candidateCondition = candidate.conditions[conditionIndex]
        return candidateCondition?.operator === condition.operator && candidateCondition.value === condition.value
      })
  })
}

function nextDataGridSortColumns(current: readonly SortColumn[], columnKey: string, additive: boolean): readonly SortColumn[] {
  const currentIndex = current.findIndex((column) => column.columnKey === columnKey)
  const currentDirection = currentIndex < 0 ? undefined : current[currentIndex]?.direction
  const nextDirection = currentDirection === undefined ? 'ASC' : currentDirection === 'ASC' ? 'DESC' : undefined
  if (!additive) return nextDirection ? [{ columnKey, direction: nextDirection }] : []
  const next = [...current]
  if (nextDirection === undefined) {
    if (currentIndex >= 0) next.splice(currentIndex, 1)
  } else if (currentIndex >= 0) {
    next[currentIndex] = { columnKey, direction: nextDirection }
  } else {
    next.push({ columnKey, direction: nextDirection })
  }
  return next
}

function createActionContext<Row>(field: DataGridSourceField<Row, unknown>, row: Row, update: (value: unknown) => void): DataGridCellActionContext<Row, unknown> {
  return { editable: isDataGridSourceFieldEditable(field, row), field, row, value: field.getValue(row), update }
}

function resolveSourceCellActions<Row>(
  field: DataGridSourceField<Row, unknown>,
  renderer: DataGridCellTypeRenderer<Row, unknown>,
  row: Row,
  update: (value: unknown) => void,
  onError: ((error: unknown) => void) | undefined,
) {
  const context = createActionContext(field, row, update)
  return {
    actions: guardActions(resolveDataGridCellActions(context, renderer.actions ?? []), onError),
    context,
  }
}

function guardActions<Row>(actions: readonly ResolvedDataGridCellAction<Row>[], onError: ((error: unknown) => void) | undefined): readonly ResolvedDataGridCellAction<Row>[] {
  return actions.map((action) => ({ ...action, run: async () => {
    try {
      await action.run()
    } catch (error) {
      if (onError) onError(error)
      else throw error
    }
  } }))
}

function snapshotDirtyByRow<RowKey extends GridRowKey>(
  dirtyByRow: DataGridDirtyByRow<RowKey>,
) {
  return new Map(
    [...dirtyByRow].map(([key, fields]) => [key, new Map(fields)] as const),
  )
}

function createCommitIssues<Row, RowKey extends GridRowKey>(
  engine: DataGridEngine<Row, RowKey>,
  rejected: readonly DataGridCommitRejection<RowKey>[],
) {
  const cellErrorsByRow = new Map<RowKey, ReadonlyMap<string, string>>()
  const conflictsByRow = new Map<RowKey, ReadonlyMap<string, DataGridConflict<Row>>>()
  rejected.forEach(({ key }) => {
    const errors = engine.getCellErrors(key)
    const conflicts = engine.getConflicts(key)
    if (errors) cellErrorsByRow.set(key, new Map(errors))
    if (conflicts) conflictsByRow.set(key, new Map(conflicts))
  })
  return { cellErrorsByRow, conflictsByRow }
}

function DefaultDataSourceDataGridCommitIssues<Row, RowKey extends GridRowKey>({
  issues,
  messages,
}: {
  issues: DataSourceDataGridCommitIssues<Row, RowKey>
  messages: DataSourceDataGridMessages
}) {
  return <div className="operational-data-grid-commit-issues" role="alert">
    {issues.rejected.length > 0
      ? <strong>{messages.blockedChanges?.(issues.rejected.length) ?? `${issues.rejected.length} rows need attention.`}</strong>
      : null}
    {[...issues.cellErrorsByRow].flatMap(([rowKey, errors]) =>
      [...errors].map(([fieldKey, message]) =>
        <p key={`${String(rowKey)}:${fieldKey}`}>{message}</p>))}
    {[...issues.conflictsByRow].flatMap(([rowKey, conflicts]) =>
      [...conflicts].map(([fieldKey]) => {
        const fieldLabel = fieldKey === '__row__'
          ? 'Row'
          : issues.fieldLabels.get(fieldKey) ?? fieldKey
        return <div key={`${String(rowKey)}:${fieldKey}`}>
          <span>{messages.conflict?.(fieldLabel) ?? `“${fieldLabel}” changed in the source.`}</span>
          <button type="button" onClick={() => issues.resolveConflict(rowKey, fieldKey, 'draft')}>{messages.keepDraft ?? 'Keep draft'}</button>
          <button type="button" onClick={() => issues.resolveConflict(rowKey, fieldKey, 'source')}>{messages.useSource ?? 'Use source'}</button>
        </div>
      }))}
    {issues.orderConflict ? <div>
      <span>{messages.orderConflict ?? 'Row order changed in the source.'}</span>
      <button type="button" onClick={() => issues.resolveOrderConflict('draft')}>{messages.keepDraft ?? 'Keep draft'}</button>
      <button type="button" onClick={() => issues.resolveOrderConflict('source')}>{messages.useSource ?? 'Use source'}</button>
    </div> : null}
  </div>
}

function toEngineField<Row>(
  field: DataGridSourceField<Row, unknown>,
  renderer?: DataGridCellTypeRenderer<Row, unknown>,
): DataGridFieldDefinition<Row> {
  const bulk = renderer?.bulk as
    | DataGridCellTypeRenderer<Row, string>['bulk']
    | DataGridCellTypeRenderer<Row, number>['bulk']
    | DataGridCellTypeRenderer<Row, string[]>['bulk']
  const optional = {
    ...(field.isEditable === undefined ? {} : { isEditable: field.isEditable }),
    ...(field.valuesEqual === undefined ? {} : { valuesEqual: field.valuesEqual }),
    ...(renderer?.formatClipboard === undefined ? {} : {
      formatOriginalValue: (value: unknown, row: Row) => renderer.formatClipboard!(value, row, field),
    }),
    ...(field.validate === undefined ? {} : { validate: field.validate }),
    ...(renderer?.clearValue === undefined || !field.setValue ? {} : {
      clearValue: (row: Row) => field.setValue!(row, renderer.clearValue!(row, field)),
    }),
  }
  if (!field.setValue) return { kind: 'readonly', key: field.key, label: field.label, getValue: field.getValue, ...optional }
  if (field.bulkEditable !== false && bulk?.kind === 'text') {
    const textField = field as DataGridSourceField<Row, string>
    return {
      kind: 'text', key: field.key, label: field.label,
      getValue: textField.getValue, setValue: textField.setValue!,
      ...(bulk.operations === undefined ? {} : { bulkOperations: bulk.operations }),
      ...optional,
    } as DataGridFieldDefinition<Row>
  }
  if (field.bulkEditable !== false && bulk?.kind === 'number') {
    const numberField = field as DataGridSourceField<Row, number>
    const numberRenderer = renderer as DataGridCellTypeRenderer<Row, number>
    const numberBulk = numberRenderer.bulk
    return {
      kind: 'number', key: field.key, label: field.label,
      getValue: numberField.getValue, setValue: numberField.setValue!,
      parseInput: (value: string, row: Row) => numberBulk?.kind === 'number'
        ? numberBulk.parseInput(value, row, numberField)
        : { error: 'This cell type does not support number input.' },
      ...optional,
    } as DataGridFieldDefinition<Row>
  }
  if (field.bulkEditable !== false && bulk?.kind === 'select') {
    const selectField = field as DataGridSourceField<Row, string>
    return {
      kind: 'select', key: field.key, label: field.label,
      getValue: selectField.getValue, setValue: selectField.setValue!,
      options: bulk.options,
      ...optional,
    } as DataGridFieldDefinition<Row>
  }
  if (field.bulkEditable !== false && bulk?.kind === 'tags') {
    const tagsField = field as DataGridSourceField<Row, string[]>
    const tagsRenderer = renderer as DataGridCellTypeRenderer<Row, string[]>
    const tagsBulk = tagsRenderer.bulk
    if (tagsBulk?.kind !== 'tags') return { kind: 'custom', type: field.type, key: field.key, label: field.label, getValue: field.getValue, setValue: field.setValue, ...optional }
    return {
      kind: 'tags', key: field.key, label: field.label,
      getValue: tagsField.getValue, setValue: tagsField.setValue!,
      ...(tagsBulk.operations === undefined ? {} : { bulkOperations: tagsBulk.operations }),
      ...(tagsBulk.labels === undefined ? {} : { bulkLabels: tagsBulk.labels }),
      ...(tagsBulk.options === undefined ? {} : { options: tagsBulk.options }),
      ...(tagsBulk.parseInput === undefined ? {} : { parseInput: (value: string, row: Row) => tagsBulk.parseInput!(value, row, tagsField) }),
      ...(tagsBulk.normalize === undefined ? {} : { normalize: (values: string[], row: Row) => tagsBulk.normalize!(values, row, tagsField) }),
      ...optional,
    } as DataGridFieldDefinition<Row>
  }
  return { kind: 'custom', type: field.type, key: field.key, label: field.label, getValue: field.getValue, setValue: field.setValue, ...optional }
}
