// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DataGridBulkEditor } from './bulk-editor'
import { DataGridImageCell, revokeDataGridStagedImagePreviews } from './image-cell'
import type { DataGridFieldDefinition, DataGridStagedImage } from './field-definition'

afterEach(() => vi.restoreAllMocks())

describe('DataGridImageCell', () => {
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
})
