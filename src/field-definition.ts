import type { GridRowKey as Key } from './types'

export type DataGridOption<Value extends string = string> = {
  label: string
  value: Value
}

export type DataGridValidationResult =
  | { valid: true }
  | { valid: false; message?: string }

export type DataGridParseFailure = {
  error: string
}

export type DataGridTextBulkOperation = 'set' | 'affix' | 'replace'
export type DataGridTagsBulkOperation = 'set' | 'add' | 'remove'

type DataGridFieldBase<Row, Value> = {
  key: string
  label: string
  getValue: (row: Row) => Value
  setValue: (row: Row, value: Value) => Row
  isEditable?: (row: Row) => boolean
  valuesEqual?: (left: Value, right: Value) => boolean
  formatClipboard?: (value: Value, row: Row) => string
  formatOriginalValue?: (value: Value, row: Row) => string
  clearValue?: (row: Row) => Row
  validate?: (value: Value, row: Row) => DataGridValidationResult
}

export type DataGridReadonlyField<Row> = Omit<
  DataGridFieldBase<Row, unknown>,
  'setValue'
> & {
  kind: 'readonly'
  setValue?: never
}

export type DataGridTextField<Row> = DataGridFieldBase<Row, string> & {
  kind: 'text'
  bulkOperations?: readonly DataGridTextBulkOperation[]
  inputMode?: 'text' | 'email' | 'search' | 'tel' | 'url'
}

export type DataGridNumberField<Row> = DataGridFieldBase<
  Row,
  string | number
> & {
  kind: 'number'
  bulkOperations?: readonly ['set']
  inputMode?: 'decimal' | 'numeric'
  parseInput: (
    value: string,
    row: Row,
  ) => string | number | DataGridParseFailure
}

export type DataGridSelectField<Row> = DataGridFieldBase<Row, string> & {
  kind: 'select'
  bulkOperations?: readonly ['set']
  options: readonly DataGridOption[]
}

export type DataGridTagsField<Row> = DataGridFieldBase<Row, string[]> & {
  kind: 'tags'
  bulkOperations?: readonly DataGridTagsBulkOperation[]
  bulkLabels?: {
    noun: string
    set: string
    add: string
    remove: string
    choose: string
  }
  options?: readonly DataGridOption[]
  parseInput?: (value: string, row: Row) => string[]
  normalize?: (values: string[], row: Row) => string[]
}

export type DataGridStagedImage<Uploaded = unknown> = {
  file: File
  previewUrl: string
  uploaded?: Uploaded
}

export type DataGridImageField<Row> = DataGridFieldBase<
  Row,
  string | null
> & {
  kind: 'image'
  accept?: string
  maxBytes?: number
}

export type DataGridCustomField<Row, Value = unknown> = DataGridFieldBase<Row, Value> & {
  kind: 'custom'
  type: string
}

export type DataGridFieldDefinition<Row> =
  | DataGridReadonlyField<Row>
  | DataGridTextField<Row>
  | DataGridNumberField<Row>
  | DataGridSelectField<Row>
  | DataGridTagsField<Row>
  | DataGridImageField<Row>
  | DataGridCustomField<Row>

export function createDataGridFieldRegistry<Row>(fields: readonly DataGridFieldDefinition<Row>[]) {
  return new Map(fields.map((field) => [field.key, field]))
}

export function isDataGridFieldEditable<Row>(field: DataGridFieldDefinition<Row>, row: Row) {
  return field.kind !== 'readonly' && (field.isEditable?.(row) ?? true)
}

export function shouldOpenDataGridEditorOnClick<Row>(field: DataGridFieldDefinition<Row> | undefined, row: Row) {
  return field?.kind === 'select' && isDataGridFieldEditable(field, row)
}

export function dataGridFieldValuesEqual<Row>(
  field: DataGridFieldDefinition<Row>,
  leftRow: Row,
  rightRow: Row,
) {
  const left = field.getValue(leftRow)
  const right = field.getValue(rightRow)
  if (field.valuesEqual) {
    return field.valuesEqual(left as never, right as never)
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    )
  }
  return Object.is(left, right)
}

export function formatDataGridOriginalValue<Row>(
  field: DataGridFieldDefinition<Row>,
  row: Row,
) {
  const value = field.getValue(row)
  if (field.formatOriginalValue) {
    return field.formatOriginalValue(value as never, row)
  }
  const formatted = (
    field.formatClipboard
      ? field.formatClipboard(value as never, row)
      : Array.isArray(value)
        ? value.join(' / ')
        : value === null || value === undefined
          ? ''
          : String(value)
  ).trim()
  return formatted || '空'
}

export function formatDataGridFieldValue<Row>(field: DataGridFieldDefinition<Row>, row: Row) {
  const value = field.getValue(row)
  if (field.formatClipboard) return field.formatClipboard(value as never, row)
  if (Array.isArray(value)) return value.join(' / ')
  return value === null || value === undefined ? '' : String(value)
}

export function setDataGridFieldFromText<Row>(field: DataGridFieldDefinition<Row>, row: Row, rawValue: string): Row | DataGridParseFailure {
  if (!isDataGridFieldEditable(field, row) || field.kind === 'readonly') return row
  if (field.kind === 'text') return field.setValue(row, rawValue)
  if (field.kind === 'number') {
    const parsed = field.parseInput(rawValue, row)
    return isDataGridParseFailure(parsed) ? parsed : field.setValue(row, parsed)
  }
  if (field.kind === 'select') {
    const option = field.options.find((candidate) => candidate.value === rawValue || candidate.label === rawValue)
    return option ? field.setValue(row, option.value) : row
  }
  if (field.kind === 'tags') {
    const parsed = field.parseInput?.(rawValue, row) ?? rawValue.split(/\s*[、/,]\s*/).filter(Boolean)
    return field.setValue(row, field.normalize?.(parsed, row) ?? parsed)
  }
  return row
}

export function clearDataGridField<Row>(field: DataGridFieldDefinition<Row>, row: Row) {
  if (!isDataGridFieldEditable(field, row) || field.kind === 'readonly') return row
  if (field.clearValue) return field.clearValue(row)
  if (field.kind === 'text') return field.setValue(row, '')
  if (field.kind === 'tags') return field.setValue(row, [])
  return row
}

export function isDataGridParseFailure(value: unknown): value is DataGridParseFailure {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
}

export type DataGridDirtyByRow<RowKey extends Key = Key> = ReadonlyMap<
  RowKey,
  ReadonlyMap<string, string>
>
