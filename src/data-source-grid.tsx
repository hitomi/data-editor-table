import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { CellMouseArgs, CellMouseEvent, Column, RowsChangeData, SortColumn } from 'react-data-grid'

import { DefaultDataGridContextActions, resolveDataGridCellActions, type DataGridActionSurfaces, type DataGridCellActionContext, type ResolvedDataGridCellAction } from './actions'
import { renderRegisteredCell, renderRegisteredEditor, type DataGridCellTypeRegistry, type DataGridSourceField } from './cell-type-registry'
import type { DataGridDataSource, DataGridPersistenceRequest } from './data-source'
import type { DataGridFieldDefinition } from './field-definition'
import { useDataGridEngine } from './grid-engine-react'
import { OperationalDataGrid } from './operational-data-grid'
import type { GridRowKey } from './types'

export type DataSourceDataGridMessages = {
  empty: ReactNode
  filteredEmpty: ReactNode
  loading: ReactNode
  save: string
  saving: string
  changed: (count: number) => ReactNode
  saveFailed: (error: unknown) => ReactNode
}

const DEFAULT_MESSAGES: DataSourceDataGridMessages = {
  empty: 'No rows yet.', filteredEmpty: 'No rows match the current filters.', loading: 'Loading rows…',
  save: 'Save changes', saving: 'Saving…', changed: (count) => `${count} changed`,
  saveFailed: () => 'Changes could not be saved. Try again.',
}

export function DataSourceDataGrid<Row, RowKey extends GridRowKey>({
  actionSurfaces, ariaLabel, cellTypes, className, dataSource, messages = DEFAULT_MESSAGES, onActionError, onSaveError,
}: {
  actionSurfaces?: DataGridActionSurfaces<Row>
  ariaLabel: string
  cellTypes: DataGridCellTypeRegistry<Row>
  className?: string
  dataSource: DataGridDataSource<Row, RowKey>
  messages?: DataSourceDataGridMessages
  onActionError?: (error: unknown) => void
  onSaveError?: (error: unknown) => void
}) {
  const snapshot = useSyncExternalStore(dataSource.subscribe, dataSource.getSnapshot, dataSource.getSnapshot)
  const engineFields = useMemo(() => dataSource.fields.map(toEngineField), [dataSource.fields])
  const grid = useDataGridEngine({ fields: engineFields, rowKeyGetter: dataSource.getRowKey, rows: snapshot.rows }, { identity: dataSource })
  const [saveError, setSaveError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const saveControllerRef = useRef<AbortController | null>(null)
  const cellActionTimerRef = useRef<number | null>(null)
  const [activeActions, setActiveActions] = useState<{ context: DataGridCellActionContext<Row, unknown>; actions: readonly ResolvedDataGridCellAction<Row>[] } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const columns = useMemo<readonly Column<Row>[]>(() => dataSource.fields.map((field) => {
    const renderer = cellTypes.get(field.type)
    if (!renderer) throw new Error(`No renderer is registered for cell type "${field.type}".`)
    return {
      key: field.key, name: field.label, width: field.width, minWidth: field.minWidth, maxWidth: field.maxWidth, sortable: Boolean(field.sortable && dataSource.capabilities?.sorting),
      editable: field.setValue ? (row: Row) => field.isEditable?.(row) ?? true : false,
      renderCell: (props) => {
        const context = createActionContext(field, props.row, (next) => { if (field.setValue) props.onRowChange(field.setValue(props.row, next)) })
        const actions = guardActions(resolveDataGridCellActions(context, renderer.actions ?? []), onActionError)
        return <div className="operational-data-grid-cell-content">{renderRegisteredCell(renderer, field, props)}{actions.length > 0 && actionSurfaces?.renderCell ? actionSurfaces.renderCell({ actions, context }) : null}</div>
      },
      renderEditCell: renderer.renderEditor && field.setValue ? (props) => renderRegisteredEditor(renderer, field, props) : undefined,
    }
  }), [actionSurfaces, cellTypes, dataSource.capabilities?.sorting, dataSource.fields, onActionError])

  const createPersistenceRequest = useCallback((signal: AbortSignal): DataGridPersistenceRequest<Row, RowKey> | null => {
    const plan = grid.engine.prepareCommit()
    if (plan.rejected.length > 0 || plan.acceptedKeys.size === 0) return null
    const deletedKeys = new Set([...plan.acceptedKeys].filter((key) => grid.engine.getRowSnapshot(key) === undefined))
    return { rows: plan.rows, acceptedKeys: plan.acceptedKeys, deletedKeys, dirtyByRow: grid.engine.getDirtyByRow(), signal }
  }, [grid.engine])

  const persist = useCallback(async () => {
    saveControllerRef.current?.abort()
    const controller = new AbortController()
    saveControllerRef.current = controller
    const request = createPersistenceRequest(controller.signal)
    if (!request) return
    setSaving(true); setSaveError(null)
    try {
      const persistence = dataSource.persistence
      if (persistence.mode === 'update') await persistence.update(request)
      else await persistence.saveDirty(request)
    } catch (error) {
      if (!controller.signal.aborted) { setSaveError(error); onSaveError?.(error) }
    } finally {
      if (saveControllerRef.current === controller) { saveControllerRef.current = null; setSaving(false) }
    }
  }, [createPersistenceRequest, dataSource.persistence, onSaveError])

  useEffect(() => () => {
    saveControllerRef.current?.abort()
    if (cellActionTimerRef.current !== null) window.clearTimeout(cellActionTimerRef.current)
  }, [])
  const revision = grid.engine.getRevision()
  useEffect(() => {
    dataSource.observeDraft?.({
      rows: grid.engine.getRowsSnapshot(), dirtyByRow: grid.engine.getDirtyByRow(),
      dirtyCount: grid.dirtyCount, invalidCount: grid.invalidCount, conflictCount: grid.conflictCount,
    })
  }, [dataSource, grid.conflictCount, grid.dirtyCount, grid.engine, grid.invalidCount, revision])
  useEffect(() => {
    if (dataSource.persistence.mode !== 'auto-save' || grid.dirtyCount === 0) return
    const timeout = window.setTimeout(() => { void persist() }, dataSource.persistence.debounceMs ?? 500)
    return () => window.clearTimeout(timeout)
  }, [dataSource.persistence, grid.dirtyCount, persist, revision])

  const onRowsChange = useCallback((rows: Row[], change: RowsChangeData<Row>) => {
    grid.applyRows(change.indexes.flatMap((index) => rows[index] ? [rows[index]!] : []))
    if (dataSource.persistence.mode === 'update') queueMicrotask(() => { void persist() })
  }, [dataSource.persistence.mode, grid, persist])

  const toolbar = dataSource.persistence.mode === 'save-dirty'
    ? <div className="operational-data-grid-source-toolbar"><span>{grid.dirtyCount ? messages.changed(grid.dirtyCount) : null}</span><button type="button" disabled={!grid.dirtyCount || saving || grid.invalidCount > 0 || grid.conflictCount > 0} onClick={() => { void persist() }}>{saving ? messages.saving : messages.save}</button></div>
    : null
  const errorContent = saveError ? messages.saveFailed(saveError) : snapshot.error
  const collectionState = saveError ? (grid.rows.length > 0 ? 'failed-with-data' : 'failed-empty') : snapshot.state
  const activateCellActions = useCallback((args: CellMouseArgs<Row>, event?: CellMouseEvent) => {
    const field = dataSource.fields.find((candidate) => candidate.key === args.column.key)
    if (!field) return
    const renderer = cellTypes.get(field.type)
    if (!renderer) return
    const context = createActionContext(field, args.row, (next) => {
      if (field.setValue) grid.applyRows([field.setValue(args.row, next)])
    })
    const actions = guardActions(resolveDataGridCellActions(context, renderer.actions ?? []), onActionError)
    setActiveActions({ context, actions })
    if (event && actions.length > 0) {
      event.preventGridDefault()
      event.preventDefault()
      setContextMenu({ x: event.clientX, y: event.clientY })
    }
  }, [cellTypes, dataSource.fields, grid, onActionError])
  const runSort = useCallback((sortColumns: readonly SortColumn[]) => {
    void Promise.resolve(dataSource.capabilities?.sorting?.update(sortColumns)).catch(onActionError)
  }, [dataSource.capabilities?.sorting, onActionError])
  const scheduleCellActions = useCallback((args: CellMouseArgs<Row>) => {
    if (cellActionTimerRef.current !== null) window.clearTimeout(cellActionTimerRef.current)
    cellActionTimerRef.current = window.setTimeout(() => {
      cellActionTimerRef.current = null
      activateCellActions(args)
    }, 180)
  }, [activateCellActions])
  const preserveDoubleClickEditing = useCallback(() => {
    if (cellActionTimerRef.current !== null) {
      window.clearTimeout(cellActionTimerRef.current)
      cellActionTimerRef.current = null
    }
  }, [])
  const contextActions = activeActions && contextMenu && activeActions.actions.length > 0
    ? (actionSurfaces?.renderContext ?? ((props) => <DefaultDataGridContextActions {...props} />))({ ...activeActions, ...contextMenu, close: () => setContextMenu(null) })
    : null
  const toolbarActions = activeActions && activeActions.actions.length > 0 && actionSurfaces?.renderToolbar ? actionSurfaces.renderToolbar(activeActions) : null

  return <div className="operational-data-grid-source"><div className="operational-data-grid-external-toolbar">{toolbarActions}</div><OperationalDataGrid ariaLabel={ariaLabel} {...(className === undefined ? {} : { className })} columns={columns} rows={grid.rows}
    rowKeyGetter={dataSource.getRowKey} onRowsChange={onRowsChange} {...(collectionState === undefined ? {} : { collectionState })}
    sortColumns={snapshot.sortColumns ?? []} onSortColumnsChange={runSort}
    onCellClick={scheduleCellActions} onCellDoubleClick={preserveDoubleClickEditing} onCellContextMenu={(args, event) => activateCellActions(args, event)}
    loadingContent={messages.loading} emptyContent={messages.empty} filteredEmptyContent={messages.filteredEmpty}
    errorContent={errorContent} toolbar={toolbar} />{contextActions}</div>
}

function createActionContext<Row>(field: DataGridSourceField<Row, unknown>, row: Row, update: (value: unknown) => void): DataGridCellActionContext<Row, unknown> {
  return { field, row, value: field.getValue(row), update }
}

function guardActions<Row>(actions: readonly ResolvedDataGridCellAction<Row>[], onError: ((error: unknown) => void) | undefined): readonly ResolvedDataGridCellAction<Row>[] {
  return actions.map((action) => ({ ...action, run: async () => {
    try { await action.run() } catch (error) { onError?.(error) }
  } }))
}

function toEngineField<Row>(field: DataGridSourceField<Row, unknown>): DataGridFieldDefinition<Row> {
  const optional = {
    ...(field.isEditable === undefined ? {} : { isEditable: field.isEditable }),
    ...(field.validate === undefined ? {} : { validate: field.validate }),
  }
  if (!field.setValue) return { kind: 'readonly', key: field.key, label: field.label, getValue: field.getValue, ...optional }
  return { kind: 'custom', type: field.type, key: field.key, label: field.label, getValue: field.getValue, setValue: field.setValue, ...optional }
}
