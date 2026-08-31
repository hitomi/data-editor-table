import { useRef, useState, type DragEvent, type ReactNode } from 'react'

import { classNames } from './class-names.js'
import type { DataGridStagedImage } from '../core/field-definition.js'

export type DataGridImageCellMessages = {
  invalidType: string
  tooLarge: (maxBytes: number) => string
  uploadHint?: string
}

const DEFAULT_MESSAGES: DataGridImageCellMessages = {
  invalidType: 'Choose a supported image file.',
  tooLarge: (maxBytes) => `The image must be smaller than ${formatBytes(maxBytes)}.`,
  uploadHint: 'Double-click or drop an image to upload.',
}

export function DataGridImageCell<Uploaded = unknown>({
  accept = 'image/*', alt, className, emptyContent = 'Add image', label,
  disabled = false, maxBytes = 8 * 1024 * 1024, messages = DEFAULT_MESSAGES, onError, onStage,
  renderImage, src,
}: {
  accept?: string
  alt: string
  className?: string
  disabled?: boolean
  emptyContent?: ReactNode
  label: string
  maxBytes?: number
  messages?: DataGridImageCellMessages
  onError: (message: string) => void
  onStage: (image: DataGridStagedImage<Uploaded>) => void
  renderImage?: (src: string, alt: string) => ReactNode
  src: string | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const chooseFile = (file: File) => {
    if (disabled) return
    if (!fileMatchesAccept(file, accept)) return onError(messages.invalidType)
    if (file.size > maxBytes) return onError(messages.tooLarge(maxBytes))
    onStage({ file, previewUrl: URL.createObjectURL(file) })
  }

  const openFilePicker = () => {
    if (!disabled) inputRef.current?.click()
  }

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (disabled) return
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) chooseFile(file)
  }

  return <div className="operational-data-grid-image-cell-container">
    <input ref={inputRef} hidden type="file" accept={accept} disabled={disabled} onChange={(event) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file) chooseFile(file)
    }} />
    <button
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={classNames('operational-data-grid-image-cell', dragging && 'is-dragging', className)}
      tabIndex={disabled ? -1 : undefined}
      title={messages.uploadHint ?? DEFAULT_MESSAGES.uploadHint}
      type="button"
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); openFilePicker() }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        openFilePicker()
      }}
      onMouseDown={(event) => event.preventDefault()}
      onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true) }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {src ? (renderImage?.(src, alt) ?? <img className="operational-data-grid-image-preview" src={src} alt={alt} />) : emptyContent}
    </button>
  </div>
}

/** The consumer owns staged URLs; call this on commit, replacement, cancellation, and unmount. */
export function revokeDataGridStagedImagePreviews(images: Iterable<DataGridStagedImage | null | undefined>) {
  const urls = new Set<string>()
  for (const image of images) if (image?.previewUrl) urls.add(image.previewUrl)
  urls.forEach((url) => URL.revokeObjectURL(url))
}

export function fileMatchesDataGridImageAccept(file: Pick<File, 'name' | 'type'>, accept: string) {
  return accept.split(',').some((rule) => {
    const value = rule.trim().toLowerCase()
    if (!value) return false
    if (value.startsWith('.')) return file.name.toLowerCase().endsWith(value)
    if (value.endsWith('/*')) return file.type.toLowerCase().startsWith(value.slice(0, -1))
    return file.type.toLowerCase() === value
  })
}

const fileMatchesAccept = fileMatchesDataGridImageAccept

function formatBytes(value: number) {
  if (value >= 1024 * 1024) {
    const megabytes = value / (1024 * 1024)
    return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`
  }
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}
