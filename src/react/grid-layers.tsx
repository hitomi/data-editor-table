import { createPortal } from 'react-dom'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'

import type { GridRuntimeReactView } from '../cell-types/react-view-contracts.js'
import {
  GRID_FILL_HANDLE_HIT_SIZE,
  GRID_FILL_HANDLE_SIZE,
  GRID_SELECTION_STROKE_WIDTH,
} from '../layout/grid-geometry.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import type {
  GridCompiledColumn,
  GridEditSession,
  GridInteractionState,
  GridLayoutState,
  GridRange,
  GridRowKey,
  GridSourceStatus,
} from '../model/grid-model.js'
import type { GridDomEffectAdapter } from './dom-effect-adapter.js'

type GridPortalThemeStyle = CSSProperties & Record<`--grid-${string}`, string>

type GridPortalThemeValue = Readonly<{
  ownerId: string | null
  style: GridPortalThemeStyle
}>

const GridPortalThemeContext = createContext<GridPortalThemeValue>({
  ownerId: null,
  style: {},
})

type GridCellEditorPopoverPosition = Readonly<{ left: number; top: number }>

/** Body-level, theme-aware popover for registered cell editors that need room beyond one row. */
export function GridCellEditorPopover({
  anchor,
  ariaLabel,
  children,
  onCancel,
}: {
  anchor: RefObject<HTMLElement | null>
  ariaLabel: string
  children: ReactNode
  onCancel: () => void
}) {
  const portal = useContext(GridPortalThemeContext)
  const content = useRef<HTMLDivElement>(null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  const [position, setPosition] = useState<GridCellEditorPopoverPosition | null>(null)
  const container = typeof document === 'undefined' ? null : document.body

  useLayoutEffect(() => {
    const anchorNode = anchor.current
    const contentNode = content.current
    if (!anchorNode || !contentNode) return
    const update = () => {
      const anchorRect = anchorNode.getBoundingClientRect()
      const contentRect = contentNode.getBoundingClientRect()
      const inset = 8
      const gap = 5
      const maxLeft = Math.max(inset, window.innerWidth - contentRect.width - inset)
      const left = Math.min(maxLeft, Math.max(inset, anchorRect.left))
      const below = anchorRect.bottom + gap
      const above = anchorRect.top - contentRect.height - gap
      const requestedTop = below + contentRect.height <= window.innerHeight - inset || above < inset ? below : above
      const maxTop = Math.max(inset, window.innerHeight - contentRect.height - inset)
      const top = Math.min(maxTop, Math.max(inset, requestedTop))
      setPosition((current) => current?.left === left && current.top === top ? current : { left, top })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(anchorNode)
    observer.observe(contentNode)
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    queueMicrotask(() => queueMicrotask(() => contentNode.querySelector<HTMLElement>('[role="option"][tabindex="0"], input:not(:disabled), button:not(:disabled), select:not(:disabled)')?.focus()))
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  useLayoutEffect(() => {
    const isInside = (target: EventTarget | null) => target instanceof Node
      && Boolean(anchor.current?.contains(target) || content.current?.contains(target))
    const pointerDown = (event: globalThis.PointerEvent) => {
      if (isInside(event.target)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const click = (event: globalThis.MouseEvent) => {
      if (isInside(event.target)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel.current()
    }
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', keyDown, true)
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', keyDown, true)
    }
  }, [anchor])

  if (!container) return null
  return createPortal(<div
    aria-label={ariaLabel}
    className="business-grid-portal business-grid-cell-editor-popover"
    data-grid-pointer-owner={portal.ownerId ?? undefined}
    ref={content}
    role="dialog"
    style={{
      ...portal.style,
      left: position?.left ?? 0,
      top: position?.top ?? 0,
      visibility: position ? 'visible' : 'hidden',
    }}
    onKeyDown={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
  >{children}</div>, container)
}

/** Keeps body-level portals on the same resolved theme as their grid root. */
export function GridPortalThemeBridge({
  children,
  ownerId,
  root,
}: {
  children: ReactNode
  ownerId: string
  root: RefObject<HTMLElement | null>
}) {
  const [theme, setTheme] = useState<GridPortalThemeStyle>({})
  const refresh = useCallback(() => {
    const next = readPortalTheme(root.current)
    setTheme((current) => equalPortalTheme(current, next) ? current : next)
  }, [root])
  useLayoutEffect(refresh)
  useEffect(() => {
    const node = root.current
    if (!node) return
    const observer = new MutationObserver(refresh)
    let ancestor: HTMLElement | null = node
    while (ancestor) {
      observer.observe(ancestor, {
        attributeFilter: ['class', 'style'],
        attributes: true,
      })
      ancestor = ancestor.parentElement
    }
    window.addEventListener('resize', refresh)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', refresh)
    }
  }, [refresh, root])
  return <GridPortalThemeContext.Provider value={{ ownerId, style: theme }}>{children}</GridPortalThemeContext.Provider>
}

type GridDirtyCellPopoverPosition = Readonly<{
  left: number
  placement: 'above' | 'below'
  top: number
}>

const DIRTY_CELL_POPOVER_GAP = 6
const DIRTY_CELL_POPOVER_VIEWPORT_INSET = 8
const DIRTY_CELL_POPOVER_CLOSE_DELAY = 100

/** Interactive details for one cell-level dirty marker. */
export function GridDirtyCellPopover({
  originalValue,
  originalValueLabel,
  revertLabel,
  triggerLabel,
  onRevert,
}: {
  originalValue: string
  originalValueLabel: string
  revertLabel: string
  triggerLabel: string
  onRevert: () => boolean
}) {
  const portal = useContext(GridPortalThemeContext)
  const container = typeof document === 'undefined' ? null : document.body
  const content = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<number | null>(null)
  const focusContentOnOpen = useRef(false)
  const restoringTriggerFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<GridDirtyCellPopoverPosition | null>(null)
  const popoverId = useId()

  const cancelScheduledClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])
  const close = useCallback((restoreFocus = false) => {
    cancelScheduledClose()
    focusContentOnOpen.current = false
    setOpen(false)
    setPosition(null)
    if (restoreFocus) {
      restoringTriggerFocus.current = true
      queueMicrotask(() => {
        trigger.current?.focus()
        queueMicrotask(() => { restoringTriggerFocus.current = false })
      })
    }
  }, [cancelScheduledClose])
  const scheduleClose = useCallback(() => {
    cancelScheduledClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
      setPosition(null)
    }, DIRTY_CELL_POPOVER_CLOSE_DELAY)
  }, [cancelScheduledClose])
  const show = useCallback((focusContent = false) => {
    cancelScheduledClose()
    focusContentOnOpen.current ||= focusContent
    setOpen(true)
    if (focusContent && open) content.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [cancelScheduledClose, open])

  useLayoutEffect(() => {
    if (!open || !trigger.current || !content.current) return
    const updatePosition = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const popover = content.current?.getBoundingClientRect()
      if (!anchor || !popover) return
      const maxLeft = Math.max(
        DIRTY_CELL_POPOVER_VIEWPORT_INSET,
        window.innerWidth - popover.width - DIRTY_CELL_POPOVER_VIEWPORT_INSET,
      )
      const left = Math.min(
        maxLeft,
        Math.max(
          DIRTY_CELL_POPOVER_VIEWPORT_INSET,
          anchor.left + anchor.width / 2 - popover.width / 2,
        ),
      )
      const belowTop = anchor.bottom + DIRTY_CELL_POPOVER_GAP
      const aboveTop = anchor.top - popover.height - DIRTY_CELL_POPOVER_GAP
      const placement = belowTop + popover.height <= window.innerHeight - DIRTY_CELL_POPOVER_VIEWPORT_INSET
        || aboveTop < DIRTY_CELL_POPOVER_VIEWPORT_INSET
        ? 'below'
        : 'above'
      const requestedTop = placement === 'below' ? belowTop : aboveTop
      const maxTop = Math.max(
        DIRTY_CELL_POPOVER_VIEWPORT_INSET,
        window.innerHeight - popover.height - DIRTY_CELL_POPOVER_VIEWPORT_INSET,
      )
      const top = Math.min(
        maxTop,
        Math.max(DIRTY_CELL_POPOVER_VIEWPORT_INSET, requestedTop),
      )
      setPosition((current) => current?.left === left && current.top === top && current.placement === placement
        ? current
        : { left, placement, top })
    }
    updatePosition()
    const resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(trigger.current)
    resizeObserver.observe(content.current)
    window.addEventListener('resize', updatePosition)
    if (focusContentOnOpen.current) {
      focusContentOnOpen.current = false
      content.current.querySelector<HTMLButtonElement>('button')?.focus()
    }
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePosition)
    }
  }, [open, originalValue])

  useEffect(() => {
    if (!open) return
    const isInside = (target: EventTarget | null) => target instanceof Node
      && (trigger.current?.contains(target) || content.current?.contains(target))
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!isInside(event.target)) close()
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!isInside(event.target)) close()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    const onScroll = () => { close() }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [close, open])
  useEffect(() => () => { cancelScheduledClose() }, [cancelScheduledClose])

  return <>
    <button
      aria-controls={open ? popoverId : undefined}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={triggerLabel}
      className="business-grid__dirty-marker business-grid__dirty-marker-button"
      data-grid-dirty-trigger="true"
      ref={trigger}
      type="button"
      onClick={() => { show() }}
      onFocus={() => {
        if (restoringTriggerFocus.current) return
        show()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          show(true)
        } else if (event.key === 'Escape' && open) {
          event.preventDefault()
          close(true)
        }
      }}
      onKeyUp={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          content.current?.querySelector<HTMLButtonElement>('button')?.focus()
        }
      }}
      onPointerDown={(event) => { event.stopPropagation() }}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') show()
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') scheduleClose()
      }}
    ><span aria-hidden="true" /></button>
    {open && container ? createPortal(<div
      aria-label={originalValueLabel}
      className="business-grid-portal business-grid-dirty-popover"
      data-grid-pointer-owner={portal.ownerId ?? undefined}
      data-placement={position?.placement}
      id={popoverId}
      ref={content}
      role="dialog"
      style={{
        ...portal.style,
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          close(true)
        }
      }}
      onPointerDown={(event) => { event.stopPropagation() }}
      onPointerEnter={cancelScheduledClose}
      onPointerLeave={scheduleClose}
    >
      <span className="business-grid-dirty-popover__label">{originalValueLabel}</span>
      <span className="business-grid-dirty-popover__value">{originalValue}</span>
      <button
        className="business-grid__button"
        type="button"
        onClick={() => {
          if (onRevert()) close()
        }}
      >{revertLabel}</button>
    </div>, container) : null}
  </>
}

export type GridSelectionLayerProps<RowKey extends GridRowKey> = Readonly<{
  interaction: GridInteractionState<RowKey>
  layout: GridLayoutState
  visibleRowKeys: readonly RowKey[]
  fillEnabled: boolean
}>

export function GridSelectionLayer<RowKey extends GridRowKey>({
  interaction,
  layout,
  visibleRowKeys,
  fillEnabled,
}: GridSelectionLayerProps<RowKey>) {
  const columnKeys = layout.columns.map((column) => column.key)
  const ranges = interaction.ranges.flatMap((range, index) => {
    const rect = rangeRect(range, visibleRowKeys, columnKeys, layout)
    return rect ? [{ index, rect }] : []
  })
  const active = interaction.activeRangeIndex === null
    ? undefined
    : ranges.find(({ index }) => index === interaction.activeRangeIndex)
  const preview = interaction.fillPreview
    ? rangeRect(interaction.fillPreview, visibleRowKeys, columnKeys, layout)
    : null
  const activeStroke = active ? strokeCenterRect(active.rect, GRID_SELECTION_STROKE_WIDTH) : null
  const showHandle = fillEnabled
    && interaction.ranges.length === 1
    && activeStroke !== null

  if (ranges.length === 0 && preview === null) return null

  return <svg
    aria-hidden="true"
    className="business-grid__selection-layer"
    data-grid-selection-layer="true"
    width={layout.contentWidth}
    height={layout.contentHeight}
    viewBox={`0 0 ${layout.contentWidth} ${layout.contentHeight}`}
  >
    {ranges.map(({ index, rect }) => <rect
      className="business-grid__selection-fill"
      data-grid-selection-range={index}
      key={index}
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
    />)}
    {activeStroke ? <rect
      className="business-grid__selection-border"
      data-grid-selection-border="true"
      strokeWidth={GRID_SELECTION_STROKE_WIDTH}
      x={activeStroke.x}
      y={activeStroke.y}
      width={activeStroke.width}
      height={activeStroke.height}
    /> : null}
    {preview ? <rect className="business-grid__fill-preview" x={preview.x} y={preview.y} width={preview.width} height={preview.height} /> : null}
    {showHandle && activeStroke ? <g data-grid-fill-handle="true">
      <rect
        className="business-grid__fill-hit"
        data-grid-hit="fill-handle"
        x={activeStroke.x + activeStroke.width - GRID_FILL_HANDLE_HIT_SIZE / 2}
        y={activeStroke.y + activeStroke.height - GRID_FILL_HANDLE_HIT_SIZE / 2}
        width={GRID_FILL_HANDLE_HIT_SIZE}
        height={GRID_FILL_HANDLE_HIT_SIZE}
      />
      <rect
        className="business-grid__fill-handle"
        x={activeStroke.x + activeStroke.width - GRID_FILL_HANDLE_SIZE / 2}
        y={activeStroke.y + activeStroke.height - GRID_FILL_HANDLE_SIZE / 2}
        width={GRID_FILL_HANDLE_SIZE}
        height={GRID_FILL_HANDLE_SIZE}
        rx={1}
      />
    </g> : null}
  </svg>
}

export function GridCollectionStateLayer({
  error,
  filtered,
  messages,
  rowCount,
  status,
}: {
  error: string | null
  filtered: boolean
  messages: GridCollectionStateMessages
  rowCount: number
  status: GridSourceStatus
}) {
  const message = status === 'loading'
    ? messages.loadingRows
    : status === 'refreshing' && rowCount === 0
      ? messages.refreshingRows
      : status === 'error' && rowCount === 0
        ? error ?? messages.rowsLoadError
        : rowCount === 0
          ? filtered ? messages.filteredEmptyRows : messages.emptyRows
          : null
  if (message === null) return null
  return <div
    aria-live="polite"
    className="business-grid__collection-state"
    role={status === 'error' ? 'alert' : status === 'loading' || status === 'refreshing' ? 'status' : undefined}
  >{message}</div>
}

export type GridCollectionStateMessages = Readonly<{
  loadingRows: string
  refreshingRows: string
  rowsLoadError: string
  emptyRows: string
  filteredEmptyRows: string
}>

export function GridEditorPortal<Row, RowKey extends GridRowKey>({
  claimInitialActivation,
  column,
  dom,
  host,
  layout,
  onCancel,
  onCommit,
  onCommitAndMove,
  onDraftChange,
  dirty,
  onEffect,
  onSetComposing,
  row,
  rowIndex,
  session,
  view,
}: {
  claimInitialActivation: () => boolean
  column: GridCompiledColumn<Row>
  dom: GridDomEffectAdapter
  host: Element | null
  layout: GridLayoutState
  onCancel: () => void
  onCommit: () => void
  onCommitAndMove: (direction: 'next' | 'previous') => void
  onDraftChange: (draft: unknown) => void
  dirty: boolean
  onEffect: (name: string, input: unknown) => Readonly<{ id: string; cancel: () => void }>
  onSetComposing: (composing: boolean, finalDraft?: unknown) => void
  row: Row
  rowIndex: number
  session: GridEditSession<RowKey>
  view: GridRuntimeReactView<Row>
}) {
  const columnLayout = layout.columns.find((candidate) => candidate.key === column.key)
  const Editor = view.Editor
  if (!host || !columnLayout || !Editor) return null
  const errorPlacement = editorErrorPlacement(layout, columnLayout, rowIndex)
  const style = editorFrameStyle(layout, columnLayout, rowIndex, errorPlacement)
  return createPortal(<div
    className="business-grid__editor-frame"
    data-grid-selection-boundary="true"
    data-grid-editor="true"
    data-error-inline={session.error ? errorPlacement.inline : undefined}
    data-error-placement={session.error ? errorPlacement.block : undefined}
    data-invalid={session.status === 'invalid' || undefined}
    style={style}
  >
    <Editor
      cancel={onCancel}
      claimInitialActivation={claimInitialActivation}
      columnKey={column.key}
      commit={onCommit}
      commitAndMove={onCommitAndMove}
      composing={session.composing}
      draft={session.draftValue}
      requestEffect={onEffect}
      row={row}
      setComposing={onSetComposing}
      setDraft={onDraftChange}
      typeOptions={column.typeOptions}
      value={session.originalValue}
    />
    {dirty ? <span aria-hidden="true" className="business-grid__dirty-marker" /> : null}
    {session.error ? <div className="business-grid__editor-error" role="alert">{session.error}</div> : null}
    <EditorFocusRegistration dom={dom} />
  </div>, host, encodeCellIdentity(session.cell))
}

export function GridInvalidEditorPortal<Row, RowKey extends GridRowKey>({
  cancelLabel,
  column,
  dom,
  draftLabel,
  host,
  issue,
  layout,
  onCancel,
  rowIndex,
  session,
  sourceValueLabel,
}: {
  cancelLabel: string
  column: GridCompiledColumn<Row>
  dom: GridDomEffectAdapter
  draftLabel: string
  host: Element | null
  issue: string
  layout: GridLayoutState
  onCancel: () => void
  rowIndex: number
  session: GridEditSession<RowKey>
  sourceValueLabel: string
}) {
  const columnLayout = layout.columns.find((candidate) => candidate.key === column.key)
  if (!host || !columnLayout) return null
  const errorPlacement = editorErrorPlacement(layout, columnLayout, rowIndex)
  return createPortal(<div
    className="business-grid__editor-frame business-grid__invalid-editor"
    data-grid-editor="true"
    data-error-inline={errorPlacement.inline}
    data-error-placement={errorPlacement.block}
    data-invalid="true"
    style={editorFrameStyle(layout, columnLayout, rowIndex, errorPlacement)}
  >
    <span className="business-grid__invalid-editor-value" title={draftLabel}>{draftLabel}</span>
    <InvalidEditorCancel cancelLabel={cancelLabel} dom={dom} onCancel={onCancel} />
    <div className="business-grid__editor-error" role="alert"><div>{issue}</div><div>{sourceValueLabel}</div></div>
  </div>, host, encodeCellIdentity(session.cell))
}

type GridDetachedEditorCommon<RowKey extends GridRowKey> = Readonly<{
  cancelLabel: string
  dom: GridDomEffectAdapter
  draftLabel: string
  host: Element | null
  layout: GridLayoutState
  onCancel: () => void
  reason: string
  session: GridEditSession<RowKey>
}>

type GridDetachedEditorMode<Row> =
  | Readonly<{
      kind: 'editable'
      claimInitialActivation: () => boolean
      column: GridCompiledColumn<Row>
      commitLabel: string
      onCommit: () => void
      onDraftChange: (draft: unknown) => void
      onEffect: (name: string, input: unknown) => Readonly<{ id: string; cancel: () => void }>
      onSetComposing: (composing: boolean, finalDraft?: unknown) => void
      row: Row
      view: GridRuntimeReactView<Row>
    }>
  | Readonly<{ kind: 'recovery' }>

export function GridDetachedEditorPortal<Row, RowKey extends GridRowKey>(
  props: GridDetachedEditorCommon<RowKey> & GridDetachedEditorMode<Row>,
) {
  if (!props.host) return null
  if (props.kind === 'editable' && props.view.Editor) {
    const Editor = props.view.Editor
    return createPortal(<div
      className="business-grid__detached-editor"
      data-grid-detached-editor="true"
      data-grid-editor="true"
      data-invalid={props.session.status === 'invalid' || undefined}
      style={detachedEditorFrameStyle(props.layout)}
    >
      <div className="business-grid__detached-editor-main">
        <Editor
          cancel={props.onCancel}
          claimInitialActivation={props.claimInitialActivation}
          columnKey={props.column.key}
          commit={props.onCommit}
          commitAndMove={props.onCommit}
          composing={props.session.composing}
          draft={props.session.draftValue}
          requestEffect={props.onEffect}
          row={props.row}
          setComposing={props.onSetComposing}
          setDraft={props.onDraftChange}
          typeOptions={props.column.typeOptions}
          value={props.session.originalValue}
        />
      </div>
      <div className="business-grid__detached-editor-actions">
        <button
          className="business-grid__button business-grid__button--primary"
          type="button"
          onClick={props.onCommit}
        >{props.commitLabel}</button>
        <button
          aria-label={props.cancelLabel}
          className="business-grid__button"
          title={props.cancelLabel}
          type="button"
          onClick={props.onCancel}
        >{props.cancelLabel}</button>
      </div>
      <div className="business-grid__detached-editor-status" role={props.session.error ? 'alert' : 'status'}>
        {props.session.error ?? props.reason}
      </div>
      <EditorFocusRegistration dom={props.dom} />
    </div>, props.host, `detached:${encodeCellIdentity(props.session.cell)}`)
  }
  return createPortal(<div
    className="business-grid__detached-editor"
    data-grid-detached-editor="true"
    data-grid-editor="true"
    data-invalid="true"
    style={detachedEditorFrameStyle(props.layout)}
  >
    <div className="business-grid__detached-editor-main">
      <span
        className="business-grid__invalid-editor-value"
        title={props.draftLabel}
      >{props.draftLabel}</span>
    </div>
    <div className="business-grid__detached-editor-actions">
      <InvalidEditorCancel
        cancelLabel={props.cancelLabel}
        dom={props.dom}
        onCancel={props.onCancel}
      />
    </div>
    <div className="business-grid__detached-editor-status" role={props.session.error ? 'alert' : 'status'}>
      {props.reason}
    </div>
  </div>, props.host, `detached:${encodeCellIdentity(props.session.cell)}`)
}

function editorFrameStyle(
  layout: GridLayoutState,
  column: GridLayoutState['columns'][number],
  rowIndex: number,
  errorPlacement: ReturnType<typeof editorErrorPlacement>,
) {
  return {
    '--grid-editor-boundary-width': `${GRID_SELECTION_STROKE_WIDTH}px`,
    '--grid-editor-error-inline-offset': `${errorPlacement.inlineOffset}px`,
    '--grid-editor-error-max-inline-size': `${errorPlacement.maxInlineSize}px`,
    left: column.offset,
    top: rowIndex * layout.rowHeight,
    width: column.width,
    height: layout.rowHeight,
  } satisfies CSSProperties & Record<
    '--grid-editor-boundary-width' | '--grid-editor-error-inline-offset' | '--grid-editor-error-max-inline-size',
    string
  >
}

function editorErrorPlacement(
  layout: GridLayoutState,
  column: GridLayoutState['columns'][number],
  rowIndex: number,
) {
  const bodyHeight = Math.max(0, layout.viewportHeight - layout.headerHeight)
  const bodyWidth = Math.max(0, layout.viewportWidth - layout.rowIndicatorWidth)
  const top = rowIndex * layout.rowHeight - layout.scrollTop
  const left = column.offset - layout.scrollLeft
  const spaceAbove = Math.max(0, top)
  const spaceBelow = Math.max(0, bodyHeight - (top + layout.rowHeight))
  const cellInlineEnd = left + column.width
  const anchorStart = clamp(left, 0, bodyWidth)
  const anchorEnd = clamp(cellInlineEnd, 0, bodyWidth)
  const clippedInlineStart = anchorStart - left
  const clippedInlineEnd = cellInlineEnd - anchorEnd
  const preferredWidth = Math.min(280, bodyWidth)
  const inline = left < 0
    ? 'start'
    : cellInlineEnd > bodyWidth || bodyWidth - anchorStart < preferredWidth
      ? 'end'
      : 'start'
  return {
    block: spaceBelow < 48 && spaceAbove > spaceBelow ? 'above' : 'below',
    inline,
    inlineOffset: inline === 'start' ? clippedInlineStart : clippedInlineEnd,
    maxInlineSize: inline === 'start'
      ? Math.max(0, bodyWidth - anchorStart)
      : Math.max(0, anchorEnd),
  } as const
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function detachedEditorFrameStyle(layout: GridLayoutState) {
  const left = layout.rowIndicatorWidth + 8
  return {
    left,
    top: layout.headerHeight + 8,
    width: `min(440px, calc(100% - ${left + 8}px))`,
  } satisfies CSSProperties
}

function InvalidEditorCancel({
  cancelLabel,
  dom,
  onCancel,
}: {
  cancelLabel: string
  dom: GridDomEffectAdapter
  onCancel: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    dom.registerEditor(button.current)
    queueMicrotask(() => { dom.focusEditor() })
    return () => { dom.registerEditor(null) }
  }, [dom])
  return <button
    aria-label={cancelLabel}
    className="business-grid__button"
    ref={button}
    title={cancelLabel}
    type="button"
    onClick={onCancel}
  >{cancelLabel}</button>
}

function EditorFocusRegistration({ dom }: { dom: GridDomEffectAdapter }) {
  const marker = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const editor = marker.current?.parentElement?.querySelector<HTMLElement>('input, textarea, select, button, [contenteditable="true"]') ?? null
    dom.registerEditor(editor)
    if (editor) queueMicrotask(() => { dom.focusEditor(true) })
    return () => { dom.registerEditor(null) }
  }, [dom])
  return <span aria-hidden="true" ref={marker} />
}

export type GridMenuAction = Readonly<{
  id: string
  label: ReactNode
  /** Stable semantic group for custom renderers and non-visual menu hooks. */
  group?: string
  disabled?: boolean
  disabledReason?: string | null
  destructive?: boolean
  /** Preserve focus when the action opens an editor, dialog, or another focus-owning surface. */
  focusAfterRun?: 'restore' | 'preserve'
  run: () => void
}>

export type GridMenuCloseReason = 'action' | 'escape' | 'outside' | 'programmatic'

export type GridContextMenuProps = Readonly<{
  actions: readonly GridMenuAction[]
  onClose: (reason?: GridMenuCloseReason, action?: GridMenuAction) => void
  position: Readonly<{ x: number; y: number }>
  portalContainer?: Element
}>

export function GridContextMenu({
  actions,
  onClose,
  position,
  portalContainer,
}: GridContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState(() => ({ left: position.x, top: position.y }))
  const portal = useContext(GridPortalThemeContext)
  const container = portalContainer ?? (typeof document === 'undefined' ? null : document.body)
  useEffect(() => {
    if (container === null) return
    const close = (event: globalThis.PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose('outside')
    }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose('escape') }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape, true)
    queueMicrotask(() => menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus())
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [container, onClose])
  useLayoutEffect(() => {
    const node = menu.current
    if (!node || typeof window === 'undefined') return
    const update = () => {
      const rect = node.getBoundingClientRect()
      const left = Math.max(8, Math.min(position.x, Math.max(8, window.innerWidth - rect.width - 8)))
      const top = Math.max(8, Math.min(position.y, Math.max(8, window.innerHeight - rect.height - 8)))
      setPlacement((current) => current.left === left && current.top === top ? current : { left, top })
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(node)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [actions, position.x, position.y])
  if (container === null) return null
  const style = {
    ...portal.style,
    left: placement.left,
    top: placement.top,
  } as CSSProperties
  return createPortal(<div
    className="business-grid-portal business-grid-menu"
    data-grid-pointer-owner={portal.ownerId ?? undefined}
    ref={menu}
    role="menu"
    style={style}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === 'Escape') return
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
      if (items.length === 0) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length
      items[next]?.focus()
    }}
  >{actions.flatMap((action, index) => {
    const item = <button
      data-grid-menu-group={action.group}
      data-destructive={action.destructive || undefined}
      disabled={action.disabled}
      key={action.id}
      role="menuitem"
      title={action.disabledReason ?? undefined}
      type="button"
      onClick={() => { action.run(); onClose('action', action) }}
    >{action.label}</button>
    if (index === 0 || action.group === actions[index - 1]?.group) return [item]
    return [<div className="business-grid-menu__separator" key={`separator:${action.id}`} role="separator" />, item]
  })}</div>, container)
}

export function GridDialog({
  ariaLabel,
  children,
  portalContainer,
}: {
  ariaLabel: string
  children: ReactNode
  portalContainer?: Element
}) {
  const portal = useContext(GridPortalThemeContext)
  const dialog = useRef<HTMLElement>(null)
  const container = portalContainer ?? (typeof document === 'undefined' ? null : document.body)
  useLayoutEffect(() => {
    if (container === null) return
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    let active = true
    queueMicrotask(() => {
      if (!active) return
      const node = dialog.current
      const target = node && gridDialogTabStops(node)[0]
      const focusTarget = target ?? node
      focusTarget?.focus({ preventScroll: true })
    })
    return () => {
      active = false
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true })
    }
  }, [container])
  if (container === null) return null
  return createPortal(<div
    className="business-grid-portal business-grid-dialog-backdrop"
    data-grid-pointer-owner={portal.ownerId ?? undefined}
    data-grid-portal="dialog"
    style={portal.style}
    onPointerDown={(event) => event.stopPropagation()}
  ><section
    aria-label={ariaLabel}
    aria-modal="true"
    className="business-grid-dialog"
    ref={dialog}
    role="dialog"
    tabIndex={-1}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key !== 'Tab') return
      const stops = gridDialogTabStops(event.currentTarget)
      if (stops.length === 0) {
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        return
      }
      const first = stops[0]!
      const last = stops.at(-1)!
      const focused = document.activeElement
      if (event.shiftKey && (focused === first || !event.currentTarget.contains(focused))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && focused === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }}
  >{children}</section></div>, container)
}

function gridDialogTabStops(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>([
    'a[href]',
    'button:not(:disabled)',
    'input:not(:disabled)',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))].filter((element) => !element.hidden
    && element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0)
}

function readPortalTheme(root: HTMLElement | null): GridPortalThemeStyle {
  if (!root || typeof window === 'undefined') return {}
  const computed = window.getComputedStyle(root)
  const theme: Record<string, string> = {
    color: computed.color,
    fontFamily: computed.fontFamily,
    fontSize: computed.fontSize,
    fontStyle: computed.fontStyle,
    fontWeight: computed.fontWeight,
    lineHeight: computed.lineHeight,
  }
  for (let index = 0; index < computed.length; index += 1) {
    const name = computed.item(index)
    if (!name.startsWith('--grid-')) continue
    theme[name] = computed.getPropertyValue(name).trim()
  }
  return theme as GridPortalThemeStyle
}

function equalPortalTheme(left: GridPortalThemeStyle, right: GridPortalThemeStyle) {
  const entries = Object.entries(left)
  return entries.length === Object.keys(right).length
    && entries.every(([name, value]) => right[name as keyof GridPortalThemeStyle] === value)
}

type RangeRect = Readonly<{ x: number; y: number; width: number; height: number }>

function rangeRect<RowKey extends GridRowKey>(
  range: GridRange<RowKey>,
  visibleRowKeys: readonly RowKey[],
  columnKeys: readonly string[],
  layout: GridLayoutState,
): RangeRect | null {
  const anchorRow = visibleRowKeys.findIndex((rowKey) => gridRowKeysEqual(rowKey, range.anchor.rowKey))
  const focusRow = visibleRowKeys.findIndex((rowKey) => gridRowKeysEqual(rowKey, range.focus.rowKey))
  const anchorColumn = columnKeys.indexOf(range.anchor.columnKey)
  const focusColumn = columnKeys.indexOf(range.focus.columnKey)
  if (anchorRow < 0 || focusRow < 0 || anchorColumn < 0 || focusColumn < 0) return null
  const minRow = Math.min(anchorRow, focusRow)
  const maxRow = Math.max(anchorRow, focusRow)
  const minColumn = Math.min(anchorColumn, focusColumn)
  const maxColumn = Math.max(anchorColumn, focusColumn)
  const firstColumn = layout.columns[minColumn]
  const lastColumn = layout.columns[maxColumn]
  if (!firstColumn || !lastColumn) return null
  return {
    x: layout.rowIndicatorWidth + firstColumn.offset,
    y: layout.headerHeight + minRow * layout.rowHeight,
    width: lastColumn.offset + lastColumn.width - firstColumn.offset,
    height: (maxRow - minRow + 1) * layout.rowHeight,
  }
}

function strokeCenterRect(rect: RangeRect, strokeWidth: number): RangeRect {
  const inset = strokeWidth / 2
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(0, rect.width - strokeWidth),
    height: Math.max(0, rect.height - strokeWidth),
  }
}
