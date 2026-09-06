import { resolveGridGeometry } from '../layout/grid-geometry.js'
import {
  assertCompleteDataSourceSnapshot,
  assertUniqueDataSourceRowKeys,
  type GridDataSource,
} from '../data/data-source.js'
import { deriveLocalView } from '../data/local-view.js'
import { collectRowValidationIssues } from '../data/row-invariants.js'
import { cloneGridRow } from '../data/safe-callback.js'
import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridCompiledColumn, GridControllerSnapshot, GridRowKey } from '../model/grid-model.js'
import { clearInteraction } from './selection-model.js'
import type { GridControllerOptions } from './controller-contracts.js'

export function createInitialGridSnapshot<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
>(
  dataSource: GridDataSource<Row, RowKey, Schema>,
  columns: readonly GridCompiledColumn<Row>[],
  sizes: { rowHeight: number; headerHeight: number; rowIndicatorWidth: number },
): GridControllerSnapshot<Row, RowKey> {
  const remote = dataSource.getSnapshot()
  assertCompleteDataSourceSnapshot(remote)
  assertUniqueDataSourceRowKeys(remote, dataSource.getRowKey)
  const rows = Object.freeze([...remote.rows]),
    view = deriveLocalView({
      rows,
      columns,
      getRowKey: dataSource.getRowKey,
      globalFilter: '',
      columnFilters: [],
      sort: [],
      revision: 0,
    })
  return Object.freeze({
    revision: 0,
    columns,
    getRowKey: dataSource.getRowKey,
    rowOperations: Object.freeze({
      canAdd: dataSource.rows?.create !== undefined,
      canDuplicate: dataSource.rows?.duplicate !== undefined,
      canOrder: dataSource.rows?.ordering === 'mutable',
      canDelete: dataSource.rows?.canDelete
        ? (row: Row) => {
            const cloned = cloneGridRow(row, dataSource.cloneRow)
            return cloned.ok
              ? dataSource.rows!.canDelete!(cloned.value)
              : false
          }
        : null,
    }),
    sourceOperations: Object.freeze({
      canRefresh: dataSource.refresh !== undefined,
    }),
    source: Object.freeze({
      revision: 0,
      status: remote.status,
      rows,
      version: remote.version,
      scope: Object.freeze({ kind: 'complete' as const }),
      error: remote.error ?? null,
    }),
    draft: Object.freeze({
      revision: 0,
      baselineVersion: remote.version,
      baselineRows: rows,
      rows,
      dirtyCells: Object.freeze([]),
      validationIssues: collectRowValidationIssues(rows, columns, dataSource.getRowKey),
      conflicts: Object.freeze([]),
      insertedRowKeys: Object.freeze([]),
      deletedRowKeys: Object.freeze([]),
      orderDirty: false,
      undoStack: Object.freeze([]),
      redoStack: Object.freeze([]),
    }),
    view,
    layout: resolveGridLayout(
      columns,
      view.visibleRowKeys.length,
      { viewportWidth: 0, viewportHeight: 0, scrollLeft: 0, scrollTop: 0 },
      sizes,
      0,
    ),
    interaction: clearInteraction<RowKey>(),
    edit: null,
    bulk: null,
    filterSession: null,
    persistence: Object.freeze({
      revision: 0,
      mode: dataSource.persistence.mode,
      status: 'idle',
      inFlightOperationId: null,
      pendingDraftRevision: null,
      error: null,
      retryOperationId: null,
    }),
    feedback: Object.freeze({ revision: 0, items: Object.freeze([]) }),
  })
}
export function resolveGridLayout<Row>(
  columns: readonly GridCompiledColumn<Row>[],
  count: number,
  viewport: {
    viewportWidth: number
    viewportHeight: number
    scrollLeft: number
    scrollTop: number
  },
  sizes: { rowHeight: number; headerHeight: number; rowIndicatorWidth: number },
  revision: number,
) {
  const geometryColumns = columns.map((column) => ({
    key: column.key,
    label: column.label,
    type: column.type,
    layout: column.layout,
    getValue: column.getValue,
  }))
  const value = resolveGridGeometry({
    columns: geometryColumns,
    visibleRowCount: count,
    viewportWidth: viewport.viewportWidth,
    viewportHeight: viewport.viewportHeight,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
    ...sizes,
  })
  return Object.freeze({
    revision,
    viewportWidth: value.viewportWidth,
    viewportHeight: value.viewportHeight,
    scrollLeft: value.scrollLeft,
    scrollTop: value.scrollTop,
    rowHeight: value.rowHeight,
    headerHeight: value.headerHeight,
    rowIndicatorWidth: value.rowIndicatorWidth,
    contentWidth: value.contentWidth,
    contentHeight: value.contentHeight,
    columns: value.columns,
  })
}

export function validateControllerOptions<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>(options: GridControllerOptions<Row, RowKey, Schema, Effect>) {
  const dimensions = [
    ['rowHeight', options.rowHeight ?? 36],
    ['headerHeight', options.headerHeight ?? 36],
    ['rowIndicatorWidth', options.rowIndicatorWidth ?? 48],
  ] as const
  for (const [name, value] of dimensions) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be finite and greater than zero.`)
    }
  }
  const limits = [
    ['maxMutations', options.maxMutations ?? 10_000],
    ['maxClipboardBytes', options.maxClipboardBytes ?? 2_000_000],
  ] as const
  for (const [name, value] of limits) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`)
    }
  }
}
