import type {
  GridHitTarget,
  GridInteractionState,
  GridPoint,
  GridPointerModifiers,
  GridRange,
  GridRowKey,
} from '../model/grid-model.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import {
  clearInteraction,
  freezeRange,
  rangeForHitTarget,
} from './selection-model.js'
import type { GridKeyboardCommand } from './controller-contracts.js'

export type GridInteractionTransition<RowKey extends GridRowKey> =
  | Readonly<{ ok: true; state: GridInteractionState<RowKey> }>
  | Readonly<{ ok: false; reason: string }>

export function activateGridPoint<RowKey extends GridRowKey>(
  target: GridPoint<RowKey>,
  range: GridRange<RowKey> | undefined,
  rows: readonly RowKey[],
  columns: readonly string[],
): GridInteractionTransition<RowKey> {
  const next = range ?? { anchor: target, focus: target }
  if (
    !isGridPointAvailable(target, rows, columns) ||
    !isGridRangeAvailable(next, rows, columns)
  ) {
    return { ok: false, reason: 'The active range is invalid.' }
  }
  return {
    ok: true,
    state: freezeInteraction({
      activeCell: freezePoint(target),
      ranges: Object.freeze([freezeRange(next)]),
      activeRangeIndex: 0,
      gesture: null,
      fillPreview: null,
      actionSession: null,
    }),
  }
}

export function replaceGridRanges<RowKey extends GridRowKey>(
  ranges: readonly GridRange<RowKey>[],
  activeRangeIndex: number | null,
  rows: readonly RowKey[],
  columns: readonly string[],
): GridInteractionTransition<RowKey> {
  if (ranges.length === 0)
    return { ok: true, state: clearInteraction<RowKey>() }
  if (
    activeRangeIndex === null ||
    ranges[activeRangeIndex] === undefined ||
    ranges.some((range) => !isGridRangeAvailable(range, rows, columns))
  ) {
    return { ok: false, reason: 'The selection is invalid.' }
  }
  const next = Object.freeze(ranges.map(freezeRange))
  return {
    ok: true,
    state: freezeInteraction({
      activeCell: next[activeRangeIndex]!.focus,
      ranges: next,
      activeRangeIndex,
      gesture: null,
      fillPreview: null,
      actionSession: null,
    }),
  }
}

export function reconcileInteractionAfterViewChange<RowKey extends GridRowKey>(
  state: GridInteractionState<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
) {
  const active = state.activeCell
  if (!active || !isGridPointAvailable(active, rows, columns)) {
    return clearInteraction<RowKey>()
  }
  return freezeInteraction({
    ...clearInteraction<RowKey>(),
    activeCell: freezePoint(active),
    ranges: Object.freeze([freezeRange({ anchor: active, focus: active })]),
    activeRangeIndex: 0,
  })
}

/**
 * A local row reorder changes range geometry but not the identity of selected
 * cells. Preserve every still-valid key-based range and active point while
 * ending transient pointer/fill/action state tied to the old geometry.
 */
export function reconcileInteractionAfterRowReorder<
  RowKey extends GridRowKey,
>(
  state: GridInteractionState<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
) {
  const ranges = state.ranges.flatMap((range, originalIndex) =>
    isGridRangeAvailable(range, rows, columns)
      ? [{ range: freezeRange(range), originalIndex }]
      : [],
  )
  if (ranges.length === 0) {
    const active = state.activeCell
    if (!active || !isGridPointAvailable(active, rows, columns)) {
      return clearInteraction<RowKey>()
    }
    const point = freezePoint(active)
    return freezeInteraction({
      activeCell: point,
      ranges: Object.freeze([freezeRange({ anchor: point, focus: point })]),
      activeRangeIndex: 0,
      gesture: null,
      fillPreview: null,
      actionSession: null,
    })
  }
  const activeRangeIndex = Math.max(
    0,
    ranges.findIndex((entry) => entry.originalIndex === state.activeRangeIndex),
  )
  const active = state.activeCell && isGridPointAvailable(
    state.activeCell,
    rows,
    columns,
  )
    ? freezePoint(state.activeCell)
    : ranges[activeRangeIndex]!.range.focus
  return freezeInteraction({
    activeCell: active,
    ranges: Object.freeze(ranges.map((entry) => entry.range)),
    activeRangeIndex,
    gesture: null,
    fillPreview: null,
    actionSession: null,
  })
}

export function startGridPointer<RowKey extends GridRowKey>(
  state: GridInteractionState<RowKey>,
  pointerId: number,
  target: GridHitTarget<RowKey>,
  modifiers: GridPointerModifiers,
  rows: readonly RowKey[],
  columns: readonly string[],
): GridInteractionTransition<RowKey> {
  if (target.kind === 'fill-handle') {
    if (state.activeRangeIndex === null)
      return { ok: false, reason: 'There is no active range.' }
    return {
      ok: true,
      state: freezeInteraction({
        ...state,
        gesture: Object.freeze({
          kind: 'fill',
          pointerId,
          sourceRangeIndex: state.activeRangeIndex,
          axis: null,
        }),
        fillPreview: null,
      }),
    }
  }

  const range = rangeForHitTarget(target, rows, columns)
  if (!range || !isGridRangeAvailable(range, rows, columns))
    return { ok: false, reason: 'The pointer target is unavailable.' }
  if (target.kind === 'corner') {
    return {
      ok: true,
      state: freezeInteraction({
        activeCell: range.focus,
        ranges: Object.freeze([range]),
        activeRangeIndex: 0,
        gesture: Object.freeze({
          kind: 'select',
          pointerId,
          mode: 'replace',
          origin: 'corner',
        }),
        fillPreview: null,
        actionSession: null,
      }),
    }
  }
  const current = state.activeRangeIndex
  let ranges: readonly GridRange<RowKey>[]
  let activeRangeIndex: number
  if (modifiers.shift && current !== null) {
    ranges = Object.freeze(
      state.ranges.map((candidate, index) =>
        index === current
          ? freezeRange({ anchor: candidate.anchor, focus: range.focus })
          : candidate,
      ),
    )
    activeRangeIndex = current
  } else if (modifiers.additive) {
    ranges = Object.freeze([...state.ranges, range])
    activeRangeIndex = ranges.length - 1
  } else {
    ranges = Object.freeze([range])
    activeRangeIndex = 0
  }
  return {
    ok: true,
    state: freezeInteraction({
      activeCell: ranges[activeRangeIndex]!.focus,
      ranges,
      activeRangeIndex,
      gesture: Object.freeze({
        kind: 'select',
        pointerId,
        mode: modifiers.shift
          ? 'extend'
          : modifiers.additive
            ? 'append'
            : 'replace',
        origin: target.kind,
      }),
      fillPreview: null,
      actionSession: null,
    }),
  }
}

export function moveGridPointer<RowKey extends GridRowKey>(
  state: GridInteractionState<RowKey>,
  pointerId: number,
  target: GridHitTarget<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
): GridInteractionTransition<RowKey> {
  const gesture = state.gesture
  const targetPoint = pointForPointerTarget(target, rows, columns)
  if (!gesture || gesture.pointerId !== pointerId || !targetPoint) {
    return { ok: false, reason: 'There is no matching pointer gesture.' }
  }
  if (gesture.kind === 'fill') {
    const source = state.ranges[gesture.sourceRangeIndex]
    const axis =
      source && gesture.axis === null
        ? resolveFillAxis(source, targetPoint, rows, columns)
        : gesture.axis
    return {
      ok: true,
      state: freezeInteraction({
        ...state,
        gesture: Object.freeze({ ...gesture, axis }),
        fillPreview: source
          ? resolveFillTarget(source, targetPoint, rows, columns, axis)
          : null,
      }),
    }
  }

  const index = state.activeRangeIndex
  if (index === null) return { ok: false, reason: 'There is no active range.' }
  const current = state.ranges[index]!
  const focus =
    gesture.origin === 'row'
      ? { rowKey: targetPoint.rowKey, columnKey: columns.at(-1)! }
      : gesture.origin === 'column'
        ? { rowKey: rows.at(-1)!, columnKey: targetPoint.columnKey }
        : gesture.origin === 'corner'
          ? { rowKey: rows.at(-1)!, columnKey: columns.at(-1)! }
          : targetPoint
  const ranges = Object.freeze(
    state.ranges.map((candidate, at) =>
      at === index ? freezeRange({ anchor: current.anchor, focus }) : candidate,
    ),
  )
  return {
    ok: true,
    state: freezeInteraction({
      ...state,
      ranges,
      activeCell: freezePoint(focus),
    }),
  }
}

export function endGridPointer<RowKey extends GridRowKey>(
  state: GridInteractionState<RowKey>,
  pointerId: number,
): GridInteractionTransition<RowKey> {
  if (!state.gesture || state.gesture.pointerId !== pointerId) {
    return { ok: false, reason: 'There is no matching pointer gesture.' }
  }
  return {
    ok: true,
    state: freezeInteraction({ ...state, gesture: null, fillPreview: null }),
  }
}

export function moveGridPoint<RowKey extends GridRowKey>(
  active: GridPoint<RowKey>,
  command: Extract<
    GridKeyboardCommand,
    'move-up' | 'move-down' | 'move-left' | 'move-right'
  >,
  rows: readonly RowKey[],
  columns: readonly string[],
) {
  let row = rows.findIndex((key) => gridRowKeysEqual(key, active.rowKey))
  let column = columns.indexOf(active.columnKey)
  if (command === 'move-up') row -= 1
  if (command === 'move-down') row += 1
  if (command === 'move-left') column -= 1
  if (command === 'move-right') column += 1
  return Object.freeze({
    rowKey: rows[clamp(row, 0, rows.length - 1)]!,
    columnKey: columns[clamp(column, 0, columns.length - 1)]!,
  })
}

export function moveGridPointLinear<RowKey extends GridRowKey>(
  active: GridPoint<RowKey>,
  delta: -1 | 1,
  rows: readonly RowKey[],
  columns: readonly string[],
) {
  const row = rows.findIndex((key) => gridRowKeysEqual(key, active.rowKey))
  const column = columns.indexOf(active.columnKey)
  const total = rows.length * columns.length
  const next = clamp(row * columns.length + column + delta, 0, total - 1)
  return Object.freeze({
    rowKey: rows[Math.floor(next / columns.length)]!,
    columnKey: columns[next % columns.length]!,
  })
}

export type GridRangeBounds = Readonly<{
  minRow: number
  maxRow: number
  minColumn: number
  maxColumn: number
  rowCount: number
  columnCount: number
}>

export function gridRangeBounds<RowKey extends GridRowKey>(
  range: GridRange<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
): GridRangeBounds | null {
  const rowA = rows.findIndex((key) =>
    gridRowKeysEqual(key, range.anchor.rowKey),
  )
  const rowB = rows.findIndex((key) =>
    gridRowKeysEqual(key, range.focus.rowKey),
  )
  const columnA = columns.indexOf(range.anchor.columnKey)
  const columnB = columns.indexOf(range.focus.columnKey)
  if (rowA < 0 || rowB < 0 || columnA < 0 || columnB < 0) return null
  const minRow = Math.min(rowA, rowB)
  const maxRow = Math.max(rowA, rowB)
  const minColumn = Math.min(columnA, columnB)
  const maxColumn = Math.max(columnA, columnB)
  return {
    minRow,
    maxRow,
    minColumn,
    maxColumn,
    rowCount: maxRow - minRow + 1,
    columnCount: maxColumn - minColumn + 1,
  }
}

export function gridFillDirection(
  source: GridRangeBounds,
  target: GridRangeBounds,
) {
  if (target.maxRow < source.minRow) return 'up' as const
  if (target.minRow > source.maxRow) return 'down' as const
  if (target.maxColumn < source.minColumn) return 'left' as const
  if (target.minColumn > source.maxColumn) return 'right' as const
  return null
}

export function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor
}

function resolveFillTarget<RowKey extends GridRowKey>(
  source: GridRange<RowKey>,
  focus: GridPoint<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
  axis: 'vertical' | 'horizontal' | null,
): GridRange<RowKey> | null {
  const bounds = gridRangeBounds(source, rows, columns)
  const row = rows.findIndex((key) => gridRowKeysEqual(key, focus.rowKey))
  const column = columns.indexOf(focus.columnKey)
  if (!bounds || row < 0 || column < 0) return null
  const verticalDistance =
    row < bounds.minRow
      ? bounds.minRow - row
      : row > bounds.maxRow
        ? row - bounds.maxRow
        : 0
  const horizontalDistance =
    column < bounds.minColumn
      ? bounds.minColumn - column
      : column > bounds.maxColumn
        ? column - bounds.maxColumn
        : 0
  if (verticalDistance === 0 && horizontalDistance === 0) return null
  if ((axis ?? (verticalDistance >= horizontalDistance ? 'vertical' : 'horizontal')) === 'vertical') {
    return row < bounds.minRow
      ? freezeRange({
          anchor: { rowKey: rows[row]!, columnKey: columns[bounds.minColumn]! },
          focus: {
            rowKey: rows[bounds.minRow - 1]!,
            columnKey: columns[bounds.maxColumn]!,
          },
        })
      : freezeRange({
          anchor: {
            rowKey: rows[bounds.maxRow + 1]!,
            columnKey: columns[bounds.minColumn]!,
          },
          focus: { rowKey: rows[row]!, columnKey: columns[bounds.maxColumn]! },
        })
  }
  return column < bounds.minColumn
    ? freezeRange({
        anchor: { rowKey: rows[bounds.minRow]!, columnKey: columns[column]! },
        focus: {
          rowKey: rows[bounds.maxRow]!,
          columnKey: columns[bounds.minColumn - 1]!,
        },
      })
    : freezeRange({
        anchor: {
          rowKey: rows[bounds.minRow]!,
          columnKey: columns[bounds.maxColumn + 1]!,
        },
        focus: { rowKey: rows[bounds.maxRow]!, columnKey: columns[column]! },
      })
}

function resolveFillAxis<RowKey extends GridRowKey>(
  source: GridRange<RowKey>,
  focus: GridPoint<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
): 'vertical' | 'horizontal' | null {
  const bounds = gridRangeBounds(source, rows, columns)
  const row = rows.findIndex((key) => gridRowKeysEqual(key, focus.rowKey))
  const column = columns.indexOf(focus.columnKey)
  if (!bounds || row < 0 || column < 0) return null
  const verticalDistance =
    row < bounds.minRow
      ? bounds.minRow - row
      : row > bounds.maxRow
        ? row - bounds.maxRow
        : 0
  const horizontalDistance =
    column < bounds.minColumn
      ? bounds.minColumn - column
      : column > bounds.maxColumn
        ? column - bounds.maxColumn
        : 0
  if (verticalDistance === 0 && horizontalDistance === 0) return null
  return verticalDistance >= horizontalDistance ? 'vertical' : 'horizontal'
}

function isGridRangeAvailable<RowKey extends GridRowKey>(
  range: GridRange<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
) {
  return (
    isGridPointAvailable(range.anchor, rows, columns) &&
    isGridPointAvailable(range.focus, rows, columns)
  )
}

function isGridPointAvailable<RowKey extends GridRowKey>(
  point: GridPoint<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
) {
  return (
    rows.some((rowKey) => gridRowKeysEqual(rowKey, point.rowKey)) &&
    columns.includes(point.columnKey)
  )
}

function pointForPointerTarget<RowKey extends GridRowKey>(
  target: GridHitTarget<RowKey>,
  rows: readonly RowKey[],
  columns: readonly string[],
): GridPoint<RowKey> | null {
  const firstRow = rows[0]
  const firstColumn = columns[0]
  if (
    firstRow === undefined ||
    firstColumn === undefined ||
    target.kind === 'fill-handle'
  )
    return null
  switch (target.kind) {
    case 'cell':
      return isGridPointAvailable(target, rows, columns)
        ? freezePoint({ rowKey: target.rowKey, columnKey: target.columnKey })
        : null
    case 'row':
      return rows.some((rowKey) => gridRowKeysEqual(rowKey, target.rowKey))
        ? freezePoint({ rowKey: target.rowKey, columnKey: firstColumn })
        : null
    case 'column':
      return columns.includes(target.columnKey)
        ? freezePoint({ rowKey: firstRow, columnKey: target.columnKey })
        : null
    case 'corner':
      return freezePoint({ rowKey: firstRow, columnKey: firstColumn })
  }
}

function freezePoint<RowKey extends GridRowKey>(point: GridPoint<RowKey>) {
  return Object.freeze({ ...point })
}

function freezeInteraction<RowKey extends GridRowKey>(
  state: GridInteractionState<RowKey>,
) {
  return Object.freeze(state)
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
