import { WorkspaceSelectionLayer } from './workspace-selection-layer.js'
import { SortIcon } from './workspace-grid-icons.js'
import { observeResize } from './workspace-resize.js'
import type { WorkspaceFill } from './workspace-fill.js'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { projectView, scopeView } from '../kernel/view.js'
import { canonicalEncodedValue, ownEncodedValue, readDocument } from '../kernel/document.js'
import type { Document, EntityId, FieldId, ResourceValue, ViewId, ViewSort, ViewPredicate } from '../kernel/model.js'
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
  width?: number
  minWidth?: number
  /** Share of unused viewport width; manually resized columns stop growing. */
  flex?: number
  align?: 'start' | 'center' | 'end'
  sortable?: boolean
  fill?: WorkspaceFill
  render(context: Readonly<{ entityId: EntityId; document: Document; value: ResourceValue }>): ReactNode
}>
export type WorkspaceGridViewportMessages = Readonly<{
  selectAll?: string
  selectRow?(index: number): string
  selectColumn?(label: string): string
  unavailable: string
  loading: string
  refreshing: string
  loadFailed: string
  refreshFailed: string
  empty: string
  noMatches: string
}>
export type WorkspaceGridRowHeader = Readonly<{ label: string; width?: number; render(row: Readonly<{ entityId: EntityId; document: Document; index: number }>): ReactNode }>
export type WorkspaceGridViewportProps = Readonly<{
  workspace: Workspace
  viewId?: ViewId
  columns: readonly WorkspaceGridColumn[]
  caption: ReactNode
  messages: WorkspaceGridViewportMessages
  serverSnapshot?: WorkspaceSnapshot
  rowScope?: ViewPredicate
  rowHeader?: WorkspaceGridRowHeader
  renderHeaderControl?(column: WorkspaceGridColumn): ReactNode
  renderControl?(cell: WorkspaceGridCell, value: ResourceValue): ReactNode
  renderAdornment?(cell: WorkspaceGridCell): ReactNode
  editing?: WorkspaceGridCell | null
  sorting?: Readonly<{ sort: readonly ViewSort[]; disabled: boolean; label(column: string): string;
    priority(position: number): string; describe(direction: 'asc' | 'desc', position: number): string; toggle(fieldId: FieldId, additive: boolean): void }>
  fill?: Readonly<{ enabled: boolean; source: WorkspaceGridCell | null; token: string | null; start(): string | null; drop(cell: WorkspaceGridCell, token: string): void; cancel(): void }>
  interaction?: Readonly<{ selectionPending?(): boolean; selected: WorkspaceGridCell | null; members: Pick<WorkspaceGridSelection, 'rows' | 'columns'>; ranges?: readonly Pick<WorkspaceGridSelection, 'rows' | 'columns'>[]; anchor?: WorkspaceGridCell | null; onSelect(cell: WorkspaceGridCell, extend: boolean, anchor?: WorkspaceGridCell, additive?: boolean): boolean | void; onEdit?(cell: WorkspaceGridCell, initialText?: string): void; onSelectExtent?(extent: 'all' | 'row' | 'column', cell: WorkspaceGridCell, extend?: boolean, additive?: boolean, anchor?: WorkspaceGridCell): boolean | void; acceptsFile?(cell: WorkspaceGridCell): boolean; onFileDrop?(cell: WorkspaceGridCell, file: File): void; onCopyShortcut?(cell: WorkspaceGridCell): void; onCopy?(cell: WorkspaceGridCell): string | null; onPaste?(cell: WorkspaceGridCell, text: string): void; onClear?(cell: WorkspaceGridCell): void; onContextMenu?(cell: WorkspaceGridCell, anchor: Readonly<{ x: number; y: number; element: HTMLElement }>): void }>
}>

const selectRows = (snapshot: WorkspaceSnapshot) => ({ state: snapshot.state, view: snapshot.view, authority: snapshot.state.authority, projection: snapshot.projection })
const sameRows = (left: ReturnType<typeof selectRows>, right: ReturnType<typeof selectRows>) => left.state === right.state && left.view === right.view && left.authority === right.authority && left.projection === right.projection

/** Read boundary for the Workspace grid. No source subscription, business-key
 * lookup, local draft or controller snapshot is involved. It renders all
 * selected rows; future virtualization must preserve access to the rest. */
export function WorkspaceGridViewport({ workspace, viewId, columns, caption, messages, serverSnapshot, interaction, sorting, rowScope, rowHeader, fill, editing, renderControl, renderAdornment, renderHeaderControl }: WorkspaceGridViewportProps) {
  const observed = useWorkspaceSelector(workspace, selectRows, { isEqual: sameRows, ...(serverSnapshot ? { serverSnapshot } : {}) })
  const contentId = useId()
  const authority = observed.authority
  const scopeKey = rowScope ? canonicalEncodedValue(ownEncodedValue(rowScope)) : ''
  const view = useMemo(() => {
    const queryView = viewId === undefined ? observed.view : projectView(observed.state, workspace.schema, observed.projection, viewId)
    return rowScope ? scopeView(queryView, observed.projection, workspace.schema, rowScope) : queryView
  }, [observed, workspace, viewId, rowScope, scopeKey])
  const rowHeaderWidth = rowHeader?.width ?? 44
  if (!Number.isFinite(rowHeaderWidth) || rowHeaderWidth <= 0) throw new Error('Row header width must be a positive finite number.')
  const viewportElement = useRef<HTMLDivElement>(null)
  const surfaceElement = useRef<HTMLDivElement>(null)
  const tableElement = useRef<HTMLTableElement>(null)
  const cells = useRef(new Map<string, HTMLTableCellElement>())
  const cellKey = (entityId: EntityId, columnId: string) => JSON.stringify([entityId, columnId])
  useLayoutEffect(() => {
    if (!editing) return
    const cell = cells.current.get(cellKey(editing.entityId, editing.columnId)), viewport = viewportElement.current
    if (!cell || !viewport) return
    const target = cell.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
    // Scroll the captured edit target into view without changing its identity.
    viewport.scrollTop += target.bottom > bounds.bottom ? target.bottom - bounds.bottom : target.top < bounds.top ? target.top - bounds.top : 0
    viewport.scrollLeft += target.right > bounds.right ? target.right - bounds.right : target.left < bounds.left ? target.left - bounds.left : 0
  }, [editing?.entityId, editing?.columnId])
  const activeClick = useRef<WorkspaceGridCell | null>(null)
  const cellLocations = useRef(new WeakMap<Element, WorkspaceGridCell>())
  const [fillPreview, setFillPreview] = useState<Readonly<{ rows: readonly EntityId[]; columns: readonly string[] }> | null>(null)
  const pointer = useRef<{ fillToken?: string; fillAxis?: 'vertical' | 'horizontal'; fillSource?: Readonly<{ rows: readonly EntityId[]; columns: readonly string[] }>; id: number; element: HTMLElement; extent?: 'row' | 'column'; anchor: WorkspaceGridCell; last: WorkspaceGridCell;
    workspace: Workspace; rows: typeof view.rows; columns: typeof columns; viewport: HTMLDivElement; x: number; y: number; dragging: boolean; frame: number | null } | null>(null)
  function interactiveTarget(target: EventTarget | null) {
    return target instanceof Element && !!target.closest('button, input, textarea, select, a, [contenteditable], [draggable="true"]')
  }
  const rowOrder = JSON.stringify(view.rows.map(row => row.entityId))
  function endSelection(cancelFill = true) {
    const gesture = pointer.current
    pointer.current = null
    if (gesture?.fillToken) { setFillPreview(null); if (cancelFill) fill?.cancel() }
    if (gesture?.frame != null) cancelAnimationFrame(gesture.frame)
    if (gesture?.element.hasPointerCapture(gesture.id)) gesture.element.releasePointerCapture(gesture.id)
  }
  useEffect(() => {
    const cancel = () => { endSelection(); resizing.current = null }
    window.addEventListener('blur', cancel)
    return () => { window.removeEventListener('blur', cancel); endSelection() }
  }, [workspace, rowOrder, columns])
  function moveSelection(event: PointerEvent<HTMLDivElement>, ending = false) {
    const gesture = pointer.current
    if (!gesture || gesture.id !== event.pointerId) return
    if (!event.buttons && !ending || gesture.workspace !== workspace || gesture.rows.length !== view.rows.length || gesture.rows.some((row, index) => row.entityId !== view.rows[index]?.entityId) || gesture.columns !== columns) { endSelection(); return }
    // A plain click may expand a review panel and move rows underneath the
    // stationary pointer. Only a physical drag may resample its hit target.
    if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return
    activeClick.current = null
    gesture.dragging = true
    gesture.x = event.clientX; gesture.y = event.clientY
    const selectAtPointer = () => {
      const viewport = gesture.viewport, rect = viewport.getBoundingClientRect()
      const element = document.elementFromPoint(Math.max(rect.left + 2, Math.min(rect.right - 2, gesture.x)),
        Math.max(rect.top + 2, Math.min(rect.bottom - 2, gesture.y)))?.closest('[role="gridcell"], [data-selection-column], [data-selection-row]')
      let cell = element && viewport.contains(element) ? cellLocations.current.get(element) ?? (element instanceof HTMLElement && element.dataset.selectionColumn ? { entityId: view.rows[0]!.entityId, columnId: element.dataset.selectionColumn } : element instanceof HTMLElement && element.dataset.selectionRow ? { entityId: element.dataset.selectionRow as EntityId, columnId: columns[0]!.id } : null) : null
      if (cell && gesture.fillToken && gesture.fillSource) {
        const source = gesture.fillSource, rows = view.rows.map(row => row.entityId), ids = columns.map(column => column.id)
        const top = rows.indexOf(source.rows[0]!), bottom = rows.indexOf(source.rows.at(-1)!), left = ids.indexOf(source.columns[0]!), right = ids.indexOf(source.columns.at(-1)!)
        const row = rows.indexOf(cell.entityId), column = ids.indexOf(cell.columnId)
        const vertical = Math.max(top - row, row - bottom, 0), horizontal = Math.max(left - column, column - right, 0)
        if (!gesture.fillAxis && (vertical || horizontal)) gesture.fillAxis = vertical >= horizontal ? 'vertical' : 'horizontal'
        cell = gesture.fillAxis === 'vertical' ? { entityId: cell.entityId, columnId: source.columns.at(-1)! }
          : gesture.fillAxis === 'horizontal' ? { entityId: source.rows.at(-1)!, columnId: cell.columnId } : gesture.anchor
        if (cell.entityId !== gesture.last.entityId || cell.columnId !== gesture.last.columnId) setFillPreview({
          rows: gesture.fillAxis === 'vertical' ? rows.slice(Math.min(top, row), Math.max(bottom, row) + 1) : source.rows,
          columns: gesture.fillAxis === 'horizontal' ? ids.slice(Math.min(left, column), Math.max(right, column) + 1) : source.columns,
        })
        gesture.last = cell
        return
      }
      if (cell && (cell.entityId !== gesture.last.entityId || cell.columnId !== gesture.last.columnId)) {
        gesture.last = cell
        if (gesture.extent) interaction?.onSelectExtent?.(gesture.extent, cell, true, false, gesture.anchor)
        else interaction?.onSelect(cell, true, gesture.anchor)
      }
    }
    selectAtPointer()
    if (ending || gesture.frame !== null) return
    // Keep the same scrolling speed when rendering drops frames. A bounded
    // elapsed time also avoids a large jump after a suspended browser tab.
    let previousFrame = performance.now() - 1000 / 60
    const tick = (now: number) => {
      if (pointer.current !== gesture) return
      const viewport = gesture.viewport, rect = viewport.getBoundingClientRect()
      const speed = (point: number, start: number, end: number) => point < start + 24 ? -16 : point > end - 24 ? 16 : 0
      const elapsed = Math.min(100, Math.max(0, now - previousFrame)) / (1000 / 60)
      previousFrame = now
      viewport.scrollBy(speed(gesture.x, rect.left, rect.right) * elapsed, speed(gesture.y, rect.top, rect.bottom) * elapsed)
      selectAtPointer()
      gesture.frame = requestAnimationFrame(tick)
    }
    tick(performance.now())
  }
  function beginExtent(event: PointerEvent<HTMLButtonElement>, extent: 'row' | 'column', cell: WorkspaceGridCell) {
    if (event.button !== 0 || !interaction || !viewportElement.current) return
    event.preventDefault(); endSelection()
    const anchor = event.shiftKey ? interaction.anchor ?? cell : cell
    const selected = interaction.onSelectExtent?.(extent, cell, event.shiftKey, event.ctrlKey || event.metaKey) !== false
    if (!selected && !interaction.selectionPending?.()) return
    if (selected) cells.current.get(cellKey(cell.entityId, cell.columnId))?.focus({ preventScroll: true })
    pointer.current = { id: event.pointerId, element: event.currentTarget, extent, anchor, last: cell, workspace, rows: view.rows, columns,
      viewport: viewportElement.current, x: event.clientX, y: event.clientY, dragging: false, frame: null }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({})
  const [availableWidth, setAvailableWidth] = useState(0)
  useLayoutEffect(() => {
    const element = viewportElement.current
    if (!element) return
    const measure = () => setAvailableWidth(element.clientWidth)
    measure()
    return observeResize([element], measure)
  }, [])
  const resizing = useRef<{ id: number; column: string; start: number; width: number; minimum: number } | null>(null)
  const selectedRows = useMemo(() => new Set(interaction?.members.rows), [interaction?.members.rows])
  const selectedRanges = useMemo(() => interaction?.ranges?.map(range => ({ rows: new Set(range.rows), columns: new Set(range.columns) })), [interaction?.ranges])
  const selectedColumns = useMemo(() => new Set(interaction?.members.columns), [interaction?.members.columns])
  const bindings = useMemo(() => {
    const ids = new Set<string>()
    if (!columns.length) throw new Error('A Workspace grid requires at least one display column.')
    return columns.map(column => {
      if (column.width !== undefined && (!Number.isFinite(column.width) || column.width <= 0)
        || column.minWidth !== undefined && (!Number.isFinite(column.minWidth) || column.minWidth <= 0)) throw new Error('Column widths must be positive finite numbers.')
      if (column.flex !== undefined && (!Number.isFinite(column.flex) || column.flex < 0)) throw new Error('Column flex must be a nonnegative finite number.')
      if (!column.id || !column.label || ids.has(column.id)) throw new Error('Display columns require unique identities and accessible labels.')
      ids.add(column.id)
      const field = workspace.schema.fields.find(field => field.id === column.fieldId)
      if (!field) throw new Error('A display column must reference a field in the Workspace schema.')
      return { column, field }
    })
  }, [workspace, columns])
  const baseWidths = bindings.map(({ column }) => Math.max(column.minWidth ?? 64, widths[column.id] ?? column.width ?? 160))
  const unusedWidth = Math.max(0, availableWidth - 8 - (interaction || rowHeader ? rowHeaderWidth : 0) - baseWidths.reduce((sum, width) => sum + width, 0))
  const flexWeights = bindings.map(({ column }) => widths[column.id] === undefined ? column.flex ?? 0 : 0)
  // Normalize first so even large finite weights cannot overflow their sum.
  const largestWeight = Math.max(1, ...flexWeights)
  const totalWeight = flexWeights.reduce((sum, weight) => sum + weight / largestWeight, 0)
  const displayedWidths = Object.fromEntries(bindings.map(({ column }, index) => [
    column.id, baseWidths[index]! + (totalWeight ? unusedWidth * (flexWeights[index]! / largestWeight / totalWeight) : 0),
  ]))
  const visibleSelection = interaction?.selected && view.rows.some(row => row.entityId === interaction.selected!.entityId)
    && columns.some(column => column.id === interaction.selected!.columnId) ? interaction.selected : null
  const focusCell = visibleSelection ?? (view.rows[0] && columns[0] ? { entityId: view.rows[0].entityId, columnId: columns[0].id } : null)
  const pasteCapture = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => () => { pasteCapture.current?.remove(); pasteCapture.current = null }, [workspace])
  function capturePaste(cell: WorkspaceGridCell) {
    pasteCapture.current?.remove()
    const input = document.createElement('textarea')
    input.className = 'business-grid__visually-hidden'
    input.setAttribute('aria-label', 'Paste from clipboard')
    let disposed = false
    const dispose = () => { if (disposed) return; disposed = true; input.remove(); if (pasteCapture.current === input) pasteCapture.current = null }
    input.addEventListener('paste', event => {
      event.preventDefault(); event.stopPropagation()
      const raw = event.clipboardData?.getData('text/plain') ?? ''
      // WebKit can expose native clipboard text with an empty types list.
      const text = raw !== '' || event.clipboardData?.types.includes('text/plain') ? raw : null
      dispose()
      cells.current.get(cellKey(cell.entityId, cell.columnId))?.focus({ preventScroll: true })
      if (text !== null) interaction?.onPaste?.(cell, text)
    }, { once: true })
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); dispose(); cells.current.get(cellKey(cell.entityId, cell.columnId))?.focus({ preventScroll: true }) } })
    input.addEventListener('blur', dispose, { once: true })
    viewportElement.current?.append(input)
    pasteCapture.current = input
    input.focus({ preventScroll: true })
  }
  function navigate(event: KeyboardEvent<HTMLElement>, rowIndex: number, columnIndex: number) {
    if (!interaction || event.target !== event.currentTarget || event.altKey) return
    // Release the gesture before the owning grid clears its selection on Escape.
    if (event.key === 'Escape' && pointer.current) { endSelection(); return }
    // A keyboard entry point is not an implicit selection or edit target.
    if (!visibleSelection && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) return
    if (fill?.token && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.key === 'Escape') { fill.cancel(); return }
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && interaction.onPaste && !event.repeat) {
      // Firefox and WebKit dispatch native paste only to an editable target.
      // Focus a transient capture before the browser's default paste action.
      capturePaste({ entityId: view.rows[rowIndex]!.entityId, columnId: columns[columnIndex]!.id })
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
    if (!event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing && event.key.length === 1 && interaction.onEdit) {
      event.preventDefault()
      interaction.onEdit({ entityId: view.rows[rowIndex]!.entityId, columnId: columns[columnIndex]!.id }, event.key === ' ' ? undefined : event.key)
      return
    }
    if (event.metaKey) return
    let nextRow = rowIndex, nextColumn = columnIndex
    switch (event.key) {
      case 'Enter': case ' ': break
      case 'Tab': { const next = rowIndex * columns.length + columnIndex + (event.shiftKey ? -1 : 1); nextRow = Math.floor(next / columns.length); nextColumn = (next + columns.length) % columns.length; break }
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
    if (interaction.onSelect({ entityId: row.entityId, columnId: column.id }, event.shiftKey && event.key !== 'Tab') === false) return
    cells.current.get(cellKey(row.entityId, column.id))?.focus()
  }
  const complete = authority.content.kind === 'complete'
  const status = authority.read.kind === 'loading' ? complete ? messages.refreshing : messages.loading
    : authority.read.kind === 'failed' ? complete ? messages.refreshFailed : messages.loadFailed
      : !complete ? messages.unavailable : null
  const empty = complete && authority.read.kind === 'idle' && !view.rows.length
    ? view.total ? messages.noMatches : messages.empty : null
  return <div className="business-grid__workspace-viewport" ref={viewportElement}
    onPointerMove={event => {
      const resize = resizing.current
      if (resize?.id === event.pointerId) setWidths(previous => ({ ...previous, [resize.column]: Math.max(resize.minimum, resize.width + event.clientX - resize.start) }))
      else moveSelection(event)
    }}
    onPointerUp={event => { if (resizing.current?.id === event.pointerId) resizing.current = null; if (pointer.current?.id === event.pointerId) { moveSelection(event, true); const gesture = pointer.current; endSelection(false)
      if (gesture?.fillToken) {
        if (gesture.fillAxis && !(gesture.fillSource?.rows.includes(gesture.last.entityId) && gesture.fillSource.columns.includes(gesture.last.columnId))) fill?.drop(gesture.last, gesture.fillToken); else fill?.cancel()
      }
    } }}
    onPointerCancel={event => { if (resizing.current?.id === event.pointerId) resizing.current = null; if (pointer.current?.id === event.pointerId) endSelection() }}
    onLostPointerCapture={event => { if (resizing.current?.id === event.pointerId) resizing.current = null; if (pointer.current?.id === event.pointerId) endSelection() }}>

    {status ? <p role={authority.read.kind === 'failed' ? 'alert' : 'status'}>{status}</p> : null}
    <div className="business-grid__workspace-grid-surface" ref={surfaceElement}>
    <table ref={tableElement} style={{ tableLayout: 'fixed', width: bindings.reduce((sum, { column }) => sum + displayedWidths[column.id]!, interaction || rowHeader ? rowHeaderWidth : 0) }} tabIndex={interaction ? visibleSelection ? -1 : 0 : undefined} onKeyDown={event => {
      if (focusCell) navigate(event, view.rows.findIndex(row => row.entityId === focusCell.entityId), columns.findIndex(column => column.id === focusCell.columnId))
    }} role={interaction ? 'grid' : undefined} aria-multiselectable={interaction ? true : undefined} aria-busy={authority.read.kind === 'loading'}>
      <caption>{caption}</caption>
      <colgroup>{interaction || rowHeader ? <col style={{ width: rowHeaderWidth }} /> : null}{bindings.map(({ column }) => <col key={column.id} style={{ width: displayedWidths[column.id]! }} />)}</colgroup>
      <thead><tr>{interaction || rowHeader ? <th scope="col">{interaction && view.rows[0] && columns[0] ? <button className="business-grid__workspace-corner" type="button" aria-label={messages.selectAll ?? 'Select all cells'} onPointerDown={event => { if (event.button === 0) { event.preventDefault(); interaction.onSelectExtent?.('all', { entityId: view.rows[0]!.entityId, columnId: columns[0]!.id }) } }} onClick={event => { if (event.detail === 0) interaction.onSelectExtent?.('all', { entityId: view.rows[0]!.entityId, columnId: columns[0]!.id }) }}><span aria-hidden="true" /></button> : rowHeader?.label}</th> : null}{bindings.map(({ column }) => {
        const index = sorting?.sort.findIndex(sort => sort.fieldId === column.fieldId) ?? -1
        const direction = index < 0 ? null : sorting!.sort[index]!.direction
        return <th data-selection-column={column.id} key={column.id} scope="col" aria-label={column.label}
          aria-sort={index === 0 ? direction === 'asc' ? 'ascending' : 'descending' : index > 0 ? 'other' : undefined}>
          {interaction && view.rows[0] ? <button type="button" title={column.label} aria-label={messages.selectColumn?.(column.label) ?? `Select column ${column.label}`}
            onPointerDown={event => beginExtent(event, 'column', { entityId: view.rows[0]!.entityId, columnId: column.id })}
            onClick={event => { if (event.detail === 0) interaction.onSelectExtent?.('column', { entityId: view.rows[0]!.entityId, columnId: column.id }, event.shiftKey, event.ctrlKey || event.metaKey) }}>{column.header}</button> : column.header}
          {column.sortable && sorting ? <button className="business-grid__workspace-sort" data-active={!!direction || undefined} title={sorting.label(column.label)} type="button" aria-disabled={sorting.disabled} aria-label={sorting.label(column.label)}
            aria-description={direction ? sorting.describe(direction, index + 1) : undefined}
            onClick={event => { if (!sorting.disabled) sorting.toggle(column.fieldId, event.shiftKey) }}>
            <SortIcon direction={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined} />
            {direction ? <><span className="business-grid__visually-hidden">{sorting.priority(index + 1)}</span>
              {sorting.sort.length > 1 ? <span aria-hidden="true" className="business-grid__header-action-badge">{index + 1}</span> : null}</> : null}
          </button> : null}
          {renderHeaderControl?.(column)}
          <span role="separator" aria-label={`Resize ${column.label}`} aria-orientation="vertical" tabIndex={0} aria-valuemin={column.minWidth ?? 64} aria-valuenow={displayedWidths[column.id]}
            className="business-grid__workspace-resizer"
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidths(previous => ({ ...previous, [column.id]: Math.max(column.minWidth ?? 64, displayedWidths[column.id]! + (event.key === 'ArrowLeft' ? -10 : 10)) })) } }}
            onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); endSelection(); resizing.current = { id: event.pointerId, column: column.id, start: event.clientX, width: displayedWidths[column.id]!, minimum: column.minWidth ?? 64 }; event.currentTarget.setPointerCapture(event.pointerId) }} />
        </th>
      })}</tr></thead>
      <tbody>{view.rows.map((row, rowIndex) => <tr key={row.entityId}>
        {interaction || rowHeader ? <th data-selection-row={row.entityId} scope="row" className="business-grid__workspace-row-header">
          <div className="business-grid__workspace-row-controls">{interaction && columns[0] ? <button type="button" aria-label={messages.selectRow?.(rowIndex + 1) ?? `Select row ${rowIndex + 1}`}
            onPointerDown={event => beginExtent(event, 'row', { entityId: row.entityId, columnId: columns[0]!.id })}
            onClick={event => { if (event.detail === 0) interaction.onSelectExtent?.('row', { entityId: row.entityId, columnId: columns[0]!.id }, event.shiftKey, event.ctrlKey || event.metaKey) }}>{rowIndex + 1}</button> : null}
          {rowHeader?.render({ entityId: row.entityId, document: row.preview!, index: rowIndex })}</div>
        </th> : null}
        {bindings.map(({ column, field }, columnIndex) => <td key={column.id} data-entity-id={row.entityId} data-column-key={column.id} data-grid-row-index={rowIndex} role={interaction ? 'gridcell' : undefined} aria-labelledby={`${contentId}-${rowIndex}-${columnIndex}`}
          aria-selected={interaction ? (selectedRanges?.length ? selectedRanges.some(range => range.rows.has(row.entityId) && range.columns.has(column.id)) : selectedRows.has(row.entityId) && selectedColumns.has(column.id)) : undefined}
          data-fill-preview={fillPreview?.rows.includes(row.entityId) && fillPreview.columns.includes(column.id) || undefined}
          tabIndex={interaction ? visibleSelection?.entityId === row.entityId && visibleSelection.columnId === column.id ? 0 : -1 : undefined}
          ref={cell => { const key = cellKey(row.entityId, column.id); if (cell) { cells.current.set(key, cell); cellLocations.current.set(cell, { entityId: row.entityId, columnId: column.id }) } else cells.current.delete(key) }}
          onPointerDown={event => {
            if (!interaction || event.button !== 0 || event.isPrimary === false || interactiveTarget(event.target) || fill?.token) return
            const cell = { entityId: row.entityId, columnId: column.id }
            activeClick.current = !event.shiftKey && !event.ctrlKey && !event.metaKey && document.activeElement === event.currentTarget && interaction.selected?.entityId === cell.entityId && interaction.selected.columnId === cell.columnId && (interaction.ranges?.length ?? 1) <= 1 && interaction.members.rows.length <= 1 && interaction.members.columns.length <= 1 ? cell : null
            const anchor = event.shiftKey ? interaction.anchor ?? interaction.selected ?? cell : cell
            const selected = interaction.onSelect(cell, event.shiftKey, anchor, event.ctrlKey || event.metaKey) !== false
            if (!selected) {
              event.preventDefault(); activeClick.current = null
              if (!interaction.selectionPending?.()) return
            }
            // Touch keeps native page scrolling; mouse/pen capture a range gesture.
            if (event.pointerType === 'touch') return
            event.preventDefault()
            if (selected) event.currentTarget.focus({ preventScroll: true })
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
            if (!interaction?.onPaste || event.target !== event.currentTarget) return
            const text = event.clipboardData.getData('text/plain')
            if (!text && !event.clipboardData.types.includes('text/plain')) return
            event.preventDefault()
            interaction.onPaste({ entityId: row.entityId, columnId: column.id }, text)
          }}
          onDragOver={event => {
            if (event.dataTransfer.types.includes('Files') && interaction?.acceptsFile?.({ entityId: row.entityId, columnId: column.id })) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; return }
            if (fill?.token && event.dataTransfer.types.includes('application/x-data-editor-fill')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }
          }}
          onDrop={event => {
            if (event.dataTransfer.types.includes('Files') && interaction?.acceptsFile?.({ entityId: row.entityId, columnId: column.id })) {
              event.preventDefault(); event.stopPropagation()
              const file = event.dataTransfer.files[0]
              if (file) interaction.onFileDrop?.({ entityId: row.entityId, columnId: column.id }, file)
              return
            }
            if (!fill?.token || event.dataTransfer.getData('application/x-data-editor-fill') !== fill.token) return
            event.preventDefault(); event.stopPropagation()
            fill.drop({ entityId: row.entityId, columnId: column.id }, fill.token)
          }}
          onClick={event => {
            if (fill?.token && !interactiveTarget(event.target)) fill.drop({ entityId: row.entityId, columnId: column.id }, fill.token)
            else if (activeClick.current?.entityId === row.entityId && activeClick.current.columnId === column.id && !interactiveTarget(event.target)) { activeClick.current = null; interaction?.onEdit?.({ entityId: row.entityId, columnId: column.id }) }
            else if (event.detail === 0 && !interactiveTarget(event.target)) interaction?.onSelect({ entityId: row.entityId, columnId: column.id }, event.shiftKey)
          }}
          onKeyDown={event => navigate(event, rowIndex, columnIndex)}>
          <span className="business-grid__cell-content" data-align={column.align} id={`${contentId}-${rowIndex}-${columnIndex}`}>{renderControl?.({ entityId: row.entityId, columnId: column.id }, readDocument(row.preview!, field.path)) ?? column.render({ entityId: row.entityId, document: row.preview!, value: readDocument(row.preview!, field.path) })}</span>
          {renderAdornment?.({ entityId: row.entityId, columnId: column.id })}

        </td>)}
      </tr>)}</tbody>
    </table>
    {interaction ? <WorkspaceSelectionLayer surface={surfaceElement} table={tableElement}
      rows={view.rows.map(row => row.entityId)} columns={columns.map(column => column.id)}
      ranges={interaction.ranges ?? [interaction.members]} preview={fillPreview}
      renderHandle={corner => fill?.enabled && fill.source ?           <span className="business-grid__workspace-fill-target" data-grid-fill-handle="true" style={{ left: corner.x - 8, top: corner.y - 8 }} aria-hidden="true" draggable={fill.enabled}
            onClick={event => event.stopPropagation()}
            onPointerDown={event => {
              if (event.button !== 0 || !fill.enabled || !fill.source || !interaction || !viewportElement.current) return
              event.preventDefault(); event.stopPropagation(); endSelection()
              const token = fill.start()
              if (!token) return
              cells.current.get(cellKey(fill.source.entityId, fill.source.columnId))?.focus({ preventScroll: true })
              pointer.current = { id: event.pointerId, element: event.currentTarget, anchor: fill.source, last: fill.source,
                fillToken: token, fillSource: interaction.members, workspace, rows: view.rows, columns, viewport: viewportElement.current,
                x: event.clientX, y: event.clientY, dragging: false, frame: null }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onDragStart={event => {
              if (pointer.current?.fillToken) { event.preventDefault(); return }
              event.stopPropagation()
              const token = fill.start()
              if (!token) { event.preventDefault(); return }
              event.dataTransfer.setData('application/x-data-editor-fill', token); event.dataTransfer.effectAllowed = 'copy'
            }}
            onDragEnd={() => fill.cancel()}>
              <svg width="16" height="16" viewBox="0 0 16 16"><rect className="business-grid__fill-handle" x={4.5} y={4.5} width={7} height={7} rx={1} /></svg>
            </span> : null} /> : null}
    </div>
    {empty ? <p role="status">{empty}</p> : null}
  </div>
}
