import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'

import {
  isDataGridParseFailure,
  setDataGridFieldFromText,
  type DataGridFieldDefinition,
  type DataGridTagsBulkOperation,
} from '../core/field-definition.js'
import { createDataGridTextTransform, type DataGridTextTransformMode } from '../core/text-transform.js'

export type DataGridBulkSelection<Row> = {
  cellCount: number
  columnKey: string
  columnLabel: string
  hasMixedValues: boolean
  hasReadOnlyCells: boolean
  rows: readonly Row[]
  /** Changes when the host starts a different editing selection. */
  sessionKey?: string | number
}

export type DataGridBulkEditorMessages = {
  apply: (cellCount: number) => string
  cancel: string
  mixedValues: string
  readOnly: string
  title: (column: string, cellCount: number) => string
  operation?: string
  setValue?: string
  affix?: string
  replace?: string
  value?: string
  prefix?: string
  suffix?: string
  find?: string
  regularExpression?: string
  replaceWith?: string
  choose?: string
}

const DEFAULT_MESSAGES: DataGridBulkEditorMessages = {
  apply: (count) => `Apply to ${count} cells`,
  cancel: 'Cancel',
  mixedValues: 'The selection contains different values. Applying will replace them.',
  readOnly: 'The selection includes read-only cells.',
  title: (column, count) => `${column} · ${count} cells`,
  operation: 'Operation', setValue: 'Set value', affix: 'Add prefix/suffix', replace: 'Find and replace',
  value: 'Value', prefix: 'Prefix', suffix: 'Suffix', find: 'Find', regularExpression: 'Regular expression',
  replaceWith: 'Replace with', choose: 'Choose…',
}

export function getDataGridBulkActionLabel<Row>(field: DataGridFieldDefinition<Row> | undefined) {
  if (field?.kind === 'tags') return `Edit ${field.bulkLabels?.noun ?? 'tags'}…`
  if (field?.kind === 'text') return 'Edit text…'
  return 'Set value…'
}

/**
 * Product-neutral bulk editor panel. Position it in the host's dialog/popover primitive;
 * the panel itself never dismisses on outside interaction and only calls onCancel explicitly.
 */
export function DataGridBulkEditor<Row>({
  field, footer, messages = DEFAULT_MESSAGES, onApplyRowTransform, onCancel, selection,
}: {
  field?: DataGridFieldDefinition<Row>
  footer?: ReactNode
  messages?: DataGridBulkEditorMessages
  onApplyRowTransform: (transform: (row: Row, field: string) => Row) => void
  onCancel: () => void
  selection: DataGridBulkSelection<Row> | null
}) {
  const [textMode, setTextMode] = useState<DataGridTextTransformMode>('set')
  const [tagsMode, setTagsMode] = useState<DataGridTagsBulkOperation>('set')
  const firstSelectedRow = selection?.rows[0]
  const [value, setValue] = useState(() => field && firstSelectedRow && !selection?.hasMixedValues ? editableValue(field, firstSelectedRow) : '')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [find, setFind] = useState('')
  const [replacement, setReplacement] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const textOperations = field?.kind === 'text'
    ? field.bulkOperations ?? ['set', 'affix', 'replace']
    : []
  const tagOperations = field?.kind === 'tags'
    ? field.bulkOperations ?? ['set', 'add', 'remove']
    : []
  const editorSessionKey = [
    field?.key ?? '',
    field?.kind ?? '',
    selection?.columnKey ?? '',
    selection?.sessionKey ?? '',
    ...textOperations,
    ...tagOperations,
  ].join('\u0000')

  useEffect(() => {
    const row = selection?.rows[0]
    setValue(field && row && !selection?.hasMixedValues ? editableValue(field, row) : '')
    setPrefix('')
    setSuffix('')
    setFind('')
    setReplacement('')
    setUseRegex(false)
    setInputError(null)
    setTextMode(textOperations[0] ?? 'set')
    setTagsMode(tagOperations[0] ?? 'set')
  }, [editorSessionKey])

  const textTransform = useMemo(() => createDataGridTextTransform({
    mode: textMode, value, prefix, suffix, find, replacement, useRegex,
  }), [find, prefix, replacement, suffix, textMode, useRegex, value])
  const error = field?.kind === 'text' && textMode !== 'set' ? textTransform.error : inputError
  const hasAllowedOperation = field?.kind === 'text'
    ? textOperations.length > 0
    : field?.kind === 'tags'
      ? tagOperations.length > 0
      : true
  const blocked = !field || !selection?.rows[0] || field.kind === 'readonly' || field.kind === 'image' || field.kind === 'custom' || !hasAllowedOperation || selection.hasReadOnlyCells

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const firstRow = selection?.rows[0]
    if (!field || !selection || !firstRow || blocked || error) return
    if (field.kind === 'text') {
      onApplyRowTransform((row) => field.setValue(row, textTransform.transform(field.getValue(row))))
      return
    }
    if (field.kind === 'tags') {
      onApplyRowTransform((row) => {
        const parsed = field.parseInput?.(value, row) ?? value.split(/\s*[、/,]\s*/).filter(Boolean)
        if (tagsMode === 'set') return field.setValue(row, field.normalize?.(parsed, row) ?? parsed)
        const current = field.getValue(row)
        const selected = new Map(parsed.map((candidate) => [candidate.toLowerCase(), candidate]))
        if (selected.size === 0) return row
        const next = tagsMode === 'add'
          ? [...current, ...[...selected].filter(([normalized]) => !current.some((candidate) => candidate.toLowerCase() === normalized)).map(([, candidate]) => candidate)]
          : current.filter((candidate) => !selected.has(candidate.toLowerCase()))
        return field.setValue(row, field.normalize?.(next, row) ?? next)
      })
      return
    }
    const parsedRows = new Map<Row, Row>()
    for (const row of selection.rows) {
      const parsed = setDataGridFieldFromText(field, row, value)
      if (isDataGridParseFailure(parsed)) return setInputError(parsed.error)
      parsedRows.set(row, parsed)
    }
    onApplyRowTransform((row) => {
      const parsed = parsedRows.get(row) ?? setDataGridFieldFromText(field, row, value)
      if (isDataGridParseFailure(parsed)) throw new Error(parsed.error)
      return parsed
    })
  }

  return <form className="operational-data-grid-bulk-editor" aria-label={messages.title(selection?.columnLabel ?? field?.label ?? '', selection?.cellCount ?? 0)} onSubmit={submit}>
    <strong>{messages.title(selection?.columnLabel ?? field?.label ?? '', selection?.cellCount ?? 0)}</strong>
    {field?.kind === 'text' ? <label>{messages.operation ?? 'Operation'}<select value={textMode} onChange={(event) => setTextMode(event.target.value as DataGridTextTransformMode)}>{textOperations.includes('set') ? <option value="set">{messages.setValue ?? 'Set value'}</option> : null}{textOperations.includes('affix') ? <option value="affix">{messages.affix ?? 'Add prefix/suffix'}</option> : null}{textOperations.includes('replace') ? <option value="replace">{messages.replace ?? 'Find and replace'}</option> : null}</select></label> : null}
    {field?.kind === 'tags' ? <label>{messages.operation ?? 'Operation'}<select value={tagsMode} onChange={(event) => setTagsMode(event.target.value as DataGridTagsBulkOperation)}>{tagOperations.includes('set') ? <option value="set">{field.bulkLabels?.set ?? messages.setValue ?? 'Set tags'}</option> : null}{tagOperations.includes('add') ? <option value="add">{field.bulkLabels?.add ?? 'Add tag'}</option> : null}{tagOperations.includes('remove') ? <option value="remove">{field.bulkLabels?.remove ?? 'Remove tag'}</option> : null}</select></label> : null}
    {field?.kind === 'text' && textMode === 'affix' ? <><label>{messages.prefix ?? 'Prefix'}<input value={prefix} onChange={(event) => setPrefix(event.target.value)} /></label><label>{messages.suffix ?? 'Suffix'}<input value={suffix} onChange={(event) => setSuffix(event.target.value)} /></label></> : field?.kind === 'text' && textMode === 'replace' ? <><label>{messages.find ?? 'Find'}<input value={find} onChange={(event) => setFind(event.target.value)} /></label><label className="operational-data-grid-checkbox"><input type="checkbox" checked={useRegex} onChange={(event) => setUseRegex(event.target.checked)} />{messages.regularExpression ?? 'Regular expression'}</label><label>{messages.replaceWith ?? 'Replace with'}<input value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label></> : <label>{messages.value ?? 'Value'}{field?.kind === 'select' ? <select value={value} onChange={(event) => setValue(event.target.value)}><option value="">{messages.choose ?? 'Choose…'}</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input value={value} onChange={(event) => { setValue(event.target.value); setInputError(null) }} />}</label>}
    {selection?.hasMixedValues ? <small>{messages.mixedValues}</small> : null}
    {selection?.hasReadOnlyCells ? <p role="alert">{messages.readOnly}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {footer}
    <div className="operational-data-grid-bulk-actions"><button type="button" onClick={onCancel}>{messages.cancel}</button><button type="submit" disabled={blocked || Boolean(error)}>{messages.apply(selection?.cellCount ?? 0)}</button></div>
  </form>
}

function editableValue<Row>(field: DataGridFieldDefinition<Row>, row: Row) {
  const value = field.getValue(row)
  if (Array.isArray(value)) return value.join(' / ')
  return value === null || value === undefined ? '' : String(value)
}
