import { useEffect, useRef, type ReactNode } from 'react'
import type { RenderCellProps, RenderEditCellProps } from 'react-data-grid'

import type { DataGridCellAction } from './actions.js'
import { DataGridImageCell, revokeDataGridStagedImagePreviews, type DataGridImageCellMessages } from '../ui/image-cell.js'
import type { DataGridOption, DataGridParseFailure, DataGridStagedImage, DataGridTagsBulkOperation, DataGridTextBulkOperation } from '../core/field-definition.js'

export type DataGridBuiltinCellTypes = {
  number: number
  text: string
}

export type DataGridSourceField<Row, Value = unknown, Type extends string = string> = {
  key: string
  label: string
  type: Type
  getValue: (row: Row) => Value
  setValue?: (row: Row, value: Value) => Row
  isEditable?: (row: Row) => boolean
  valuesEqual?: (left: Value, right: Value) => boolean
  validate?: (value: Value, row: Row) => { valid: true } | { valid: false; message?: string }
  width?: number | string
  minWidth?: number
  maxWidth?: number
  filterable?: boolean
  bulkEditable?: boolean
  sortable?: boolean
  typeOptions?: unknown
}

export type DataGridSourceFieldForTypes<
  Row,
  CellTypes extends object,
> = {
  [Type in Extract<keyof CellTypes, string>]: DataGridSourceField<
    Row,
    CellTypes[Type],
    Type
  >
}[Extract<keyof CellTypes, string>]

export type DataGridCellTypeRenderProps<Row, Value = unknown> = {
  editable: boolean
  field: DataGridSourceField<Row, Value>
  row: Row
  value: Value
  update: (value: Value) => void
}

export type DataGridCellTypeEditorProps<Row, Value = unknown> = DataGridCellTypeRenderProps<Row, Value> & {
  close: (commit?: boolean) => void
}

export type DataGridCellTypeBulkBehavior<Row, Value> =
  | ([Value] extends [string] ? string extends Value ? {
      kind: 'text'
      operations?: readonly DataGridTextBulkOperation[]
    } : never : never)
  | ([Value] extends [number] ? number extends Value ? {
      kind: 'number'
      parseInput: (
        text: string,
        row: Row,
        field: DataGridSourceField<Row, Value>,
      ) => Value | DataGridParseFailure
    } : never : never)
  | ([Value] extends [string] ? string extends Value ? {
      kind: 'select'
      options: readonly DataGridOption[]
    } : never : never)
  | ([Value] extends [string[]] ? string[] extends Value ? {
      kind: 'tags'
      operations?: readonly DataGridTagsBulkOperation[]
      labels?: {
        noun: string
        set: string
        add: string
        remove: string
        choose: string
      }
      options?: readonly DataGridOption[]
      parseInput?: (text: string, row: Row, field: DataGridSourceField<Row, Value>) => string[]
      normalize?: (values: string[], row: Row, field: DataGridSourceField<Row, Value>) => string[]
    } : never : never)

export type DataGridCellFilterOperator<Row, Value> = {
  key: string
  label: string
  requiresValue: boolean
  inputMode?: 'text' | 'decimal' | 'numeric'
  validate?: (raw: string) => string | null
  matches: (
    value: Value,
    raw: string,
    row: Row,
    field: DataGridSourceField<Row, Value>,
  ) => boolean
}

export type DataGridCellFilter<Row, Value> = {
  defaultOperator: string
  operators: readonly DataGridCellFilterOperator<Row, Value>[]
}

export type DataGridCellFillContext<Row, Value> = {
  defaultValue: Value
  field: DataGridSourceField<Row, Value>
  sourceRows: readonly Row[]
  sourceStartIndex: number
  sourceValues: readonly Value[]
  targetIndex: number
  targetRow: Row
}

export type DataGridCellTypeRenderer<Row, Value = unknown> = {
  renderCell: (props: DataGridCellTypeRenderProps<Row, Value>) => ReactNode
  renderEditor?: (props: DataGridCellTypeEditorProps<Row, Value>) => ReactNode
  formatClipboard?: (value: Value, row: Row, field: DataGridSourceField<Row, Value>) => string
  parseClipboard?: (text: string, row: Row, field: DataGridSourceField<Row, Value>) => Value
  clearValue?: (row: Row, field: DataGridSourceField<Row, Value>) => Value
  /** Continue or override the default top-to-bottom repeating fill sequence. */
  fill?: (context: DataGridCellFillContext<Row, Value>) => Value
  /** Opts this cell type into the turnkey grid's bulk editor. */
  bulk?: DataGridCellTypeBulkBehavior<Row, Value>
  /** Product-neutral column filter semantics for this cell type. */
  filter?: DataGridCellFilter<Row, Value>
  actions?: readonly DataGridCellAction<Row, Value>[]
}

export type DataGridCellTypeRegistry<Row, CellTypes extends object = DataGridBuiltinCellTypes> = {
  get: <Type extends Extract<keyof CellTypes, string>>(
    type: Type,
  ) => DataGridCellTypeRenderer<Row, CellTypes[Type]> | undefined
  register: <Value, Type extends string = string>(
    type: Type,
    renderer: DataGridCellTypeRenderer<Row, Value>,
  ) => DataGridCellTypeRegistry<Row, CellTypes & Record<Type, Value>>
}

export function isDataGridSourceFieldEditable<Row, Value>(
  field: DataGridSourceField<Row, Value>,
  row: Row,
) {
  return Boolean(field.setValue) && (field.isEditable?.(row) ?? true)
}

export function updateDataGridSourceField<Row, Value>(
  field: DataGridSourceField<Row, Value>,
  row: Row,
  value: Value,
  onRowChange: (row: Row) => void,
) {
  if (!field.setValue || !isDataGridSourceFieldEditable(field, row)) return false
  onRowChange(field.setValue(row, value))
  return true
}

export function createDataGridCellTypeRegistry<Row>(): DataGridCellTypeRegistry<Row, {}> {
  const renderers = new Map<string, DataGridCellTypeRenderer<Row, unknown>>()
  const registry = {
    get: (type: string) => renderers.get(type),
    register(type, renderer) {
      if (!type.trim()) throw new Error('A cell type name is required.')
      if (renderers.has(type)) throw new Error(`Cell type "${type}" is already registered.`)
      renderers.set(type, renderer as DataGridCellTypeRenderer<Row, unknown>)
      return registry
    },
  } as DataGridCellTypeRegistry<Row, {}>
  return registry
}

export function registerDataGridBuiltinCellTypes<Row, CellTypes extends object>(
  registry: DataGridCellTypeRegistry<Row, CellTypes>,
) {
  const withText = registry.register<string, 'text'>('text', {
    bulk: { kind: 'text' },
    filter: {
      defaultOperator: 'contains',
      operators: [
        { key: 'contains', label: 'contains', requiresValue: true, matches: (value, raw) => value.toLocaleLowerCase().includes(raw.toLocaleLowerCase()) },
        { key: 'not-contains', label: 'does not contain', requiresValue: true, matches: (value, raw) => !value.toLocaleLowerCase().includes(raw.toLocaleLowerCase()) },
        { key: 'equals', label: 'equals', requiresValue: true, matches: (value, raw) => value.localeCompare(raw, undefined, { sensitivity: 'base' }) === 0 },
        { key: 'not-equals', label: 'does not equal', requiresValue: true, matches: (value, raw) => value.localeCompare(raw, undefined, { sensitivity: 'base' }) !== 0 },
        { key: 'is-empty', label: 'is empty', requiresValue: false, matches: (value) => value.length === 0 },
        { key: 'is-not-empty', label: 'is not empty', requiresValue: false, matches: (value) => value.length > 0 },
      ],
    },
    renderCell: ({ value }) => value,
    renderEditor: ({ value, update, close }) => <input
      autoFocus className="rdg-text-editor operational-data-grid-cell-editor" value={value ?? ''}
      onChange={(event) => update(event.target.value)}
      onBlur={() => close(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') close(true)
        if (event.key === 'Escape') close(false)
      }}
    />,
    formatClipboard: (value) => value,
    parseClipboard: (text) => text,
    clearValue: () => '',
    actions: [{ id: 'clear-text', label: 'Clear text', disabled: ({ value }) => value.length === 0, run: ({ update }) => update('') }],
  })
  return withText.register<number, 'number'>('number', {
    bulk: {
      kind: 'number',
      parseInput: (text) => {
        const value = Number(text)
        return text.trim() && Number.isFinite(value) ? value : { error: 'Enter a valid number.' }
      },
    },
    filter: {
      defaultOperator: 'equals',
      operators: [
        { key: 'equals', label: 'equals', requiresValue: true, inputMode: 'decimal', validate: validateFiniteNumberFilter, matches: (value, raw) => value === Number(raw) },
        { key: 'not-equals', label: 'does not equal', requiresValue: true, inputMode: 'decimal', validate: validateFiniteNumberFilter, matches: (value, raw) => value !== Number(raw) },
        { key: 'greater-than-or-equal', label: 'is at least', requiresValue: true, inputMode: 'decimal', validate: validateFiniteNumberFilter, matches: (value, raw) => value >= Number(raw) },
        { key: 'less-than-or-equal', label: 'is at most', requiresValue: true, inputMode: 'decimal', validate: validateFiniteNumberFilter, matches: (value, raw) => value <= Number(raw) },
      ],
    },
    renderCell: ({ value }) => String(value),
    fill: ({ defaultValue, sourceStartIndex, sourceValues, targetIndex }) => {
      if (sourceValues.length < 2) return defaultValue
      const first = sourceValues[0]
      const second = sourceValues[1]
      if (first === undefined || second === undefined) return defaultValue
      const step = second - first
      const isArithmetic = sourceValues.slice(2).every((value, index) => {
        const previous = sourceValues[index + 1]
        if (previous === undefined) return false
        const difference = value - previous
        const tolerance = Number.EPSILON * Math.max(1, Math.abs(step), Math.abs(difference)) * 8
        return Math.abs(difference - step) <= tolerance
      })
      return isArithmetic ? first + (targetIndex - sourceStartIndex) * step : defaultValue
    },
    renderEditor: ({ value, update, close }) => <input
      autoFocus className="rdg-text-editor operational-data-grid-cell-editor" type="number" value={Number.isFinite(value) ? value : 0}
      onChange={(event) => {
        const next = event.target.valueAsNumber
        if (Number.isFinite(next)) update(next)
      }}
      onBlur={() => close(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') close(true)
        if (event.key === 'Escape') close(false)
      }}
    />,
    formatClipboard: (value) => String(value),
    parseClipboard: (text) => {
      const value = Number(text)
      if (!text.trim() || !Number.isFinite(value)) throw new Error('Enter a valid number.')
      return value
    },
    clearValue: () => 0,
    actions: [{ id: 'reset-number', label: 'Reset to zero', disabled: ({ value }) => value === 0, run: ({ update }) => update(0) }],
  })
}

function validateFiniteNumberFilter(raw: string) {
  return raw.trim() && Number.isFinite(Number(raw)) ? null : 'Enter a valid number.'
}

export function renderRegisteredCell<Row, Value>(
  renderer: DataGridCellTypeRenderer<Row, Value>,
  field: DataGridSourceField<Row, Value>,
  props: RenderCellProps<Row>,
  updateValue?: (value: Value) => void,
) {
  const value = field.getValue(props.row)
  return renderer.renderCell({
    editable: isDataGridSourceFieldEditable(field, props.row), field, row: props.row, value,
    update: updateValue ?? ((next) => { updateDataGridSourceField(field, props.row, next, props.onRowChange) }),
  })
}

export function renderRegisteredEditor<Row, Value>(
  renderer: DataGridCellTypeRenderer<Row, Value>,
  field: DataGridSourceField<Row, Value>,
  props: RenderEditCellProps<Row>,
  getCurrentRow?: () => Row | undefined,
) {
  if (!renderer.renderEditor || !field.setValue) return null
  const value = field.getValue(props.row)
  return renderer.renderEditor({
    editable: isDataGridSourceFieldEditable(field, getCurrentRow?.() ?? props.row), field, row: props.row, value,
    update: (next) => {
      updateDataGridSourceField(field, getCurrentRow?.() ?? props.row, next, props.onRowChange)
    },
    close: (commit = true) => props.onClose(commit),
  })
}

export type DataGridImageTypeOptions<Row, Value> = {
  accept?: string
  alt: (row: Row, value: Value | null) => string
  emptyContent?: ReactNode
  label: (row: Row) => string
  maxBytes?: number
  messages?: DataGridImageCellMessages
  resolveSrc: (value: Value | null, row: Row) => string | null
  upload: (input: { file: File; row: Row; signal: AbortSignal }) => Promise<Value>
  onError?: (error: unknown, row: Row) => void
}

/** Image upload is an ordinary registered cell type, not a Grid special case. */
export function createDataGridImageCellTypeRenderer<Row, Value>(options: DataGridImageTypeOptions<Row, Value>): DataGridCellTypeRenderer<Row, Value | null> {
  return {
    renderCell: ({ editable, row, value, update }) => <RegisteredImageCell editable={editable} options={options} row={row} value={value} update={update} />,
    renderEditor: ({ close, editable, row, value, update }) => <RegisteredImageEditor close={close} editable={editable} options={options} row={row} value={value} update={update} />,
    formatClipboard: (value, row) => options.resolveSrc(value, row) ?? '',
    fill: ({ defaultValue }) => defaultValue,
    clearValue: () => null,
    actions: [{ id: 'remove-image', label: 'Remove image', destructive: true, disabled: ({ value }) => value === null, run: ({ update }) => update(null) }],
  }
}

function RegisteredImageEditor<Row, Value>({ close, editable, options, row, update, value }: {
  close: (commit?: boolean) => void
  editable: boolean
  options: DataGridImageTypeOptions<Row, Value>
  row: Row
  update: (value: Value | null) => void
  value: Value | null
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  useEffect(() => { editorRef.current?.focus({ preventScroll: true }) }, [])
  return <div
    ref={editorRef}
    className="operational-data-grid-image-editor"
    tabIndex={0}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close(false)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab' || event.key.startsWith('Arrow')) close(true)
    }}
  >
    <RegisteredImageCell
      editable={editable}
      options={options}
      row={row}
      value={value}
      update={(next) => {
        update(next)
        close(true)
      }}
    />
  </div>
}

function RegisteredImageCell<Row, Value>({ editable, options, row, update, value }: {
  editable: boolean
  options: DataGridImageTypeOptions<Row, Value>
  row: Row
  update: (value: Value | null) => void
  value: Value | null
}) {
  const uploadRef = useRef<AbortController | null>(null)
  const stagedUploadsRef = useRef(new Map<AbortController, DataGridStagedImage>())
  const releaseUpload = (controller: AbortController) => {
    const staged = stagedUploadsRef.current.get(controller)
    if (!staged) return
    stagedUploadsRef.current.delete(controller)
    revokeDataGridStagedImagePreviews([staged])
  }
  useEffect(() => () => {
    uploadRef.current?.abort()
    stagedUploadsRef.current.forEach((staged) => revokeDataGridStagedImagePreviews([staged]))
    stagedUploadsRef.current.clear()
  }, [])
  return <DataGridImageCell
    {...(options.accept === undefined ? {} : { accept: options.accept })}
    alt={options.alt(row, value)} emptyContent={options.emptyContent} label={options.label(row)}
    {...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })}
    {...(options.messages === undefined ? {} : { messages: options.messages })}
    disabled={!editable}
    src={options.resolveSrc(value, row)}
    onError={(message) => {
      const error = new Error(message)
      if (options.onError) options.onError(error, row)
      else throw error
    }}
    onStage={(staged) => {
      if (uploadRef.current) {
        uploadRef.current.abort()
        releaseUpload(uploadRef.current)
      }
      const controller = new AbortController()
      uploadRef.current = controller
      stagedUploadsRef.current.set(controller, staged)
      void Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw controller.signal.reason
          return options.upload({ file: staged.file, row, signal: controller.signal })
        })
        .then((next) => { if (!controller.signal.aborted) update(next) })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          if (options.onError) options.onError(error, row)
          else throw error
        })
        .finally(() => {
          releaseUpload(controller)
          if (uploadRef.current === controller) uploadRef.current = null
        })
    }}
  />
}
