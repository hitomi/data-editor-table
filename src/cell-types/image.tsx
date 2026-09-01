import { useEffect, useId, useRef, useState, type DragEvent } from 'react'

import type {
  GridCellBehavior,
  GridValueResult,
} from './contracts.js'
import type {
  GridCellEffectHandle,
  GridCellTypeDefinition,
  GridCellEditorProps,
  GridCellViewProps,
} from './react-view-contracts.js'
import { resolveCellTypeMessages } from './messages.js'

export type GridImageUploadInput = Readonly<{
  file: File
}>

export type GridImageCellEffects = {
  upload: Readonly<{ input: GridImageUploadInput }>
}

export type GridImageColumnOptions<Row, Value> = Readonly<{
  accept?: string
  maxBytes?: number
  alt?: (row: Row, value: Value | null) => string
  label?: (row: Row) => string
}>

export type GridImageCellTypeOptions<Row, Value> = Readonly<{
  accept?: string
  maxBytes?: number
  alt: (row: Row, value: Value | null) => string
  label: (row: Row) => string
  resolveSrc: (value: Value | null, row: Row) => string | null
  validate: (value: unknown, row: Row) => GridValueResult<Value>
  upload: (input: Readonly<{
    file: File
    row: Row
    signal: AbortSignal
  }>) => Value | Promise<Value>
  parseClipboard?: (text: string, row: Row) => GridValueResult<Value | null>
  equals?: (left: Value | null, right: Value | null) => boolean
  uploadErrorMessage?: (error: unknown, row: Row) => string
  messages?: Partial<GridImageCellTypeMessages>
}>

export type GridImageCellTypeMessages = Readonly<{
  hasImage: string
  isEmpty: string
  removeImage: string
  uploadCancelled: string
  uploadFailed: string
  choose: string
  replace: string
  cancel: string
  fileTooLarge: (maxBytes: number) => string
  unsupportedFileType: string
}>

const DEFAULT_IMAGE_MESSAGES: GridImageCellTypeMessages = Object.freeze({
  hasImage: 'Has image',
  isEmpty: 'Is empty',
  removeImage: 'Remove image',
  uploadCancelled: 'Image upload was cancelled.',
  uploadFailed: 'The image could not be uploaded.',
  choose: 'Choose',
  replace: 'Replace',
  cancel: 'Cancel',
  fileTooLarge: (maxBytes) => `Choose an image smaller than ${formatBytes(maxBytes)}.`,
  unsupportedFileType: 'Choose a supported image file.',
})

export function createImageCellType<Row, Value>(
  options: GridImageCellTypeOptions<Row, Value>,
): GridCellTypeDefinition<
  Row,
  Value | null,
  Value | null,
  never,
  GridImageColumnOptions<Row, Value> | undefined,
  GridImageCellEffects
> {
  const messages = resolveCellTypeMessages(DEFAULT_IMAGE_MESSAGES, options.messages)
  if (options.maxBytes !== undefined && (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0)) {
    throw new Error('Image maxBytes must be a positive finite number.')
  }
  function resolveOptions(typeOptions: GridImageColumnOptions<Row, Value> | undefined) {
    return {
      accept: typeOptions?.accept ?? options.accept ?? 'image/*',
      maxBytes: typeOptions?.maxBytes ?? options.maxBytes,
      alt: typeOptions?.alt ?? options.alt,
      label: typeOptions?.label ?? options.label,
    }
  }

  const behavior: GridCellBehavior<
    Row,
    Value | null,
    Value | null,
    never,
    GridImageColumnOptions<Row, Value> | undefined,
    GridImageCellEffects
  > = {
    value: {
      validate: (value, context) => value === null
        ? success(null)
        : options.validate(value, context.row),
    },
    text: {
      display: (value, context) => options.resolveSrc(value, context.row) ?? '',
      search: (value, context) => options.resolveSrc(value, context.row) ?? '',
      original: (value, context) => options.resolveSrc(value, context.row) ?? '',
    },
    equals: options.equals ?? Object.is,
    clipboard: {
      format: (value, context) => options.resolveSrc(value, context.row) ?? '',
      ...(options.parseClipboard === undefined ? {} : {
        parse: (text: string, context: import('./contracts.js').GridCellValueContext<Row, GridImageColumnOptions<Row, Value> | undefined>) => options.parseClipboard!(text, context.row),
      }),
    },
    edit: {
      begin: (value) => value,
      commit: (draft) => success(draft),
    },
    clear: () => success(null),
    filter: {
      defaultOperator: 'has-image',
      operators: [
        { id: 'has-image', label: messages.hasImage, requiresValue: false, matches: (value) => value !== null },
        { id: 'is-empty', label: messages.isEmpty, requiresValue: false, matches: (value) => value === null },
      ],
    },
    actions: [{
      id: 'remove-image',
      label: messages.removeImage,
      destructive: true,
      disabled: ({ value }) => value === null,
      run: () => success({ kind: 'set-value', value: null }),
    }],
    effects: {
      upload: {
        concurrency: 'replace-cell',
        run: async ({ file }, context, signal) => {
          const resolved = resolveOptions(context.typeOptions)
          const preflight = validateImageFile(file, resolved.accept, resolved.maxBytes, messages)
          if (!preflight.ok) return preflight
          try {
            const value = await options.upload({ file, row: context.row, signal })
            if (signal.aborted) return failure('image-upload-cancelled', messages.uploadCancelled)
            return success(value)
          } catch (error) {
            if (signal.aborted) return failure('image-upload-cancelled', messages.uploadCancelled)
            return failure(
              'image-upload-failed',
              options.uploadErrorMessage?.(error, context.row) ?? messages.uploadFailed,
            )
          }
        },
      },
    },
  }

  function ImageCell(props: GridCellViewProps<
    Row,
    Value | null,
    GridImageColumnOptions<Row, Value> | undefined,
    GridImageCellEffects
  >) {
    const resolved = resolveOptions(props.typeOptions)
    const activeEffect = useRef<GridCellEffectHandle | null>(null)
    const dragDepth = useRef(0)
    const [dragging, setDragging] = useState(false)
    useEffect(() => () => {
      dragDepth.current = 0
      activeEffect.current?.cancel()
    }, [])
    useEffect(() => {
      if (props.editable) return
      dragDepth.current = 0
      setDragging(false)
    }, [props.editable])
    const resetDrag = () => {
      dragDepth.current = 0
      setDragging(false)
    }
    const startUpload = (file: File) => {
      activeEffect.current?.cancel()
      activeEffect.current = props.requestEffect('upload', { file })
    }
    const src = options.resolveSrc(props.value, props.row)
    const label = resolved.label(props.row)
    return <div
      className="data-grid-image-cell"
      data-dragging={dragging || undefined}
      data-empty={src ? undefined : 'true'}
      onDragEnter={(event) => {
        if (!props.editable || !hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!props.editable || dragDepth.current === 0) return
        event.preventDefault()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDragOver={(event) => {
        if (!props.editable || !hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        if (!props.editable) return
        if (!hasDraggedFiles(event.dataTransfer)) {
          resetDrag()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        resetDrag()
        const file = event.dataTransfer.files[0]
        if (file) startUpload(file)
      }}
    >
      {src
        ? <img alt={resolved.alt(props.row, props.value)} draggable={false} src={src} />
        : <span>{label}</span>}
    </div>
  }

  function ImageEditor(props: GridCellEditorProps<
    Row,
    Value | null,
    Value | null,
    GridImageColumnOptions<Row, Value> | undefined,
    GridImageCellEffects
  >) {
    const input = useRef<HTMLInputElement>(null)
    const inputId = useId()
    const activeEffect = useRef<GridCellEffectHandle | null>(null)
    const resolved = resolveOptions(props.typeOptions)
    const label = resolved.label(props.row)
    const compactLabel = props.value === null ? messages.choose : messages.replace
    useEffect(() => {
      if (props.claimInitialActivation()) input.current?.click()
      return () => { activeEffect.current?.cancel() }
    }, [props.claimInitialActivation])
    const upload = (file: File) => {
      activeEffect.current?.cancel()
      activeEffect.current = props.requestEffect('upload', { file })
    }
    return <div
      className="data-grid-image-editor"
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        const file = event.dataTransfer.files[0]
        if (file) upload(file)
      }}
    >
      <span className="data-grid-image-editor-chooser">
        <span aria-hidden="true" className="data-grid-image-editor-label data-grid-image-editor-label--compact">{compactLabel}</span>
        <span aria-hidden="true" className="data-grid-image-editor-label data-grid-image-editor-label--full">{label}</span>
        <input
          aria-label={label}
          ref={input}
          id={inputId}
          type="file"
          accept={resolved.accept}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) upload(file)
            else props.cancel()
          }}
        />
      </span>
      <button className="data-grid-image-editor-cancel" type="button" onClick={props.cancel}>{messages.cancel}</button>
    </div>
  }

  return {
    behavior,
    view: {
      Cell: ImageCell,
      Editor: ImageEditor,
      presentation: {
        content: 'edge-to-edge',
        align: 'center',
        editActivation: ['active-cell-click', 'enter', 'f2'],
      },
    },
  }
}

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes('Files')
    || Array.from(dataTransfer.items).some((item) => item.kind === 'file')
}

function validateImageFile(
  file: File,
  accept: string | undefined,
  maxBytes: number | undefined,
  messages: GridImageCellTypeMessages,
): GridValueResult<null> {
  if (maxBytes !== undefined && file.size > maxBytes) {
    return failure('image-too-large', messages.fileTooLarge(maxBytes))
  }
  if (accept && !matchesAccept(file, accept)) {
    return failure('unsupported-image-type', messages.unsupportedFileType)
  }
  return success(null)
}

function matchesAccept(file: File, accept: string): boolean {
  return accept.split(',').map((part) => part.trim().toLocaleLowerCase()).some((rule) => {
    if (!rule) return false
    if (rule.startsWith('.')) return file.name.toLocaleLowerCase().endsWith(rule)
    if (rule.endsWith('/*')) return file.type.toLocaleLowerCase().startsWith(rule.slice(0, -1))
    return file.type.toLocaleLowerCase() === rule
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${Math.ceil(bytes / (1024 * 1024))} MB`
}

function success<Value>(value: Value): GridValueResult<Value> {
  return { ok: true, value }
}

function failure<Value>(code: string, message: string): GridValueResult<Value> {
  return { ok: false, issue: { code, message } }
}
