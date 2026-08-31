import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { GridRowKey } from '../core/types.js'

import {
  createDataGridEngine,
  type DataGridEngine,
  type DataGridEngineOptions,
} from '../core/grid-engine.js'
import {
  createDataGridEngineView,
  type DataGridEngineView,
  type DataGridEngineViewOptions,
} from '../core/grid-engine-view.js'

const EMPTY_ROWS: readonly unknown[] = []
const NOOP_SUBSCRIBE = () => () => undefined

export function useDataGridEngine<Row, RowKey extends GridRowKey>(
  options: DataGridEngineOptions<Row, RowKey>,
  hookOptions: { materializeRows?: boolean; identity?: unknown } = {},
) {
  const identity = hookOptions.identity ?? '__default_grid_engine__'
  type EngineEntry = { engine: DataGridEngine<Row, RowKey>; identity: unknown }
  const engineCacheRef = useRef<{
    current: EngineEntry | null
    byObjectIdentity: WeakMap<object, EngineEntry>
  } | null>(null)
  engineCacheRef.current ??= { current: null, byObjectIdentity: new WeakMap() }
  const cache = engineCacheRef.current
  const objectIdentity = (typeof identity === 'object' && identity !== null) || typeof identity === 'function'
    ? identity as object
    : null
  let entry = objectIdentity ? cache.byObjectIdentity.get(objectIdentity) : undefined
  if (!entry && cache.current && Object.is(cache.current.identity, identity)) entry = cache.current
  if (!entry) {
    entry = { engine: createDataGridEngine(options), identity }
    if (objectIdentity) cache.byObjectIdentity.set(objectIdentity, entry)
  }
  cache.current = entry
  const engine = entry.engine

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
    appendRows: engine.appendRows,
    applyRows: engine.applyRows,
    baselineById: engine.getBaselineById(),
    canRedo: meta.canRedo,
    canUndo: meta.canUndo,
    cellErrorCount: meta.cellErrorCount,
    conflictCount: meta.conflictCount,
    deleteRows: engine.deleteRows,
    dirtyByRow: engine.getDirtyByRow(),
    dirtyCount: meta.dirtyCount,
    derivedVersion: meta.derivedVersion,
    dirtyStore: engine.dirtyStore,
    draftById: engine.getDraftById(),
    engine,
    invalidCount: meta.invalidCount,
    orderConflict: meta.orderConflict,
    invalidRowKeys: engine.getInvalidRowKeys(),
    prepareCommit: engine.prepareCommit,
    markCommitted: engine.markCommitted,
    redo: engine.redo,
    removeRows: engine.removeRows,
    resolveConflict: engine.resolveConflict,
    resolveOrderConflict: engine.resolveOrderConflict,
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
