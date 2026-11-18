import { copyGridInput } from '../cell-types/input-codec.js'
import { areGridValuesEqual, invokeGridResult } from '../data/safe-callback.js'
import type { GridCompiledColumn, GridEditSession, GridPoint, GridRowKey, GridValueResult } from '../model/grid-model.js'

type ResolvedEditCell<Row> = Readonly<{
  row: Row
  column: GridCompiledColumn<Row>
  value: unknown
}>

export function beginGridEditSession<Row, RowKey extends GridRowKey>(
  resolved: ResolvedEditCell<Row>,
  target: GridPoint<RowKey>,
  sourceRevision: number,
  revision: number,
  identity: Pick<GridEditSession<RowKey>, 'id' | 'entityId'>,
): GridValueResult<GridEditSession<RowKey>> {
  const edit = resolved.column.behavior.edit
  if (!edit || !resolved.column.isEditable(resolved.row)) return {
    ok: false, issue: { code: 'edit-unavailable', message: 'This cell does not support editing.' },
  }
  const begun = invokeGridResult(() => ({ ok: true, value: copyGridInput(edit.begin(resolved.value, editContext(resolved)), edit.inputCodec) }))
  if (!begun.ok) return begun
  return { ok: true, value: Object.freeze({
    ...identity, revision, startedRevision: revision, sourceRevision,
    cell: Object.freeze({ ...target }), originalValue: resolved.value, draftValue: begun.value,
    status: 'editing', composing: false, error: null,
  }) }
}

export function gridEditSourceIssue<Row, RowKey extends GridRowKey>(
  session: GridEditSession<RowKey>, resolved: ResolvedEditCell<Row>, sourceRevision: number,
) {
  if (session.sourceRevision === sourceRevision || areGridValuesEqual(resolved.column, resolved.value, session.originalValue)) return null
  return { code: 'edit-source-changed', message: 'This cell changed remotely while it was being edited. Cancel or restart the edit.' }
}

/** Produces a value proposal, never a draft transaction or a closed editor. */
export function prepareGridEditValue<Row, RowKey extends GridRowKey>(
  session: GridEditSession<RowKey>,
  resolved: ResolvedEditCell<Row>,
  sourceRevision: number,
): GridValueResult<unknown> {
  const changed = gridEditSourceIssue(session, resolved, sourceRevision)
  if (changed) return { ok: false, issue: changed }
  const edit = resolved.column.behavior.edit
  if (!edit) return { ok: false, issue: { code: 'edit-unavailable', message: 'The edit target is unavailable.' } }
  return invokeGridResult(() => edit.commit(copyGridInput(session.draftValue, edit.inputCodec), editContext(resolved)))
}

export function invalidateGridEditSession<RowKey extends GridRowKey>(
  session: GridEditSession<RowKey>,
  reason: string,
  revision: number,
): GridEditSession<RowKey> {
  return Object.freeze({ ...session, revision, status: 'invalid', error: reason })
}

function editContext<Row>(resolved: ResolvedEditCell<Row>) {
  return Object.freeze({ row: resolved.row, columnKey: resolved.column.key, typeOptions: resolved.column.typeOptions })
}
