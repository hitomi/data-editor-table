import { useMemo, useState, type FormEvent, type ReactNode } from 'react'

import {
  isDataGridParseFailure,
  setDataGridFieldFromText,
  type DataGridFieldDefinition,
  type DataGridTagsBulkOperation,
} from './field-definition'
import { createDataGridTextTransform, type DataGridTextTransformMode } from './text-transform'

export type DataGridBulkSelection<Row> = {
  cellCount: number
  columnKey: string
  columnLabel: string
  hasMixedValues: boolean
  hasReadOnlyCells: boolean
  rows: readonly Row[]
}

export type DataGridBulkEditorMessages = {
  apply: (cellCount: number) => string
  cancel: string
  mixedValues: string
  readOnly: string
  title: (column: string, cellCount: number) => string
}

const DEFAULT_MESSAGES: DataGridBulkEditorMessages = {
  apply: (count) => `Apply to ${count} cells`,
  cancel: 'Cancel',
  mixedValues: 'The selection contains different values. Applying will replace them.',
  readOnly: 'The selection includes read-only cells.',
  title: (column, count) => `${column} · ${count} cells`,
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
  onApplyRowTransform: (transform: (row: Row, field: keyof Row) => Row) => void
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

  const textTransform = useMemo(() => createDataGridTextTransform({
    mode: textMode, value, prefix, suffix, find, replacement, useRegex,
  }), [find, prefix, replacement, suffix, textMode, useRegex, value])
  const error = field?.kind === 'text' && textMode !== 'set' ? textTransform.error : inputError
  const blocked = !field || !selection?.rows[0] || field.kind === 'readonly' || field.kind === 'image' || selection.hasReadOnlyCells

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
        const selected = parsed[0]
        if (!selected) return row
        const match = (candidate: string) => candidate.toLowerCase() === selected.toLowerCase()
        const next = tagsMode === 'add'
          ? current.some(match) ? current : [...current, selected]
          : current.filter((candidate) => !match(candidate))
        return field.setValue(row, field.normalize?.(next, row) ?? next)
      })
      return
    }
    const parsed = setDataGridFieldFromText(field, firstRow, value)
    if (isDataGridParseFailure(parsed)) return setInputError(parsed.error)
    onApplyRowTransform((row) => {
      const next = setDataGridFieldFromText(field, row, value)
      return isDataGridParseFailure(next) ? row : next
    })
  }

  return <form className="operational-data-grid-bulk-editor" role="dialog" aria-modal="true" aria-label={messages.title(selection?.columnLabel ?? field?.label ?? '', selection?.cellCount ?? 0)} onSubmit={submit}>
    <strong>{messages.title(selection?.columnLabel ?? field?.label ?? '', selection?.cellCount ?? 0)}</strong>
    {field?.kind === 'text' ? <label>Operation<select value={textMode} onChange={(event) => setTextMode(event.target.value as DataGridTextTransformMode)}><option value="set">Set value</option><option value="affix">Add prefix/suffix</option><option value="replace">Find and replace</option></select></label> : null}
    {field?.kind === 'tags' ? <label>Operation<select value={tagsMode} onChange={(event) => setTagsMode(event.target.value as DataGridTagsBulkOperation)}><option value="set">Set tags</option><option value="add">Add tag</option><option value="remove">Remove tag</option></select></label> : null}
    {field?.kind === 'text' && textMode === 'affix' ? <><label>Prefix<input value={prefix} onChange={(event) => setPrefix(event.target.value)} /></label><label>Suffix<input value={suffix} onChange={(event) => setSuffix(event.target.value)} /></label></> : field?.kind === 'text' && textMode === 'replace' ? <><label>Find<input value={find} onChange={(event) => setFind(event.target.value)} /></label><label className="operational-data-grid-checkbox"><input type="checkbox" checked={useRegex} onChange={(event) => setUseRegex(event.target.checked)} />Regular expression</label><label>Replace with<input value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label></> : <label>Value{field?.kind === 'select' ? <select value={value} onChange={(event) => setValue(event.target.value)}><option value="">Choose…</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input value={value} onChange={(event) => { setValue(event.target.value); setInputError(null) }} />}</label>}
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
