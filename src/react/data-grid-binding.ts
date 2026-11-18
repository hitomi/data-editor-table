import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridCellTypeRegistry } from '../cell-types/registry.js'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import { createGridController, type GridController, type GridCloseResult, type GridEffectPort } from '../controller/grid-controller.js'
import type { GridKernelDataSource as GridDataSource } from '../data/kernel-data-source.js'
import type { DataEditorTableLocale } from '../locales/contracts.js'
import type { GridRowKey } from '../model/grid-model.js'

export type DataGridBinding<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema = StandardGridCellTypeSchema,
  Effect = never,
> = Readonly<{
  dataSource: GridDataSource<Row, RowKey, Schema>
  registry: GridCellTypeRegistry<Row, Schema>
  locale?: DataEditorTableLocale
  controller: GridController<Row, RowKey, Schema, Effect>
  destroy: () => GridCloseResult
}>

export type CreateDataGridBindingOptions<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema = StandardGridCellTypeSchema,
  Effect = never,
> = Readonly<{
  dataSource: GridDataSource<Row, RowKey, Schema>
  initial?: DataGridInitialOptions<Row, Schema>
  effects?: GridEffectPort<Row, RowKey, Effect>
}>

export type DataGridViewOptions = Readonly<{
  rowHeight?: number
  headerHeight?: number
  rowIndicatorWidth?: number
}>

export type DataGridInitialOptions<Row, Schema extends GridCellTypeSchema> = Readonly<{
  /** Defaults to createStandardCellTypeRegistry(). Required for custom cell type names. */
  registry?: GridCellTypeRegistry<Row, Schema>
  locale?: DataEditorTableLocale
  limits?: Readonly<{ maxMutations?: number; maxClipboardBytes?: number }>
}>

export function createDataGridBinding<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
>({
  dataSource,
  effects,
  initial = {},
}: CreateDataGridBindingOptions<Row, RowKey, Schema, Effect>): DataGridBinding<Row, RowKey, Schema, Effect> {
  const { registry, locale, limits = {} } = initial
  const { maxMutations, maxClipboardBytes } = limits
  const baseRegistry = registry ?? createStandardCellTypeRegistry<Row>()
  const resolvedLocale = locale ?? baseRegistry.locale
  const resolvedRegistry = baseRegistry.withLocale(resolvedLocale) as unknown as GridCellTypeRegistry<Row, Schema>
  const controller = createGridController<Row, RowKey, Schema, Effect>({
    dataSource,
    cellBehaviors: resolvedRegistry.behaviors,
    ...(effects === undefined ? {} : { effects }),
    ...(maxMutations === undefined ? {} : { maxMutations }),
    ...(maxClipboardBytes === undefined ? {} : { maxClipboardBytes }),
  })
  return Object.freeze({
    dataSource,
    registry: resolvedRegistry,
    ...(resolvedLocale === undefined ? {} : { locale: resolvedLocale }),
    controller,
    destroy: () => controller.destroy(),
  })
}
