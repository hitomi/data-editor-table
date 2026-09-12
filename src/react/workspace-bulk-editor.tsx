import type { OwnedInput } from '../kernel/model.js'

export type WorkspaceBulkMessages = Readonly<{
  operation: string; set: string; affix: string; replace: string; value: string
  prefix: string; suffix: string; find: string; replacement: string; regex: string
  requiredFind: string; invalidRegex: string
}>
export type WorkspaceBulkInput = Readonly<{
  format: 'workspace-bulk:1'; operation: 'set' | 'affix' | 'replace'
  value: string; prefix: string; suffix: string; find: string; replacement: string; useRegex: boolean
}>
export const emptyBulkInput: WorkspaceBulkInput = Object.freeze({ format: 'workspace-bulk:1', operation: 'set', value: '', prefix: '', suffix: '', find: '', replacement: '', useRegex: false })
export function readBulkInput(input: OwnedInput | null): WorkspaceBulkInput | null {
  if (input?.kind !== 'encoded' || !input.value || typeof input.value !== 'object' || Array.isArray(input.value)) return null
  const value = input.value as Readonly<Record<string, unknown>>
  return value.format === 'workspace-bulk:1' && typeof value.operation === 'string' && ['set', 'affix', 'replace'].includes(value.operation)
    && ['value', 'prefix', 'suffix', 'find', 'replacement'].every(key => typeof value[key] === 'string') && typeof value.useRegex === 'boolean'
    ? value as unknown as WorkspaceBulkInput : null
}
export function transformBulkText(input: WorkspaceBulkInput, original: string, messages: Pick<WorkspaceBulkMessages, 'requiredFind' | 'invalidRegex'> = { requiredFind: 'Enter text to find.', invalidRegex: 'Enter a valid regular expression.' }): string {
  if (input.operation === 'set') return input.value
  if (input.operation === 'affix') return input.prefix + original + input.suffix
  if (!input.find) throw new Error(messages.requiredFind)
  if (!input.useRegex) return original.split(input.find).join(input.replacement)
  let pattern: RegExp
  try { pattern = new RegExp(input.find, 'g') } catch { throw new Error(messages.invalidRegex) }
  return original.replace(pattern, input.replacement)
}

/** All operation parameters are retained input; no React draft copy. */
export function WorkspaceBulkEditor({ input, write, disabled, inputId, messages }: Readonly<{
  messages: WorkspaceBulkMessages; input: WorkspaceBulkInput; write(input: WorkspaceBulkInput, composition?: 'idle' | 'composing'): void; disabled: boolean; inputId: string
}>) {
  const text = (key: 'value' | 'prefix' | 'suffix' | 'find' | 'replacement', label: string, first = false) => <label>{label}<input id={first ? inputId : undefined}
    value={input[key]} readOnly={disabled} onChange={event => write({ ...input, [key]: event.currentTarget.value }, (event.nativeEvent as InputEvent).isComposing ? 'composing' : 'idle')}
    onCompositionStart={event => write({ ...input, [key]: event.currentTarget.value }, 'composing')}
    onCompositionEnd={event => write({ ...input, [key]: event.currentTarget.value }, 'idle')} /></label>
  return <div className="business-grid__workspace-bulk-fields">
    <label>{messages.operation}<select disabled={disabled} value={input.operation} onChange={event => write({ ...input, operation: event.currentTarget.value as WorkspaceBulkInput['operation'] })}>
      <option value="set">{messages.set}</option><option value="affix">{messages.affix}</option><option value="replace">{messages.replace}</option>
    </select></label>
    {input.operation === 'set' ? text('value', messages.value, true) : input.operation === 'affix' ? <>{text('prefix', messages.prefix, true)}{text('suffix', messages.suffix)}</>
      : <>{text('find', messages.find, true)}{text('replacement', messages.replacement)}<label><input type="checkbox" checked={input.useRegex} disabled={disabled} onChange={event => write({ ...input, useRegex: event.currentTarget.checked })} />{messages.regex}</label></>}
  </div>
}
