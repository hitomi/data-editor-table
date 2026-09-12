import type { OwnedInput } from '../kernel/model.js'
import type { WorkspaceTextCodec } from '../value-codecs.js'

type Catalog = NonNullable<WorkspaceTextCodec['choices']>
export type ChoiceBulkInput = Readonly<{ format: 'workspace-choice-bulk:1'; operation: 'keep' | 'replace' | 'add' | 'remove'; tokens: readonly string[] }>
export type ChoiceBulkMessages = Readonly<{ operation: string; keep: string; replace: string; add: string; remove: string; values: string; unavailable: string }>
export function readChoiceBulkInput(input: OwnedInput | null): ChoiceBulkInput | null {
  if (input?.kind !== 'encoded' || !input.value || typeof input.value !== 'object' || Array.isArray(input.value)) return null
  const value = input.value as Readonly<Record<string, unknown>>
  return value.format === 'workspace-choice-bulk:1' && typeof value.operation === 'string' && ['keep', 'replace', 'add', 'remove'].includes(value.operation)
    && Array.isArray(value.tokens) && value.tokens.every(token => typeof token === 'string') && new Set(value.tokens).size === value.tokens.length ? value as unknown as ChoiceBulkInput : null
}
function canonical(tokens: readonly string[], catalog: Catalog): readonly string[] {
  if (new Set(tokens).size !== tokens.length || tokens.some(token => !catalog.options.some(option => option.text === token))) throw new Error('Unknown or duplicate choice.')
  return catalog.options.filter(option => tokens.includes(option.text)).map(option => option.text)
}
export function beginChoiceBulk(values: readonly (readonly string[])[], catalog: Catalog): ChoiceBulkInput {
  const first = canonical(values[0] ?? [], catalog)
  const equal = values.every(value => JSON.stringify(canonical(value, catalog)) === JSON.stringify(first))
  return { format: 'workspace-choice-bulk:1', operation: equal ? 'replace' : 'keep', tokens: equal ? first : [] }
}
export function transformChoiceBulk(input: ChoiceBulkInput, current: readonly string[], catalog: Catalog, unavailable: string): readonly string[] {
  canonical(current, catalog); canonical(input.tokens, catalog)
  if (input.operation === 'keep') throw new Error('Choose a bulk operation.')
  if (input.operation !== 'remove' && input.tokens.some(token => catalog.options.some(option => option.text === token && option.disabled) && !current.includes(token))) throw new Error(unavailable)
  return canonical(input.operation === 'replace' ? input.tokens : input.operation === 'add' ? [...current, ...input.tokens.filter(token => !current.includes(token))] : current.filter(token => !input.tokens.includes(token)), catalog)
}
export function WorkspaceChoiceBulk({ input, catalog, messages, disabled, inputId, write }: Readonly<{
  input: ChoiceBulkInput; catalog: Catalog; messages: ChoiceBulkMessages; disabled: boolean; inputId: string; write(input: ChoiceBulkInput): void
}>) {
  return <div className="business-grid__workspace-bulk-fields">
    <label>{messages.operation}<select id={inputId} disabled={disabled} value={input.operation} onChange={event => write({ ...input, operation: event.currentTarget.value as ChoiceBulkInput['operation'] })}>
      <option value="keep" disabled>{messages.keep}</option><option value="replace">{messages.replace}</option><option value="add">{messages.add}</option><option value="remove">{messages.remove}</option>
    </select></label>
    <fieldset><legend>{messages.values}</legend>{catalog.options.map(option => <label key={option.text}><input type="checkbox" checked={input.tokens.includes(option.text)}
      disabled={disabled || !!option.disabled && input.operation !== 'remove' && !input.tokens.includes(option.text)} onChange={event => write({ ...input, tokens: canonical(event.currentTarget.checked ? [...input.tokens, option.text] : input.tokens.filter(token => token !== option.text), catalog) })} />{option.label}</label>)}</fieldset>
  </div>
}
