import type { GridControllerSnapshot, GridRowKey } from '../model/grid-model.js'
import type { GridIssue } from '../model/grid-result.js'

export type GridCloseBlocker =
  | 'command-running'
  | 'unsaved-changes'
  | 'conflicts'
  | 'editing'
  | 'bulk-editing'
  | 'filter-editing'
  | 'running-effects'
  | 'retained-results'
  | 'unsettled-save'

export type GridCloseState =
  | Readonly<{ status: 'ready' | 'closed'; blockers: readonly [] }>
  | Readonly<{ status: 'blocked'; blockers: readonly [GridCloseBlocker, ...GridCloseBlocker[]] }>

export type GridCloseResult =
  | Readonly<{ status: 'closed' }>
  | Readonly<{ status: 'blocked'; blockers: readonly [GridCloseBlocker, ...GridCloseBlocker[]] }>
  | Readonly<{ status: 'cleanup-failed'; closed: true; issues: readonly [GridIssue, ...GridIssue[]] }>

/** View switches, detach cleanup and explicit disposal use the same blockers. */
export function gridCloseBlockers<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>, saveReserved: boolean): Exclude<GridCloseBlocker, 'command-running'>[] {
  const blockers: Exclude<GridCloseBlocker, 'command-running'>[] = []
  if (snapshot.draft.savePlan.canSave || snapshot.draft.dirtyCells.length > 0
    || snapshot.draft.insertedRowKeys.length > 0 || snapshot.draft.deletedRowKeys.length > 0
    || snapshot.draft.orderDirty) blockers.push('unsaved-changes')
  if (snapshot.draft.conflicts.length > 0 || snapshot.draft.orderConflict) blockers.push('conflicts')
  if (snapshot.edit !== null) blockers.push('editing')
  if (snapshot.bulk !== null) blockers.push('bulk-editing')
  if (snapshot.filterSession !== null) blockers.push('filter-editing')
  if (snapshot.activeEffectCount > 0) blockers.push('running-effects')
  if (snapshot.pendingEffects.length > 0) blockers.push('retained-results')
  if (saveReserved) blockers.push('unsettled-save')
  return blockers
}
