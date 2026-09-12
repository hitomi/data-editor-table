import type { WorkspaceFill } from './workspace-fill.js'
import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { scopeView } from '../kernel/view.js'
import { canonicalEncodedValue, ownEncodedValue, readDocument } from '../kernel/document.js'
import type { Document, EntityId, FieldId, ResourceValue, ViewSort, ViewPredicate } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import { useWorkspaceSelector } from './workspace-react.js'
import type { WorkspaceGridCell, WorkspaceGridSelection } from './workspace-selection.js'
export type { WorkspaceGridCell } from './workspace-selection.js'

/** Display identity is independent of storage identity. Multiple columns may
 * display the same field without creating another writable field binding. */
export type WorkspaceGridColumn = Readonly<{
  id: string
  fieldId: FieldId
  header: ReactNode
  label: string
  sortable?: boolean
  fill?: WorkspaceFill
  render(context: Readonly<{ entityId: EntityId; document: Document; value: ResourceValue }>): ReactNode
}>
export type WorkspaceGridViewportMessages = Readonly<{
  unavailable: string
  loading: string
  refreshing: string
  loadFailed: string
  refreshFailed: string
  empty: string
  noMatches: string
}>
export type WorkspaceGridRowHeader = Readonly<{ label: string; render(row: Readonly<{ entityId: EntityId; document: Document; index: number }>): ReactNode }>
export type WorkspaceGridViewportProps = Readonly<{
  workspace: Workspace
  columns: readonly WorkspaceGridColumn[]
  caption: ReactNode
  messages: WorkspaceGridViewportMessages
  serverSnapshot?: WorkspaceSnapshot
  rowScope?: ViewPredicate
  rowHeader?: WorkspaceGridRowHeader
  editing?: WorkspaceGridCell | null
  sorting?: Readonly<{ sort: readonly ViewSort[]; disabled: boolean; label(column: string): string;
    priority(position: number): string; describe(direction: 'asc' | 'desc', position: number): string; toggle(fieldId: FieldId, additive: boolean): void }>
  fill?: Readonly<{ enabled: boolean; source: WorkspaceGridCell | null; token: string | null; start(): string | null; drop(cell: WorkspaceGridCell, token: string): void; cancel(): void }>
  interaction?: Readonly<{ selected: WorkspaceGridCell | null; members: Pick<WorkspaceGridSelection, 'rows' | 'columns'>; anchor?: WorkspaceGridCell | null; onSelect(cell: WorkspaceGridCell, extend: boolean, anchor?: WorkspaceGridCell): void; onEdit?(cell: WorkspaceGridCell): void; onSelectExtent?(extent: 'all' | 'row' | 'column', cell: WorkspaceGridCell): void; onCopyShortcut?(cell: WorkspaceGridCell): void; onCopy?(cell: WorkspaceGridCell): string | null; onPaste?(cell: WorkspaceGridCell, text: string): void; onClear?(cell: WorkspaceGridCell): void; onContextMenu?(cell: WorkspaceGridCell, anchor: Readonly<{ x: number; y: number; element: HTMLElement }>): void }>
}>

const selectRows = (snapshot: WorkspaceSnapshot) => ({ view: snapshot.view, authority: snapshot.state.authority, projection: snapshot.projection })
const sameRows = (left: ReturnType<typeof selectRows>, right: ReturnType<typeof selectRows>) => left.view === right.view && left.authority === right.authority && left.projection === right.projection

/** Read boundary for the Workspace grid. No source subscription, business-key
 * lookup, local draft or controller snapshot is involved. It renders all
 * selected rows; future virtualization must preserve access to the rest. */
export function WorkspaceGridViewport({ workspace, columns, caption, messages, serverSnapshot, interaction, sorting, rowScope, rowHeader, fill, editing }: WorkspaceGridViewportProps) {
  const observed = useWorkspaceSelector(workspace, selectRows, { isEqual: sameRows, ...(serverSnapshot ? { serverSnapshot } : {}) })
  const authority = observed.authority
  const scopeKey = rowScope ? canonicalEncodedValue(ownEncodedValue(rowScope)) : ''
  const view = useMemo(() => rowScope ? scopeView(observed.view, observed.projection, workspace.schema, rowScope) : observed.view, [observed.view, observed.projection, workspace, rowScope, scopeKey])
  const viewportElement = useRef<HTMLDivElement>(null)
  const cells = useRef(new Map<string, HTMLTableCellElement>())
  const cellKey = (entityId: EntityId, columnId: string) => JSON.stringify([entityId, columnId])
  useLayoutEffect(() => {
    if (!editing) return
    const cell = cells.current.get(cellKey(editing.entityId, editing.columnId)), viewport = viewportElement.current
    if (!cell || !viewport) return
    const target = cell.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
    // Opening the dock changes the available table height, not the edit target.
    viewport.scrollTop += target.bottom > bounds.bottom ? target.bottom - bounds.bottom : target.top < bounds.top ? target.top - bounds.top : 0
    viewport.scrollLeft += target.right > bounds.right ? target.right - bounds.right : target.left < bounds.left ? target.left - bounds.left : 0
  }, [editing?.entityId, editing?.columnId])
  const cellLocations = useRef(new WeakMap<Element, WorkspaceGridCell>())
  const pointer = useRef<{ id: number; element: HTMLTableCellElement; anchor: WorkspaceGridCell; last: WorkspaceGridCell;
    workspace: Workspace; rows: typeof view.rows; columns: typeof columns; viewport: HTMLDivElement; x: number; y: number; dragging: boolean; frame: number | null } | null>(null)
  function interactiveTarget(target: EventTarget | null) {
    return target instanceof Element && !!target.closest('button, input, textarea, select, a, [contenteditable], [draggable="true"]')
  }
  function endSelection() {
    const gesture = pointer.current
    pointer.current = null
    if (gesture?.frame != null) cancelAnimationFrame(gesture.frame)
    if (gesture?.element.hasPointerCapture(gesture.id)) gesture.element.releasePointerCapture(gesture.id)
  }
  useEffect(() => {
    const cancel = () => endSelection()
    window.addEventListener('blur', cancel)
    return () => { window.removeEventListener('blur', cancel); endSelection() }
  }, [workspace, view.rows, columns])
  function moveSelection(event: PointerEvent<HTMLDivElement>, ending = false) {
    const gesture = pointer.current
    if (!gesture || gesture.id !== event.pointerId) return
    if (!event.buttons && !ending || gesture.workspace !== workspace || gesture.rows !== view.rows || gesture.columns !== columns) { endSelection(); return }
    // A plain click may expand a review panel and move rows underneath the
    // stationary pointer. Only a physical drag may resample its hit target.
    if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return
    gesture.dragging = true
    gesture.x = event.clientX; gesture.y = event.clientY
    const selectAtPointer = () => {
      const viewport = gesture.viewport, rect = viewport.getBoundingClientRect()
      const element = document.elementFromPoint(Math.max(rect.left + 2, Math.min(rect.right - 2, gesture.x)),
        Math.max(rect.top + 2, Math.min(rect.bottom - 2, gesture.y)))?.closest('[role="gridcell"]')
      const cell = element && viewport.contains(element) ? cellLocations.current.get(element) : null
      if (cell && (cell.entityId !== gesture.last.entityId || cell.columnId !== gesture.last.columnId)) {
        gesture.last = cell
        interaction?.onSelect(cell, true, gesture.anchor)
      }
    }
    selectAtPointer()
    if (ending || gesture.frame !== null) return
    const tick = () => {
      if (pointer.current !== gesture) return
      const viewport = gesture.viewport, rect = viewport.getBoundingClientRect()
      const speed = (point: number, start: number, end: number) => point < start + 24 ? -16 : point > end - 24 ? 16 : 0
      viewport.scrollBy(speed(gesture.x, rect.left, rect.right), speed(gesture.y, rect.top, rect.bottom))
      selectAtPointer()
      gesture.frame = requestAnimationFrame(tick)
    }
    tick()
  }
  const selectedRows = useMemo(() => new Set(interaction?.members.rows), [interaction?.members.rows])
  const selectedColumns = useMemo(() => new Set(interaction?.members.columns), [interaction?.members.columns])
  const bindings = useMemo(() => {
    const ids = new Set<string>()
    if (!columns.length) throw new Error('A Workspace grid requires at least one display column.')
    return columns.map(column => {
      if (!column.id || !column.label || ids.has(column.id)) throw new Error('Display columns require unique identities and accessible labels.')
      ids.add(column.id)
      const field = workspace.schema.fields.find(field => field.id === column.fieldId)
      if (!field) throw new Error('A display column must reference a field in the Workspace schema.')
      return { column, field }
    })
  }, [workspace, columns])
  const visibleSelection = interaction?.selected && view.rows.some(row => row.entityId === interaction.selected!.entityId)
    && columns.some(column => column.id === interaction.selected!.columnId) ? interaction.selected : null
  const focusCell = visibleSelection ?? (view.rows[0] && columns[0] ? { entityId: view.rows[0].entityId, columnId: columns[0].id } : null)
  function navigate(event: KeyboardEvent<HTMLTableCellElement>, rowIndex: number, columnIndex: number) {
    if (!interaction || event.target !== event.currentTarget || event.altKey) return
    if (event.key === 'Escape' && pointer.current) { event.preventDefault(); endSelection(); return }
    if (fill?.token && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.key === 'Escape') { event.preventDefault(); fill.cancel(); return }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (!event.repeat && !event.nativeEvent.isComposing) fill.drop({ entityId: view.rows[rowIndex]!.entityId, columnId: columns[columnIndex]!.id }, fill.token)
        return
      }
    }
    if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && !event.ctrlKey && !event.metaKey && interaction.onContextMenu) {
      event.preventDefault()
      if (event.repeat || event.nativeEvent.isComposing) return
      const rect = event.currentTarget.getBoundingClientRect()
      interaction.onContextMenu({ entityId: view.rows[rowIndex]!.entityId, columnId: columns[columnIndex]!.id }, { x: rect.left, y: rect.bottom, element: event.currentTarget })
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !event.ctrlKey && !event.metaKey && !event.shiftKey && interaction.onClear) {
      event.preventDefault()
      if (!event.repeat && !event.nativeEvent.isComposing) interaction.onClear({ entityId: view.rows[rowIndex]!.entityId, columnId: columns[columnIndex]!.id })
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && interaction.onCopyShortcut) {
      event.preventDefault()
      interaction.onCopyShortcut({ entityId: view.rows[rowIndex]!.entityId, columnId: columns[columnIndex]!.id })
      return
    }
    const extent = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' ? 'all'
      : event.key === ' ' && (event.ctrlKey || event.metaKey) ? 'column' : event.key === ' ' && event.shiftKey ? 'row' : null
    if (extent && interaction.onSelectExtent) {
      event.preventDefault()
      interaction.onSelectExtent(extent, { entityId: view.rows[rowIndex]!.entityId, columnId: columns[columnIndex]!.id })
      return
    }
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && interaction.onEdit && (event.key === 'Enter' || event.key === 'F2')) {
      event.preventDefault()
      if (!event.repeat && !event.nativeEvent.isComposing) interaction.onEdit({ entityId: view.rows[rowIndex]!.entityId, columnId: columns[columnIndex]!.id })
      return
    }
    if (event.metaKey) return
    let nextRow = rowIndex, nextColumn = columnIndex
    switch (event.key) {
      case 'Enter': case ' ': break
      case 'ArrowUp': nextRow--; break
      case 'ArrowDown': nextRow++; break
      case 'ArrowLeft': nextColumn--; break
      case 'ArrowRight': nextColumn++; break
      case 'Home': nextColumn = 0; if (event.ctrlKey) nextRow = 0; break
      case 'End': nextColumn = columns.length - 1; if (event.ctrlKey) nextRow = view.rows.length - 1; break
      default: return
    }
    event.preventDefault()
    const row = view.rows[Math.max(0, Math.min(view.rows.length - 1, nextRow))], column = columns[Math.max(0, Math.min(columns.length - 1, nextColumn))]
    if (!row || !column) return
    interaction.onSelect({ entityId: row.entityId, columnId: column.id }, event.shiftKey)
    cells.current.get(cellKey(row.entityId, column.id))?.focus()
  }
  const complete = authority.content.kind === 'complete'
  const status = authority.read.kind === 'loading' ? complete ? messages.refreshing : messages.loading
    : authority.read.kind === 'failed' ? complete ? messages.refreshFailed : messages.loadFailed
      : !complete ? messages.unavailable : null
  const empty = complete && authority.read.kind === 'idle' && !view.rows.length
    ? view.total ? messages.noMatches : messages.empty : null
  return <div className="business-grid__workspace-viewport" ref={viewportElement}
    onPointerMove={event => moveSelection(event)}
    onPointerUp={event => { if (pointer.current?.id === event.pointerId) { moveSelection(event, true); endSelection() } }}
    onPointerCancel={event => { if (pointer.current?.id === event.pointerId) endSelection() }}
    onLostPointerCapture={event => { if (pointer.current?.id === event.pointerId) endSelection() }}>

    {status ? <p role={authority.read.kind === 'failed' ? 'alert' : 'status'}>{status}</p> : null}
    <table role={interaction ? 'grid' : undefined} aria-multiselectable={interaction ? true : undefined} aria-busy={authority.read.kind === 'loading'}>
      <caption>{caption}</caption>
      <thead><tr>{rowHeader ? <th scope="col">{rowHeader.label}</th> : null}{bindings.map(({ column }) => {
        const index = sorting?.sort.findIndex(sort => sort.fieldId === column.fieldId) ?? -1
        const direction = index < 0 ? null : sorting!.sort[index]!.direction
        return <th key={column.id} scope="col" aria-label={column.label}
          aria-sort={index === 0 ? direction === 'asc' ? 'ascending' : 'descending' : index > 0 ? 'other' : undefined}>
          {column.sortable && sorting ? <button type="button" aria-disabled={sorting.disabled} aria-label={sorting.label(column.label)}
            aria-description={direction ? sorting.describe(direction, index + 1) : undefined}
            onClick={event => { if (!sorting.disabled) sorting.toggle(column.fieldId, event.shiftKey) }}>{column.header}
            {direction ? <span>{direction === 'asc' ? ' ↑ ' : ' ↓ '}{sorting.priority(index + 1)}</span> : null}
          </button> : column.header}
        </th>
      })}</tr></thead>
      <tbody>{view.rows.map((row, rowIndex) => <tr key={row.entityId}>
        {rowHeader ? <th scope="row">{rowHeader.render({ entityId: row.entityId, document: row.preview!, index: rowIndex })}</th> : null}
        {bindings.map(({ column, field }, columnIndex) => <td key={column.id} role={interaction ? 'gridcell' : undefined}
          aria-selected={interaction ? selectedRows.has(row.entityId) && selectedColumns.has(column.id) : undefined}
          tabIndex={interaction ? focusCell?.entityId === row.entityId && focusCell.columnId === column.id ? 0 : -1 : undefined}
          ref={cell => { const key = cellKey(row.entityId, column.id); if (cell) { cells.current.set(key, cell); cellLocations.current.set(cell, { entityId: row.entityId, columnId: column.id }) } else cells.current.delete(key) }}
          onPointerDown={event => {
            if (!interaction || event.button !== 0 || event.isPrimary === false || interactiveTarget(event.target) || fill?.token) return
            const cell = { entityId: row.entityId, columnId: column.id }
            const anchor = event.shiftKey ? interaction.anchor ?? interaction.selected ?? cell : cell
            interaction.onSelect(cell, event.shiftKey, anchor)
            // Touch keeps native page scrolling; mouse/pen capture a range gesture.
            if (event.pointerType === 'touch') return
            event.preventDefault()
            event.currentTarget.focus({ preventScroll: true })
            endSelection()
            pointer.current = { id: event.pointerId, element: event.currentTarget, anchor, last: cell, workspace, rows: view.rows, columns, viewport: event.currentTarget.closest<HTMLDivElement>('.business-grid__workspace-viewport')!, x: event.clientX, y: event.clientY, dragging: false, frame: null }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onDoubleClick={event => {
            if (!interaction?.onEdit || interactiveTarget(event.target) || fill?.token) return
            event.preventDefault()
            interaction?.onEdit?.({ entityId: row.entityId, columnId: column.id })
          }}
          onContextMenu={event => {
            if (!interaction?.onContextMenu || interactiveTarget(event.target)) return
            event.preventDefault()
            interaction.onContextMenu({ entityId: row.entityId, columnId: column.id }, { x: event.clientX, y: event.clientY, element: event.currentTarget })
          }}
          onCopy={event => {
            if (!interaction?.onCopy || event.target !== event.currentTarget) return
            event.preventDefault()
            const text = interaction.onCopy({ entityId: row.entityId, columnId: column.id })
            if (text !== null) event.clipboardData.setData('text/plain', text)
          }}
          onPaste={event => {
            if (!interaction?.onPaste || event.target !== event.currentTarget || !event.clipboardData.types.includes('text/plain')) return
            const text = event.clipboardData.getData('text/plain')
            event.preventDefault()
            interaction.onPaste({ entityId: row.entityId, columnId: column.id }, text)
          }}
          onDragOver={event => {
            if (fill?.token && event.dataTransfer.types.includes('application/x-data-editor-fill')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }
          }}
          onDrop={event => {
            if (!fill?.token || event.dataTransfer.getData('application/x-data-editor-fill') !== fill.token) return
            event.preventDefault(); event.stopPropagation()
            fill.drop({ entityId: row.entityId, columnId: column.id }, fill.token)
          }}
          onClick={event => {
            if (event.target === event.currentTarget && fill?.token) fill.drop({ entityId: row.entityId, columnId: column.id }, fill.token)
            else if (event.detail === 0 && !interactiveTarget(event.target)) interaction?.onSelect({ entityId: row.entityId, columnId: column.id }, event.shiftKey)
          }}
          onKeyDown={event => navigate(event, rowIndex, columnIndex)}>
          {column.render({ entityId: row.entityId, document: row.preview!, value: readDocument(row.preview!, field.path) })}
          {fill?.source?.entityId === row.entityId && fill.source.columnId === column.id ? <span className="business-grid__fill-handle" aria-hidden="true" draggable={fill.enabled}
            onClick={event => event.stopPropagation()}
            onDragStart={event => {
              event.stopPropagation()
              const token = fill.start()
              if (!token) { event.preventDefault(); return }
              event.dataTransfer.setData('application/x-data-editor-fill', token); event.dataTransfer.effectAllowed = 'copy'
            }}
            onDragEnd={() => fill.cancel()} /> : null}
        </td>)}
      </tr>)}</tbody>
    </table>
    {empty ? <p role="status">{empty}</p> : null}
  </div>
}
