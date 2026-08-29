import { useId, useState, type DragEvent, type ReactNode } from 'react'

import { classNames } from './class-names'
import type { DataGridStagedImage } from './field-definition'

export type DataGridImageCellMessages = {
  invalidType: string
  tooLarge: (maxBytes: number) => string
}

const DEFAULT_MESSAGES: DataGridImageCellMessages = {
  invalidType: 'Choose a supported image file.',
  tooLarge: (maxBytes) => `The image must be smaller than ${formatBytes(maxBytes)}.`,
}

export function DataGridImageCell<Uploaded = unknown>({
  accept = 'image/*', alt, className, emptyContent = 'Add image', label,
  maxBytes = 8 * 1024 * 1024, messages = DEFAULT_MESSAGES, onError, onStage,
  renderImage, src,
}: {
  accept?: string
  alt: string
  className?: string
  emptyContent?: ReactNode
  label: string
  maxBytes?: number
  messages?: DataGridImageCellMessages
  onError: (message: string) => void
  onStage: (image: DataGridStagedImage<Uploaded>) => void
  renderImage?: (src: string, alt: string) => ReactNode
  src: string | null
}) {
  const inputId = useId()
  const [dragging, setDragging] = useState(false)

  const chooseFile = (file: File) => {
    if (!fileMatchesAccept(file, accept)) return onError(messages.invalidType)
    if (file.size > maxBytes) return onError(messages.tooLarge(maxBytes))
    onStage({ file, previewUrl: URL.createObjectURL(file) })
  }

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) chooseFile(file)
  }

  return <label
    htmlFor={inputId}
    aria-label={label}
    className={classNames('operational-data-grid-image-cell', dragging && 'is-dragging', className)}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
    onDragOver={(event) => event.preventDefault()}
    onDragLeave={() => setDragging(false)}
    onDrop={onDrop}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <input id={inputId} type="file" accept={accept} className="operational-data-grid-visually-hidden" onChange={(event) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file) chooseFile(file)
    }} />
    {src ? (renderImage?.(src, alt) ?? <img className="operational-data-grid-image-preview" src={src} alt={alt} />) : emptyContent}
  </label>
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
