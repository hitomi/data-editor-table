// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DataGridBulkEditor } from './bulk-editor'
import { createDataGridImageCellTypeRenderer } from '../data-source/cell-type-registry'
import { DataGridImageCell, revokeDataGridStagedImagePreviews } from './image-cell'
import type { DataGridFieldDefinition, DataGridStagedImage } from '../core/field-definition'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DataGridImageCell', () => {
  it('copies the resolved image source by default', () => {
    type ImageRow = { id: string; image: string | null }
    const row: ImageRow = { id: 'one', image: 'asset:poster' }
    const field = { key: 'image', label: 'Image', type: 'image', getValue: (value: ImageRow) => value.image, setValue: (value: ImageRow, image: string | null) => ({ ...value, image }) }
    const renderer = createDataGridImageCellTypeRenderer<ImageRow, string>({
      alt: () => 'Poster', label: () => 'Upload poster', resolveSrc: (value) => value ? `https://cdn.example/${value}.png` : null,
      upload: async () => 'asset:new',
    })

    expect(renderer.formatClipboard?.(row.image, row, field)).toBe('https://cdn.example/asset:poster.png')
    expect(renderer.formatClipboard?.(null, { ...row, image: null }, field)).toBe('')
    expect(renderer.fill?.({
      defaultValue: row.image,
      field,
      sourceRows: [row],
      sourceStartIndex: 0,
      sourceValues: [row.image],
      targetIndex: 1,
      targetRow: { id: 'two', image: null },
    })).toBe('asset:poster')
  })

  it('stages a validated image and exposes explicit preview cleanup', () => {
    const createObjectURL = vi.fn(() => 'blob:preview')
    const revokeObjectURL = vi.fn()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    })
    const onStage = vi.fn<(image: DataGridStagedImage) => void>()
    const view = render(<DataGridImageCell alt="Poster" label="Upload poster" src={null} accept="image/png" onError={vi.fn()} onStage={onStage} />)
    const file = new File(['png'], 'poster.png', { type: 'image/png' })
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } })
    expect(createObjectURL).toHaveBeenCalledWith(file)
    expect(onStage).toHaveBeenCalledWith({ file, previewUrl: 'blob:preview' })
    revokeDataGridStagedImagePreviews([onStage.mock.calls[0]![0]])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })

  it('opens the picker on pointer double-click or keyboard activation and accepts dropped files', () => {
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const createObjectURL = vi.fn(() => 'blob:dropped')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    const onStage = vi.fn<(image: DataGridStagedImage) => void>()
    render(<DataGridImageCell alt="Poster" label="Upload poster" src={null} accept="image/png" onError={vi.fn()} onStage={onStage} />)
    const surface = screen.getByRole('button', { name: 'Upload poster' })

    fireEvent.click(surface, { detail: 1 })
    expect(inputClick).not.toHaveBeenCalled()
    fireEvent.doubleClick(surface)
    expect(inputClick).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(surface, { key: 'Enter' })
    expect(inputClick).toHaveBeenCalledTimes(2)

    const file = new File(['png'], 'dropped.png', { type: 'image/png' })
    fireEvent.dragEnter(surface, { dataTransfer: { files: [file] } })
    expect(surface.classList.contains('is-dragging')).toBe(true)
    fireEvent.drop(surface, { dataTransfer: { files: [file] } })
    expect(surface.classList.contains('is-dragging')).toBe(false)
    expect(createObjectURL).toHaveBeenCalledWith(file)
    expect(onStage).toHaveBeenCalledWith({ file, previewUrl: 'blob:dropped' })
  })

  it('works as a registered renderer and revokes its temporary URL after upload', async () => {
    const createObjectURL = vi.fn(() => 'blob:registered')
    const revokeObjectURL = vi.fn()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    })
    type ImageRow = { id: string; image: string | null }
    const upload = vi.fn(async (_input: { file: File; row: ImageRow; signal: AbortSignal }) => 'asset:new')
    const update = vi.fn()
    const renderer = createDataGridImageCellTypeRenderer<ImageRow, string>({
      alt: () => 'Poster', label: () => 'Upload poster', resolveSrc: () => null, upload,
    })
    const field = { key: 'image', label: 'Image', type: 'image', getValue: (row: ImageRow) => row.image, setValue: (row: ImageRow, image: string | null) => ({ ...row, image }) }
    const view = render(renderer.renderCell({ editable: true, field, row: { id: 'one', image: null }, value: null, update }))
    const file = new File(['png'], 'poster.png', { type: 'image/png' })
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } })
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith('asset:new'))
    expect(upload.mock.calls[0]![0].file).toBe(file)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:registered')
  })

  it('gives the registered image editor an explicit commit and cancel lifecycle', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:editor') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    })
    type ImageRow = { id: string; image: string | null }
    const row: ImageRow = { id: 'one', image: null }
    const update = vi.fn()
    const close = vi.fn()
    const renderer = createDataGridImageCellTypeRenderer<ImageRow, string>({
      alt: () => 'Poster', label: () => 'Upload poster', resolveSrc: () => null,
      upload: async () => 'asset:new',
    })
    const field = { key: 'image', label: 'Image', type: 'image', getValue: (value: ImageRow) => value.image, setValue: (value: ImageRow, image: string | null) => ({ ...value, image }) }
    const view = render(renderer.renderEditor!({ close, editable: true, field, row, value: null, update }))
    const editor = view.container.querySelector('.operational-data-grid-image-editor')!

    fireEvent.keyDown(editor, { key: 'ArrowRight' })
    expect(close).toHaveBeenLastCalledWith(true)
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(close).toHaveBeenLastCalledWith(false)

    const file = new File(['png'], 'poster.png', { type: 'image/png' })
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } })
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith('asset:new'))
    expect(close).toHaveBeenLastCalledWith(true)
  })

  it('aborts a pending registered upload and releases its preview on unmount', async () => {
    const revokeObjectURL = vi.fn()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:pending') },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    })
    type ImageRow = { id: string; image: string | null }
    let signal!: AbortSignal
    const upload = vi.fn(({ signal: uploadSignal }: { file: File; row: ImageRow; signal: AbortSignal }) => {
      signal = uploadSignal
      return new Promise<string>(() => undefined)
    })
    const renderer = createDataGridImageCellTypeRenderer<ImageRow, string>({
      alt: () => 'Poster', label: () => 'Upload poster', resolveSrc: () => null, upload,
    })
    const field = { key: 'image', label: 'Image', type: 'image', getValue: (row: ImageRow) => row.image, setValue: (row: ImageRow, image: string | null) => ({ ...row, image }) }
    const view = render(renderer.renderCell({ editable: true, field, row: { id: 'one', image: null }, value: null, update: vi.fn() }))
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['png'], 'poster.png', { type: 'image/png' })] } })
    await vi.waitFor(() => expect(upload).toHaveBeenCalled())

    view.unmount()

    expect(signal.aborted).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pending')
  })

  it('does not start an upload for a non-editable image cell', () => {
    type ImageRow = { id: string; image: string | null }
    const upload = vi.fn(async () => 'asset:new')
    const renderer = createDataGridImageCellTypeRenderer<ImageRow, string>({
      alt: () => 'Poster', label: () => 'Upload poster', resolveSrc: () => null, upload,
    })
    const field = { key: 'image', label: 'Image', type: 'image', getValue: (row: ImageRow) => row.image, setValue: (row: ImageRow, image: string | null) => ({ ...row, image }) }
    const view = render(renderer.renderCell({ editable: false, field, row: { id: 'one', image: null }, value: null, update: vi.fn() }))

    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['png'], 'poster.png', { type: 'image/png' })] } })

    expect(upload).not.toHaveBeenCalled()
  })

  it('routes synchronous upload failures and always releases the staged preview', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:sync-error') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    })
    type ImageRow = { id: string; image: string | null }
    const onError = vi.fn()
    const renderer = createDataGridImageCellTypeRenderer<ImageRow, string>({
      alt: () => 'Poster', label: () => 'Upload poster', resolveSrc: () => null,
      upload: () => { throw new Error('sync upload failure') }, onError,
    })
    const field = { key: 'image', label: 'Image', type: 'image', getValue: (row: ImageRow) => row.image, setValue: (row: ImageRow, image: string | null) => ({ ...row, image }) }
    const view = render(renderer.renderCell({ editable: true, field, row: { id: 'one', image: null }, value: null, update: vi.fn() }))
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['png'], 'poster.png', { type: 'image/png' })] } })

    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sync-error')
  })
})

describe('DataGridBulkEditor', () => {
  type Row = { id: string; name: string }
  const field: DataGridFieldDefinition<Row> = {
    kind: 'text', key: 'name', label: 'Name', getValue: (row) => row.name,
    setValue: (row, name) => ({ ...row, name }),
  }
  it('preserves entered input across host rerenders and applies one row transform', () => {
    const selection = { cellCount: 1, columnKey: 'name', columnLabel: 'Name', hasMixedValues: false, hasReadOnlyCells: false, rows: [{ id: 'one', name: 'Before' }] }
    const onApplyRowTransform = vi.fn()
    const view = render(<DataGridBulkEditor field={field} selection={selection} onApplyRowTransform={onApplyRowTransform} onCancel={vi.fn()} />)
    const input = screen.getByLabelText('Value')
    fireEvent.change(input, { target: { value: 'After' } })
    view.rerender(<DataGridBulkEditor field={field} selection={{ ...selection, rows: [...selection.rows] }} onApplyRowTransform={onApplyRowTransform} onCancel={vi.fn()} />)
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('After')
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 cells' }))
    const transform = onApplyRowTransform.mock.calls[0]![0] as (row: Row, field: keyof Row) => Row
    expect(transform(selection.rows[0]!, 'name')).toEqual({ id: 'one', name: 'After' })
  })

  it('resets input only when the editing session changes', () => {
    const selection = { cellCount: 1, columnKey: 'name', columnLabel: 'Name', hasMixedValues: false, hasReadOnlyCells: false, rows: [{ id: 'one', name: 'Before' }], sessionKey: 'one' }
    const view = render(<DataGridBulkEditor field={{ ...field }} selection={selection} onApplyRowTransform={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(within(view.container).getByLabelText('Value'), { target: { value: 'Draft' } })
    view.rerender(<DataGridBulkEditor field={{ ...field }} selection={{ ...selection, rows: [{ ...selection.rows[0]! }] }} onApplyRowTransform={vi.fn()} onCancel={vi.fn()} />)
    expect((within(view.container).getByLabelText('Value') as HTMLInputElement).value).toBe('Draft')
    view.rerender(<DataGridBulkEditor field={{ ...field }} selection={{ ...selection, sessionKey: 'two', rows: [{ id: 'two', name: 'Second' }] }} onApplyRowTransform={vi.fn()} onCancel={vi.fn()} />)
    expect((within(view.container).getByLabelText('Value') as HTMLInputElement).value).toBe('Second')
  })

  it('only offers operations allowed by the field contract', () => {
    const selection = { cellCount: 1, columnKey: 'name', columnLabel: 'Name', hasMixedValues: false, hasReadOnlyCells: false, rows: [{ id: 'one', name: 'Before' }] }
    const view = render(<DataGridBulkEditor field={{ ...field, bulkOperations: ['replace'] as const }} selection={selection} onApplyRowTransform={vi.fn()} onCancel={vi.fn()} />)
    const operation = within(view.container).getByLabelText('Operation')
    expect((operation as HTMLSelectElement).value).toBe('replace')
    expect(within(view.container).queryByRole('option', { name: 'Set value' })).toBeNull()
    expect(within(view.container).getByRole('option', { name: 'Find and replace' })).toBeTruthy()
  })

  it('does not apply when a field explicitly allows no bulk operations', () => {
    const selection = { cellCount: 1, columnKey: 'name', columnLabel: 'Name', hasMixedValues: false, hasReadOnlyCells: false, rows: [{ id: 'one', name: 'Before' }] }
    const onApplyRowTransform = vi.fn()
    render(<DataGridBulkEditor field={{ ...field, bulkOperations: [] }} selection={selection} onApplyRowTransform={onApplyRowTransform} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 cells' }))
    expect(onApplyRowTransform).not.toHaveBeenCalled()
  })

  it('rejects a current-row parse failure instead of partially skipping it', () => {
    type BoundedRow = { id: string; maximum: number; quantity: number }
    const boundedField: DataGridFieldDefinition<BoundedRow> = {
      kind: 'number', key: 'quantity', label: 'Quantity',
      getValue: (row) => row.quantity,
      setValue: (row, quantity) => ({ ...row, quantity: Number(quantity) }),
      parseInput: (raw, row) => {
        const value = Number(raw)
        return Number.isFinite(value) && value <= row.maximum
          ? value
          : { error: 'Quantity exceeds this row’s maximum.' }
      },
    }
    const selection = {
      cellCount: 2, columnKey: 'quantity', columnLabel: 'Quantity', hasMixedValues: true, hasReadOnlyCells: false,
      rows: [{ id: 'one', maximum: 10, quantity: 1 }, { id: 'two', maximum: 10, quantity: 2 }],
    }
    const onApplyRowTransform = vi.fn()
    render(<DataGridBulkEditor field={boundedField} selection={selection} onApplyRowTransform={onApplyRowTransform} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 cells' }))

    const transform = onApplyRowTransform.mock.calls[0]![0] as (row: BoundedRow) => BoundedRow
    expect(() => transform({ id: 'one', maximum: 5, quantity: 1 })).toThrow('Quantity exceeds this row’s maximum.')
    expect(transform({ id: 'two', maximum: 10, quantity: 2 })).toEqual({ id: 'two', maximum: 10, quantity: 8 })
  })
})
