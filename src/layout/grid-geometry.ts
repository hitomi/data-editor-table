import type { GridColumn, GridColumnLayout } from '../model/grid-model.js'

export type GridRect = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>

export type GridColumnGeometry = Readonly<{
  key: string
  index: number
  offset: number
  width: number
}>

export type GridGeometry = Readonly<{
  viewportWidth: number
  viewportHeight: number
  scrollLeft: number
  scrollTop: number
  rowHeight: number
  headerHeight: number
  rowIndicatorWidth: number
  contentWidth: number
  contentHeight: number
  columns: readonly GridColumnGeometry[]
  columnByKey: ReadonlyMap<string, GridColumnGeometry>
  templateColumns: string
}>

export const GRID_SELECTION_STROKE_WIDTH = 2
export const GRID_FILL_HANDLE_SIZE = 7
export const GRID_FILL_HANDLE_HIT_SIZE = 16

export type ResolveGridGeometryOptions<Row> = Readonly<{
  columns: readonly GridColumn<Row, unknown>[]
  visibleRowCount: number
  viewportWidth: number
  viewportHeight: number
  scrollLeft: number
  scrollTop: number
  rowHeight: number
  headerHeight: number
  rowIndicatorWidth: number
}>

const DEFAULT_COLUMN_BASIS = 160
const DEFAULT_COLUMN_MIN = 72

export function resolveGridGeometry<Row>({
  columns,
  visibleRowCount,
  viewportWidth,
  viewportHeight,
  scrollLeft,
  scrollTop,
  rowHeight,
  headerHeight,
  rowIndicatorWidth,
}: ResolveGridGeometryOptions<Row>): GridGeometry {
  const availableWidth = Math.max(0, viewportWidth - rowIndicatorWidth)
  const widths = resolveColumnWidths(columns.map((column) => column.layout), availableWidth)
  const resolvedColumns: GridColumnGeometry[] = []
  let offset = 0

  columns.forEach((column, index) => {
    const width = widths[index] ?? DEFAULT_COLUMN_BASIS
    resolvedColumns.push(Object.freeze({ key: column.key, index, offset, width }))
    offset += width
  })

  const frozenColumns = Object.freeze(resolvedColumns)
  const columnByKey = new Map(frozenColumns.map((column) => [column.key, column] as const))
  const safeRowHeight = Math.max(1, rowHeight)
  const safeHeaderHeight = Math.max(1, headerHeight)
  const safeIndicatorWidth = Math.max(1, rowIndicatorWidth)

  return Object.freeze({
    viewportWidth: Math.max(0, viewportWidth),
    viewportHeight: Math.max(0, viewportHeight),
    scrollLeft: Math.max(0, scrollLeft),
    scrollTop: Math.max(0, scrollTop),
    rowHeight: safeRowHeight,
    headerHeight: safeHeaderHeight,
    rowIndicatorWidth: safeIndicatorWidth,
    contentWidth: safeIndicatorWidth + offset,
    contentHeight: safeHeaderHeight + Math.max(0, visibleRowCount) * safeRowHeight,
    columns: frozenColumns,
    columnByKey,
    templateColumns: `${formatPixel(safeIndicatorWidth)} ${frozenColumns.map((column) => formatPixel(column.width)).join(' ')}`,
  })
}

export function getCellViewportRect(
  geometry: GridGeometry,
  visibleRowIndex: number,
  columnKey: string,
): GridRect | null {
  const column = geometry.columnByKey.get(columnKey)
  if (!column || visibleRowIndex < 0) return null
  return Object.freeze({
    x: geometry.rowIndicatorWidth + column.offset - geometry.scrollLeft,
    y: geometry.headerHeight + visibleRowIndex * geometry.rowHeight - geometry.scrollTop,
    width: column.width,
    height: geometry.rowHeight,
  })
}

export function getRangeViewportRect(
  geometry: GridGeometry,
  minRowIndex: number,
  maxRowIndex: number,
  minColumnIndex: number,
  maxColumnIndex: number,
): GridRect | null {
  const firstColumn = geometry.columns[minColumnIndex]
  const lastColumn = geometry.columns[maxColumnIndex]
  if (!firstColumn || !lastColumn || minRowIndex < 0 || maxRowIndex < minRowIndex) return null
  return Object.freeze({
    x: geometry.rowIndicatorWidth + firstColumn.offset - geometry.scrollLeft,
    y: geometry.headerHeight + minRowIndex * geometry.rowHeight - geometry.scrollTop,
    width: lastColumn.offset + lastColumn.width - firstColumn.offset,
    height: (maxRowIndex - minRowIndex + 1) * geometry.rowHeight,
  })
}

export function hitTestGrid(
  geometry: GridGeometry,
  viewportX: number,
  viewportY: number,
  visibleRowCount: number,
):
  | Readonly<{ kind: 'corner' }>
  | Readonly<{ kind: 'row'; rowIndex: number }>
  | Readonly<{ kind: 'column'; columnKey: string }>
  | Readonly<{ kind: 'cell'; rowIndex: number; columnKey: string }>
  | null {
  const contentX = viewportX + geometry.scrollLeft
  const contentY = viewportY + geometry.scrollTop
  const inIndicator = viewportX < geometry.rowIndicatorWidth
  const inHeader = viewportY < geometry.headerHeight

  if (inIndicator && inHeader) return Object.freeze({ kind: 'corner' })

  if (inHeader) {
    const column = findColumnAtOffset(geometry.columns, contentX - geometry.rowIndicatorWidth)
    return column ? Object.freeze({ kind: 'column', columnKey: column.key }) : null
  }

  const rowIndex = Math.floor((contentY - geometry.headerHeight) / geometry.rowHeight)
  if (rowIndex < 0 || rowIndex >= visibleRowCount) return null
  if (inIndicator) return Object.freeze({ kind: 'row', rowIndex })

  const column = findColumnAtOffset(geometry.columns, contentX - geometry.rowIndicatorWidth)
  return column ? Object.freeze({ kind: 'cell', rowIndex, columnKey: column.key }) : null
}

function resolveColumnWidths(layouts: readonly (GridColumnLayout | undefined)[], availableWidth: number): number[] {
  const widths = layouts.map((layout) => clamp(
    layout?.basis ?? DEFAULT_COLUMN_BASIS,
    layout?.min ?? DEFAULT_COLUMN_MIN,
    layout?.max ?? Number.POSITIVE_INFINITY,
  ))
  let remaining = availableWidth - widths.reduce((total, width) => total + width, 0)
  if (remaining <= 0) return widths.map(roundLayoutPixel)

  const candidates = new Set(layouts.flatMap((layout, index) => (layout?.flex ?? 0) > 0 ? [index] : []))
  while (remaining > 0.01 && candidates.size > 0) {
    const totalFlex = [...candidates].reduce((total, index) => total + (layouts[index]?.flex ?? 0), 0)
    if (totalFlex <= 0) break
    let consumed = 0
    for (const index of candidates) {
      const layout = layouts[index]
      const share = remaining * ((layout?.flex ?? 0) / totalFlex)
      const max = layout?.max ?? Number.POSITIVE_INFINITY
      const next = Math.min(max, (widths[index] ?? 0) + share)
      consumed += next - (widths[index] ?? 0)
      widths[index] = next
      if (next >= max - 0.01) candidates.delete(index)
    }
    if (consumed <= 0.01) break
    remaining -= consumed
  }

  return widths.map(roundLayoutPixel)
}

function findColumnAtOffset(columns: readonly GridColumnGeometry[], offset: number) {
  if (offset < 0) return undefined
  return columns.find((column) => offset >= column.offset && offset < column.offset + column.width)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function roundLayoutPixel(value: number) {
  return Math.round(value * 1000) / 1000
}

function formatPixel(value: number) {
  return `${roundLayoutPixel(value)}px`
}
