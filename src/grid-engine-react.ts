import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { GridRowKey } from './types'

import {
  createDataGridEngine,
  type DataGridEngine,
  type DataGridEngineOptions,
} from './grid-engine'
import {
  createDataGridEngineView,
  type DataGridEngineView,
  type DataGridEngineViewOptions,
} from './grid-engine-view'

const EMPTY_ROWS: readonly unknown[] = []
const NOOP_SUBSCRIBE = () => () => undefined

export function useDataGridEngine<Row, RowKey extends GridRowKey>(
  options: DataGridEngineOptions<Row, RowKey>,
  hookOptions: { materializeRows?: boolean; identity?: unknown } = {},
) {
  const enginesRef = useRef(new Map<unknown, DataGridEngine<Row, RowKey>>())
  const identity = hookOptions.identity ?? '__default_grid_engine__'
  const engine = enginesRef.current.get(identity) ?? createDataGridEngine(options)
  if (!enginesRef.current.has(identity)) enginesRef.current.set(identity, engine)

  useLayoutEffect(() => {
    engine.configure({
      fields: options.fields,
      isRowInvalid: options.isRowInvalid,
    })
    engine.rebaseSource(options.rows)
  }, [engine, options.fields, options.isRowInvalid, options.rows])

  const materializeRows = hookOptions.materializeRows ?? true
  const rows = useSyncExternalStore(
    materializeRows ? engine.subscribeRows : NOOP_SUBSCRIBE,
    materializeRows
      ? engine.getRowsSnapshot
      : () => EMPTY_ROWS as readonly Row[],
    materializeRows
      ? engine.getRowsSnapshot
      : () => EMPTY_ROWS as readonly Row[],
  )
  const meta = useSyncExternalStore(
    engine.subscribeMeta,
    engine.getMetaSnapshot,
    engine.getMetaSnapshot,
  )

  const updateRows = useCallback(
    (candidateRows: readonly Row[]) => {
      const changedRows = candidateRows.filter(
        (row) =>
          engine.getRowSnapshot(options.rowKeyGetter(row)) !== row,
      )
      engine.applyRows(changedRows)
    },
    [engine, options.rowKeyGetter],
  )

  return {
    appendRow: engine.appendRow,
    applyRows: engine.applyRows,
    baselineById: engine.getBaselineById(),
    canRedo: meta.canRedo,
    canUndo: meta.canUndo,
    cellErrorCount: meta.cellErrorCount,
    conflictCount: meta.conflictCount,
    deleteRows: engine.deleteRows,
    dirtyByRow: engine.getDirtyByRow(),
    dirtyCount: meta.dirtyCount,
    dirtyStore: engine.dirtyStore,
    draftById: engine.getDraftById(),
    engine,
    invalidCount: meta.invalidCount,
    invalidRowKeys: engine.getInvalidRowKeys(),
    prepareCommit: engine.prepareCommit,
    markCommitted: engine.markCommitted,
    redo: engine.redo,
    removeRows: engine.removeRows,
    resolveConflict: engine.resolveConflict,
    reset: engine.reset,
    rows,
    undo: engine.undo,
    updateRow: (row: Row) => engine.applyRows([row]),
    updateRows,
  }
}

export function useDataGridEngineView<Row, RowKey extends GridRowKey>(
  engine: DataGridEngine<Row, RowKey>,
  options: DataGridEngineViewOptions<Row>,
) {
  const viewRef = useRef<{
    engine: DataGridEngine<Row, RowKey>
    view: DataGridEngineView<Row>
  } | null>(null)
  if (!viewRef.current || viewRef.current.engine !== engine) {
    viewRef.current = {
      engine,
      view: createDataGridEngineView(engine, options),
    }
  }
  const view = viewRef.current.view

  useLayoutEffect(() => {
    view.configure(options)
  }, [options, view])

  return useSyncExternalStore(
    view.subscribe,
    view.getRowsSnapshot,
    view.getRowsSnapshot,
  )
}
