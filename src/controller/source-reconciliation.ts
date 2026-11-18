import type { GridRowKeyRemap } from '../data/data-source.js'
import { resolveGridCellValue } from '../data/runtime-cell-resolver.js'
import { areGridValuesEqual } from '../data/safe-callback.js'
import type { GridBulkSession, GridCompiledColumn, GridEditSession, GridInteractionState, GridPoint, GridRange, GridRowKey } from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'

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
    bulk: current.bulk,
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

/** Preserve recoverable editor input, returning a revision instead of mutating a counter. */
export function reconcileGridEditAfterAuthority<Row, RowKey extends GridRowKey>(input: Readonly<{
  session: GridEditSession<RowKey> | null
  resolveRow: (session: GridEditSession<RowKey>) => Row | undefined
  columns: readonly GridCompiledColumn<Row>[]
  sourceRevision: number
  editRevision: number
}>): Readonly<{ edit: GridEditSession<RowKey> | null; editRevision: number }> {
  const { session, columns, resolveRow, sourceRevision, editRevision } = input
  if (!session) return { edit: null, editRevision }
  const row = resolveRow(session)
  const column = columns.find((candidate) => candidate.key === session.cell.columnKey)
  let error = 'This edit target was removed remotely. Cancel the edit to continue.'
  if (row !== undefined && column) {
    const resolved = resolveGridCellValue(row, column)
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
