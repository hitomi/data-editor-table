import { canonicalEncodedValue, ownEncodedValue } from './kernel/document.js'
import type { EncodedValue, FieldId, ViewPredicate } from './kernel/model.js'
import { createIsoDateCodec, createNumberCodec, type WorkspaceTextCodec } from './value-codecs.js'

export type FilterOperator = 'contains' | 'not-contains' | 'equals' | 'not-equals' | 'greater-than' | 'greater-than-or-equal'
  | 'less-than' | 'less-than-or-equal' | 'on' | 'not-on' | 'before' | 'after' | 'is-empty' | 'is-not-empty' | 'has-image'
export type FilterDraft = Readonly<{ format: 'workspace-filter:1'; combine: 'all' | 'any'; conditions: readonly Readonly<{ operator: FilterOperator; value: string }>[] }>
export type FilterConditionMessages = Readonly<{
  operators: Readonly<Record<FilterOperator, string>>
  title(label: string): string; fieldLabel(label: string): string
  locale: string; trueLabel: string; falseLabel: string
  none: string; match: string; all: string; any: string; add: string; clear: string; choose: string; required: string; invalidNumber: string; invalidDate: string
  condition(index: number): string; value(label: string, index: number): string; remove(index: number): string
}>
export type WorkspaceFilterCodec = Readonly<{
  format(predicate: ViewPredicate | null): string
  parse(text: string): Readonly<{ kind: 'valid'; predicate: ViewPredicate | null }> | Readonly<{ kind: 'invalid'; message: string }>
  conditions?: Readonly<{
    operators: readonly Readonly<{ id: FilterOperator; label: string; requiresValue: boolean }>[]
    initial: FilterDraft
    inputKind: 'text' | 'date'
    options?: readonly Readonly<{ text: string; label: string }>[]
    read(text: string): FilterDraft | null
  }>
}>

/** The retained draft is encoded input. Compiling it produces only storage-field
 * expressions, so recovery and future source reads never depend on React or a
 * snapshot of the currently matching rows. */
export function createStandardFilterCodec(fieldId: FieldId, codec: WorkspaceTextCodec, messages: FilterConditionMessages,
  options: Readonly<{ locale?: string; image?: boolean }> = {}): WorkspaceFilterCodec | null {
  const kind = options.image ? 'image' : codec.inputKind === 'boolean' ? 'boolean' : codec.choices ? codec.choices.multiple ? 'multi' : 'choice' : codec.inputKind
  if (!kind) return null
  const locale = new Intl.Collator(options.locale ?? messages.locale).resolvedOptions().locale
  const operators: readonly FilterOperator[] = kind === 'text' ? ['contains', 'not-contains', 'equals', 'not-equals', 'is-empty', 'is-not-empty']
    : kind === 'number' ? ['equals', 'not-equals', 'greater-than', 'greater-than-or-equal', 'less-than', 'less-than-or-equal', 'is-empty', 'is-not-empty']
    : kind === 'date' ? ['on', 'not-on', 'before', 'after', 'is-empty', 'is-not-empty']
    : kind === 'image' ? ['has-image', 'is-empty'] : kind === 'multi' ? ['contains', 'not-contains', 'is-empty', 'is-not-empty']
    : kind === 'boolean' ? ['equals', 'not-equals'] : ['equals', 'not-equals', 'is-empty', 'is-not-empty']
  const choices = codec.choices?.options ?? (kind === 'boolean' ? [{ text: 'true', label: messages.trueLabel }, { text: 'false', label: messages.falseLabel }] : undefined)
  const operand = kind === 'number' ? createNumberCodec({ invalid: messages.invalidNumber })
    : kind === 'date' ? createIsoDateCodec({ invalid: messages.invalidDate }) : null
  const requiresValue = (operator: FilterOperator) => !['is-empty', 'is-not-empty', 'has-image'].includes(operator)
  const initial: FilterDraft = Object.freeze({ format: 'workspace-filter:1', combine: 'all', conditions: Object.freeze([{ operator: operators[0]!, value: '' }]) })
  const compare = (operator: Extract<ViewPredicate, { kind: 'compare' }>['operator'], value: EncodedValue): ViewPredicate => ({ kind: 'compare', fieldId, operator, value,
    ...(['text-contains', 'text-equals'].includes(operator) ? { locale } : {}) })
  const not = (predicate: ViewPredicate): ViewPredicate => ({ kind: 'not', predicate })
  const empty: ViewPredicate = { kind: 'any', predicates: [{ kind: 'missing', fieldId }, compare('equals', null),
    ...(kind === 'text' ? [compare('equals', '')] : kind === 'multi' ? [compare('equals', [])] : [])] }
  function compile(condition: FilterDraft['conditions'][number]): ViewPredicate {
    if (!operators.includes(condition.operator)) throw new Error(messages.required)
    if (!requiresValue(condition.operator)) return condition.operator === 'is-empty' ? empty : not(empty)
    const text = condition.value
    if (!text.trim()) throw new Error(messages.required)
    let value: EncodedValue = text
    if (operand) {
      const parsed = operand.parse(text.trim())
      if (parsed.kind === 'invalid') throw new Error(parsed.message)
      if (parsed.value.kind !== 'value') throw new Error(messages.required)
      value = parsed.value.value
    } else if (kind === 'choice' || kind === 'multi' || kind === 'boolean') {
      if (!choices?.some(option => option.text === text)) throw new Error(messages.required)
      value = ownEncodedValue(JSON.parse(text))
    }
    switch (condition.operator) {
      case 'contains': case 'not-contains': {
        const predicate = compare(kind === 'multi' ? 'includes' : 'text-contains', value)
        return condition.operator === 'contains' ? predicate : not(predicate)
      }
      case 'equals': case 'not-equals': case 'on': case 'not-on': {
        const predicate = compare(kind === 'text' ? 'text-equals' : 'equals', value)
        return condition.operator === 'equals' || condition.operator === 'on' ? predicate : not(predicate)
      }
      case 'greater-than': case 'after': return compare('greater-than', value)
      case 'less-than': case 'before': return compare('less-than', value)
      case 'greater-than-or-equal': case 'less-than-or-equal': return { kind: 'any', predicates: [compare(condition.operator === 'greater-than-or-equal' ? 'greater-than' : 'less-than', value), compare('equals', value)] }
      default: throw new Error(messages.required)
    }
  }
  function read(text: string): FilterDraft | null {
    try {
      const raw: unknown = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const value = raw as Record<string, unknown>
      if (value.format !== 'workspace-filter:1' || (value.combine !== 'all' && value.combine !== 'any') || !Array.isArray(value.conditions)
        || !value.conditions.every(condition => condition && typeof condition === 'object' && operators.includes(condition.operator) && typeof condition.value === 'string')) return null
      return raw as FilterDraft
    } catch { return null }
  }
  function decompile(predicate: ViewPredicate): FilterDraft['conditions'][number] {
    const values: EncodedValue[] = []
    const visit = (value: ViewPredicate) => {
      if (value.kind === 'compare') values.push(value.value)
      else if (value.kind === 'not') visit(value.predicate)
      else if (value.kind === 'all' || value.kind === 'any') value.predicates.forEach(visit)
    }
    visit(predicate)
    const candidates = ['', ...values.flatMap(value => {
      try { return [kind === 'choice' || kind === 'multi' || kind === 'boolean' ? JSON.stringify(value) : operand ? operand.format({ kind: 'value', value }) : typeof value === 'string' ? value : ''] }
      catch { return [] }
    })]
    const key = canonicalEncodedValue(ownEncodedValue(predicate))
    for (const operator of operators) for (const value of candidates) {
      try { if (canonicalEncodedValue(ownEncodedValue(compile({ operator, value }))) === key) return { operator, value } }
      catch { /* Try the next complete representation; never approximate an existing query. */ }
    }
    throw new Error('This filter cannot be represented by the standard editor.')
  }
  return Object.freeze({
    conditions: Object.freeze({ operators: Object.freeze(operators.map(id => Object.freeze({ id, label: messages.operators[id], requiresValue: requiresValue(id) }))), initial,
      inputKind: kind === 'date' ? 'date' as const : 'text' as const, ...(choices ? { options: choices } : {}), read }),
    format(predicate: ViewPredicate | null) {
      if (!predicate) return JSON.stringify(initial)
      try {
        if (predicate.kind === 'any' && !predicate.predicates.length) throw new Error('An always-false query is not an empty draft.')
        if (predicate.kind !== 'all' && predicate.kind !== 'any') return JSON.stringify({ ...initial, conditions: [decompile(predicate)] })
        return JSON.stringify({ format: 'workspace-filter:1', combine: predicate.kind, conditions: predicate.predicates.map(decompile) })
      } catch { return JSON.stringify({ format: 'workspace-filter-unrepresented:1', predicate }) }
    },
    parse(text: string) {
      const draft = read(text)
      if (!draft) return { kind: 'invalid' as const, message: messages.required }
      try { return { kind: 'valid' as const, predicate: draft.conditions.length ? { kind: draft.combine, predicates: draft.conditions.map(compile) } : null } }
      catch (error) { return { kind: 'invalid' as const, message: error instanceof Error ? error.message : messages.required } }
    },
  })
}
