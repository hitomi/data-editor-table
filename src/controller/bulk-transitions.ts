import { copyGridInput } from '../cell-types/input-codec.js'
import { gridValueIssue, type GridIssue } from '../model/grid-result.js'
import { invokeGridCallback, invokeGridResult } from '../data/safe-callback.js'
import type { GridCellMutation } from '../data/command-planner.js'
import type { GridBulkSession, GridCompiledColumn, GridPoint, GridRowKey, GridTargetDependency, GridValueResult } from '../model/grid-model.js'

type Session<RowKey extends GridRowKey> = NonNullable<GridBulkSession<RowKey>>
type Resolved<Row, RowKey extends GridRowKey> = Readonly<{
  cell: GridPoint<RowKey>; row: Row; column: GridCompiledColumn<Row>; value: unknown
}>

export function beginGridBulkSession<Row, RowKey extends GridRowKey>(input: Readonly<{
  id: string
  capture: (cell: GridPoint<RowKey>) => GridTargetDependency<RowKey>
  column: GridCompiledColumn<Row>
  cells: readonly Resolved<Row, RowKey>[]
  revision: number
  maxMutations: number
}>): GridValueResult<Session<RowKey>> {
  const { column, cells, revision, maxMutations } = input
  const bulk = column.behavior.bulk
  if (!bulk || !column.bulkEditable) return rejected('This column does not support bulk editing.')
  if (!cells.length) return rejected('There are no bulk-editable cells.')
  if (cells.length > maxMutations) return rejected('This operation exceeds the mutation limit.', 'mutation-limit')
  const begun = invokeGridCallback(() => copyGridInput(bulk.begin(cells.map((cell) => cell.value), cells.map(context)), bulk.inputCodec))
  if (!begun.ok) return rejected(begun.message, 'exception')
  const targets = Object.freeze(cells.map(cell => input.capture(cell.cell)))
  return { ok: true, value: Object.freeze({
    id: input.id, revision, targets, columnKey: column.key, draft: begun.value, error: null,
  }) }
}

/** Returns one complete plan or a recoverable failure; never commits partial values. */
export function prepareGridBulkValues<Row, RowKey extends GridRowKey>(input: Readonly<{
  session: Session<RowKey>
  maxMutations: number
  resolveCell: (target: GridTargetDependency<RowKey>) => Resolved<Row, RowKey> | null
}>) {
  const { session, maxMutations, resolveCell } = input
  const reject = (issue: GridIssue, annotate = false) => ({
    ok: false as const, issue,
    session: annotate ? Object.freeze({ ...session, revision: session.revision + 1, error: issue.message }) : session,
  })
  if (session.targets.length > maxMutations)
    return reject({ code: 'limit-exceeded', message: 'This operation exceeds the mutation limit.' })
  const current = session.targets.map(resolveCell)
  const mutations: GridCellMutation<RowKey>[] = []
  for (const resolved of current) {
    const bulk = resolved?.column.behavior.bulk
    if (!resolved || !bulk || !resolved.column.isEditable(resolved.row))
      return reject({ code: 'stale-target', message: 'A target changed after this bulk edit opened. Your input is retained; cancel and review the current rows.' }, true)
  }
  for (const cell of current) {
    const resolved = cell!, bulk = resolved.column.behavior.bulk!
    const value = invokeGridResult(() => bulk.apply(resolved.value, copyGridInput(session.draft, bulk.inputCodec), context(resolved)))
    if (!value.ok) return reject(gridValueIssue(value.issue), true)
    mutations.push({ cell: resolved.cell, value: value.value })
  }
  return { ok: true as const, mutations: Object.freeze(mutations) }
}

function context<Row, RowKey extends GridRowKey>(cell: Resolved<Row, RowKey>) {
  return Object.freeze({ row: cell.row, columnKey: cell.column.key, typeOptions: cell.column.typeOptions })
}

function rejected(message: string, code = 'bulk-unavailable'): GridValueResult<never> {
  return { ok: false, issue: { code, message } }
}
