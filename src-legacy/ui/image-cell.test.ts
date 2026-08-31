import { describe, expect, it } from 'vitest'

import { fileMatchesDataGridImageAccept } from './image-cell'

describe('fileMatchesDataGridImageAccept', () => {
  const png = { name: 'poster.PNG', type: 'image/png' }
  it('supports mime families, exact mime types, and extensions', () => {
    expect(fileMatchesDataGridImageAccept(png, 'image/*')).toBe(true)
    expect(fileMatchesDataGridImageAccept(png, 'image/jpeg,image/png')).toBe(true)
    expect(fileMatchesDataGridImageAccept(png, '.png')).toBe(true)
    expect(fileMatchesDataGridImageAccept(png, '.jpg')).toBe(false)
  })
})
