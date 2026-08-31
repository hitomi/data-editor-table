import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type Key,
} from 'react'
import {
  Cell,
  type CellCopyArgs,
  type CellKeyDownArgs,
  type CellKeyboardEvent,
  type CellMouseArgs,
  type CellMouseEvent,
  type CellRendererProps,
  type Column,
  type DataGridHandle,
  type PositionChangeArgs,
  type Renderers,
} from 'react-data-grid'
import { classNames } from './class-names.js'

import {
  clamp,
  keyboardDirection,
  rangeCellCount,
  resolveBounds,
  serializeRange,
  serializeSelectedCells,
  type CellCoordinate,
  type CellRange,
} from '../core/range-utils.js'
import { DATA_GRID_CLIPBOARD_CELL_LIMIT, parseDataGridClipboard } from '../core/clipboard.js'
import type { GridRowKey } from '../core/types.js'

// Migrated from Huifan's reusable data-grid selection state machine. Keep
// selection geometry, clipboard, pointer and viewport-overlay behavior aligned
// with that source contract; Cellophane only supplies its Dataset adapter.

export type UseDataGridRangeSelectionOptions<TRow extends object, RowId extends GridRowKey> = {
  rows: readonly TRow[]
  columns: readonly Column<TRow>[]
  /** Stable identity used by selection geometry. */
  getRowId: (row: TRow) => RowId
  selectableColumnKeys: ReadonlySet<string>
  applyRows?: (rows: readonly TRow[]) => void
  updateRows: (rows: TRow[]) => void
  createRow?: () => TRow
  getCellText: (
    row: TRow,
    field: string,
  ) => string
  cellValuesEqual: (left: TRow, right: TRow, field: string) => boolean
  applyCellText: (
    row: TRow,
    field: string,
    value: string,
  ) => TRow
  clearCell: (
    row: TRow,
    field: string,
  ) => TRow
  rowIndexForId?: (rowId: RowId) => number | undefined
  pasteMatrix?: (start: CellCoordinate<RowId>, matrix: string[][]) => void
  /** Keeps an editing selection stable while a host-owned modal is open. */
  preserveSelectionOnOutsideInteraction?: boolean
  onSelectionCleared?: () => void
  messages?: {
    operationCellLimitExceeded?: (selectedCellCount: number, limit: number) => string
    clipboardUnreadable?: string
  }
}

type SelectionOverlayState = {
  style: SelectionOverlayGeometry
  animate: boolean
}

type SelectionOverlayGeometry = {
  left: number
  top: number
  width: number
  height: number
}

type DataGridContextTarget<RowId extends GridRowKey> = {
  rowId: RowId
  insideSelection: boolean
}

type DataGridAxisSelectionOptions = {
  additive?: boolean
  extend?: boolean
}

type DataGridSelectionUpdateMode = 'append' | 'replace' | 'replace-active'

function selectionUpdateMode(options: DataGridAxisSelectionOptions): DataGridSelectionUpdateMode {
  if (options.extend) return 'replace-active'
  return options.additive ? 'append' : 'replace'
}

export type DataGridRangeApplyResult =
  | { applied: true; changedRowCount: number }
  | { applied: false; error: string; reason: 'blocked' | 'failed' | 'no-selection' }

const DATA_GRID_RANGE_OPERATION_CELL_LIMIT = DATA_GRID_CLIPBOARD_CELL_LIMIT

export function useDataGridRangeSelection<TRow extends object, RowId extends GridRowKey>({
  rows,
  columns,
  selectableColumnKeys,
  applyRows,
  updateRows,
  createRow,
  getCellText,
  cellValuesEqual,
  applyCellText,
  clearCell,
  getRowId,
  rowIndexForId,
  pasteMatrix,
  preserveSelectionOnOutsideInteraction = false,
  onSelectionCleared,
  messages,
}: UseDataGridRangeSelectionOptions<TRow, RowId>) {
  const gridRef = useRef<DataGridHandle>(null)
  const gridContainerRef = useRef<HTMLDivElement>(null)
  const selectionOverlayRef = useRef<HTMLDivElement>(null)
  const fillHandleVisualRef = useRef<HTMLDivElement>(null)
  const overlayFrameRef = useRef<number | null>(null)
  const draggingSelectionIndexRef = useRef<number | null>(null)
  const activeCellRef = useRef<CellCoordinate<RowId> | null>(null)
  const selectionClearedRef = useRef(true)
  const pendingPastedRangeRef = useRef<{ start: CellCoordinate<RowId>; rowCount: number; columnCount: number } | null>(null)
  const [selections, setSelections] = useState<CellRange<RowId>[]>([])
  const [showActiveCellSelection, setShowActiveCellSelection] = useState(true)
  const [rangeOperationError, setRangeOperationError] = useState<string | null>(null)
  const [contextTarget, setContextTarget] =
    useState<DataGridContextTarget<RowId> | null>(null)
  const clearContextTarget = useCallback(() => {
    setContextTarget(null)
  }, [])
  const [selectionOverlay, setSelectionOverlay] =
    useState<SelectionOverlayState | null>(null)
  const clearSelection = useCallback(() => {
    if (overlayFrameRef.current !== null) {
      cancelAnimationFrame(overlayFrameRef.current)
      overlayFrameRef.current = null
    }
    draggingSelectionIndexRef.current = null
    activeCellRef.current = null
    selectionClearedRef.current = true
    setSelectionOverlay(null)
    setSelections([])
    setShowActiveCellSelection(false)
    onSelectionCleared?.()
  }, [onSelectionCleared])

  const rowIndexById = useMemo<Pick<ReadonlyMap<RowId, number>, 'get'>>(
    () => rowIndexForId ? { get: rowIndexForId } : new Map(rows.map((row, index) => [getRowId(row), index])),
    [getRowId, rowIndexForId, rows],
  )
  const columnIndexByKey = useMemo(
    () => new Map(columns.map((column, index) => [column.key, index])),
    [columns],
  )
  const selectableColumns = useMemo(
    () =>
      columns
        .map((column, index) => ({ key: column.key, index }))
        .filter(({ key }) => selectableColumnKeys.has(key)),
    [columns, selectableColumnKeys],
  )
  const selectableColumnPositionByKey = useMemo(
    () => new Map(selectableColumns.map((column, index) => [column.key, index])),
    [selectableColumns],
  )

  const selectionBounds = useMemo(
    () =>
      selections.flatMap((selection) => {
        const bounds = resolveBounds(
          selection,
          rowIndexById,
          columnIndexByKey,
        )
        return bounds ? [bounds] : []
      }),
    [columnIndexByKey, rowIndexById, selections],
  )
  const activeSelection = selections.at(-1) ?? null
  const activeBounds = selectionBounds.at(-1) ?? null
  const selectedCellCount = useMemo(() => rangeCellCount(selectionBounds, selectableColumns), [selectableColumns, selectionBounds])
  const rangeOperationBlocked = selectedCellCount > DATA_GRID_RANGE_OPERATION_CELL_LIMIT
  useEffect(() => {
    if (!rangeOperationBlocked) setRangeOperationError(null)
  }, [rangeOperationBlocked])
  const isCellSelected = useCallback(
    (rowIndex: number, columnIndex: number) =>
      selectionBounds.some(
        (bounds) =>
          rowIndex >= bounds.minRowIndex &&
          rowIndex <= bounds.maxRowIndex &&
          columnIndex >= bounds.minColumnIndex &&
          columnIndex <= bounds.maxColumnIndex,
      ),
    [selectionBounds],
  )
  const selectedCellIndexes = useMemo(() => {
    const byRow = new Map<number, Set<number>>()
    if (rangeOperationBlocked) return byRow
    for (const bounds of selectionBounds) {
      for (
        let rowIndex = bounds.minRowIndex;
        rowIndex <= bounds.maxRowIndex;
        rowIndex += 1
      ) {
        let columnsForRow = byRow.get(rowIndex)
        if (!columnsForRow) {
          columnsForRow = new Set<number>()
          byRow.set(rowIndex, columnsForRow)
        }
        for (const { index } of selectableColumns) {
          if (
            index >= bounds.minColumnIndex &&
            index <= bounds.maxColumnIndex
          ) {
            columnsForRow.add(index)
          }
        }
      }
    }
    return byRow
  }, [rangeOperationBlocked, selectableColumns, selectionBounds])

  const applySelectionRange = useCallback((selection: CellRange<RowId>, mode: DataGridSelectionUpdateMode, dragging: boolean) => {
    const selectionIndex = mode === 'append'
      ? selections.length
      : mode === 'replace-active'
        ? Math.max(selections.length - 1, 0)
        : 0
    draggingSelectionIndexRef.current = dragging ? selectionIndex : null
    activeCellRef.current = selection.focus
    setSelections((current) => {
      if (mode === 'append') return [...current, selection]
      if (mode === 'replace-active') return [...current.slice(0, -1), selection]
      return [selection]
    })
  }, [selections.length])

  const beginSelectionGesture = useCallback((selection: CellRange<RowId>, mode: DataGridSelectionUpdateMode) => {
    applySelectionRange(selection, mode, true)
  }, [applySelectionRange])

  const updateSelectionGesture = useCallback((focus: CellCoordinate<RowId>) => {
    const selectionIndex = draggingSelectionIndexRef.current
    if (selectionIndex === null) return false
    activeCellRef.current = focus
    setSelections((current) => current.map((selection, index) =>
      index === selectionIndex ? { ...selection, focus } : selection,
    ))
    return true
  }, [])

  const endSelectionGesture = useCallback(() => {
    draggingSelectionIndexRef.current = null
  }, [])

  const replaceSelectionRanges = useCallback((nextSelections: CellRange<RowId>[]) => {
    const active = nextSelections.at(-1)?.focus
    if (!active) {
      clearSelection()
      return
    }
    endSelectionGesture()
    activeCellRef.current = active
    setShowActiveCellSelection(true)
    setSelections(nextSelections)
  }, [clearSelection, endSelectionGesture])

  useLayoutEffect(() => {
    const pending = pendingPastedRangeRef.current
    if (!pending) return
    const startRowIndex = rowIndexById.get(pending.start.rowId)
    const startColumnPosition = selectableColumnPositionByKey.get(pending.start.columnKey)
    if (startRowIndex === undefined || startColumnPosition === undefined) return
    const lastRow = rows[Math.min(rows.length - 1, startRowIndex + pending.rowCount - 1)]
    const lastColumn = selectableColumns[Math.min(selectableColumns.length - 1, startColumnPosition + pending.columnCount - 1)]
    if (!lastRow || !lastColumn) return
    pendingPastedRangeRef.current = null
    applySelectionRange({
      anchor: pending.start,
      focus: { rowId: getRowId(lastRow), columnKey: lastColumn.key },
    }, 'replace', false)
  }, [applySelectionRange, getRowId, rowIndexById, rows, selectableColumnPositionByKey, selectableColumns])

  const commitRows = useCallback(
    (
      nextRows: TRow[],
      range?: { minRowIndex: number; maxRowIndex: number },
    ) => {
      if (!applyRows) {
        updateRows(nextRows)
        return
      }
      const firstIndex = range?.minRowIndex ?? 0
      const lastIndex = Math.min(
        range?.maxRowIndex ?? nextRows.length - 1,
        nextRows.length - 1,
      )
      const changedRows: TRow[] = []
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const row = nextRows[index]
        if (row && row !== rows[index]) changedRows.push(row)
      }
      applyRows(changedRows)
    },
    [applyRows, rows, updateRows],
  )
  const updateSelectedCells = useCallback(
    (updateCell: (row: TRow, field: string) => TRow) => {
      if (rangeOperationBlocked) {
        const error = messages?.operationCellLimitExceeded?.(selectedCellCount, DATA_GRID_RANGE_OPERATION_CELL_LIMIT) ?? `The selection contains ${selectedCellCount.toLocaleString()} cells. A single operation can process up to ${DATA_GRID_RANGE_OPERATION_CELL_LIMIT.toLocaleString()}.`
        setRangeOperationError(error)
        return { applied: false, error, reason: 'blocked' } as const
      }
      if (selectedCellIndexes.size === 0) return { applied: false, error: 'Select one or more cells first.', reason: 'no-selection' } as const
      try {
        const selectedRowIndexes = [...selectedCellIndexes.keys()].sort(
          (left, right) => left - right,
        )
        const changedRows: TRow[] = []
        for (const rowIndex of selectedRowIndexes) {
          const row = rows[rowIndex]
          const selectedColumns = selectedCellIndexes.get(rowIndex)
          if (!row || !selectedColumns) continue
          let nextRow = row
          for (const columnIndex of [...selectedColumns].sort(
            (left, right) => left - right,
          )) {
            const column = columns[columnIndex]
            if (!column || !selectableColumnKeys.has(column.key)) continue
            nextRow = updateCell(nextRow, column.key)
          }
          if (nextRow !== row) changedRows.push(nextRow)
        }
        if (applyRows) applyRows(changedRows)
        else {
          const nextRows = [...rows]
          changedRows.forEach((row) => {
            const index = rowIndexById.get(getRowId(row))
            if (index !== undefined) nextRows[index] = row
          })
          updateRows(nextRows)
        }
        setRangeOperationError(null)
        return { applied: true, changedRowCount: changedRows.length } as const
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The selected cells could not be updated.'
        setRangeOperationError(message)
        return { applied: false, error: message, reason: 'failed' } as const
      }
    },
    [
      columns,
      getRowId,
      applyRows,
      rows,
      rowIndexById,
      selectableColumnKeys,
      selectedCellIndexes,
      rangeOperationBlocked,
      selectedCellCount,
      messages,
      updateRows,
    ],
  )

  useEffect(() => {
    window.addEventListener('pointerup', endSelectionGesture)
    window.addEventListener('blur', endSelectionGesture)
    return () => {
      window.removeEventListener('pointerup', endSelectionGesture)
      window.removeEventListener('blur', endSelectionGesture)
    }
  }, [endSelectionGesture])

  useEffect(() => {
    if (selections.length === 0) return

    const clearWhenOutsideGrid = (event: PointerEvent) => {
      if (preserveSelectionOnOutsideInteraction) return
      const target = event.target
      if (!(target instanceof Element)) return
      const gridElement = gridRef.current?.element
      if (gridElement?.contains(target)) {
        if (
          target.closest(
            '[role="gridcell"], [role="columnheader"], .rdg-cell-drag-handle, input, textarea, select, [contenteditable="true"]',
          )
        ) {
          return
        }
        clearSelection()
        return
      }
      if (document.querySelector('[data-slot="popover-content"]')) return
      if (
        target.closest(
          '[data-grid-selection-action], [data-slot="context-menu-content"], [data-slot="popover-content"], [data-slot="select-content"]',
        )
      ) {
        return
      }
      clearSelection()
    }

    document.addEventListener('pointerdown', clearWhenOutsideGrid, true)
    return () => {
      document.removeEventListener('pointerdown', clearWhenOutsideGrid, true)
    }
  }, [clearSelection, preserveSelectionOnOutsideInteraction, selections.length])

  useEffect(() => {
    if (!activeBounds) return
    gridRef.current?.setActivePosition({
      rowIdx: activeBounds.maxRowIndex,
      idx: activeBounds.maxColumnIndex,
    })
  }, [activeBounds])

  useLayoutEffect(() => {
    const container = gridContainerRef.current
    if (!container) return

    const headers = container.querySelectorAll<HTMLElement>(
      '[role="columnheader"]',
    )
    headers.forEach((header) => {
      const ariaColumnIndex = Number(header.getAttribute('aria-colindex'))
      const columnIndex = ariaColumnIndex - 1
      const column = columns[columnIndex]
      const isSelected =
        Number.isInteger(columnIndex) &&
        selectionBounds.some(
          (bounds) =>
            columnIndex >= bounds.minColumnIndex &&
            columnIndex <= bounds.maxColumnIndex,
        ) &&
        column !== undefined &&
        selectableColumnKeys.has(column.key)
      header.toggleAttribute('data-range-column-header', isSelected)
      header.setAttribute('aria-selected', String(isSelected))
    })
  }, [columns, selectableColumnKeys, selectionBounds])

  const measureSelectionOverlay =
    useCallback((): SelectionOverlayGeometry | null => {
      const container = gridContainerRef.current
      if (!container || !activeBounds || selectionClearedRef.current) {
        return null
      }

      const selectedCells = container.querySelectorAll<HTMLElement>(
        '[data-range-active="true"]',
      )
      if (selectedCells.length === 0) return null

      const containerBounds = container.getBoundingClientRect()
      let left = Number.POSITIVE_INFINITY
      let top = Number.POSITIVE_INFINITY
      let right = Number.NEGATIVE_INFINITY
      let bottom = Number.NEGATIVE_INFINITY

      selectedCells.forEach((cell) => {
        const cellBounds = cell.getBoundingClientRect()
        left = Math.min(left, cellBounds.left)
        top = Math.min(top, cellBounds.top)
        right = Math.max(right, cellBounds.right)
        bottom = Math.max(bottom, cellBounds.bottom)
      })

      return {
        left: left - containerBounds.left,
        top: top - containerBounds.top,
        width: right - left,
        height: bottom - top,
      }
    }, [activeBounds])

  const commitSelectionOverlay = useCallback(
    (
      nextStyle: SelectionOverlayGeometry | null,
      animate: boolean,
    ) => {
      setSelectionOverlay((current) => {
        if (!nextStyle) return null
        const geometryUnchanged =
          current?.style.left === nextStyle.left &&
          current.style.top === nextStyle.top &&
          current.style.width === nextStyle.width &&
          current.style.height === nextStyle.height
        if (current && geometryUnchanged) {
          return current.animate === animate
            ? current
            : { style: current.style, animate }
        }
        return { style: nextStyle, animate }
      })
    },
    [],
  )

  const syncSelectionOverlay = useCallback((animate: boolean) => {
    if (overlayFrameRef.current !== null) {
      cancelAnimationFrame(overlayFrameRef.current)
      overlayFrameRef.current = null
    }
    commitSelectionOverlay(measureSelectionOverlay(), animate)
  }, [commitSelectionOverlay, measureSelectionOverlay])

  const syncViewportOverlayImmediately = useCallback(() => {
    const nextStyle = measureSelectionOverlay()
    const overlay = selectionOverlayRef.current
    if (!nextStyle || !overlay) {
      syncSelectionOverlay(false)
      return
    }

    overlay.dataset.selectionMotion = 'viewport'
    overlay.style.left = `${nextStyle.left}px`
    overlay.style.top = `${nextStyle.top}px`
    overlay.style.width = `${nextStyle.width}px`
    overlay.style.height = `${nextStyle.height}px`
    const fillHandleVisual = fillHandleVisualRef.current
    if (fillHandleVisual) {
      fillHandleVisual.dataset.selectionMotion = 'viewport'
      fillHandleVisual.style.left = `${nextStyle.left}px`
      fillHandleVisual.style.top = `${nextStyle.top}px`
      fillHandleVisual.style.width = `${nextStyle.width}px`
      fillHandleVisual.style.height = `${nextStyle.height}px`
    }

    if (overlayFrameRef.current !== null) {
      cancelAnimationFrame(overlayFrameRef.current)
    }
    overlayFrameRef.current = requestAnimationFrame(() => {
      overlayFrameRef.current = null
      commitSelectionOverlay(nextStyle, false)
    })
  }, [commitSelectionOverlay, measureSelectionOverlay, syncSelectionOverlay])

  const scheduleViewportOverlaySync = useCallback(() => {
    if (overlayFrameRef.current !== null) {
      cancelAnimationFrame(overlayFrameRef.current)
    }
    overlayFrameRef.current = requestAnimationFrame(() => {
      overlayFrameRef.current = null
      commitSelectionOverlay(measureSelectionOverlay(), false)
    })
  }, [commitSelectionOverlay, measureSelectionOverlay])

  useLayoutEffect(() => {
    selectionClearedRef.current = activeSelection === null
  }, [activeSelection])

  useLayoutEffect(() => {
    syncSelectionOverlay(true)
  }, [activeSelection, syncSelectionOverlay])

  useEffect(() => {
    const container = gridContainerRef.current
    if (!container) return
    const observer = new ResizeObserver(scheduleViewportOverlaySync)
    observer.observe(container)
    return () => observer.disconnect()
  }, [scheduleViewportOverlaySync])

  useEffect(
    () => () => {
      if (overlayFrameRef.current !== null) {
        cancelAnimationFrame(overlayFrameRef.current)
      }
    },
    [],
  )

  const coordinateFor = useCallback(
    (rowIndex: number, columnKey: string): CellCoordinate<RowId> | null => {
      const row = rows[rowIndex]
      if (!row || !selectableColumnKeys.has(columnKey)) return null
      return { rowId: getRowId(row), columnKey }
    },
    [getRowId, rows, selectableColumnKeys],
  )

  const onCellMouseDown = useCallback(
    (
      { rowIdx, column }: CellMouseArgs<TRow>,
      event: CellMouseEvent,
    ) => {
      if (event.button !== 0) {
        const isInsideSelection =
          event.button === 2 &&
          isCellSelected(rowIdx, column.idx)
        if (isInsideSelection) {
          event.preventGridDefault()
        }
        return
      }
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return
      }
      const coordinate = coordinateFor(rowIdx, column.key)
      if (!coordinate) {
        clearSelection()
        return
      }

      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      setShowActiveCellSelection(true)
      const additive = event.ctrlKey || event.metaKey
      if (event.shiftKey && activeSelection) {
        beginSelectionGesture({ anchor: activeSelection.anchor, focus: coordinate }, 'replace-active')
        return
      }
      if (additive) {
        if (isCellSelected(rowIdx, column.idx)) {
          replaceSelectionRanges(selections.filter((selection) => {
            const selectionBounds = resolveBounds(
              selection,
              rowIndexById,
              columnIndexByKey,
            )
            return !(
              selectionBounds &&
              rowIdx >= selectionBounds.minRowIndex &&
              rowIdx <= selectionBounds.maxRowIndex &&
              column.idx >= selectionBounds.minColumnIndex &&
              column.idx <= selectionBounds.maxColumnIndex
            )
          }))
          return
        }
        beginSelectionGesture({ anchor: coordinate, focus: coordinate }, 'append')
        return
      }
      beginSelectionGesture({ anchor: coordinate, focus: coordinate }, 'replace')
    },
    [
      activeSelection,
      beginSelectionGesture,
      clearSelection,
      columnIndexByKey,
      coordinateFor,
      isCellSelected,
      replaceSelectionRanges,
      rowIndexById,
      selections,
    ],
  )

  const onCellContextMenu = useCallback(
    (
      { rowIdx, column }: CellMouseArgs<TRow>,
      _event: CellMouseEvent,
    ) => {
      const row = rows[rowIdx]
      if (!row) {
        setContextTarget(null)
        return
      }
      const coordinate = coordinateFor(rowIdx, column.key)
      const isInsideSelection =
        coordinate !== null &&
        isCellSelected(rowIdx, column.idx)

      setContextTarget({
        rowId: getRowId(row),
        insideSelection: isInsideSelection,
      })
      if (!coordinate) {
        clearSelection()
        return
      }
      if (!isInsideSelection) {
        applySelectionRange({ anchor: coordinate, focus: coordinate }, 'replace', false)
      }
    },
    [
      applySelectionRange,
      clearSelection,
      coordinateFor,
      getRowId,
      isCellSelected,
      rows,
    ],
  )

  const renderCell = useCallback(
    (
      key: Key,
      props: CellRendererProps<TRow, unknown>,
    ) => {
      const columnKey = props.column.key
      const isSelected =
        selectableColumnKeys.has(columnKey) &&
        isCellSelected(props.rowIdx, props.column.idx)
      const isActive =
        activeBounds !== null &&
        props.rowIdx >= activeBounds.minRowIndex &&
        props.rowIdx <= activeBounds.maxRowIndex &&
        props.column.idx >= activeBounds.minColumnIndex &&
        props.column.idx <= activeBounds.maxColumnIndex &&
        selectableColumnKeys.has(columnKey)
      const isRangeCorner =
        isActive &&
        props.rowIdx === activeBounds?.maxRowIndex &&
        props.column.idx === activeBounds.maxColumnIndex
      const isSelectedRowHeader =
        props.column.idx === 0 &&
        selectedCellIndexes.has(props.rowIdx)

      return (
        <Cell
          key={key}
          {...props}
          aria-selected={
            isSelected || isSelectedRowHeader || (props.isCellActive && showActiveCellSelection)
          }
          data-range-selected={isSelected || undefined}
          data-range-active={isActive || undefined}
          data-range-corner={isRangeCorner || undefined}
          data-range-row-header={isSelectedRowHeader || undefined}
          data-row-index={props.rowIdx}
          data-column-key={columnKey}
          className={classNames(
            props.className,
            isSelected && 'operational-data-grid-range-cell',
          )}
          onPointerEnter={() => {
            const coordinate = coordinateFor(props.rowIdx, columnKey)
            if (!coordinate) return
            updateSelectionGesture(coordinate)
          }}
        />
      )
    },
    [
      activeBounds,
      coordinateFor,
      getRowId,
      isCellSelected,
      selectableColumnKeys,
      selectedCellIndexes,
      showActiveCellSelection,
      updateSelectionGesture,
    ],
  )

  const renderers = useMemo<Renderers<TRow, unknown>>(
    () => ({ renderCell }),
    [renderCell],
  )

  const onActivePositionChange = useCallback(
    ({
      rowIdx,
      row,
      column,
    }: PositionChangeArgs<TRow>) => {
      if (!row || !column || rowIdx < 0) return
      activeCellRef.current = {
        rowId: getRowId(row),
        columnKey: column.key,
      }
      setShowActiveCellSelection(true)
    },
    [getRowId],
  )

  const commitActiveEditor = useCallback(() => {
    const activeCell = activeCellRef.current
    if (!activeCell) return
    const rowIdx = rowIndexById.get(activeCell.rowId)
    const idx = columnIndexByKey.get(activeCell.columnKey)
    if (rowIdx === undefined || idx === undefined) return
    // RDG commits the current editor before applying an imperative active
    // position. Re-selecting the same cell closes the editor without moving
    // the operator's focus to an unrelated row.
    gridRef.current?.setActivePosition({ rowIdx, idx })
  }, [columnIndexByKey, rowIndexById])

  const onCellKeyDown = useCallback(
    (
      args: CellKeyDownArgs<TRow>,
      event: CellKeyboardEvent,
    ) => {
      if (event.nativeEvent.isComposing) return
      if (args.mode !== 'ACTIVE' || !args.row || !args.column) return
      const activeCoordinate = coordinateFor(args.rowIdx, args.column.key)
      const current = activeSelection?.focus ?? activeCoordinate
      const currentRowIndex = current
        ? rowIndexById.get(current.rowId)
        : undefined
      if (!current || currentRowIndex === undefined) {
        clearSelection()
        return
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        const firstRow = rows[0]
        const lastRow = rows.at(-1)
        const firstColumn = selectableColumns[0]
        const lastColumn = selectableColumns.at(-1)
        if (firstRow && lastRow && firstColumn && lastColumn) {
          event.preventDefault()
          event.preventGridDefault()
          applySelectionRange({
            anchor: { rowId: getRowId(firstRow), columnKey: firstColumn.key },
            focus: { rowId: getRowId(lastRow), columnKey: lastColumn.key },
          }, 'replace', false)
        }
        return
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        event.preventGridDefault()
        if (selectedCellIndexes.size > 0) {
          updateSelectedCells((row, field) => clearCell(row, field))
        } else {
          const currentBounds = resolveBounds(
            { anchor: current, focus: current },
            rowIndexById,
            columnIndexByKey,
          )
          if (currentBounds) {
            const row = rows[currentBounds.minRowIndex]
            if (row) {
              const changed = selectableColumns
                .filter(({ index }) => index >= currentBounds.minColumnIndex && index <= currentBounds.maxColumnIndex)
                .reduce((next, { key }) => clearCell(next, key), row)
              if (applyRows) applyRows([changed])
              else {
                const nextRows = [...rows]
                nextRows[currentBounds.minRowIndex] = changed
                updateRows(nextRows)
              }
            }
          }
        }
        return
      }

      if (event.key === 'Escape') {
        clearSelection()
        return
      }

      const direction = keyboardDirection(event.key)
      if (!event.shiftKey || !direction) {
        if (
          event.key === 'ArrowUp' ||
          event.key === 'ArrowDown' ||
          event.key === 'ArrowLeft' ||
          event.key === 'ArrowRight' ||
          event.key === 'Tab' ||
          event.key === 'Enter'
        ) {
          clearSelection()
        }
        return
      }

      const currentColumnPosition =
        selectableColumnPositionByKey.get(current.columnKey)
      if (currentColumnPosition === undefined) return
      const nextRowIndex = clamp(
        currentRowIndex + direction.row,
        0,
        rows.length - 1,
      )
      const nextColumnPosition = clamp(
        currentColumnPosition + direction.column,
        0,
        selectableColumns.length - 1,
      )
      const nextColumn = selectableColumns[nextColumnPosition]
      if (!nextColumn) return
      const nextCoordinate = coordinateFor(nextRowIndex, nextColumn.key)
      if (!nextCoordinate) return

      event.preventDefault()
      event.preventGridDefault()
      applySelectionRange({
        anchor: activeSelection?.anchor ?? current,
        focus: nextCoordinate,
      }, 'replace-active', false)
    },
    [
      activeSelection,
      applySelectionRange,
      clearCell,
      clearSelection,
      columnIndexByKey,
      coordinateFor,
      getRowId,
      applyRows,
      rowIndexById,
      rows,
      selectableColumnPositionByKey,
      selectableColumns,
      selectedCellIndexes,
      updateSelectedCells,
      updateRows,
    ],
  )

  const onCellCopy = useCallback(
    (
      { row, column }: CellCopyArgs<TRow>,
      event: ClipboardEvent<HTMLDivElement>,
    ) => {
      const fallbackCoordinate = {
        rowId: getRowId(row),
        columnKey: column.key,
      }
      const currentSelection = activeSelection ?? {
        anchor: fallbackCoordinate,
        focus: fallbackCoordinate,
      }
      const currentBounds = resolveBounds(
        currentSelection,
        rowIndexById,
        columnIndexByKey,
      )
      if (!currentBounds) return

      const text = selectedCellIndexes.size > 0
        ? serializeSelectedCells(rows, selectedCellIndexes, selectableColumns, getCellText)
        : serializeRange(rows, currentBounds, selectableColumns, getCellText)
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
    },
    [
      activeSelection,
      columnIndexByKey,
      getCellText,
      getRowId,
      rowIndexById,
      rows,
      selectableColumns,
      selectedCellIndexes,
    ],
  )

  const onPasteCapture = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const editorTarget = event.target instanceof Element
        ? event.target.closest('.rdg-editor-container, input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        : null
      // A single-cell paste belongs to the active editor. Once the user has
      // selected a range, the range owns the matrix even if RDG opened an
      // editor in the active corner before the browser dispatched `paste`.
      if (editorTarget && selectedCellCount <= 1) return

      const targetCell = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-row-index][data-column-key]')
        : null
      const targetRowIndex = targetCell?.dataset.rowIndex === undefined ? Number.NaN : Number(targetCell.dataset.rowIndex)
      const targetRow = Number.isInteger(targetRowIndex) ? rows[targetRowIndex] : undefined
      const targetCoordinate = targetRow && targetCell?.dataset.columnKey
        ? { rowId: getRowId(targetRow), columnKey: targetCell.dataset.columnKey }
        : null
      const startCoordinate = activeSelection?.anchor ?? activeCellRef.current ?? targetCoordinate
      if (!startCoordinate) return
      const startRowIndex = rowIndexById.get(startCoordinate.rowId)
      const startColumnPosition = selectableColumnPositionByKey.get(
        startCoordinate.columnKey,
      )
      if (startRowIndex === undefined || startColumnPosition === undefined) {
        return
      }

      const clipboardText = event.clipboardData.getData('text/plain')
      let matrix: string[][]
      try {
        matrix = parseDataGridClipboard(clipboardText)
      } catch (error) {
        event.preventDefault(); event.stopPropagation()
        setRangeOperationError(error instanceof Error ? error.message : messages?.clipboardUnreadable ?? 'The clipboard content could not be read.')
        return
      }
      const firstMatrixRow = matrix[0]
      if (!firstMatrixRow || firstMatrixRow.length === 0) return

      event.preventDefault()
      event.stopPropagation()
      if (editorTarget) commitActiveEditor()

      const fillSelection =
        matrix.length === 1 &&
        firstMatrixRow.length === 1 &&
        [...selectedCellIndexes.values()].reduce(
          (count, indexes) => count + indexes.size,
          0,
        ) > 1

      if (fillSelection) {
        if (rangeOperationBlocked) {
          setRangeOperationError(messages?.operationCellLimitExceeded?.(selectedCellCount, DATA_GRID_RANGE_OPERATION_CELL_LIMIT) ?? `The selection contains ${selectedCellCount.toLocaleString()} cells. A single operation can process up to ${DATA_GRID_RANGE_OPERATION_CELL_LIMIT.toLocaleString()}.`)
          return
        }
        const fillValue = firstMatrixRow[0]
        if (fillValue === undefined) return
        updateSelectedCells((row, field) =>
          applyCellText(row, field, fillValue),
        )
        return
      }

      if (pasteMatrix) {
        pendingPastedRangeRef.current = {
          start: startCoordinate,
          rowCount: matrix.length,
          columnCount: Math.max(...matrix.map((row) => row.length)),
        }
        pasteMatrix(startCoordinate, matrix)
        return
      }

      const requiredRowCount = createRow
        ? startRowIndex + matrix.length
        : rows.length
      const nextRows = [...rows]
      while (createRow && nextRows.length < requiredRowCount) {
        nextRows.push(createRow())
      }

      let lastRowIndex = startRowIndex
      let lastColumnPosition = startColumnPosition
      try {
        for (
          let sourceRowIndex = 0;
          sourceRowIndex < matrix.length &&
          startRowIndex + sourceRowIndex < nextRows.length;
          sourceRowIndex += 1
        ) {
          const targetRowIndex = startRowIndex + sourceRowIndex
          const sourceRow = matrix[sourceRowIndex]
          let nextRow = nextRows[targetRowIndex]
          if (!sourceRow || !nextRow) continue
          for (
            let sourceColumnIndex = 0;
            sourceColumnIndex < sourceRow.length &&
            startColumnPosition + sourceColumnIndex < selectableColumns.length;
            sourceColumnIndex += 1
          ) {
            const targetColumnPosition = startColumnPosition + sourceColumnIndex
            const targetColumn = selectableColumns[targetColumnPosition]
            const sourceValue = sourceRow[sourceColumnIndex]
            if (!targetColumn || sourceValue === undefined) continue
            nextRow = applyCellText(nextRow, targetColumn.key, sourceValue)
            lastColumnPosition = Math.max(lastColumnPosition, targetColumnPosition)
          }
          nextRows[targetRowIndex] = nextRow
          lastRowIndex = targetRowIndex
        }
      } catch (error) {
        setRangeOperationError(error instanceof Error ? error.message : 'The clipboard values could not be applied.')
        return
      }

      commitRows(nextRows, {
        minRowIndex: startRowIndex,
        maxRowIndex: lastRowIndex,
      })
      setRangeOperationError(null)
      const lastRow = nextRows[lastRowIndex]
      const lastColumn = selectableColumns[lastColumnPosition]
      const startColumn = selectableColumns[startColumnPosition]
      if (!lastRow || !lastColumn || !startColumn) return
      applySelectionRange({
        anchor: startCoordinate,
        focus: {
          rowId: getRowId(lastRow),
          columnKey: lastColumn.key,
        },
      }, 'replace', false)
      gridRef.current?.setActivePosition({
        rowIdx: startRowIndex,
        idx: startColumn.index,
      })
    },
    [
      applySelectionRange,
      applyCellText,
      activeSelection,
      createRow,
      getRowId,
      rowIndexById,
      rows,
      selectableColumnPositionByKey,
      selectableColumns,
      selectedCellIndexes,
      rangeOperationBlocked,
      selectedCellCount,
      commitRows,
      commitActiveEditor,
      updateSelectedCells,
      pasteMatrix,
      messages,
    ],
  )

  const selectionText = useMemo(() => {
    if (!activeSelection || !activeBounds) return null
    if (rangeOperationBlocked) return null
    return selectedCellIndexes.size > 0
      ? serializeSelectedCells(rows, selectedCellIndexes, selectableColumns, getCellText)
      : serializeRange(rows, activeBounds, selectableColumns, getCellText)
  }, [activeBounds, activeSelection, getCellText, rangeOperationBlocked, rows, selectableColumns, selectedCellIndexes])

  const clearSelectedCells = useCallback(
    () => updateSelectedCells((row, field) => clearCell(row, field)),
    [clearCell, updateSelectedCells],
  )

  const selectionSummary = useMemo(() => {
    if (rangeOperationBlocked && activeBounds) {
      const columnCount = selectableColumns.filter(({ index }) => index >= activeBounds.minColumnIndex && index <= activeBounds.maxColumnIndex).length
      return { rowCount: activeBounds.maxRowIndex - activeBounds.minRowIndex + 1, columnCount, cellCount: selectedCellCount, operationBlocked: true }
    }
    if (selectedCellIndexes.size === 0) return null
    const rowCount = selectedCellIndexes.size
    const columnCount = new Set(
      [...selectedCellIndexes.values()].flatMap((indexes) => [...indexes]),
    ).size
    const cellCount = [...selectedCellIndexes.values()].reduce(
      (count, indexes) => count + indexes.size,
      0,
    )
    if (rowCount === 1 && columnCount === 1) return null
    return {
      rowCount,
      columnCount,
      cellCount,
    }
  }, [activeBounds, rangeOperationBlocked, selectableColumns, selectedCellCount, selectedCellIndexes])
  const selectedRowIds = useMemo(
    () => [...selectedCellIndexes.keys()]
      .sort((left, right) => left - right)
      .flatMap((rowIndex) => {
        const row = rows[rowIndex]
        return row ? [getRowId(row)] : []
      }),
    [getRowId, rows, selectedCellIndexes],
  )
  const selectedCells = useMemo(
    () => [...selectedCellIndexes.entries()].flatMap(([rowIndex, columnIndexes]) => {
      const row = rows[rowIndex]
      if (!row) return []
      return [...columnIndexes].sort((left, right) => left - right).flatMap((columnIndex) => {
        const column = columns[columnIndex]
        return column && selectableColumnKeys.has(column.key) ? [{ row, columnKey: column.key }] : []
      })
    }),
    [columns, rows, selectableColumnKeys, selectedCellIndexes],
  )

  const singleColumnSelection = useMemo(() => {
    if (rangeOperationBlocked) return null
    if (selectedCellIndexes.size === 0) return null
    const selectedColumnIndexes = new Set(
      [...selectedCellIndexes.values()].flatMap((indexes) => [...indexes]),
    )
    if (selectedColumnIndexes.size !== 1) return null
    const selectedColumnIndex = [...selectedColumnIndexes][0]
    if (selectedColumnIndex === undefined) return null
    const column = columns[selectedColumnIndex]
    if (!column || !selectableColumnKeys.has(column.key)) return null

    const field = column.key
    const selectedRows = [...selectedCellIndexes.keys()]
      .sort((left, right) => left - right)
      .flatMap((rowIndex) => {
        const row = rows[rowIndex]
        return row ? [row] : []
      })
    const rawValues = selectedRows.map((row) => getCellText(row, field))
    const firstSelectedRow = selectedRows[0]
    const hasMixedValues = firstSelectedRow
      ? selectedRows.slice(1).some((row) => !cellValuesEqual(firstSelectedRow, row, field))
      : false
    const hasReadOnlyCells = selectedRows.some((row) => {
      if (column.editable === false) return true
      return typeof column.editable === 'function' && !column.editable(row)
    })

    return {
      columnKey: column.key,
      columnLabel:
        typeof column.name === 'string' ? column.name : column.key,
      cellCount: selectedRows.length,
      commonValue: hasMixedValues ? '' : (rawValues[0] ?? ''),
      hasMixedValues,
      hasReadOnlyCells,
      rows: selectedRows,
      rowIds: selectedRows.map((row) => getRowId(row)),
      sessionKey: `${column.key}:${selectedRows.map((row) => getRowId(row)).join('\u0000')}`,
      values: rawValues,
    }
  }, [cellValuesEqual, columns, getCellText, getRowId, rangeOperationBlocked, rows, selectableColumnKeys, selectedCellIndexes])

  const applyUniformValue = useCallback(
    (value: string) => {
      if (!singleColumnSelection) return
      updateSelectedCells((row, field) =>
        applyCellText(row, field, value),
      )
    },
    [
      applyCellText,
      singleColumnSelection,
      updateSelectedCells,
    ],
  )

  const applyValueTransform = useCallback(
    (transform: (value: string) => string) => {
      if (!singleColumnSelection) return
      updateSelectedCells((row, field) =>
        applyCellText(row, field, transform(getCellText(row, field))),
      )
    },
    [
      applyCellText,
      getCellText,
      singleColumnSelection,
      updateSelectedCells,
    ],
  )

  const applyRowTransform = useCallback(
    (transform: (row: TRow, field: string) => TRow) => {
      if (!singleColumnSelection) return { applied: false, error: 'Select one or more cells first.', reason: 'no-selection' } as const
      return updateSelectedCells(transform)
    },
    [
      singleColumnSelection,
      updateSelectedCells,
    ],
  )

  const applyAxisSelection = useCallback((resolved: {
    activePosition: { idx: number; rowIdx: number }
    mode: DataGridSelectionUpdateMode
    selection: CellRange<RowId>
  } | undefined, dragging: boolean) => {
    if (!resolved) return false
    if (dragging) beginSelectionGesture(resolved.selection, resolved.mode)
    else applySelectionRange(resolved.selection, resolved.mode, false)
    gridRef.current?.setActivePosition(resolved.activePosition)
    return true
  }, [applySelectionRange, beginSelectionGesture])

  const extendAxisSelection = useCallback((focus: CellCoordinate<RowId>, activePosition: { idx: number; rowIdx: number }) => {
    if (!updateSelectionGesture(focus)) return false
    gridRef.current?.setActivePosition(activePosition)
    return true
  }, [updateSelectionGesture])

  const resolveVisibleColumnSelection = useCallback(
    (columnKey: string, options: DataGridAxisSelectionOptions = {}) => {
      const firstRow = rows[0]
      const lastRow = rows.at(-1)
      const columnIndex = columnIndexByKey.get(columnKey)
      if (
        !firstRow ||
        !lastRow ||
        columnIndex === undefined ||
        !selectableColumnKeys.has(columnKey)
      ) {
        return
      }
      const anchorColumnKey = options.extend && activeSelection?.anchor.columnKey
        ? activeSelection.anchor.columnKey
        : columnKey
      const anchor = { rowId: getRowId(firstRow), columnKey: anchorColumnKey }
      const focus = { rowId: getRowId(lastRow), columnKey }
      return {
        activePosition: { rowIdx: rows.length - 1, idx: columnIndex },
        mode: selectionUpdateMode(options),
        selection: { anchor, focus },
      }
    },
    [activeSelection, columnIndexByKey, getRowId, rows, selectableColumnKeys],
  )

  const selectVisibleColumn = useCallback(
    (columnKey: string, options: DataGridAxisSelectionOptions = {}) => {
      return applyAxisSelection(resolveVisibleColumnSelection(columnKey, options), false)
    },
    [applyAxisSelection, resolveVisibleColumnSelection],
  )

  const beginVisibleColumnSelection = useCallback(
    (columnKey: string, options: DataGridAxisSelectionOptions = {}) => {
      return applyAxisSelection(resolveVisibleColumnSelection(columnKey, options), true)
    },
    [applyAxisSelection, resolveVisibleColumnSelection],
  )

  const extendVisibleColumnSelection = useCallback(
    (columnKey: string) => {
      const lastRow = rows.at(-1)
      const columnIndex = columnIndexByKey.get(columnKey)
      if (!lastRow || columnIndex === undefined || !selectableColumnKeys.has(columnKey)) return false
      const focus = { rowId: getRowId(lastRow), columnKey }
      return extendAxisSelection(focus, { rowIdx: rows.length - 1, idx: columnIndex })
    },
    [columnIndexByKey, extendAxisSelection, getRowId, rows, selectableColumnKeys],
  )

  const resolveVisibleRowSelection = useCallback(
    (rowId: RowId, options: DataGridAxisSelectionOptions = {}) => {
      const firstColumn = selectableColumns[0]
      const lastColumn = selectableColumns.at(-1)
      const anchorRowId = options.extend && activeSelection?.anchor.rowId !== undefined
        ? activeSelection.anchor.rowId
        : rowId
      const anchorRowIndex = rowIndexById.get(anchorRowId)
      const focusRowIndex = rowIndexById.get(rowId)
      if (anchorRowIndex === undefined || focusRowIndex === undefined || !rows[anchorRowIndex] || !rows[focusRowIndex] || !firstColumn || !lastColumn) return
      const anchor = { rowId: anchorRowId, columnKey: firstColumn.key }
      const focus = { rowId, columnKey: lastColumn.key }
      return {
        activePosition: { rowIdx: focusRowIndex, idx: lastColumn.index },
        mode: selectionUpdateMode(options),
        selection: { anchor, focus },
      }
    },
    [activeSelection, rowIndexById, rows, selectableColumns],
  )

  const selectVisibleRow = useCallback(
    (rowId: RowId, options: DataGridAxisSelectionOptions = {}) => {
      return applyAxisSelection(resolveVisibleRowSelection(rowId, options), false)
    },
    [applyAxisSelection, resolveVisibleRowSelection],
  )

  const beginVisibleRowSelection = useCallback(
    (rowId: RowId, options: DataGridAxisSelectionOptions = {}) => {
      return applyAxisSelection(resolveVisibleRowSelection(rowId, options), true)
    },
    [applyAxisSelection, resolveVisibleRowSelection],
  )

  const extendVisibleRowSelection = useCallback(
    (rowId: RowId) => {
      const rowIndex = rowIndexById.get(rowId)
      const lastColumn = selectableColumns.at(-1)
      if (rowIndex === undefined || !rows[rowIndex] || !lastColumn) return false
      const focus = { rowId, columnKey: lastColumn.key }
      return extendAxisSelection(focus, { rowIdx: rowIndex, idx: lastColumn.index })
    },
    [extendAxisSelection, rowIndexById, rows, selectableColumns],
  )

  const selectAllVisible = useCallback(
    () => {
      const firstRow = rows[0]
      const lastRow = rows.at(-1)
      const firstColumn = selectableColumns[0]
      const lastColumn = selectableColumns.at(-1)
      if (!firstRow || !lastRow || !firstColumn || !lastColumn) return
      const anchor = { rowId: getRowId(firstRow), columnKey: firstColumn.key }
      const focus = { rowId: getRowId(lastRow), columnKey: lastColumn.key }
      applyAxisSelection({
        activePosition: { rowIdx: rows.length - 1, idx: lastColumn.index },
        mode: 'replace',
        selection: { anchor, focus },
      }, false)
    },
    [applyAxisSelection, getRowId, rows, selectableColumns],
  )

  return {
    gridRef,
    gridContainerRef,
    selectionOverlayRef,
    renderers,
    selectionOverlayStyle: selectionOverlay?.style ?? null,
    selectionOverlayAnimated: selectionOverlay?.animate ?? false,
    fillHandleVisualRef,
    fillHandleEnabled: selections.length === 1 && activeBounds !== null && !rangeOperationBlocked,
    selectionSummary,
    selectedRowIds,
    selectedCells,
    contextTarget,
    clearContextTarget,
    singleColumnSelection,
    applyUniformValue,
    applyValueTransform,
    applyRowTransform,
    selectVisibleColumn,
    beginVisibleColumnSelection,
    extendVisibleColumnSelection,
    selectVisibleRow,
    beginVisibleRowSelection,
    extendVisibleRowSelection,
    endSelectionGesture,
    selectAllVisible,
    clearSelection,
    selectionText,
    rangeOperationError,
    rangeOperationBlocked,
    clearSelectedCells,
    commitActiveEditor,
    onCellMouseDown,
    onCellContextMenu,
    onCellKeyDown,
    onCellCopy,
    onGridScroll: syncViewportOverlayImmediately,
    onColumnResize: scheduleViewportOverlaySync,
    onPasteCapture,
    onActivePositionChange,
  }
}
