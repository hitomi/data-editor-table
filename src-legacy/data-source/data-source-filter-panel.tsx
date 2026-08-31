import { useMemo, useState, type FormEvent } from 'react'

import type { DataGridCellFilter } from './cell-type-registry.js'
import type { DataGridColumnFilterGroup, DataGridFilterCondition } from './data-source.js'

export type DataSourceFilterPanelMessages = {
  addCondition: string
  all: string
  any: string
  apply: string
  cancel: string
  clear: string
  match: string
  removeCondition: string
  title: (columnLabel: string) => string
  value: string
}

const DEFAULT_MESSAGES: DataSourceFilterPanelMessages = {
  addCondition: 'Add condition',
  all: 'All conditions',
  any: 'Any condition',
  apply: 'Apply filters',
  cancel: 'Cancel',
  clear: 'Clear filters',
  match: 'Match',
  removeCondition: 'Remove condition',
  title: (columnLabel) => `Filter ${columnLabel}`,
  value: 'Value',
}

export function DataSourceFilterPanel<Row>({
  columnKey,
  columnLabel,
  current,
  filter,
  messages = DEFAULT_MESSAGES,
  onApply,
  onCancel,
}: {
  columnKey: string
  columnLabel: string
  current?: DataGridColumnFilterGroup
  filter: DataGridCellFilter<Row, unknown>
  messages?: DataSourceFilterPanelMessages
  onApply: (group: DataGridColumnFilterGroup | null) => void
  onCancel: () => void
}) {
  const createCondition = (): DataGridFilterCondition => ({ operator: filter.defaultOperator, value: '' })
  const [match, setMatch] = useState<'all' | 'any'>(current?.match ?? 'all')
  const [conditions, setConditions] = useState<readonly DataGridFilterCondition[]>(
    current?.conditions.length ? current.conditions.map((condition) => ({ ...condition })) : [createCondition()],
  )
  const errors = useMemo(() => conditions.map((condition) => {
    const operator = filter.operators.find((candidate) => candidate.key === condition.operator)
    if (!operator) return 'This filter is no longer available.'
    if (operator.requiresValue && !condition.value.trim()) return 'Enter a value.'
    return operator.validate?.(condition.value) ?? null
  }), [conditions, filter.operators])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (errors.some(Boolean)) return
    onApply({ columnKey, match, conditions: conditions.map((condition) => ({ ...condition })) })
  }

  return <form aria-label={messages.title(columnLabel)} className="operational-data-grid-filter-panel" onSubmit={submit}>
    <strong>{messages.title(columnLabel)}</strong>
    <label>{messages.match}<select value={match} onChange={(event) => setMatch(event.target.value as 'all' | 'any')}>
      <option value="all">{messages.all}</option>
      <option value="any">{messages.any}</option>
    </select></label>
    <div className="operational-data-grid-filter-conditions">
      {conditions.map((condition, index) => {
        const operator = filter.operators.find((candidate) => candidate.key === condition.operator)
        return <div className="operational-data-grid-filter-condition" key={`${index}:${condition.operator}`}>
          <select aria-label={`Condition ${index + 1}`} value={condition.operator} onChange={(event) => setConditions((currentConditions) => currentConditions.map((candidate, candidateIndex) => candidateIndex === index ? { operator: event.target.value, value: '' } : candidate))}>
            {filter.operators.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
          </select>
          {operator?.requiresValue ? <label><span className="operational-data-grid-visually-hidden">{messages.value}</span><input aria-invalid={Boolean(errors[index])} aria-label={`${columnLabel} ${messages.value}`} inputMode={operator.inputMode ?? 'text'} value={condition.value} onChange={(event) => setConditions((currentConditions) => currentConditions.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, value: event.target.value } : candidate))} /></label> : <span />}
          <button aria-label={messages.removeCondition} disabled={conditions.length === 1} type="button" onClick={() => setConditions((currentConditions) => currentConditions.filter((_, candidateIndex) => candidateIndex !== index))}>×</button>
          {errors[index] ? <small role="alert">{errors[index]}</small> : null}
        </div>
      })}
    </div>
    <button type="button" onClick={() => setConditions((currentConditions) => [...currentConditions, createCondition()])}>{messages.addCondition}</button>
    <div className="operational-data-grid-filter-actions">
      <button type="button" onClick={() => onApply(null)}>{messages.clear}</button>
      <span />
      <button type="button" onClick={onCancel}>{messages.cancel}</button>
      <button type="submit" disabled={errors.some(Boolean)}>{messages.apply}</button>
    </div>
  </form>
}
