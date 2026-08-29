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
import { classNames } from './class-names'

import {
  clamp,
  keyboardDirection,
  rangeCellCount,
  resolveBounds,
  serializeRange,
  type CellCoordinate,
  type CellRange,
} from './range-utils'
import { DATA_GRID_CLIPBOARD_CELL_LIMIT, parseDataGridClipboard } from './clipboard'

// Migrated from Huifan's reusable data-grid selection state machine. Keep
// selection geometry, clipboard, pointer and viewport-overlay behavior aligned
// with that source contract; Cellophane only supplies its Dataset adapter.

type UseDataGridRangeSelectionOptions<TRow extends { id: string }> = {
  rows: readonly TRow[]
  columns: readonly Column<TRow>[]
  selectableColumnKeys: ReadonlySet<string>
  applyRows?: (rows: readonly TRow[]) => void
  updateRows: (rows: TRow[]) => void
  createRow?: () => TRow
  getCellText: (
    row: TRow,
    field: keyof TRow,
  ) => string
  applyCellText: (
    row: TRow,
    field: keyof TRow,
    value: string,
  ) => TRow
  clearCell: (
    row: TRow,
    field: keyof TRow,
  ) => TRow
  rowIndexForId?: (rowId: string) => number | undefined
  pasteMatrix?: (start: CellCoordinate, matrix: string[][]) => void
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

type DataGridContextTarget = {
  rowId: string
  insideSelection: boolean
}

const DATA_GRID_RANGE_OPERATION_CELL_LIMIT = DATA_GRID_CLIPBOARD_CELL_LIMIT

export function useDataGridRangeSelection<TRow extends { id: string }>({
  rows,
  columns,
  selectableColumnKeys,
  applyRows,
  updateRows,
  createRow,
  getCellText,
  applyCellText,
  clearCell,
  rowIndexForId,
  pasteMatrix,
}: UseDataGridRangeSelectionOptions<TRow>) {
  const gridRef = useRef<DataGridHandle>(null)
  const gridContainerRef = useRef<HTMLDivElement>(null)
  const selectionOverlayRef = useRef<HTMLDivElement>(null)
  const overlayFrameRef = useRef<number | null>(null)
  const draggingSelectionIndexRef = useRef<number | null>(null)
  const activeCellRef = useRef<CellCoordinate | null>(null)
  const selectionClearedRef = useRef(true)
  const pendingPastedRangeRef = useRef<{ start: CellCoordinate; rowCount: number; columnCount: number } | null>(null)
  const [selections, setSelections] = useState<CellRange[]>([])
  const [showActiveCellSelection, setShowActiveCellSelection] = useState(true)
  const [rangeOperationError, setRangeOperationError] = useState<string | null>(null)
  const [contextTarget, setContextTarget] =
    useState<DataGridContextTarget | null>(null)
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
  }, [])

  const rowIndexById = useMemo<Pick<ReadonlyMap<string, number>, 'get'>>(
    () => rowIndexForId ? { get: rowIndexForId } : new Map(rows.map((row, index) => [row.id, index])),
    [rowIndexForId, rows],
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
    setSelections([{ anchor: pending.start, focus: { rowId: lastRow.id, columnKey: lastColumn.key } }])
  }, [rowIndexById, rows, selectableColumnPositionByKey, selectableColumns])

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
    (updateCell: (row: TRow, field: keyof TRow) => TRow) => {
      if (rangeOperationBlocked) {
        setRangeOperationError(`选区包含 ${selectedCellCount.toLocaleString('zh-CN')} 个单元格；单次操作最多处理 ${DATA_GRID_RANGE_OPERATION_CELL_LIMIT.toLocaleString('zh-CN')} 个。`)
        return
      }
      if (selectedCellIndexes.size === 0) return
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
          nextRow = updateCell(nextRow, column.key as keyof TRow)
        }
        if (nextRow !== row) changedRows.push(nextRow)
      }
      if (applyRows) applyRows(changedRows)
      else {
        const nextRows = [...rows]
        changedRows.forEach((row) => {
          const index = rowIndexById.get(row.id)
          if (index !== undefined) nextRows[index] = row
        })
        updateRows(nextRows)
      }
    },
    [
      columns,
      applyRows,
      rows,
      rowIndexById,
      selectableColumnKeys,
      selectedCellIndexes,
      rangeOperationBlocked,
      selectedCellCount,
      updateRows,
    ],
  )

  useEffect(() => {
    const stopDragging = () => {
      draggingSelectionIndexRef.current = null
    }
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('blur', stopDragging)
    return () => {
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('blur', stopDragging)
    }
  }, [])

  useEffect(() => {
    if (selections.length === 0) return

    const clearWhenOutsideGrid = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const gridElement = gridRef.current?.element
      if (gridElement?.contains(target)) {
        if (
          target.closest(
            '[role="gridcell"], [role="columnheader"], input, textarea, select, [contenteditable="true"]',
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
  }, [clearSelection, selections.length])

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
    (rowIndex: number, columnKey: string): CellCoordinate | null => {
      const row = rows[rowIndex]
      if (!row || !selectableColumnKeys.has(columnKey)) return null
      return { rowId: row.id, columnKey }
    },
    [rows, selectableColumnKeys],
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
      activeCellRef.current = coordinate
      setShowActiveCellSelection(true)
      const additive = event.ctrlKey || event.metaKey
      if (event.shiftKey && activeSelection) {
        const nextSelectionIndex = Math.max(selections.length - 1, 0)
        draggingSelectionIndexRef.current = nextSelectionIndex
        setSelections((current) => [
          ...current.slice(0, -1),
          { anchor: activeSelection.anchor, focus: coordinate },
        ])
        return
      }
      if (additive) {
        if (isCellSelected(rowIdx, column.idx)) {
          draggingSelectionIndexRef.current = null
          setSelections((current) =>
            current.filter((selection) => {
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
            }),
          )
          return
        }
        draggingSelectionIndexRef.current = selections.length
        setSelections((current) => [
          ...current,
          { anchor: coordinate, focus: coordinate },
        ])
        return
      }
      draggingSelectionIndexRef.current = 0
      setSelections([{ anchor: coordinate, focus: coordinate }])
    },
    [
      activeSelection,
      clearSelection,
      columnIndexByKey,
      coordinateFor,
      isCellSelected,
      rowIndexById,
      selections.length,
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
        rowId: row.id,
        insideSelection: isInsideSelection,
      })
      if (!coordinate) {
        clearSelection()
        return
      }
      if (!isInsideSelection) {
        activeCellRef.current = coordinate
        setSelections([{ anchor: coordinate, focus: coordinate }])
      }
    },
    [
      clearSelection,
      coordinateFor,
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
            isSelected || (props.isCellActive && showActiveCellSelection)
          }
          data-range-selected={isSelected || undefined}
          data-range-active={isActive || undefined}
          data-range-corner={isRangeCorner || undefined}
          data-range-row-header={isSelectedRowHeader || undefined}
          data-row-id={props.row.id}
          data-column-key={columnKey}
          className={classNames(
            props.className,
            isSelected && 'operational-data-grid-range-cell',
          )}
          onPointerEnter={() => {
            const draggingSelectionIndex =
              draggingSelectionIndexRef.current
            if (draggingSelectionIndex === null) return
            const coordinate = coordinateFor(props.rowIdx, columnKey)
            if (!coordinate) return
            setSelections((current) =>
              current.map((selection, index) =>
                index === draggingSelectionIndex
                  ? { ...selection, focus: coordinate }
                  : selection,
              ),
            )
          }}
        />
      )
    },
    [
      activeBounds,
      coordinateFor,
      isCellSelected,
      selectableColumnKeys,
      selectedCellIndexes,
      showActiveCellSelection,
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
        rowId: row.id,
        columnKey: column.key,
      }
      setShowActiveCellSelection(true)
    },
    [],
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
          setSelections([{
            anchor: { rowId: firstRow.id, columnKey: firstColumn.key },
            focus: { rowId: lastRow.id, columnKey: lastColumn.key },
          }])
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
                .reduce((next, { key }) => clearCell(next, key as keyof TRow), row)
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
      setSelections((currentSelections) => [
        ...currentSelections.slice(0, -1),
        {
          anchor: currentSelections.at(-1)?.anchor ?? current,
          focus: nextCoordinate,
        },
      ])
      activeCellRef.current = nextCoordinate
    },
    [
      activeSelection,
      clearCell,
      clearSelection,
      columnIndexByKey,
      coordinateFor,
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
        rowId: row.id,
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

      const selectedColumnIndexes = new Set(
        [...selectedCellIndexes.values()].flatMap((indexes) => [...indexes]),
      )
      const selectedColumnIndex = [...selectedColumnIndexes][0]
      const text =
        selectedCellIndexes.size > 1 &&
        selectedColumnIndexes.size === 1 &&
        selectedColumnIndex !== undefined
          ? [...selectedCellIndexes.keys()]
              .sort((left, right) => left - right)
              .map((rowIndex) => {
                const selectedRow = rows[rowIndex]
                const selectedColumn = columns[selectedColumnIndex]
                if (!selectedRow || !selectedColumn) return ''
                return serializeRange(
                  rows,
                  {
                    minRowIndex: rowIndex,
                    maxRowIndex: rowIndex,
                    minColumnIndex: selectedColumnIndex,
                    maxColumnIndex: selectedColumnIndex,
                  },
                  selectableColumns,
                  getCellText,
                )
              })
              .join('\n')
          : serializeRange(
              rows,
              currentBounds,
              selectableColumns,
              getCellText,
            )
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
    },
    [
      activeSelection,
      columnIndexByKey,
      columns,
      getCellText,
      rowIndexById,
      rows,
      selectableColumns,
      selectedCellIndexes,
    ],
  )

  const onPasteCapture = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const targetCell = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-row-id][data-column-key]')
        : null
      const targetCoordinate = targetCell?.dataset.rowId && targetCell.dataset.columnKey
        ? { rowId: targetCell.dataset.rowId, columnKey: targetCell.dataset.columnKey }
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
        setRangeOperationError(error instanceof Error ? error.message : '剪贴板内容无法读取。')
        return
      }
      const firstMatrixRow = matrix[0]
      if (!firstMatrixRow || firstMatrixRow.length === 0) return

      event.preventDefault()
      event.stopPropagation()

      const fillSelection =
        matrix.length === 1 &&
        firstMatrixRow.length === 1 &&
        [...selectedCellIndexes.values()].reduce(
          (count, indexes) => count + indexes.size,
          0,
        ) > 1

      if (fillSelection) {
        if (rangeOperationBlocked) {
          setRangeOperationError(`选区包含 ${selectedCellCount.toLocaleString('zh-CN')} 个单元格；单次操作最多处理 ${DATA_GRID_RANGE_OPERATION_CELL_LIMIT.toLocaleString('zh-CN')} 个。`)
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
          const targetColumnPosition =
            startColumnPosition + sourceColumnIndex
          const targetColumn = selectableColumns[targetColumnPosition]
          const sourceValue = sourceRow[sourceColumnIndex]
          if (!targetColumn || sourceValue === undefined) continue
          const field = targetColumn.key as keyof TRow
          nextRow = applyCellText(
            nextRow,
            field,
            sourceValue,
          )
          lastColumnPosition = Math.max(
            lastColumnPosition,
            targetColumnPosition,
          )
        }
        nextRows[targetRowIndex] = nextRow
        lastRowIndex = targetRowIndex
      }

      commitRows(nextRows, {
        minRowIndex: startRowIndex,
        maxRowIndex: lastRowIndex,
      })
      const lastRow = nextRows[lastRowIndex]
      const lastColumn = selectableColumns[lastColumnPosition]
      const startColumn = selectableColumns[startColumnPosition]
      if (!lastRow || !lastColumn || !startColumn) return
      setSelections([{
        anchor: startCoordinate,
        focus: {
          rowId: lastRow.id,
          columnKey: lastColumn.key,
        },
      }])
      gridRef.current?.setActivePosition({
        rowIdx: startRowIndex,
        idx: startColumn.index,
      })
    },
    [
      applyCellText,
      activeSelection,
      createRow,
      rowIndexById,
      rows,
      selectableColumnPositionByKey,
      selectableColumns,
      selectedCellIndexes,
      rangeOperationBlocked,
      selectedCellCount,
      commitRows,
      updateSelectedCells,
      pasteMatrix,
    ],
  )

  const selectionText = useMemo(() => {
    if (!activeSelection || !activeBounds) return null
    if (rangeOperationBlocked) return null
    const selectedColumnIndexes = new Set([...selectedCellIndexes.values()].flatMap((indexes) => [...indexes]))
    const selectedColumnIndex = [...selectedColumnIndexes][0]
    if (selectedCellIndexes.size > 1 && selectedColumnIndexes.size === 1 && selectedColumnIndex !== undefined) {
      return [...selectedCellIndexes.keys()].sort((left, right) => left - right).map((rowIndex) => serializeRange(rows, {
        minRowIndex: rowIndex,
        maxRowIndex: rowIndex,
        minColumnIndex: selectedColumnIndex,
        maxColumnIndex: selectedColumnIndex,
      }, selectableColumns, getCellText)).join('\n')
    }
    return serializeRange(rows, activeBounds, selectableColumns, getCellText)
  }, [activeBounds, activeSelection, getCellText, rangeOperationBlocked, rows, selectableColumns, selectedCellIndexes])

  const clearSelectedCells = useCallback(() => {
    updateSelectedCells((row, field) => clearCell(row, field))
  }, [clearCell, updateSelectedCells])

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
      .flatMap((rowIndex) => rows[rowIndex]?.id ? [rows[rowIndex].id] : []),
    [rows, selectedCellIndexes],
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

    const field = column.key as keyof TRow
    const selectedRows = [...selectedCellIndexes.keys()]
      .sort((left, right) => left - right)
      .flatMap((rowIndex) => {
        const row = rows[rowIndex]
        return row ? [row] : []
      })
    const rawValues = selectedRows.map((row) => String(row[field] ?? ''))
    const hasMixedValues = rawValues.some(
      (value) => value !== rawValues[0],
    )
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
      rowIds: selectedRows.map((row) => row.id),
      values: rawValues,
    }
  }, [columns, rangeOperationBlocked, rows, selectableColumnKeys, selectedCellIndexes])

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
        applyCellText(row, field, transform(String(row[field] ?? ''))),
      )
    },
    [
      applyCellText,
      singleColumnSelection,
      updateSelectedCells,
    ],
  )

  const applyRowTransform = useCallback(
    (transform: (row: TRow, field: keyof TRow) => TRow) => {
      if (!singleColumnSelection) return
      updateSelectedCells(transform)
    },
    [
      singleColumnSelection,
      updateSelectedCells,
    ],
  )

  const selectVisibleColumn = useCallback(
    (columnKey: string) => {
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
      const anchor = { rowId: firstRow.id, columnKey }
      const focus = { rowId: lastRow.id, columnKey }
      activeCellRef.current = focus
      setSelections([{ anchor, focus }])
      gridRef.current?.setActivePosition({
        rowIdx: rows.length - 1,
        idx: columnIndex,
      })
    },
    [columnIndexByKey, rows, selectableColumnKeys],
  )

  return {
    gridRef,
    gridContainerRef,
    selectionOverlayRef,
    renderers,
    selectionOverlayStyle: selectionOverlay?.style ?? null,
    selectionOverlayAnimated: selectionOverlay?.animate ?? false,
    fillHandleEnabled: selections.length === 1 && activeBounds !== null && !rangeOperationBlocked,
    selectionSummary,
    selectedRowIds,
    contextTarget,
    clearContextTarget,
    singleColumnSelection,
    applyUniformValue,
    applyValueTransform,
    applyRowTransform,
    selectVisibleColumn,
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
