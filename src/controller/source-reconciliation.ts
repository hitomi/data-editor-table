import type { GridDataSourceSnapshot, GridReadyDataSourceSnapshot, GridRowKeyRemap } from '../data/data-source.js'
import { rebaseGridDraft } from '../data/rebase-draft.js'
import { replayDraftAfterCommit } from '../data/replay-after-commit.js'
import { collectRowValidationIssues } from '../data/row-invariants.js'
import { resolveGridCellValue } from '../data/runtime-cell-resolver.js'
import { areGridValuesEqual } from '../data/safe-callback.js'
import type { GridBulkSession, GridCompiledColumn, GridDraftState, GridEditSession, GridInteractionState, GridPoint, GridRange, GridRowKey } from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'

type DraftInputs<Row, RowKey extends GridRowKey> = Readonly<{
  draft: GridDraftState<Row, RowKey>
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  cloneRow?: (row: Row) => Row
}>

/** Translate every source-owned target together before reconciling the new view. */
export function remapGridAuthorityTargets<RowKey extends GridRowKey>(
  current: Readonly<{
    visibleRowKeys: readonly RowKey[]
    interaction: GridInteractionState<RowKey>
    edit: GridEditSession<RowKey> | null
    bulk: GridBulkSession<RowKey>
  }>,
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  return Object.freeze({
    visibleRowKeys: remapGridRowKeys(current.visibleRowKeys, remap),
    interaction: remapGridInteraction(current.interaction, remap),
    edit: remapGridEditSession(current.edit, remap),
    bulk: current.bulk ? Object.freeze({
      ...current.bulk,
      targetCells: Object.freeze(current.bulk.targetCells.map((target) => remapGridPoint(target, remap))),
      revision: current.bulk.revision + 1,
      error: 'Data changed while this bulk edit was open. Cancel it and start again.',
    }) : null,
  })
}

function remapGridRowKey<RowKey extends GridRowKey>(
  rowKey: RowKey,
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  return remap.find((item) => gridRowKeysEqual(item.from, rowKey))?.to ?? rowKey
}

function remapGridRowKeys<RowKey extends GridRowKey>(
  rowKeys: readonly RowKey[],
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  return remap.length === 0
    ? rowKeys
    : Object.freeze(rowKeys.map((rowKey) => remapGridRowKey(rowKey, remap)))
}

function remapGridPoint<RowKey extends GridRowKey>(
  point: GridPoint<RowKey>,
  remap: readonly GridRowKeyRemap<RowKey>[],
): GridPoint<RowKey> {
  if (remap.length === 0) return point
  const rowKey = remapGridRowKey(point.rowKey, remap)
  return gridRowKeysEqual(rowKey, point.rowKey)
    ? point
    : Object.freeze({ ...point, rowKey })
}

function remapGridInteraction<RowKey extends GridRowKey>(
  interaction: GridInteractionState<RowKey>,
  remap: readonly GridRowKeyRemap<RowKey>[],
): GridInteractionState<RowKey> {
  if (remap.length === 0) return interaction
  const range = (item: GridRange<RowKey>) => Object.freeze({
    anchor: remapGridPoint(item.anchor, remap),
    focus: remapGridPoint(item.focus, remap),
  })
  return Object.freeze({
    ...interaction,
    activeCell: interaction.activeCell
      ? remapGridPoint(interaction.activeCell, remap)
      : null,
    ranges: Object.freeze(interaction.ranges.map(range)),
    fillPreview: interaction.fillPreview ? range(interaction.fillPreview) : null,
    actionSession: interaction.actionSession
      ? Object.freeze({
          ...interaction.actionSession,
          target: remapGridPoint(interaction.actionSession.target, remap),
        })
      : null,
  })
}

function remapGridEditSession<RowKey extends GridRowKey>(
  session: GridEditSession<RowKey> | null,
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  if (!session || remap.length === 0) return session
  const cell = remapGridPoint(session.cell, remap)
  return cell === session.cell ? session : Object.freeze({ ...session, cell })
}

/** Authority changes reconcile intent and history; they are not local edits. */
export function rebaseGridAuthority<Row, RowKey extends GridRowKey>(
  input: DraftInputs<Row, RowKey> & Readonly<{ remote: GridDataSourceSnapshot<Row> }>,
): GridDraftState<Row, RowKey> {
  const { draft, remote, columns, getRowKey } = input
  const hasLocalState = draft.dirtyCells.length > 0 || draft.insertedRowKeys.length > 0
    || draft.deletedRowKeys.length > 0 || draft.orderDirty
    || draft.undoStack.length > 0 || draft.redoStack.length > 0
  if (hasLocalState) return rebaseGridDraft({
    draft, columns, getRowKey,
    remoteRows: remote.rows,
    remoteVersion: remote.version,
    ...(input.cloneRow ? { cloneRow: input.cloneRow } : {}),
  })
  const rows = Object.freeze([...remote.rows])
  return Object.freeze({
    revision: draft.revision + 1,
    baselineVersion: remote.version,
    baselineRows: rows,
    rows,
    dirtyCells: Object.freeze([]),
    validationIssues: collectRowValidationIssues(rows, columns, getRowKey),
    conflicts: Object.freeze([]),
    insertedRowKeys: Object.freeze([]),
    deletedRowKeys: Object.freeze([]),
    orderDirty: false,
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
  })
}

/** Acknowledge the original proposal, then replay later local work and authority. */
export function acknowledgeGridCommit<Row, RowKey extends GridRowKey>(
  input: DraftInputs<Row, RowKey> & Readonly<{
    applied: GridReadyDataSourceSnapshot<Row>
    latest: GridDataSourceSnapshot<Row>
    committedRows: readonly Row[]
    committedDraftRevision: number
    keyRemap: readonly GridRowKeyRemap<RowKey>[]
  }>,
): GridDraftState<Row, RowKey> {
  const { columns, getRowKey, applied, latest } = input
  const cloning = input.cloneRow ? { cloneRow: input.cloneRow } : {}
  const draft = replayDraftAfterCommit({
    current: input.draft,
    committedRows: input.committedRows,
    committedDraftRevision: input.committedDraftRevision,
    publishedRows: applied.rows,
    publishedVersion: applied.version,
    columns, getRowKey,
    keyRemap: input.keyRemap,
    ...cloning,
  })
  return Object.is(latest.version, applied.version) ? draft : rebaseGridDraft({
    draft, columns, getRowKey,
    remoteRows: latest.rows,
    remoteVersion: latest.version,
    ...cloning,
  })
}

/** Preserve recoverable editor input, returning a revision instead of mutating a counter. */
export function reconcileGridEditAfterAuthority<Row, RowKey extends GridRowKey>(input: Readonly<{
  session: GridEditSession<RowKey> | null
  rows: readonly Row[]
  columns: readonly GridCompiledColumn<Row>[]
  getRowKey: (row: Row) => RowKey
  sourceRevision: number
  editRevision: number
}>): Readonly<{ edit: GridEditSession<RowKey> | null; editRevision: number }> {
  const { session, rows, columns, getRowKey, sourceRevision, editRevision } = input
  if (!session) return { edit: null, editRevision }
  const position = rows.findIndex((row) => gridRowKeysEqual(getRowKey(row), session.cell.rowKey))
  const column = columns.find((candidate) => candidate.key === session.cell.columnKey)
  let error = 'This edit target was removed remotely. Cancel the edit to continue.'
  if (position >= 0 && column) {
    const resolved = resolveGridCellValue(rows[position] as Row, column)
    if (resolved.valid && areGridValuesEqual(column, resolved.value, session.originalValue)) return {
      edit: Object.freeze({ ...session, sourceRevision }), editRevision,
    }
    error = 'This cell changed remotely while it was being edited. Cancel or restart the edit.'
  }
  return {
    edit: Object.freeze({ ...session, revision: editRevision + 1, status: 'invalid', error }),
    editRevision: editRevision + 1,
  }
}
