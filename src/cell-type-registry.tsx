import { useEffect, useRef, type ReactNode } from 'react'
import type { RenderCellProps, RenderEditCellProps } from 'react-data-grid'

import type { DataGridCellAction } from './actions'
import { DataGridImageCell, revokeDataGridStagedImagePreviews } from './image-cell'

export type DataGridSourceField<Row, Value = unknown> = {
  key: string
  label: string
  type: string
  getValue: (row: Row) => Value
  setValue?: { bivarianceHack(row: Row, value: Value): Row }['bivarianceHack']
  isEditable?: (row: Row) => boolean
  validate?: (value: Value, row: Row) => { valid: true } | { valid: false; message?: string }
  width?: number | string
  minWidth?: number
  maxWidth?: number
  sortable?: boolean
  typeOptions?: unknown
}

export type DataGridCellTypeRenderProps<Row, Value = unknown> = {
  field: DataGridSourceField<Row, Value>
  row: Row
  value: Value
  update: (value: Value) => void
}

export type DataGridCellTypeEditorProps<Row, Value = unknown> = DataGridCellTypeRenderProps<Row, Value> & {
  close: (commit?: boolean) => void
}

export type DataGridCellTypeRenderer<Row, Value = unknown> = {
  renderCell: (props: DataGridCellTypeRenderProps<Row, Value>) => ReactNode
  renderEditor?: (props: DataGridCellTypeEditorProps<Row, Value>) => ReactNode
  formatClipboard?: (value: Value, row: Row, field: DataGridSourceField<Row, Value>) => string
  parseClipboard?: (text: string, row: Row, field: DataGridSourceField<Row, Value>) => Value
  clearValue?: (row: Row, field: DataGridSourceField<Row, Value>) => Value
  actions?: readonly DataGridCellAction<Row, Value>[]
}

export type DataGridCellTypeRegistry<Row> = {
  get: (type: string) => DataGridCellTypeRenderer<Row, unknown> | undefined
  register: <Value>(type: string, renderer: DataGridCellTypeRenderer<Row, Value>) => DataGridCellTypeRegistry<Row>
}

export function createDataGridCellTypeRegistry<Row>(): DataGridCellTypeRegistry<Row> {
  const renderers = new Map<string, DataGridCellTypeRenderer<Row, unknown>>()
  const registry: DataGridCellTypeRegistry<Row> = {
    get: (type) => renderers.get(type),
    register(type, renderer) {
      if (!type.trim()) throw new Error('A cell type name is required.')
      if (renderers.has(type)) throw new Error(`Cell type "${type}" is already registered.`)
      renderers.set(type, renderer as DataGridCellTypeRenderer<Row, unknown>)
      return registry
    },
  }
  return registry
}

export function registerDataGridBuiltinCellTypes<Row>(registry: DataGridCellTypeRegistry<Row>) {
  registry.register<string>('text', {
    renderCell: ({ value }) => value,
    renderEditor: ({ value, update, close }) => <input
      autoFocus className="rdg-text-editor" value={value ?? ''}
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
  registry.register<number>('number', {
    renderCell: ({ value }) => String(value),
    renderEditor: ({ value, update, close }) => <input
      autoFocus className="rdg-text-editor" type="number" value={Number.isFinite(value) ? value : 0}
      onChange={(event) => update(event.target.valueAsNumber)}
      onBlur={() => close(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') close(true)
        if (event.key === 'Escape') close(false)
      }}
    />,
    formatClipboard: (value) => String(value),
    parseClipboard: (text) => Number(text),
    clearValue: () => 0,
    actions: [{ id: 'reset-number', label: 'Reset to zero', disabled: ({ value }) => value === 0, run: ({ update }) => update(0) }],
  })
  return registry
}

export function renderRegisteredCell<Row>(
  renderer: DataGridCellTypeRenderer<Row, unknown>,
  field: DataGridSourceField<Row, unknown>,
  props: RenderCellProps<Row>,
) {
  const value = field.getValue(props.row)
  return renderer.renderCell({
    field, row: props.row, value,
    update: (next) => {
      if (field.setValue) props.onRowChange(field.setValue(props.row, next))
    },
  })
}

export function renderRegisteredEditor<Row>(
  renderer: DataGridCellTypeRenderer<Row, unknown>,
  field: DataGridSourceField<Row, unknown>,
  props: RenderEditCellProps<Row>,
) {
  if (!renderer.renderEditor || !field.setValue) return null
  const value = field.getValue(props.row)
  return renderer.renderEditor({
    field, row: props.row, value,
    update: (next) => props.onRowChange(field.setValue!(props.row, next)),
    close: (commit = true) => props.onClose(commit),
  })
}

export type DataGridImageTypeOptions<Row, Value> = {
  accept?: string
  alt: (row: Row, value: Value | null) => string
  emptyContent?: ReactNode
  label: (row: Row) => string
  maxBytes?: number
  resolveSrc: (value: Value | null, row: Row) => string | null
  upload: (input: { file: File; row: Row; signal: AbortSignal }) => Promise<Value>
  onError?: (error: unknown, row: Row) => void
}

/** Image upload is an ordinary registered cell type, not a Grid special case. */
export function createDataGridImageCellTypeRenderer<Row, Value>(options: DataGridImageTypeOptions<Row, Value>): DataGridCellTypeRenderer<Row, Value | null> {
  return {
    renderCell: ({ row, value, update }) => <RegisteredImageCell options={options} row={row} value={value} update={update} />,
    actions: [{ id: 'remove-image', label: 'Remove image', destructive: true, disabled: ({ value }) => value === null, run: ({ update }) => update(null) }],
  }
}

function RegisteredImageCell<Row, Value>({ options, row, update, value }: {
  options: DataGridImageTypeOptions<Row, Value>
  row: Row
  update: (value: Value | null) => void
  value: Value | null
}) {
  const uploadRef = useRef<AbortController | null>(null)
  useEffect(() => () => uploadRef.current?.abort(), [])
  return <DataGridImageCell
    {...(options.accept === undefined ? {} : { accept: options.accept })}
    alt={options.alt(row, value)} emptyContent={options.emptyContent} label={options.label(row)}
    {...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })}
    src={options.resolveSrc(value, row)}
    onError={(message) => options.onError?.(new Error(message), row)}
    onStage={(staged) => {
      uploadRef.current?.abort()
      const controller = new AbortController()
      uploadRef.current = controller
      void options.upload({ file: staged.file, row, signal: controller.signal })
        .then((next) => { if (!controller.signal.aborted) update(next) })
        .catch((error: unknown) => { if (!controller.signal.aborted) options.onError?.(error, row) })
        .finally(() => {
          revokeDataGridStagedImagePreviews([staged])
          if (uploadRef.current === controller) uploadRef.current = null
        })
    }}
  />
}
