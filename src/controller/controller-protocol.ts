import type { ScopeDisputeEvent } from '../kernel/gateway.js'
import type { AuthorityFrontier, WorkspaceId } from '../kernel/model.js'
import type { ServerAuthority } from '../kernel/source.js'
import type { GridRowKey } from '../model/grid-model.js'
import { initialGridEffectOwnershipState, type GridActiveEffect, type GridEffectOwnershipState } from './effect-coordinator.js'
import type { GridCellEffectOperation, GridControllerEffectEvent, GridExternalEffectOperation } from './controller-effects.js'

import type { GridKernelPersistenceEffect, GridKernelPersistenceEvent } from './kernel-persistence-effects.js'
import type { GridEffectInput, GridEffectPort } from './controller-contracts.js'
import type { KernelState } from '../kernel/state.js'
import type { GridSaveAttempt, GridPersistenceCompletion, GridSaveFeedback } from './controller-persistence.js'

/** The Runtime owns one kernel, together with the original UI/effect state. */
export type GridControllerInternalState<Row, RowKey extends GridRowKey> = Readonly<{
  data: KernelState
  effects: GridEffectOwnershipState<RowKey>
  editRevision: number
  sequence: number
  saveFeedback: GridSaveFeedback | null
  saveAttempt: GridSaveAttempt | null
  saveReadTicket: string | null
  refreshTicket: string | null
  retainedEffects: readonly GridControllerEffectEvent<Row, RowKey, unknown>[]
}>

export type GridControllerEvent<Row, RowKey extends GridRowKey, Effect> =
  | Readonly<{ type: 'effect/event'; event: GridControllerEffectEvent<Row, RowKey, Effect> }>
  | Readonly<{ type: 'source/required'; frontier: AuthorityFrontier; origin?: WorkspaceId }>
  | Readonly<{ type: 'source/dispute'; event: ScopeDisputeEvent }>
  | Readonly<{ type: 'source/published'; remote: ServerAuthority }>
  | Readonly<{ type: 'source/failed'; error: string }>
  | Readonly<{ type: 'persistence/event'; event: GridKernelPersistenceEvent }>

export type GridControllerEffect<Row, RowKey extends GridRowKey, Effect> =
  | Readonly<{ type: 'cell/run'; operation: GridCellEffectOperation<Row, RowKey> }>
  | Readonly<{ type: 'external/run'; operation: GridExternalEffectOperation<RowKey, Effect>; port: GridEffectPort<Row, RowKey, Effect>; cells: readonly GridEffectInput<Row, RowKey>[] }>
  | Readonly<{ type: 'effect/cancel'; active: GridActiveEffect<RowKey> }>
  | Readonly<{ type: 'persistence/run'; effect: GridKernelPersistenceEffect }>
  | GridPersistenceCompletion

export type GridControllerSizes = Readonly<{ rowHeight: number; headerHeight: number; rowIndicatorWidth: number }>

export function initialGridControllerInternal<Row, RowKey extends GridRowKey>(data: KernelState): GridControllerInternalState<Row, RowKey> {
  return Object.freeze({ data, effects: initialGridEffectOwnershipState<RowKey>(), editRevision: 0, sequence: 0, saveFeedback: null,
    saveAttempt: null, saveReadTicket: null, refreshTicket: null, retainedEffects: Object.freeze([]) })
}
