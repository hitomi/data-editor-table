import { invokeGridCallback, invokeGridResult } from '../data/safe-callback.js'
import type { GridCellMutation } from '../data/draft-transactions.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import type { GridBulkSession, GridCompiledColumn, GridPoint, GridRowKey, GridValueResult } from '../model/grid-model.js'

type Session<RowKey extends GridRowKey> = NonNullable<GridBulkSession<RowKey>>
type Resolved<Row, RowKey extends GridRowKey> = Readonly<{
  cell: GridPoint<RowKey>; row: Row; column: GridCompiledColumn<Row>; value: unknown
}>
type Revisions = Readonly<{ sourceRevision: number; draftRevision: number; viewRevision: number }>

export function beginGridBulkSession<Row, RowKey extends GridRowKey>(input: Readonly<{
  column: GridCompiledColumn<Row>
  cells: readonly Resolved<Row, RowKey>[]
  revisions: Revisions
  revision: number
  maxMutations: number
}>): GridValueResult<Session<RowKey>> {
  const { column, cells, revisions, revision, maxMutations } = input
  const bulk = column.behavior.bulk
  if (!bulk || !column.bulkEditable) return rejected('This column does not support bulk editing.')
  if (!cells.length) return rejected('There are no bulk-editable cells.')
  if (cells.length > maxMutations) return rejected('This operation exceeds the mutation limit.')
  const begun = invokeGridCallback(() => bulk.begin(cells.map((cell) => cell.value), cells.map(context)))
  if (!begun.ok) return rejected(begun.message)
  const targetCells = Object.freeze(cells.map((cell) => cell.cell))
  return { ok: true, value: Object.freeze({
    ...revisions, revision, targetCells, columnKey: column.key,
    selectionSignature: signature(targetCells), draft: begun.value, error: null,
  }) }
}

/** Returns one complete plan or a recoverable failure; never commits partial values. */
export function prepareGridBulkValues<Row, RowKey extends GridRowKey>(input: Readonly<{
  session: Session<RowKey>
  revisions: Revisions
  currentTargets: readonly GridPoint<RowKey>[]
  maxMutations: number
  resolveCell: (target: GridPoint<RowKey>) => Resolved<Row, RowKey> | null
}>) {
  const { session, revisions, currentTargets, maxMutations, resolveCell } = input
  const reject = (reason: string, annotate = false) => ({
    ok: false as const, reason,
    session: annotate ? Object.freeze({ ...session, revision: session.revision + 1, error: reason }) : session,
  })
  if (session.sourceRevision !== revisions.sourceRevision || session.draftRevision !== revisions.draftRevision
    || session.viewRevision !== revisions.viewRevision || session.selectionSignature !== signature(currentTargets))
    return reject('The data or selection changed after this bulk edit opened. Cancel it and start again.', true)
  if (new Set(session.targetCells.map(encodeCellIdentity)).size > maxMutations)
    return reject('This operation exceeds the mutation limit.')
  const mutations: GridCellMutation<RowKey>[] = []
  for (const target of session.targetCells) {
    const resolved = resolveCell(target)
    const bulk = resolved?.column.behavior.bulk
    if (!resolved || !bulk || !resolved.column.isEditable(resolved.row)) return reject('The bulk target changed.')
    const value = invokeGridResult(() => bulk.apply(resolved.value, session.draft, context(resolved)))
    if (!value.ok) return reject(value.issue.message, true)
    mutations.push({ cell: target, value: value.value })
  }
  return { ok: true as const, mutations: Object.freeze(mutations) }
}

function context<Row, RowKey extends GridRowKey>(cell: Resolved<Row, RowKey>) {
  return Object.freeze({ row: cell.row, columnKey: cell.column.key, typeOptions: cell.column.typeOptions })
}

function signature<RowKey extends GridRowKey>(cells: readonly GridPoint<RowKey>[]) {
  return cells.map(encodeCellIdentity).sort().join('\u0001')
}

function rejected(message: string): GridValueResult<never> {
  return { ok: false, issue: { code: 'bulk-unavailable', message } }
}
