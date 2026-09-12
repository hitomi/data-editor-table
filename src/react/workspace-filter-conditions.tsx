import type { FilterConditionMessages, FilterDraft, WorkspaceFilterCodec } from '../filter-codecs.js'

/** Every change replaces the retained encoded draft through Workspace ingress. */
export function WorkspaceFilterConditions({ draft, definition, messages, label, inputId, disabled, write }: Readonly<{
  draft: FilterDraft; definition: NonNullable<WorkspaceFilterCodec['conditions']>; messages: FilterConditionMessages
  label: string; inputId: string; disabled: boolean; write(value: string, composition?: 'idle' | 'composing'): void
}>) {
  const update = (index: number, changes: Partial<FilterDraft['conditions'][number]>, composition: 'idle' | 'composing' = 'idle') =>
    write(JSON.stringify({ ...draft, conditions: draft.conditions.map((condition, position) => position === index ? { ...condition, ...changes } : condition) }), composition)
  return <div className="business-grid__filter-conditions">
    {draft.conditions.length > 1 ? <label>{messages.match}<select disabled={disabled} value={draft.combine} onChange={event => write(JSON.stringify({ ...draft, combine: event.currentTarget.value }))}>
      <option value="all">{messages.all}</option><option value="any">{messages.any}</option>
    </select></label> : null}
    {draft.conditions.map((condition, index) => <div key={index} className="business-grid__filter-condition">
      <select aria-label={messages.condition(index + 1)} disabled={disabled} value={condition.operator} onChange={event => update(index, { operator: event.currentTarget.value as typeof condition.operator })}>
        {definition.operators.map(operator => <option key={operator.id} value={operator.id}>{operator.label}</option>)}
      </select>
      {definition.operators.find(operator => operator.id === condition.operator)?.requiresValue ? definition.options
        ? <select id={index === 0 ? inputId : undefined} aria-label={messages.value(label, index + 1)} disabled={disabled} value={condition.value} onChange={event => update(index, { value: event.currentTarget.value })}>
          <option value="" disabled>{messages.choose}</option>{definition.options.map(option => <option key={option.text} value={option.text}>{option.label}</option>)}
        </select> : <input id={index === 0 ? inputId : undefined} aria-label={messages.value(label, index + 1)} type={definition.inputKind} readOnly={disabled} value={condition.value}
          onChange={event => update(index, { value: event.currentTarget.value }, (event.nativeEvent as InputEvent).isComposing ? 'composing' : 'idle')}
          onCompositionStart={event => update(index, { value: event.currentTarget.value }, 'composing')}
          onCompositionEnd={event => update(index, { value: event.currentTarget.value }, 'idle')} /> : null}
      {draft.conditions.length > 1 ? <button type="button" disabled={disabled} aria-label={messages.remove(index + 1)} onClick={() => write(JSON.stringify({ ...draft, conditions: draft.conditions.filter((_, position) => position !== index) }))}>×</button> : null}
    </div>)}
    <button type="button" disabled={disabled} onClick={() => write(JSON.stringify({ ...draft, conditions: [...draft.conditions, definition.initial.conditions[0]!] }))}>{messages.add}</button>
  </div>
}
