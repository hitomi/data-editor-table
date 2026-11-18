import type { GridBulkSession, GridEditSession, GridFilterSession, GridPoint, GridRowKey } from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import type { GridIssue } from '../model/grid-result.js'

export type GridDraftCommandOwner<RowKey extends GridRowKey> =
  | Readonly<{ kind: 'external' }>
  | Readonly<{ kind: 'edit-commit'; cell: GridPoint<RowKey>; editRevision: number }>
  | Readonly<{ kind: 'bulk-apply'; bulkRevision: number }>
  | Readonly<{ kind: 'cell-effect'; cell: GridPoint<RowKey>; editRevision: number | null }>

type Sessions<RowKey extends GridRowKey> = Readonly<{
  edit: GridEditSession<RowKey> | null
  bulk: GridBulkSession<RowKey>
  filterSession: GridFilterSession
}>

export type GridSessionExitDecision =
  | Readonly<{ kind: 'allow' }>
  | Readonly<{ kind: 'commit-edit' }>
  | Readonly<{ kind: 'blocked'; reason: string }>

/** Policy decides; the workflow commits an editor only after an explicit decision. */
export function decideGridSessionExit<RowKey extends GridRowKey>(
  sessions: Sessions<RowKey>,
  action: string,
  explicitEdit: boolean,
): GridSessionExitDecision {
  if (sessions.bulk) return { kind: 'blocked', reason: `Apply or cancel the bulk edit before ${action}.` }
  if (sessions.filterSession) return { kind: 'blocked', reason: `Apply or cancel the filter edit before ${action}.` }
  if (!sessions.edit) return { kind: 'allow' }
  return explicitEdit
    ? { kind: 'blocked', reason: `Apply or cancel the cell edit before ${action}.` }
    : { kind: 'commit-edit' }
}

export function gridDraftSessionIssue<RowKey extends GridRowKey>(
  sessions: Sessions<RowKey>,
  editRevision: number,
  owner: GridDraftCommandOwner<RowKey>,
  action: string,
): GridIssue | null {
  if (sessions.bulk) {
    if (owner.kind === 'bulk-apply' && owner.bulkRevision === sessions.bulk.revision) return null
    return { code: 'session-open', message: `Apply or cancel the bulk edit before ${action}.` }
  }
  if (owner.kind === 'bulk-apply') return { code: 'stale-target', message: 'The bulk edit session is no longer current.' }
  if (sessions.filterSession) return { code: 'session-open', message: `Apply or cancel the filter edit before ${action}.` }
  if (sessions.edit) {
    const ownsEdit = (owner.kind === 'edit-commit' || owner.kind === 'cell-effect')
      && owner.editRevision === editRevision
      && gridRowKeysEqual(owner.cell.rowKey, sessions.edit.cell.rowKey)
      && owner.cell.columnKey === sessions.edit.cell.columnKey
    return ownsEdit ? null : { code: 'session-open', message: `Commit or cancel the cell edit before ${action}.` }
  }
  if (owner.kind === 'edit-commit') return { code: 'stale-target', message: 'The cell edit session is no longer current.' }
  if (owner.kind === 'cell-effect' && owner.editRevision !== null)
    return { code: 'stale-target', message: 'The cell effect no longer belongs to the current edit session.' }
  return null
}
