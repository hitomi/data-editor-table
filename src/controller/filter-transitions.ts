import { invokeGridResult } from '../data/safe-callback.js'
import type { GridColumnFilter, GridCompiledColumn, GridFilterSession, GridValueResult } from '../model/grid-model.js'

type Session = NonNullable<GridFilterSession>
export type GridFilterSessionChange =
  | Readonly<{ type: 'change'; index: number; operator: string | undefined; value: unknown; combine: 'all' | 'any' | undefined }>
  | Readonly<{ type: 'add'; defaultOperator: string }>
  | Readonly<{ type: 'remove'; index: number }>

export function beginGridFilterSession<Row>(
  column: GridCompiledColumn<Row> | undefined,
  filters: readonly GridColumnFilter[],
  revision: number,
): GridValueResult<Session> {
  const filter = column?.behavior.filter
  if (!column || !filter || !column.filterable) return unavailable('This column does not support filtering.')
  const current = filters.filter((candidate) => candidate.columnKey === column.key)
  return { ok: true, value: Object.freeze({
    revision, columnKey: column.key,
    conditions: Object.freeze(current.length > 0
      ? current.map(({ operator, value }) => Object.freeze({ operator, value }))
      : [Object.freeze({ operator: filter.defaultOperator, value: '' })]),
    combine: current[0]?.combine ?? 'all', error: null,
  }) }
}

export function changeGridFilterSession(session: GridFilterSession, change: GridFilterSessionChange): GridValueResult<Session> {
  if (!session || (change.type !== 'add' && !session.conditions[change.index]))
    return unavailable(change.type === 'add' ? 'There is no active filter session.' : 'The filter condition is unavailable.')
  let conditions = session.conditions
  let combine = session.combine
  switch (change.type) {
    case 'add': conditions = Object.freeze([...conditions, Object.freeze({ operator: change.defaultOperator, value: '' })]); break
    case 'remove': conditions = Object.freeze(conditions.filter((_, index) => index !== change.index)); break
    case 'change':
      conditions = Object.freeze(conditions.map((condition, index) => index === change.index ? Object.freeze({
        operator: change.operator ?? condition.operator,
        value: change.value === undefined ? condition.value : change.value,
      }) : condition))
      combine = change.combine ?? combine
  }
  return { ok: true, value: Object.freeze({ ...session, revision: session.revision + 1, conditions, combine, error: null }) }
}

/** Validate/normalize conditions while retaining input on failure; applying the query is a workflow. */
export function prepareGridFilterApply<Row>(
  session: GridFilterSession,
  column: GridCompiledColumn<Row> | undefined,
  current: readonly GridColumnFilter[],
) {
  const reject = (reason: string, next = session) => ({ ok: false as const, reason, session: next })
  if (!session) return reject('There is no active filter session.')
  const filter = column?.behavior.filter
  if (!filter) return reject('The filter is unavailable.')
  const next: GridColumnFilter[] = []
  for (const condition of session.conditions) {
    const operator = filter.operators.find((candidate) => candidate.id === condition.operator)
    if (!operator) return reject('The filter operator is unavailable.')
    const value = operator.validate ? invokeGridResult(() => operator.validate!(condition.value)) : undefined
    if (value && !value.ok) return reject(value.issue.message, Object.freeze({
      ...session, revision: session.revision + 1, error: value.issue.message,
    }))
    next.push({ columnKey: session.columnKey, operator: condition.operator, value: value?.ok ? value.value : condition.value, combine: session.combine })
  }
  return { ok: true as const, filters: Object.freeze([
    ...current.filter((candidate) => candidate.columnKey !== session.columnKey), ...next,
  ]) }
}

function unavailable(message: string): GridValueResult<never> {
  return { ok: false, issue: { code: 'filter-unavailable', message } }
}
