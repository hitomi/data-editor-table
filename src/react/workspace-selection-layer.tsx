import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import type { EntityId } from '../kernel/model.js'
import type { WorkspaceGridSelection } from './workspace-selection.js'
import { observeResize } from './workspace-resize.js'

type Range = Pick<WorkspaceGridSelection, 'rows' | 'columns'>
type Rect = Readonly<{ x: number; y: number; width: number; height: number }>
type Geometry = Readonly<{ width: number; height: number; ranges: readonly (readonly Rect[])[]; preview: readonly Rect[] }>

/** Selection geometry follows displayed identities. Sorting can split a captured
 * range into multiple rectangles; never paint across unselected rows or columns.
 * Coordinates share the table's scrolling surface, so scrolling needs no render. */
export function WorkspaceSelectionLayer({ surface, table, rows, columns, ranges, preview, renderHandle }: Readonly<{
  surface: RefObject<HTMLDivElement | null>; table: RefObject<HTMLTableElement | null>
  rows: readonly EntityId[]; columns: readonly string[]; ranges: readonly Range[]; preview: Range | null
  renderHandle?(corner: Readonly<{ x: number; y: number }>): ReactNode
}>) {
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const measure = () => {
    if (!surface.current || !table.current) return
    const origin = surface.current.getBoundingClientRect()
    const cells = new Map([...table.current.querySelectorAll<HTMLTableCellElement>('[role="gridcell"]')]
      .map(cell => [JSON.stringify([cell.dataset.entityId, cell.dataset.columnKey]), cell]))
    const groups = <T,>(order: readonly T[], members: readonly T[]): readonly (readonly T[])[] => {
      const selected = new Set(members), groups: T[][] = []
      let group: T[] | null = null
      for (const id of order) {
        if (!selected.has(id)) { group = null; continue }
        if (!group) { group = []; groups.push(group) }
        group.push(id)
      }
      return groups
    }
    const rectangles = (range: Range): readonly Rect[] => groups(rows, range.rows).flatMap(rowGroup =>
      groups(columns, range.columns).flatMap(columnGroup => {
        const first = cells.get(JSON.stringify([rowGroup[0], columnGroup[0]]))
        const last = cells.get(JSON.stringify([rowGroup.at(-1), columnGroup.at(-1)]))
        if (!first || !last) return []
        const start = first.getBoundingClientRect(), end = last.getBoundingClientRect()
        return [{ x: start.left - origin.left, y: start.top - origin.top, width: end.right - start.left, height: end.bottom - start.top }]
      }))
    const bounds = table.current.getBoundingClientRect()
    const next = { width: bounds.width + 8, height: bounds.height + 8, ranges: ranges.map(rectangles), preview: preview ? rectangles(preview) : [] }
    setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }
  // Measure after React has committed row order, column widths and selection.
  useLayoutEffect(measure)
  useLayoutEffect(() => {
    if (!surface.current || !table.current) return
    return observeResize([surface.current, table.current], measure)
  }, [surface, table, rows, columns, ranges, preview])
  if (!geometry) return null
  const active = geometry.ranges.at(-1) ?? []
  const handle = ranges.length === 1 && active.length === 1
    && ranges[0]!.rows.every(id => rows.includes(id)) && ranges[0]!.columns.every(id => columns.includes(id))
    ? active[0]! : null
  // Preserve the old 2px inset stroke and 7px handle centered on its corner.
  const stroke = (rect: Rect) => ({ x: rect.x + 1, y: rect.y + 1, width: Math.max(0, rect.width - 2), height: Math.max(0, rect.height - 2) })
  return <>
    <svg aria-hidden="true" className="business-grid__selection-layer" data-grid-selection-layer="true"
      width={geometry.width} height={geometry.height} viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
      {geometry.ranges.flatMap((rects, index) => rects.map((rect, part) =>
        <rect key={`${index}:${part}`} className="business-grid__selection-fill" data-grid-selection-range={index} {...rect} />))}
      {active.map((rect, index) => <rect key={index} className="business-grid__selection-border" data-grid-selection-border="true" strokeWidth={2} {...stroke(rect)} />)}
      {geometry.preview.map((rect, index) => <rect key={index} className="business-grid__fill-preview" strokeWidth={1} {...stroke(rect)} />)}
    </svg>
    {handle ? renderHandle?.({ x: handle.x + handle.width - 1, y: handle.y + handle.height - 1 }) : null}
  </>
}
