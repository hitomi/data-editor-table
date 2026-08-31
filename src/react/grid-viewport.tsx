import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'

import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridCellViewPort } from '../cell-types/react-view-contracts.js'
import type { GridController, GridDispatchResult } from '../controller/grid-controller.js'
import { selectedCells } from '../controller/selection-model.js'
import {
  fallbackGridCellText,
  resolveGridCellValue,
} from '../data/runtime-cell-resolver.js'
import { hitTestGrid, type GridGeometry } from '../layout/grid-geometry.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import type {
  GridControllerSnapshot,
  GridHitTarget,
  GridLayoutState,
  GridRowKey,
  GridSort,
} from '../model/grid-model.js'
import {
  reportGridRejectedAction,
  type GridRejectedActionPresenter,
  useGridSelector,
} from './controller-react.js'
import { gridClipboardText } from './clipboard-boundary.js'
import {
  GridCell,
  GridDataRow,
  GridHeaderRow,
  type DataGridRowHeaderActions,
  type GridCellMessages,
} from './grid-cells.js'
import { GridDomEffectAdapter } from './dom-effect-adapter.js'
import {
  GridCollectionStateLayer,
  GridDetachedEditorPortal,
  GridEditorPortal,
  GridInvalidEditorPortal,
  GridSelectionLayer,
  type GridCollectionStateMessages,
} from './grid-layers.js'

export type GridViewportMessages = GridCellMessages & GridCollectionStateMessages & Readonly<{
  unknownCellType: (cellType: string) => string
  cancelInvalidEdit: string
  unsavedEditValue: (draftText: string) => string
  currentInvalidSourceValue: (fallbackText: string) => string
  applyHiddenEdit: string
  editedCellOutsideViewport: string
  editedRowHidden: string
  editedRowUnavailable: string
  clipboardWriteFailed: string
  rejectedAction: GridRejectedActionPresenter
}>

export type DataGridRowDropTarget<RowKey extends GridRowKey> = Readonly<{
  edge: 'before' | 'after' | 'end'
  visibleRowIndex: number
  placement: Readonly<{ beforeRowKey: RowKey | null }>
}>

export type DataGridRowDropZone<RowKey extends GridRowKey> = Readonly<{
  active: boolean
  onTargetChange: (target: DataGridRowDropTarget<RowKey> | null) => void
  renderIndicator?: (target: DataGridRowDropTarget<RowKey>) => ReactNode
  autoScroll?: boolean
}>

export type GridViewportProps<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect> = Readonly<{
  ariaLabel: string
  controller: GridController<Row, RowKey, Schema, Effect>
  dom: GridDomEffectAdapter
  messages: GridViewportMessages
  views: GridCellViewPort<Row>
  onOpenFilter: (columnKey: string) => void
  rowHeaderActions?: DataGridRowHeaderActions<Row, RowKey, Schema, Effect>
  rowDropZone?: DataGridRowDropZone<RowKey>
}>

export function GridViewport<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>({
  ariaLabel,
  controller,
  dom,
  messages,
  views,
  onOpenFilter,
  rowHeaderActions,
  rowDropZone,
}: GridViewportProps<Row, RowKey, Schema, Effect>) {
  const shell = useRef<HTMLDivElement>(null)
  const scrollport = useRef<HTMLDivElement>(null)
  const autoScroll = useRef<{ frame: number | null; pointerId: number; clientX: number; clientY: number }>({
    frame: null,
    pointerId: -1,
    clientX: 0,
    clientY: 0,
  })
  const dropAutoScroll = useRef<number | null>(null)
  const dropPointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const dropZoneRef = useRef(rowDropZone)
  dropZoneRef.current = rowDropZone
  const dropTargetRef = useRef<DataGridRowDropTarget<RowKey> | null>(null)
  const dropIndicatorYRef = useRef<number | null>(null)
  const [dropTarget, setDropTarget] = useState<DataGridRowDropTarget<RowKey> | null>(null)
  const [dropIndicatorY, setDropIndicatorY] = useState<number | null>(null)
  const [editorBodyHost, setEditorBodyHost] = useState<HTMLDivElement | null>(null)
  const [editorFloatingHost, setEditorFloatingHost] = useState<HTMLDivElement | null>(null)
  const structure = useGridSelector(controller, selectViewportStructure, equalViewportStructure)
  const geometry = useMemo(() => snapshotGeometry(controller.getSnapshot()), [controller, structure])
  const style = {
    '--grid-content-height': `${structure.layout.contentHeight}px`,
    '--grid-content-width': `${structure.layout.contentWidth}px`,
    '--grid-header-height': `${structure.layout.headerHeight}px`,
    '--grid-row-height': `${structure.layout.rowHeight}px`,
    '--grid-row-indicator-width': `${structure.layout.rowIndicatorWidth}px`,
    '--grid-template-columns': geometry.templateColumns,
  } as CSSProperties

  const dispatch = useCallback((intent: Parameters<typeof controller.dispatch>[0]) => controller.dispatch(intent), [controller])
  const reportRejected = useCallback((result: GridDispatchResult) => {
    reportGridRejectedAction(controller, result, messages.rejectedAction)
  }, [controller, messages.rejectedAction])

  const publishDropTarget = useCallback((target: DataGridRowDropTarget<RowKey> | null) => {
    const node = scrollport.current
    const snapshot = controller.getSnapshot()
    const indicatorY = target && node
      ? rowDropIndicatorY(
          target,
          snapshot.layout.headerHeight,
          snapshot.layout.rowHeight,
          node.scrollTop,
          node.clientHeight,
        )
      : null
    const targetChanged = !equalRowDropTarget(dropTargetRef.current, target)
    const indicatorChanged = dropIndicatorYRef.current !== indicatorY
    if (!targetChanged && !indicatorChanged) return
    dropTargetRef.current = target
    dropIndicatorYRef.current = indicatorY
    setDropTarget(target)
    setDropIndicatorY(indicatorY)
    if (targetChanged) dropZoneRef.current?.onTargetChange(target)
  }, [controller])
  const dropTargetAt = useCallback((clientX: number, clientY: number) => {
    const node = scrollport.current
    if (!node || !dropZoneRef.current?.active) return null
    const rect = node.getBoundingClientRect()
    if (
      clientX < rect.left || clientX > rect.right
      || clientY < rect.top || clientY > rect.bottom
    ) return null
    const snapshot = controller.getSnapshot()
    return resolveRowDropTarget(
      snapshot.view.visibleRowKeys,
      snapshot.layout.headerHeight,
      snapshot.layout.rowHeight,
      node.scrollTop,
      clientY - rect.top,
    )
  }, [controller])
  const stopDropAutoScroll = useCallback(() => {
    if (dropAutoScroll.current !== null) cancelAnimationFrame(dropAutoScroll.current)
    dropAutoScroll.current = null
  }, [])
  const clearDropTarget = useCallback(() => {
    stopDropAutoScroll()
    dropPointer.current = null
    publishDropTarget(null)
  }, [publishDropTarget, stopDropAutoScroll])
  const continueDropAutoScroll = useCallback(() => {
    if (dropAutoScroll.current !== null || dropZoneRef.current?.autoScroll === false) return
    const tick = () => {
      dropAutoScroll.current = null
      const node = scrollport.current
      const pointer = dropPointer.current
      if (
        !node || !pointer || !dropZoneRef.current?.active
        || dropZoneRef.current.autoScroll === false
      ) return
      const rect = node.getBoundingClientRect()
      const velocity = edgeVelocity(pointer.clientY, rect.top, rect.bottom)
      if (velocity === 0) return
      const before = node.scrollTop
      node.scrollBy({ top: velocity, behavior: 'auto' })
      if (node.scrollTop === before) return
      dispatch({ type: 'viewport/scrolled', scrollLeft: node.scrollLeft, scrollTop: node.scrollTop })
      publishDropTarget(dropTargetAt(pointer.clientX, pointer.clientY))
      dropAutoScroll.current = requestAnimationFrame(tick)
    }
    dropAutoScroll.current = requestAnimationFrame(tick)
  }, [dispatch, dropTargetAt, publishDropTarget])

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    dropPointer.current = { clientX: event.clientX, clientY: event.clientY }
    publishDropTarget(dropTargetAt(event.clientX, event.clientY))
    continueDropAutoScroll()
  }
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    clearDropTarget()
  }

  const targetAt = useCallback((event: PointerEvent<HTMLElement>): GridHitTarget<RowKey> | null => {
    const explicit = (event.target as Element).closest<HTMLElement>('[data-grid-hit="fill-handle"]')
    if (explicit) return { kind: 'fill-handle' }
    const root = scrollport.current
    if (!root) return null
    const rect = root.getBoundingClientRect()
    const snapshot = controller.getSnapshot()
    return hitTargetAt(
      snapshotGeometry(snapshot),
      snapshot.view.visibleRowKeys,
      event.clientX - rect.left,
      event.clientY - rect.top,
    )
  }, [controller])

  const stopAutoScroll = useCallback(() => {
    if (autoScroll.current.frame !== null) cancelAnimationFrame(autoScroll.current.frame)
    autoScroll.current.frame = null
    autoScroll.current.pointerId = -1
  }, [])
  const continueAutoScroll = useCallback(() => {
    if (autoScroll.current.frame !== null) return
    const tick = () => {
      autoScroll.current.frame = null
      const node = scrollport.current
      const gesture = controller.getSnapshot().interaction.gesture
      if (!node || !gesture || gesture.pointerId !== autoScroll.current.pointerId) return
      const rect = node.getBoundingClientRect()
      const left = edgeVelocity(autoScroll.current.clientX, rect.left, rect.right)
      const top = edgeVelocity(autoScroll.current.clientY, rect.top, rect.bottom)
      if (left === 0 && top === 0) return
      const beforeLeft = node.scrollLeft
      const beforeTop = node.scrollTop
      node.scrollBy({ left, top, behavior: 'auto' })
      if (node.scrollLeft !== beforeLeft || node.scrollTop !== beforeTop) {
        dispatch({ type: 'viewport/scrolled', scrollLeft: node.scrollLeft, scrollTop: node.scrollTop })
        const current = controller.getSnapshot()
        const target = hitTargetAt(
          snapshotGeometry(current),
          current.view.visibleRowKeys,
          autoScroll.current.clientX - rect.left,
          autoScroll.current.clientY - rect.top,
        )
        if (target) dispatch({ type: 'pointer/move', pointerId: autoScroll.current.pointerId, target })
      }
      autoScroll.current.frame = requestAnimationFrame(tick)
    }
    autoScroll.current.frame = requestAnimationFrame(tick)
  }, [controller, dispatch])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (isRowHeaderActionTarget(event.target)
      || (event.target as Element).closest('[data-grid-header-action], input, button, select, textarea, [contenteditable="true"]')) return
    const target = targetAt(event)
    if (!target) return
    event.preventDefault()
    const result = dispatch({
      type: 'pointer/start',
      pointerId: event.pointerId,
      target,
      modifiers: { shift: event.shiftKey, additive: event.metaKey || event.ctrlKey },
    })
    if (result.accepted) {
      dom.capturePointer(event.pointerId)
      queueMicrotask(() => {
        const active = controller.getSnapshot().interaction.activeCell
        if (active) dom.focusCell(active, false)
      })
    } else reportRejected(result)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = controller.getSnapshot().interaction.gesture
    if (!gesture || gesture.pointerId !== event.pointerId) return
    autoScroll.current.pointerId = event.pointerId
    autoScroll.current.clientX = event.clientX
    autoScroll.current.clientY = event.clientY
    continueAutoScroll()
    const target = targetAt(event)
    if (target) dispatch({ type: 'pointer/move', pointerId: event.pointerId, target })
  }
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = controller.getSnapshot().interaction.gesture
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const target = targetAt(event)
    const result = dispatch(target
      ? { type: 'pointer/end', pointerId: event.pointerId, target }
      : { type: 'pointer/end', pointerId: event.pointerId })
    dom.releasePointer(event.pointerId)
    stopAutoScroll()
    reportRejected(result)
  }
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = controller.getSnapshot().interaction.gesture
    if (!gesture || gesture.pointerId !== event.pointerId) return
    dispatch({ type: 'pointer/cancel', pointerId: event.pointerId })
    dom.releasePointer(event.pointerId)
    stopAutoScroll()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isRowHeaderActionTarget(event.target)
      || (event.target as Element).closest('input, textarea, select, [contenteditable="true"]')) return
    const shortcut = event.metaKey || event.ctrlKey
    if (shortcut && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      dispatch({ type: 'keyboard/command', command: event.shiftKey ? 'redo' : 'undo' })
      return
    }
    if (shortcut && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      dispatch({ type: 'keyboard/command', command: 'redo' })
      return
    }
    const command = keyboardCommand(event.key)
    if (command) {
      event.preventDefault()
      const result = dispatch({ type: 'keyboard/command', command, extend: event.shiftKey })
      reportRejected(result)
      const next = controller.getSnapshot().interaction.activeCell
      if (next && command.startsWith('move-')) queueMicrotask(() => { dom.focusCell(next) })
      return
    }
    if (event.key.length === 1 && !shortcut && !event.altKey) {
      const snapshot = controller.getSnapshot()
      const point = snapshot.interaction.activeCell
      const column = point && snapshot.columns.find((candidate) => candidate.key === point.columnKey)
      const view = column && views.resolve(column.type)
      if (view?.presentation.editActivation.includes('printable')) {
        event.preventDefault()
        const start = dispatch({ type: 'edit/start' })
        if (start.accepted) dispatch({ type: 'edit/change', value: event.key })
      }
    }
  }

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (isRowHeaderActionTarget(event.target)
      || (event.target as Element).closest('input, textarea, select, [contenteditable="true"]')) return
    const result = dispatch({ type: 'selection/copy' })
    const text = gridClipboardText(result, reportRejected, messages.clipboardWriteFailed)
    if (text !== null) {
      event.preventDefault()
      event.clipboardData.setData('text/plain', text)
    }
  }
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (isRowHeaderActionTarget(event.target)
      || (event.target as Element).closest('input, textarea, [contenteditable="true"]')) return
    event.preventDefault()
    reportRejected(dispatch({ type: 'selection/paste', text: event.clipboardData.getData('text/plain') }))
  }

  useLayoutEffect(() => {
    const node = scrollport.current
    if (!node) return
    dom.setScrollport(node)
    dom.setPointerRoot(shell.current)
    const publishSize = () => dispatch({ type: 'viewport/resized', width: node.clientWidth, height: node.clientHeight })
    publishSize()
    const observer = new ResizeObserver(publishSize)
    observer.observe(node)
    return () => {
      observer.disconnect()
      stopAutoScroll()
      dom.setScrollport(null)
      dom.setPointerRoot(null)
    }
  }, [dispatch, dom, stopAutoScroll])

  useLayoutEffect(() => {
    if (!rowDropZone?.active) clearDropTarget()
    return () => clearDropTarget()
  }, [clearDropTarget, rowDropZone?.active])

  return <div
    className="business-grid__viewport-shell"
    ref={shell}
    style={style}
    onDoubleClick={(event) => {
      if (isRowHeaderActionTarget(event.target)
        || (event.target as Element).closest('input, button, select, textarea')) return
      const target = targetAt(event as unknown as PointerEvent<HTMLElement>)
      if (!target || target.kind !== 'cell') return
      const column = controller.getSnapshot().columns.find((candidate) => candidate.key === target.columnKey)
      if (column && views.resolve(column.type)?.presentation.editActivation.includes('double-click')) {
        reportRejected(dispatch({ type: 'edit/start', cell: target }))
      }
    }}
    onPointerCancel={onPointerCancel}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerEnd}
  >
    <div
      aria-colcount={structure.columns.length + 1}
      aria-label={ariaLabel}
      aria-rowcount={structure.visibleRowKeys.length + 1}
      className="business-grid__scrollport"
      ref={scrollport}
      role="grid"
      tabIndex={controller.getSnapshot().interaction.activeCell ? -1 : 0}
      onContextMenu={(event) => {
        if (isRowHeaderActionTarget(event.target)) return
        const target = targetAt(event as unknown as PointerEvent<HTMLElement>)
        if (!target || target.kind !== 'cell' && target.kind !== 'row') return
        const snapshot = controller.getSnapshot()
        const columnKeys = snapshot.columns.map((column) => column.key)
        if (target.kind === 'row' && columnKeys.length === 0) return
        event.preventDefault()
        const point = {
          rowKey: target.rowKey,
          columnKey: target.kind === 'cell' ? target.columnKey : columnKeys[0]!,
        }
        const chosenCells = selectedCells(snapshot.interaction.ranges, snapshot.view.visibleRowKeys, columnKeys)
        const selected = new Set(chosenCells.map(encodeCellIdentity))
        const selectedRow = columnKeys.length > 0
          && columnKeys.every((columnKey) => selected.has(encodeCellIdentity({ rowKey: target.rowKey, columnKey })))
        if (target.kind === 'row' && !selectedRow) {
          dispatch({
            type: 'interaction/activate',
            cell: point,
            range: {
              anchor: point,
              focus: { rowKey: target.rowKey, columnKey: columnKeys.at(-1)! },
            },
          })
        } else if (!selected.has(encodeCellIdentity(point))) dispatch({ type: 'interaction/activate', cell: point })
        dispatch({ type: 'interaction/open-action', target: point, menuPosition: { x: event.clientX, y: event.clientY } })
      }}
      onClick={(event) => {
        const action = (event.target as Element).closest<HTMLElement>('[data-grid-header-action]')
        const columnKey = action?.dataset.columnKey
        if (!action || !columnKey) return
        if (action.dataset.gridHeaderAction === 'filter') onOpenFilter(columnKey)
        else if (action.dataset.gridHeaderAction === 'sort') {
          const sort = controller.getSnapshot().view.sort
          reportRejected(dispatch({ type: 'view/set-sort', sort: nextSort(sort, columnKey, event.metaKey || event.ctrlKey) }))
        }
      }}
      onCopy={onCopy}
      {...(rowDropZone?.active ? { onDragLeave, onDragOver } : {})}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onScroll={(event) => {
        dispatch({ type: 'viewport/scrolled', scrollLeft: event.currentTarget.scrollLeft, scrollTop: event.currentTarget.scrollTop })
        const pointer = dropPointer.current
        if (pointer && dropZoneRef.current?.active) {
          publishDropTarget(dropTargetAt(pointer.clientX, pointer.clientY))
        }
      }}
    >
      <div className="business-grid__matrix">
        <GridHeaderRow columns={structure.columns} controller={controller} messages={messages} />
        {structure.visibleRowKeys.map((rowKey, rowIndex) => <GridDataRow
          controller={controller}
          messages={messages}
          key={`${typeof rowKey}:${String(rowKey)}`}
          rowIndex={rowIndex}
          rowKey={rowKey}
          {...(rowHeaderActions === undefined ? {} : { rowHeaderActions })}
          cells={structure.columns.map((column, columnIndex) => {
            const view = views.resolve(column.type)
            if (!view) return <div className="business-grid__cell" key={column.key} role="gridcell">{messages.unknownCellType(column.type)}</div>
            return <GridCell
              column={column}
              columnIndex={columnIndex}
              controller={controller}
              dom={dom}
              key={column.key}
              messages={messages}
              rowIndex={rowIndex}
              rowKey={rowKey}
              view={view}
            />
          })}
        />)}
      </div>
    </div>
    {dropTarget && dropIndicatorY !== null ? <div
      aria-hidden="true"
      className="business-grid__row-drop-indicator"
      style={{ insetBlockStart: dropIndicatorY }}
    >{rowDropZone?.renderIndicator
        ? rowDropZone.renderIndicator(dropTarget)
        : <div className="business-grid__row-drop-indicator-line" />}</div> : null}
    <GridSelectionBoundary controller={controller} />
    <div className="business-grid__editor-host">
      <div className="business-grid__editor-body-host" ref={setEditorBodyHost} />
      <div className="business-grid__editor-floating-host" ref={setEditorFloatingHost} />
    </div>
    <GridScrollportFocusBoundary controller={controller} scrollport={scrollport} />
    <GridEditorBoundary
      bodyHost={editorBodyHost}
      controller={controller}
      dom={dom}
      floatingHost={editorFloatingHost}
      messages={messages}
      views={views}
    />
    <GridCollectionStateBoundary controller={controller} messages={messages} />
  </div>
}

function GridScrollportFocusBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  controller,
  scrollport,
}: {
  controller: GridController<Row, RowKey, Schema, Effect>
  scrollport: RefObject<HTMLDivElement | null>
}) {
  const hasActiveCell = useGridSelector(controller, (snapshot) => snapshot.interaction.activeCell !== null)
  useLayoutEffect(() => {
    if (scrollport.current) scrollport.current.tabIndex = hasActiveCell ? -1 : 0
  }, [hasActiveCell, scrollport])
  return null
}

function GridSelectionBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({ controller }: { controller: GridController<Row, RowKey, Schema, Effect> }) {
  const selection = useGridSelector(controller, selectSelectionLayer, equalSelectionLayer)
  const columnKeys = selection.layout.columns.map((column) => column.key)
  const fillEnabled = selectedCells(
    selection.interaction.ranges,
    selection.visibleRowKeys,
    columnKeys,
  ).length > 0 && !selection.editing
  return <GridSelectionLayer
    fillEnabled={fillEnabled}
    interaction={selection.interaction}
    layout={selection.layout}
    visibleRowKeys={selection.visibleRowKeys}
  />
}

function GridEditorBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({
  bodyHost,
  controller,
  dom,
  floatingHost,
  messages,
  views,
}: {
  bodyHost: Element | null
  controller: GridController<Row, RowKey, Schema, Effect>
  dom: GridDomEffectAdapter
  floatingHost: Element | null
  messages: GridViewportMessages
  views: GridCellViewPort<Row>
}) {
  const editor = useGridSelector(controller, selectEditor, equalEditorSelection)
  const claimInitialActivation = useMemo(
    createInitialEditorActivation,
    [editor?.session.startedRevision],
  )
  if (!editor) return null
  const reportRejected = (result: GridDispatchResult) => {
    reportGridRejectedAction(controller, result, messages.rejectedAction)
  }
  const reportCommitResult = (result: GridDispatchResult) => {
    const current = controller.getSnapshot().edit
    const presentedByEditor = !result.accepted
      && current?.status === 'invalid'
      && current.error !== null
    if (!presentedByEditor) reportRejected(result)
  }
  const cancel = () => {
    controller.dispatch({ type: 'edit/cancel' })
    queueMicrotask(() => {
      if (!dom.focusCell(editor.session.cell, false)) dom.focusGrid()
    })
  }
  const commit = () => {
    const result = controller.dispatch({ type: 'edit/commit' })
    reportCommitResult(result)
    queueMicrotask(() => {
      if (result.accepted) dom.focusGrid()
      else dom.focusEditor()
    })
  }
  const onDraftChange = (draft: unknown) => {
    controller.dispatch({ type: 'edit/change', value: draft })
  }
  const onEffect = (name: string, input: unknown) => {
    const result = controller.dispatch({ type: 'cell/run-effect', cell: editor.session.cell, effect: name, input })
    reportRejected(result)
    const id = effectId(result)
    let cancelled = false
    return { id, cancel: () => {
      if (cancelled || !id) return
      cancelled = true
      controller.dispatch({ type: 'cell/cancel-effect', effectId: id })
    } }
  }
  const onSetComposing = (composing: boolean, finalValue?: unknown) => {
    controller.dispatch(finalValue === undefined
      ? { type: 'edit/set-composing', composing }
      : { type: 'edit/set-composing', composing, finalValue })
  }
  const draftLabel = messages.unsavedEditValue(
    fallbackGridCellText(editor.session.draftValue),
  )
  if (editor.row === null || editor.column === null) return <GridDetachedEditorPortal
    cancelLabel={messages.cancelInvalidEdit}
    dom={dom}
    draftLabel={draftLabel}
    host={floatingHost}
    kind="recovery"
    layout={editor.layout}
    onCancel={cancel}
    reason={editor.session.error ?? messages.editedRowUnavailable}
    session={editor.session}
  />
  if (editor.rowIndex === null || !editor.intersectsBody) {
    const reason = editor.rowIndex === null
      ? messages.editedRowHidden
      : messages.editedCellOutsideViewport
    const view = editor.resolved?.valid ? views.resolve(editor.column.type) : undefined
    const remoteConflict = editor.session.status === 'invalid'
      && editor.session.sourceRevision !== editor.sourceRevision
    if (
      editor.resolved?.valid &&
      !remoteConflict &&
      view?.Editor
    ) {
      return <GridDetachedEditorPortal
        cancelLabel={messages.cancelInvalidEdit}
        claimInitialActivation={claimInitialActivation}
        column={editor.column}
        commitLabel={messages.applyHiddenEdit}
        dom={dom}
        draftLabel={draftLabel}
        host={floatingHost}
        kind="editable"
        layout={editor.layout}
        onCancel={cancel}
        onCommit={commit}
        onDraftChange={onDraftChange}
        onEffect={onEffect}
        onSetComposing={onSetComposing}
        reason={reason}
        row={editor.row}
        session={editor.session}
        view={view}
      />
    }
    return <GridDetachedEditorPortal
      cancelLabel={messages.cancelInvalidEdit}
      dom={dom}
      draftLabel={draftLabel}
      host={floatingHost}
      kind="recovery"
      layout={editor.layout}
      onCancel={cancel}
      reason={editor.session.error ?? reason}
      session={editor.session}
    />
  }
  if (!editor.resolved?.valid) return <GridInvalidEditorPortal
    cancelLabel={messages.cancelInvalidEdit}
    column={editor.column}
    dom={dom}
    draftLabel={draftLabel}
    host={bodyHost}
    issue={editor.resolved?.issue.message ?? messages.editedRowUnavailable}
    layout={editor.layout}
    onCancel={cancel}
    rowIndex={editor.rowIndex}
    session={editor.session}
    sourceValueLabel={messages.currentInvalidSourceValue(editor.resolved?.fallbackText ?? '')}
  />
  const view = views.resolve(editor.column.type)
  if (!view?.Editor) return <GridDetachedEditorPortal
    cancelLabel={messages.cancelInvalidEdit}
    dom={dom}
    draftLabel={draftLabel}
    host={floatingHost}
    kind="recovery"
    layout={editor.layout}
    onCancel={cancel}
    reason={messages.editedRowUnavailable}
    session={editor.session}
  />
  return <GridEditorPortal
    claimInitialActivation={claimInitialActivation}
    column={editor.column}
    dom={dom}
    dirty={editor.dirty}
    host={bodyHost}
    layout={editor.layout}
    onCancel={cancel}
    onCommit={commit}
    onCommitAndMove={(direction) => {
      const result = controller.dispatch({ type: 'edit/commit-and-move', direction })
      reportCommitResult(result)
      if (result.accepted) {
        const active = controller.getSnapshot().interaction.activeCell
        if (active) queueMicrotask(() => dom.focusCell(active))
      } else queueMicrotask(() => dom.focusEditor())
    }}
    onDraftChange={onDraftChange}
    onEffect={onEffect}
    onSetComposing={onSetComposing}
    row={editor.row}
    rowIndex={editor.rowIndex}
    session={editor.session}
    view={view}
  />
}

function GridCollectionStateBoundary<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>({ controller, messages }: {
  controller: GridController<Row, RowKey, Schema, Effect>
  messages: GridCollectionStateMessages
}) {
  const state = useGridSelector(controller, selectCollectionState, equalCollectionState)
  return <GridCollectionStateLayer {...state} messages={messages} />
}

function selectViewportStructure<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  return {
    columns: snapshot.columns,
    layout: snapshot.layout,
    visibleRowKeys: snapshot.view.visibleRowKeys,
  } as const
}

function equalViewportStructure<Row, RowKey extends GridRowKey>(
  left: ReturnType<typeof selectViewportStructure<Row, RowKey>>,
  right: ReturnType<typeof selectViewportStructure<Row, RowKey>>,
) {
  return left.columns === right.columns
    && sameRowKeys(left.visibleRowKeys, right.visibleRowKeys)
    && equalMatrixLayout(left.layout, right.layout)
}

function selectSelectionLayer<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  return {
    editing: snapshot.edit !== null,
    interaction: snapshot.interaction,
    layout: snapshot.layout,
    visibleRowKeys: snapshot.view.visibleRowKeys,
  } as const
}

function equalSelectionLayer<RowKey extends GridRowKey>(
  left: ReturnType<typeof selectSelectionLayer<unknown, RowKey>>,
  right: ReturnType<typeof selectSelectionLayer<unknown, RowKey>>,
) {
  return left.interaction === right.interaction
    && left.editing === right.editing
    && sameRowKeys(left.visibleRowKeys, right.visibleRowKeys)
    && equalSelectionLayout(left.layout, right.layout)
}

function selectEditor<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  const session = snapshot.edit
  if (!session) return null
  const visibleRowIndex = snapshot.view.visibleRowKeys.findIndex((rowKey) =>
    gridRowKeysEqual(rowKey, session.cell.rowKey),
  )
  const row = snapshot.draft.rows.find((candidate) =>
    gridRowKeysEqual(snapshot.getRowKey(candidate), session.cell.rowKey),
  ) ?? null
  const column = snapshot.columns.find(
    (candidate) => candidate.key === session.cell.columnKey,
  ) ?? null
  const dirty = snapshot.draft.dirtyCells.some((cell) =>
    gridRowKeysEqual(cell.rowKey, session.cell.rowKey)
      && cell.columnKey === session.cell.columnKey,
  )
  const intersectsBody = visibleRowIndex >= 0
    && column !== null
    && editorIntersectsBody(snapshot.layout, column.key, visibleRowIndex)
  return {
    column,
    dirty,
    intersectsBody,
    layout: snapshot.layout,
    resolved: row === null || column === null
      ? null
      : resolveGridCellValue(row, column),
    row,
    rowIndex: visibleRowIndex < 0 ? null : visibleRowIndex,
    session,
    sourceRevision: snapshot.source.revision,
  } as const
}

function equalEditorSelection<Row, RowKey extends GridRowKey>(
  left: ReturnType<typeof selectEditor<Row, RowKey>>,
  right: ReturnType<typeof selectEditor<Row, RowKey>>,
) {
  if (left === right) return true
  if (!left || !right) return false
  return left.column === right.column
    && left.dirty === right.dirty
    && left.intersectsBody === right.intersectsBody
    && left.layout === right.layout
    && left.row === right.row
    && left.rowIndex === right.rowIndex
    && left.session === right.session
    && left.sourceRevision === right.sourceRevision
}

function editorIntersectsBody(
  layout: GridLayoutState,
  columnKey: string,
  rowIndex: number,
) {
  const column = layout.columns.find((candidate) => candidate.key === columnKey)
  if (!column) return false
  const left = column.offset - layout.scrollLeft
  const top = rowIndex * layout.rowHeight - layout.scrollTop
  const bodyWidth = Math.max(0, layout.viewportWidth - layout.rowIndicatorWidth)
  const bodyHeight = Math.max(0, layout.viewportHeight - layout.headerHeight)
  return left < bodyWidth
    && left + column.width > 0
    && top < bodyHeight
    && top + layout.rowHeight > 0
}

function createInitialEditorActivation() {
  let claimed = false
  return () => {
    if (claimed) return false
    claimed = true
    return true
  }
}

function selectCollectionState<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>) {
  return {
    error: snapshot.source.error,
    filtered: Boolean(snapshot.view.globalFilter || snapshot.view.columnFilters.length),
    rowCount: snapshot.view.visibleRowKeys.length,
    status: snapshot.source.status,
  } as const
}

function equalCollectionState(
  left: ReturnType<typeof selectCollectionState>,
  right: ReturnType<typeof selectCollectionState>,
) {
  return left.error === right.error
    && left.filtered === right.filtered
    && left.rowCount === right.rowCount
    && left.status === right.status
}

function equalMatrixLayout(left: GridLayoutState, right: GridLayoutState) {
  return left.contentHeight === right.contentHeight
    && left.contentWidth === right.contentWidth
    && left.headerHeight === right.headerHeight
    && left.rowHeight === right.rowHeight
    && left.rowIndicatorWidth === right.rowIndicatorWidth
    && equalLayoutColumns(left, right)
}

function equalSelectionLayout(left: GridLayoutState, right: GridLayoutState) {
  return left.viewportWidth === right.viewportWidth
    && left.viewportHeight === right.viewportHeight
    && left.scrollLeft === right.scrollLeft
    && left.scrollTop === right.scrollTop
    && left.headerHeight === right.headerHeight
    && left.rowHeight === right.rowHeight
    && left.rowIndicatorWidth === right.rowIndicatorWidth
    && equalLayoutColumns(left, right)
}

function equalLayoutColumns(left: GridLayoutState, right: GridLayoutState) {
  return left.columns.length === right.columns.length
    && left.columns.every((column, index) => {
      const candidate = right.columns[index]
      return candidate !== undefined
        && column.key === candidate.key
        && column.index === candidate.index
        && column.offset === candidate.offset
        && column.width === candidate.width
    })
}

function sameRowKeys<RowKey extends GridRowKey>(left: readonly RowKey[], right: readonly RowKey[]) {
  return left.length === right.length && left.every((rowKey, index) => gridRowKeysEqual(rowKey, right[index]))
}

function snapshotGeometry<Row, RowKey extends GridRowKey>(snapshot: GridControllerSnapshot<Row, RowKey>): GridGeometry {
  const columns = snapshot.layout.columns
  return {
    ...snapshot.layout,
    columns,
    columnByKey: new Map(columns.map((column) => [column.key, column] as const)),
    templateColumns: `${snapshot.layout.rowIndicatorWidth}px ${columns.map((column) => `${column.width}px`).join(' ')}`,
  }
}

function hitTargetAt<RowKey extends GridRowKey>(
  geometry: GridGeometry,
  rowKeys: readonly RowKey[],
  viewportX: number,
  viewportY: number,
): GridHitTarget<RowKey> | null {
  const hit = hitTestGrid(geometry, viewportX, viewportY, rowKeys.length)
  if (!hit) return null
  if (hit.kind === 'row' || hit.kind === 'cell') {
    const rowKey = rowKeys[hit.rowIndex]
    if (rowKey === undefined) return null
    return hit.kind === 'row' ? { kind: 'row', rowKey } : { kind: 'cell', rowKey, columnKey: hit.columnKey }
  }
  return hit
}

function resolveRowDropTarget<RowKey extends GridRowKey>(
  rowKeys: readonly RowKey[],
  headerHeight: number,
  rowHeight: number,
  scrollTop: number,
  viewportY: number,
): DataGridRowDropTarget<RowKey> | null {
  if (viewportY < headerHeight) return null
  if (rowKeys.length === 0) return freezeRowDropTarget<RowKey>('end', 0, null)
  const bodyOffset = viewportY - headerHeight + scrollTop
  const rowIndex = Math.floor(bodyOffset / rowHeight)
  if (rowIndex >= rowKeys.length) return freezeRowDropTarget<RowKey>('end', rowKeys.length, null)
  const rowOffset = bodyOffset - rowIndex * rowHeight
  if (rowOffset < rowHeight / 2) {
    return freezeRowDropTarget('before', rowIndex, rowKeys[rowIndex] ?? null)
  }
  const nextIndex = rowIndex + 1
  if (nextIndex >= rowKeys.length) return freezeRowDropTarget<RowKey>('end', rowKeys.length, null)
  return freezeRowDropTarget('after', nextIndex, rowKeys[nextIndex] ?? null)
}

function freezeRowDropTarget<RowKey extends GridRowKey>(
  edge: DataGridRowDropTarget<RowKey>['edge'],
  visibleRowIndex: number,
  beforeRowKey: RowKey | null,
): DataGridRowDropTarget<RowKey> {
  return Object.freeze({
    edge,
    visibleRowIndex,
    placement: Object.freeze({ beforeRowKey }),
  })
}

function equalRowDropTarget<RowKey extends GridRowKey>(
  left: DataGridRowDropTarget<RowKey> | null,
  right: DataGridRowDropTarget<RowKey> | null,
) {
  if (left === right) return true
  if (!left || !right) return false
  return left.edge === right.edge
    && left.visibleRowIndex === right.visibleRowIndex
    && (left.placement.beforeRowKey === null
      ? right.placement.beforeRowKey === null
      : right.placement.beforeRowKey !== null
        && gridRowKeysEqual(left.placement.beforeRowKey, right.placement.beforeRowKey))
}

function rowDropIndicatorY<RowKey extends GridRowKey>(
  target: DataGridRowDropTarget<RowKey>,
  headerHeight: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
) {
  const boundary = headerHeight + target.visibleRowIndex * rowHeight - scrollTop
  return Math.min(
    Math.max(boundary, headerHeight + 1),
    Math.max(headerHeight + 1, viewportHeight - 1),
  )
}

function edgeVelocity(position: number, start: number, end: number) {
  const threshold = 40
  const maximum = 22
  if (position < start + threshold) return -Math.ceil(maximum * Math.min(1, (start + threshold - position) / threshold))
  if (position > end - threshold) return Math.ceil(maximum * Math.min(1, (position - (end - threshold)) / threshold))
  return 0
}

function isRowHeaderActionTarget(target: EventTarget | null) {
  return target instanceof Element
    && target.closest('[data-grid-row-header-actions]') !== null
}

function keyboardCommand(key: string) {
  switch (key) {
    case 'ArrowUp': return 'move-up' as const
    case 'ArrowDown': return 'move-down' as const
    case 'ArrowLeft': return 'move-left' as const
    case 'ArrowRight': return 'move-right' as const
    case 'Enter': return 'edit' as const
    case 'F2': return 'edit' as const
    case 'Escape': return 'cancel' as const
    case 'Delete':
    case 'Backspace': return 'clear' as const
    default: return null
  }
}

function effectId(result: GridDispatchResult) {
  if (!result.accepted || typeof result.payload !== 'object' || result.payload === null || !('effectId' in result.payload)) return ''
  const value = (result.payload as { effectId?: unknown }).effectId
  return typeof value === 'string' ? value : ''
}

function nextSort(current: readonly GridSort[], columnKey: string, additive: boolean): readonly GridSort[] {
  const existing = current.find((entry) => entry.columnKey === columnKey)
  const others = additive ? current.filter((entry) => entry.columnKey !== columnKey) : []
  if (!existing) return [...others, { columnKey, direction: 'ascending' }]
  if (existing.direction === 'ascending') return [...others, { columnKey, direction: 'descending' }]
  return others
}
