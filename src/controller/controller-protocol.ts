import type { GridDataSourceSnapshot } from '../data/data-source.js'
import type { GridRowKey } from '../model/grid-model.js'
import { initialGridEffectOwnershipState, type GridActiveEffect, type GridEffectOwnershipState } from './effect-coordinator.js'
import type { GridCellEffectOperation, GridControllerEffectEvent, GridExternalEffectOperation } from './controller-effects.js'
import { initialGridPersistenceMachineState, type GridPersistenceMachineState } from './persistence-machine.js'
import type { GridPersistenceEffect, GridPersistenceEvent } from './persistence-effects.js'

export type GridControllerInternalState<Row, RowKey extends GridRowKey> = Readonly<{
  persistence: GridPersistenceMachineState<Row, RowKey>
  effects: GridEffectOwnershipState<RowKey>
  editRevision: number
  sequence: number
}>

export type GridControllerEvent<Row, RowKey extends GridRowKey, Effect> =
  | Readonly<{ type: 'effect/event'; event: GridControllerEffectEvent<Row, RowKey, Effect> }>
  | Readonly<{ type: 'source/published'; remote: GridDataSourceSnapshot<Row> }>
  | Readonly<{ type: 'source/failed'; error: string }>
  | Readonly<{ type: 'persistence/event'; event: GridPersistenceEvent<Row, RowKey> }>

export type GridControllerEffect<Row, RowKey extends GridRowKey, Effect> =
  | Readonly<{ type: 'cell/run'; operation: GridCellEffectOperation<Row, RowKey> }>
  | Readonly<{ type: 'external/run'; operation: GridExternalEffectOperation<RowKey, Effect> }>
  | Readonly<{ type: 'effect/cancel'; active: GridActiveEffect<RowKey> }>
  | Readonly<{ type: 'persistence/run'; effect: GridPersistenceEffect<Row, RowKey> }>

export type GridControllerSizes = Readonly<{ rowHeight: number; headerHeight: number; rowIndicatorWidth: number }>

export function initialGridControllerInternal<Row, RowKey extends GridRowKey>(): GridControllerInternalState<Row, RowKey> {
  return Object.freeze({
    persistence: initialGridPersistenceMachineState<Row, RowKey>(),
    effects: initialGridEffectOwnershipState<RowKey>(), editRevision: 0, sequence: 0,
  })
}
