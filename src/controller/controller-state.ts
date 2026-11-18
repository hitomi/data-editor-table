import { resolveGridGeometry } from '../layout/grid-geometry.js'
import { projectGridPersistence } from './controller-persistence.js'
import { GridConfigurationError } from '../model/grid-result.js'
import { deriveLocalView } from '../data/local-view.js'
import { cloneGridRow } from '../data/safe-callback.js'
import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridCompiledColumn, GridControllerSnapshot, GridRowKey } from '../model/grid-model.js'
import { clearInteraction } from './selection-model.js'
import type { GridControllerOptions } from './controller-contracts.js'
import { assertGridKernelSource, type GridKernelDataSource } from '../data/kernel-data-source.js'
import { compileGridDocumentModel } from '../data/runtime-columns.js'
import { createKernelState } from '../kernel/state.js'
import type { WorkspaceId } from '../kernel/model.js'
import { createGridDataBackend } from './data-backend.js'
import { gridKernelPolicy } from './kernel-policy.js'
import { projectGridReadModel } from '../data/kernel-read-model.js'
import { initialGridControllerInternal } from './controller-protocol.js'


/** Preparation only. The new workflow will publish this internal state and its
 * derived old-UI snapshot in one Runtime transition. It does not subscribe or
 * start a second controller behind the existing demo. */
export function createInitialGridKernelData<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema>(
  source: GridKernelDataSource<Row, RowKey, Schema>,
  columns: readonly GridCompiledColumn<Row>[],
  workspaceId: WorkspaceId,
  allocate: () => string,
) {
  assertGridKernelSource(source.source, source.scope)
  const model = compileGridDocumentModel(source.model, columns, source.columns)
  const backend = createGridDataBackend(model, source.getRowKey, source.rows)
  const initial = createKernelState({ id: workspaceId, scope: source.scope, schema: model.schema.version, codec: model.codec.version },
    gridKernelPolicy(source.rows, allocate()), source.source.capabilities)
  const configured = backend.event(initial, { kind: 'save-schedule-configured', expectedToken: initial.schedule.token,
    options: { mode: source.persistence.mode === 'manual-save' ? 'manual' : source.persistence.mode === 'immediate' ? 'immediate' : 'debounced',
      debounceMs: source.persistence.mode === 'auto-save' ? source.persistence.debounceMs ?? 250 : 0 },
  })
  if (configured.result.kind !== 'accepted') throw new GridConfigurationError(
    configured.result.kind === 'ignored' ? configured.result.reason : configured.result.issue.message,
  )
  const data = configured.state
  const internal = initialGridControllerInternal<Row, RowKey>(data)
  return Object.freeze({ model, backend, internal, projection: backend.project(data) })
}

export function createInitialGridSnapshot<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
>(
  dataSource: GridKernelDataSource<Row, RowKey, Schema>,
  columns: readonly GridCompiledColumn<Row>[],
  sizes: { rowHeight: number; headerHeight: number; rowIndicatorWidth: number },
  kernel: ReturnType<typeof createInitialGridKernelData<Row, RowKey, Schema>>,
): GridControllerSnapshot<Row, RowKey> {
  const rows = kernel.projection.rows,
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
    activeEffectCount: 0,
    pendingEffects: Object.freeze([]),
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
      canRefresh: true,
    }),
    source: Object.freeze({
      revision: 0,
      status: 'loading',
      rows,
      version: '',
      scope: Object.freeze({ kind: 'complete' as const }),
      error: null,
    }),
    draft: projectGridReadModel(kernel.internal.data, kernel.projection, kernel.model, columns, dataSource.getRowKey),
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
    persistence: projectGridPersistence(kernel.internal.data, null, null),
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
    // Callers may pass a complete layout for its three live dimensions.
    // Project them explicitly so its previous viewport/scroll fields cannot
    // overwrite the current DOM measurement supplied above.
    rowHeight: sizes.rowHeight,
    headerHeight: sizes.headerHeight,
    rowIndicatorWidth: sizes.rowIndicatorWidth,
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
      throw new GridConfigurationError(`${name} must be finite and greater than zero.`)
    }
  }
  const limits = [
    ['maxMutations', options.maxMutations ?? 10_000],
    ['maxClipboardBytes', options.maxClipboardBytes ?? 2_000_000],
  ] as const
  for (const [name, value] of limits) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new GridConfigurationError(`${name} must be a positive safe integer.`)
    }
  }
}
