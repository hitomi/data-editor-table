import type { GridPoint, GridRowKey } from '../model/grid-model.js'

type CellNodeEntry = Readonly<{
  node: HTMLElement
  rowKey: GridRowKey
  columnKey: string
}>

export class GridDomEffectAdapter {
  readonly #cells = new Map<string, CellNodeEntry>()
  #editor: HTMLElement | null = null
  #pointerRoot: HTMLElement | null = null
  #scrollport: HTMLElement | null = null

  setScrollport(node: HTMLElement | null) {
    this.#scrollport = node
  }

  setPointerRoot(node: HTMLElement | null) {
    this.#pointerRoot = node
  }

  registerCell<RowKey extends GridRowKey>(point: GridPoint<RowKey>, node: HTMLElement | null) {
    const key = pointKey(point)
    if (node === null) this.#cells.delete(key)
    else this.#cells.set(key, { node, rowKey: point.rowKey, columnKey: point.columnKey })
  }

  registerEditor(node: HTMLElement | null) {
    this.#editor = node
  }

  focusCell<RowKey extends GridRowKey>(point: GridPoint<RowKey>, ensureVisible = true) {
    const cell = this.#cells.get(pointKey(point))?.node
    if (!cell) return false
    if (ensureVisible) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    cell.focus({ preventScroll: true })
    return true
  }

  focusEditor(select = false) {
    const target = this.#editor
    if (!target) return false
    target.focus({ preventScroll: true })
    if (select && target instanceof HTMLInputElement) target.select()
    return true
  }

  focusGrid() {
    if (!this.#scrollport) return false
    this.#scrollport.focus({ preventScroll: true })
    return true
  }

  ensureCellVisible<RowKey extends GridRowKey>(point: GridPoint<RowKey>) {
    const cell = this.#cells.get(pointKey(point))?.node
    if (!cell) return false
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return true
  }

  capturePointer(pointerId: number) {
    const pointerRoot = this.#pointerRoot
    if (!pointerRoot) return false
    pointerRoot.setPointerCapture(pointerId)
    return true
  }

  releasePointer(pointerId: number) {
    const pointerRoot = this.#pointerRoot
    if (!pointerRoot?.hasPointerCapture(pointerId)) return false
    pointerRoot.releasePointerCapture(pointerId)
    return true
  }

  scrollBy(left: number, top: number) {
    this.#scrollport?.scrollBy({ left, top, behavior: 'auto' })
  }

  destroy() {
    this.#cells.clear()
    this.#editor = null
    this.#pointerRoot = null
    this.#scrollport = null
  }
}

function pointKey(point: GridPoint<GridRowKey>) {
  return `${typeof point.rowKey}:${String(point.rowKey).length}:${String(point.rowKey)}\u0000${point.columnKey}`
}
