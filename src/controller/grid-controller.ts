import { resolveGridGeometry } from '../layout/grid-geometry.js'
import {
  decodeClipboardMatrix,
  encodeClipboardMatrix,
} from '../data/clipboard-matrix.js'
import {
  applyAtomicDraftTransaction,
  applyCellTransaction,
  createRowTransaction,
  restoreHistory,
  type GridCellMutation,
} from '../data/draft-transactions.js'
import {
  planGridClear,
  planGridFill,
  planRestoreCells,
  planRestoreRows,
} from '../data/command-planner.js'
import {
  assertCompleteDataSourceSnapshot,
  assertUniqueDataSourceRowKeys,
  type GridDataSource,
  type GridDataSourceSnapshot,
  type GridRowKeyRemap,
} from '../data/data-source.js'
import { deriveLocalView } from '../data/local-view.js'
import {
  areGridResolvedCellValuesEqual,
  resolveGridCellValue,
} from '../data/runtime-cell-resolver.js'
import { rebaseGridDraft } from '../data/rebase-draft.js'
import { replayDraftAfterCommit } from '../data/replay-after-commit.js'
import { areGridAuthorityRowsEqual } from '../data/authority-snapshot.js'
import { collectRowValidationIssues, findRowIdentityIssue } from '../data/row-invariants.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import {
  createGridColumnIndex,
  createGridRowIndex,
} from '../data/runtime-index.js'
import {
  areGridValuesEqual,
  cloneGridRow,
  invokeGridCallback,
  invokeGridResult,
} from '../data/safe-callback.js'
import type {
  GridCompiledColumn,
  GridControllerSnapshot,
  GridEditSession,
  GridHitTarget,
  GridInteractionState,
  GridPoint,
  GridPointerModifiers,
  GridRange,
  GridRowKey,
  GridValueResult,
} from '../model/grid-model.js'
import { encodeCellIdentity } from '../model/cell-identity.js'
import { gridRowKeysEqual } from '../model/row-key.js'
import {
  clearInteraction,
  rangeForHitTarget,
  selectedCells,
  selectedRowKeys,
} from './selection-model.js'
import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type {
  GridController,
  GridControllerOptions,
  GridDispatchResult,
  GridEffectOwner,
  GridEffectRequest,
  GridIntent,
  GridKeyboardCommand,
  GridTransactionIssue,
  GridTransactionRowPosition,
} from './controller-contracts.js'
import {
  selectGridRowDeletePlan,
  selectGridRowDuplicatePlan,
} from './grid-selectors.js'
import {
  GridEffectCoordinator,
  type GridActiveEffect,
} from './effect-coordinator.js'
import { GridPersistenceCoordinator } from './persistence-coordinator.js'
import {
  activateGridPoint,
  endGridPointer,
  moveGridPoint,
  moveGridPointLinear,
  moveGridPointer,
  reconcileInteractionAfterRowReorder,
  reconcileInteractionAfterViewChange,
  replaceGridRanges,
  startGridPointer,
} from './interaction-transitions.js'

function remapGridRowKey<RowKey extends GridRowKey>(
  rowKey: RowKey,
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  return remap.find((item) => gridRowKeysEqual(item.from, rowKey))?.to ?? rowKey
}

function remapGridRowKeys<RowKey extends GridRowKey>(
  rowKeys: readonly RowKey[],
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  return remap.length === 0
    ? rowKeys
    : Object.freeze(rowKeys.map((rowKey) => remapGridRowKey(rowKey, remap)))
}

function remapGridPoint<RowKey extends GridRowKey>(
  point: GridPoint<RowKey>,
  remap: readonly GridRowKeyRemap<RowKey>[],
): GridPoint<RowKey> {
  if (remap.length === 0) return point
  const rowKey = remapGridRowKey(point.rowKey, remap)
  return gridRowKeysEqual(rowKey, point.rowKey)
    ? point
    : Object.freeze({ ...point, rowKey })
}

function remapGridInteraction<RowKey extends GridRowKey>(
  interaction: GridInteractionState<RowKey>,
  remap: readonly GridRowKeyRemap<RowKey>[],
): GridInteractionState<RowKey> {
  if (remap.length === 0) return interaction
  const range = (item: GridRange<RowKey>) => Object.freeze({
    anchor: remapGridPoint(item.anchor, remap),
    focus: remapGridPoint(item.focus, remap),
  })
  return Object.freeze({
    ...interaction,
    activeCell: interaction.activeCell
      ? remapGridPoint(interaction.activeCell, remap)
      : null,
    ranges: Object.freeze(interaction.ranges.map(range)),
    fillPreview: interaction.fillPreview ? range(interaction.fillPreview) : null,
    actionSession: interaction.actionSession
      ? Object.freeze({
          ...interaction.actionSession,
          target: remapGridPoint(interaction.actionSession.target, remap),
        })
      : null,
  })
}

function remapGridEditSession<RowKey extends GridRowKey>(
  session: GridEditSession<RowKey> | null,
  remap: readonly GridRowKeyRemap<RowKey>[],
) {
  if (!session || remap.length === 0) return session
  const cell = remapGridPoint(session.cell, remap)
  return cell === session.cell ? session : Object.freeze({ ...session, cell })
}

export type * from './controller-contracts.js'

type GridDraftCommandOwner<RowKey extends GridRowKey> =
  | Readonly<{ kind: 'external' }>
  | Readonly<{
      kind: 'edit-commit'
      cell: GridPoint<RowKey>
      editRevision: number
    }>
  | Readonly<{ kind: 'bulk-apply'; bulkRevision: number }>
  | Readonly<{
      kind: 'cell-effect'
      cell: GridPoint<RowKey>
      editRevision: number | null
    }>

export function createGridController<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect = never,
>(
  options: GridControllerOptions<Row, RowKey, Schema, Effect>,
): GridController<Row, RowKey, Schema, Effect> {
  validateControllerOptions(options)
  const columns = compileGridColumns(
    options.dataSource.columns,
    options.cellBehaviors,
  )
  const sizes = {
    rowHeight: options.rowHeight ?? 36,
    headerHeight: options.headerHeight ?? 36,
    rowIndicatorWidth: options.rowIndicatorWidth ?? 48,
  }
  const listeners = new Set<() => void>()
  let snapshot = initialSnapshot(options.dataSource, columns, sizes),
    destroyed = false,
    transactionInProgress = false,
    editRevision = 0,
    sequence = 0
  const columnByKey = createGridColumnIndex(columns)
  const configuredColumns = new Set<object>(options.dataSource.columns)
  let rowIndex = createGridRowIndex(
    snapshot.draft.rows,
    options.dataSource.getRowKey,
  )
  let effectCoordinator: GridEffectCoordinator<RowKey>
  effectCoordinator = new GridEffectCoordinator<RowKey>(
    (active) =>
      (active.source === undefined ||
        active.source === snapshot.source.revision) &&
      (active.edit === undefined || active.edit === editRevision) &&
      (active.persistence === undefined ||
        active.persistence === snapshot.persistence.revision) &&
      (!active.cell ||
        active.cellRevision ===
          effectCoordinator.cellRevision(cellKey(active.cell))),
  )
  let unsubscribe: (() => void) | null = null
  let persistence: GridPersistenceCoordinator<Row, RowKey>
  const getSnapshot = () => snapshot
  const externalCommandOwner = Object.freeze({
    kind: 'external' as const,
  })
  const ok = (payload?: unknown): GridDispatchResult =>
    payload === undefined
      ? { accepted: true, revision: snapshot.revision }
      : { accepted: true, revision: snapshot.revision, payload }
  const no = (reason: string): GridDispatchResult => ({
    accepted: false,
    revision: snapshot.revision,
    reason,
  })
  const publish = (changes: Partial<GridControllerSnapshot<Row, RowKey>>) => {
    if (changes.draft && changes.draft !== snapshot.draft) {
      rowIndex = createGridRowIndex(
        changes.draft.rows,
        options.dataSource.getRowKey,
      )
    }
    snapshot = Object.freeze({
      ...snapshot,
      ...changes,
      revision: snapshot.revision + 1,
    })
    listeners.forEach((listener) => {
      try {
        listener()
      } catch {
        // A consumer cannot roll back an already-published controller state.
        // Keep notifying the remaining subscribers and isolate the boundary.
      }
    })
  }
  const subscribe = (listener: () => void) => {
    if (destroyed) return () => undefined
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const subscribeSelector: GridController<
    Row,
    RowKey,
    Schema,
    Effect
  >['subscribeSelector'] = (selector, listener, equal = Object.is) => {
    let selected = selector(snapshot)
    return subscribe(() => {
      const next = selector(snapshot)
      if (!equal(selected, next)) {
        selected = next
        listener()
      }
    })
  }

  const dispatchUnchecked = (
    intent: GridIntent<RowKey, Effect>,
  ): GridDispatchResult => {
    switch (intent.type) {
      case 'source/refresh':
        return persistence.refresh()
      case 'viewport/resized':
        return viewport(
          intent.width,
          intent.height,
          snapshot.layout.scrollLeft,
          snapshot.layout.scrollTop,
        )
      case 'viewport/scrolled':
        return viewport(
          snapshot.layout.viewportWidth,
          snapshot.layout.viewportHeight,
          intent.scrollLeft,
          intent.scrollTop,
        )
      case 'pointer/start':
        return pointerStart(intent.pointerId, intent.target, intent.modifiers)
      case 'pointer/move':
        return pointerMove(intent.pointerId, intent.target)
      case 'pointer/end':
        return pointerEnd(intent.pointerId, intent.target)
      case 'pointer/cancel':
        return pointerCancel(intent.pointerId)
      case 'keyboard/command':
        return keyboard(intent.command, intent.extend ?? false)
      case 'interaction/activate':
        return activate(intent.cell, intent.range)
      case 'interaction/set-ranges':
        return setRanges(intent.ranges, intent.activeRangeIndex)
      case 'interaction/open-action': {
        const blocked = prepareTransition('opening a cell action menu')
        if (blocked) return blocked
        if (
          !rowIndex.byKey.has(intent.target.rowKey) ||
          !columnByKey.has(intent.target.columnKey)
        )
          return no('The action target no longer exists.')
        publish({
          interaction: frozenInteraction({
            ...snapshot.interaction,
            actionSession: Object.freeze({
              target: point(intent.target),
              menuPosition: intent.menuPosition
                ? Object.freeze({ ...intent.menuPosition })
                : null,
            }),
          }),
        })
        return ok()
      }
      case 'interaction/close-action':
        publish({
          interaction: frozenInteraction({
            ...snapshot.interaction,
            actionSession: null,
          }),
        })
        return ok()
      case 'interaction/clear': {
        const blocked = prepareTransition('clearing the selection')
        if (blocked) return blocked
        publish({ interaction: clearInteraction<RowKey>() })
        return ok()
      }
      case 'edit/start':
        return startEdit(intent.cell ?? snapshot.interaction.activeCell)
      case 'edit/change':
        if (!snapshot.edit) return no('There is no active edit session.')
        publish({
          edit: Object.freeze({
            ...snapshot.edit,
            revision: ++editRevision,
            draftValue: intent.value,
            status: 'editing',
            error: null,
          }),
        })
        return ok()
      case 'edit/set-composing':
        if (!snapshot.edit) return no('There is no active edit session.')
        publish({
          edit: Object.freeze({
            ...snapshot.edit,
            revision: ++editRevision,
            composing: intent.composing,
            draftValue: intent.finalValue ?? snapshot.edit.draftValue,
          }),
        })
        return ok()
      case 'edit/set-status':
        if (!snapshot.edit) return no('There is no active edit session.')
        publish({
          edit: Object.freeze({
            ...snapshot.edit,
            revision: ++editRevision,
            status: intent.status,
            error: intent.error ?? null,
          }),
        })
        return ok()
      case 'edit/commit':
        return commitEdit()
      case 'edit/commit-and-move': {
        const committed = commitEdit()
        if (!committed.accepted) return committed
        return intent.direction === 'down'
          ? keyboard('move-down', false)
          : moveLinear(intent.direction === 'next' ? 1 : -1)
      }
      case 'edit/cancel':
        if (!snapshot.edit) return no('There is no active edit session.')
        editRevision += 1
        publish({ edit: null })
        return ok()
      case 'cell/set-value':
        return mutate(
          [{ cell: intent.cell, value: intent.value }],
          intent.label ?? 'Edit cell',
        )
      case 'cell/run-effect':
        return runCellEffect(intent.cell, intent.effect, intent.input)
      case 'cell/cancel-effect':
        return cancelCellEffect(intent.effectId)
      case 'cell/run-action':
        return runCellAction(intent.cell, intent.action)
      case 'selection/copy':
        return copy()
      case 'selection/paste':
        return paste(intent.text)
      case 'selection/clear-values':
        return clearValues()
      case 'selection/fill':
        return fill(intent.target)
      case 'cell/revert':
        return revertCells([intent.cell])
      case 'selection/revert':
        return revertCells(selectedCells(
          snapshot.interaction.ranges,
          snapshot.view.visibleRowKeys,
          columnKeys(),
        ))
      case 'rows/revert':
        return revertRows(intent.rowKeys ?? selectedRowKeys(
          snapshot.interaction.ranges,
          snapshot.view.visibleRowKeys,
          columnKeys(),
        ))
      case 'conflict/resolve':
        return resolveConflict(intent.rowKey, intent.columnKey, intent.resolution)
      case 'bulk/start':
        return startBulk(intent.columnKey)
      case 'bulk/change':
        if (!snapshot.bulk) return no('There is no active bulk session.')
        publish({
          bulk: Object.freeze({
            ...snapshot.bulk,
            revision: snapshot.bulk.revision + 1,
            draft: intent.value,
            error: null,
          }),
        })
        return ok()
      case 'bulk/apply':
        return applyBulk()
      case 'bulk/cancel':
        publish({ bulk: null })
        return ok()
      case 'filter/open':
        return openFilter(intent.columnKey)
      case 'filter/change':
        return changeFilter(
          intent.index ?? 0,
          intent.operator,
          intent.value,
          intent.combine,
        )
      case 'filter/add-condition':
        return addFilterCondition()
      case 'filter/remove-condition':
        return removeFilterCondition(intent.index)
      case 'filter/apply':
        return applyFilter()
      case 'filter/clear':
        return clearFilter()
      case 'filter/cancel':
        publish({ filterSession: null })
        return ok()
      case 'history/undo':
        return history('undo')
      case 'history/redo':
        return history('redo')
      case 'rows/add':
        return addRow()
      case 'rows/duplicate':
        return duplicateRows()
      case 'rows/delete':
        return deleteRows()
      case 'view/set-global-filter':
        return updateView({ globalFilter: intent.value })
      case 'view/set-column-filters':
        return updateView({ columnFilters: intent.filters })
      case 'view/set-sort':
        return updateView({ sort: intent.sort })
      case 'persistence/set-mode':
        return persistence.setMode(intent.mode)
      case 'persistence/save':
        return persistence.save()
      case 'persistence/retry':
        return persistence.retry()
      case 'feedback/push':
        publish({
          feedback: Object.freeze({
            revision: snapshot.feedback.revision + 1,
            items: Object.freeze([
              ...snapshot.feedback.items.filter(
                (item) => item.id !== intent.item.id,
              ),
              Object.freeze({ ...intent.item }),
            ]),
          }),
        })
        return ok()
      case 'feedback/dismiss':
        publish({
          feedback: Object.freeze({
            revision: snapshot.feedback.revision + 1,
            items: Object.freeze(
              snapshot.feedback.items.filter((item) => item.id !== intent.id),
            ),
          }),
        })
        return ok()
      case 'feedback/clear':
        publish({
          feedback: Object.freeze({
            revision: snapshot.feedback.revision + 1,
            items: Object.freeze([]),
          }),
        })
        return ok()
      case 'controller/run-effect':
        return externalEffect(intent.request)
      case 'controller/cancel-effect': {
        if (!effectCoordinator.cancelExternal(intent.id))
          return no('The effect is not running.')
        return ok()
      }
    }
  }
  const dispatch = (intent: GridIntent<RowKey, Effect>): GridDispatchResult => {
    if (destroyed) return no('The GridController has been destroyed.')
    if (transactionInProgress)
      return no('A grid transaction is currently being applied.')
    const result = invokeGridCallback(() => dispatchUnchecked(intent))
    return result.ok
      ? result.value
      : no(`The grid command could not be completed: ${result.message}`)
  }

  const viewport = (
    width: number,
    height: number,
    scrollLeft: number,
    scrollTop: number,
  ) => {
    if (
      ![width, height, scrollLeft, scrollTop].every(
        (value) => Number.isFinite(value) && value >= 0,
      )
    )
      return no('Viewport values must be finite and non-negative.')
    publish({
      layout: layout(
        columns,
        snapshot.view.visibleRowKeys.length,
        { viewportWidth: width, viewportHeight: height, scrollLeft, scrollTop },
        sizes,
        snapshot.layout.revision + 1,
      ),
    })
    return ok()
  }
  const activate = (target: GridPoint<RowKey>, range?: GridRange<RowKey>) => {
    const blocked = prepareTransition('changing the selection')
    if (blocked) return blocked
    const transition = activateGridPoint(
      target,
      range,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
    if (!transition.ok) return no(transition.reason)
    publish({ interaction: transition.state })
    return ok()
  }
  const setRanges = (
    ranges: readonly GridRange<RowKey>[],
    index: number | null,
  ) => {
    const blocked = prepareTransition('changing the selection')
    if (blocked) return blocked
    const transition = replaceGridRanges(
      ranges,
      index,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
    if (!transition.ok) return no(transition.reason)
    publish({ interaction: transition.state })
    return ok()
  }
  const pointerStart = (
    pointerId: number,
    target: GridHitTarget<RowKey>,
    modifiers: GridPointerModifiers,
  ) => {
    const blocked = prepareTransition('changing the selection')
    if (blocked) return blocked
    const transition = startGridPointer(
      snapshot.interaction,
      pointerId,
      target,
      modifiers,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
    if (!transition.ok) return no(transition.reason)
    publish({ interaction: transition.state })
    return ok()
  }
  const pointerMove = (pointerId: number, target: GridHitTarget<RowKey>) => {
    const transition = moveGridPointer(
      snapshot.interaction,
      pointerId,
      target,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
    if (!transition.ok) return no(transition.reason)
    publish({ interaction: transition.state })
    return ok()
  }
  const pointerEnd = (pointerId: number, target?: GridHitTarget<RowKey>) => {
    if (target && target.kind !== 'fill-handle') {
      const moved = pointerMove(pointerId, target)
      if (!moved.accepted) {
        const ended = endGridPointer(snapshot.interaction, pointerId)
        if (ended.ok) publish({ interaction: ended.state })
        return moved
      }
    }
    const gesture = snapshot.interaction.gesture
    const preview = snapshot.interaction.fillPreview
    const transition = endGridPointer(snapshot.interaction, pointerId)
    if (!transition.ok) return no(transition.reason)
    publish({ interaction: transition.state })
    return gesture?.kind === 'fill' && preview ? fill(preview) : ok()
  }
  const pointerCancel = (pointerId: number) => {
    const transition = endGridPointer(snapshot.interaction, pointerId)
    if (!transition.ok) return no(transition.reason)
    publish({ interaction: transition.state })
    return ok()
  }
  const keyboard = (command: GridKeyboardCommand, extend: boolean) => {
    if (snapshot.bulk) {
      if (command === 'cancel') {
        publish({ bulk: null })
        return ok()
      }
      return no('Apply or cancel the bulk edit before continuing.')
    }
    if (snapshot.edit?.composing)
      return no('Keyboard commands are paused during composition.')
    if (command === 'edit') return startEdit(snapshot.interaction.activeCell)
    if (command === 'commit-edit') return commitEdit()
    if (command === 'cancel') {
      if (snapshot.edit) {
        editRevision += 1
        publish({ edit: null })
      } else publish({ interaction: clearInteraction<RowKey>() })
      return ok()
    }
    if (command === 'clear') return clearValues()
    if (command === 'undo' || command === 'redo') return history(command)
    if (snapshot.edit) {
      const committed = commitEdit()
      if (!committed.accepted) return committed
    }
    const active = snapshot.interaction.activeCell
    if (!active) return no('There is no active cell.')
    const next = moveGridPoint(
      active,
      command,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
    if (!extend) return activate(next)
    const index = snapshot.interaction.activeRangeIndex
    return index === null
      ? activate(next)
      : setRanges(
          snapshot.interaction.ranges.map((range, at) =>
            at === index ? { anchor: range.anchor, focus: next } : range,
          ),
          index,
        )
  }
  const moveLinear = (delta: -1 | 1) => {
    const active = snapshot.interaction.activeCell
    if (!active) return no('There is no active cell.')
    return activate(
      moveGridPointLinear(
        active,
        delta,
        snapshot.view.visibleRowKeys,
        columnKeys(),
      ),
    )
  }

  const startEdit = (target: GridPoint<RowKey> | null) => {
    if (snapshot.bulk || snapshot.filterSession)
      return no('Close the current grid editing surface before editing a cell.')
    if (snapshot.edit) {
      if (target && samePoint(snapshot.edit.cell, target)) return ok()
      const committed = commitEdit()
      if (!committed.accepted) return committed
    }
    const resolved = target ? cell(target) : null,
      edit = resolved?.column.behavior.edit
    if (
      !target ||
      !resolved ||
      !edit ||
      !resolved.column.isEditable(resolved.row)
    )
      return no('This cell does not support editing.')
    const begun = safely(() => ({
      ok: true as const,
      value: edit.begin(resolved.value, context(resolved.row, resolved.column)),
    }))
    if (!begun.ok) return no(begun.issue.message)
    const startedRevision = ++editRevision
    publish({
      interaction: frozenInteraction({
        ...snapshot.interaction,
        actionSession: null,
      }),
      edit: Object.freeze({
        revision: startedRevision,
        startedRevision,
        sourceRevision: snapshot.source.revision,
        cell: point(target),
        originalValue: resolved.value,
        draftValue: begun.value,
        status: 'editing',
        composing: false,
        error: null,
      }),
    })
    return ok()
  }
  const commitEdit = () => {
    const session = snapshot.edit
    if (!session || session.composing)
      return no(
        session
          ? 'The edit is still composing.'
          : 'There is no active edit session.',
      )
    const resolved = cell(session.cell),
      edit = resolved?.column.behavior.edit
    if (!resolved || !edit) return no('The edit target is unavailable.')
    if (
      session.sourceRevision !== snapshot.source.revision &&
      !equalsColumnValue(resolved.column, resolved.value, session.originalValue)
    ) {
      const reason = 'This cell changed remotely while it was being edited. Cancel or restart the edit.'
      publish({ edit: Object.freeze({
        ...session,
        revision: ++editRevision,
        status: 'invalid',
        error: reason,
      }) })
      return no(reason)
    }
    const value = safely(() =>
      edit.commit(session.draftValue, context(resolved.row, resolved.column)),
    )
    if (!value.ok) {
      publish({
        edit: Object.freeze({
          ...session,
          revision: ++editRevision,
          status: 'invalid',
          error: value.issue.message,
        }),
      })
      return no(value.issue.message)
    }
    const result = mutate(
      [{ cell: session.cell, value: value.value }],
      'Edit cell',
      Object.freeze({
        kind: 'edit-commit',
        cell: session.cell,
        editRevision,
      }),
    )
    if (!result.accepted) {
      publish({
        edit: Object.freeze({
          ...session,
          revision: ++editRevision,
          status: 'invalid',
          error: result.reason ?? 'The value is invalid.',
        }),
      })
      return no(result.reason ?? 'The value is invalid.')
    }
    editRevision++
    publish({ edit: null })
    return ok(result.payload)
  }
  const mutate = (
    mutations: readonly GridCellMutation<RowKey>[],
    label: string,
    owner: GridDraftCommandOwner<RowKey> = externalCommandOwner,
  ) => {
    const blocked = draftCommandIssue(owner, 'changing grid data')
    if (blocked) return blocked
    const attempted = invokeGridCallback(() =>
      applyCellTransaction({
        draft: snapshot.draft,
        mutations,
        columns,
        getRowKey: options.dataSource.getRowKey,
        ...(options.dataSource.cloneRow
          ? { cloneRow: options.dataSource.cloneRow }
          : {}),
        label,
        transactionId: `tx-${++sequence}`,
      }),
    )
    if (!attempted.ok) return no(attempted.message)
    const result = attempted.value
    if (!result.ok) {
      return no(result.issues[0]?.message ?? 'The operation is invalid.')
    }
    return executeDraftCommand({
      owner,
      action: 'changing grid data',
      draft: result.draft,
      affectedCells: result.changedCells,
      transactionCost: gridTransactionCost(result.changedCells.length, 0),
      publishCommand: publishDraft,
      payload: { changedCells: result.changedCells.length },
    })
  }
  const executeDraftCommand = (command: Readonly<{
    owner: GridDraftCommandOwner<RowKey>
    action: string
    draft: typeof snapshot.draft
    affectedCells: readonly GridPoint<RowKey>[]
    transactionCost: number
    publishCommand: (draft: typeof snapshot.draft) => void
    payload: unknown
    expectedSnapshot?: typeof snapshot
  }>) => {
    const blocked = draftCommandIssue(command.owner, command.action)
    if (blocked) return blocked
    const limitIssue = mutationLimitIssue(command.transactionCost)
    if (limitIssue) return no(limitIssue)
    const identityIssue = findRowIdentityIssue(
      command.draft.rows,
      options.dataSource.getRowKey,
    )
    if (identityIssue) return no(identityIssue)
    if (command.expectedSnapshot && snapshot !== command.expectedSnapshot)
      return no('The grid changed while the transaction was being prepared.')
    if (command.draft === snapshot.draft) return ok(command.payload)
    command.affectedCells.forEach(invalidateCell)
    command.publishCommand(command.draft)
    return ok(command.payload)
  }
  const publishDraft = (draft: typeof snapshot.draft) => {
    const view = derive(draft.rows, snapshot.view, snapshot.view.revision + 1)
    const visibleOrderUnchanged = sameKeyOrder(
        snapshot.view.visibleRowKeys,
        view.visibleRowKeys,
      ),
      interaction = visibleOrderUnchanged
      ? snapshot.interaction
      : sameGridRowsIgnoringOrder(
          snapshot.draft.rows,
          draft.rows,
          options.dataSource.getRowKey,
        ) && sameKeySet(snapshot.view.visibleRowKeys, view.visibleRowKeys)
        ? reconcileInteractionAfterRowReorder(
            snapshot.interaction,
            view.visibleRowKeys,
            columnKeys(),
          )
        : reconcileInteractionAfterViewChange(
            snapshot.interaction,
            view.visibleRowKeys,
            columnKeys(),
          )
    publish({
      draft,
      view,
      layout: layoutFor(view, snapshot.layout.revision + 1),
      interaction,
    })
    persistence.schedule()
  }

  const commitAtomicTransaction = (input: Readonly<{
    base: typeof snapshot
    createdRows: readonly Row[]
    removedRowKeys?: readonly RowKey[]
    rowOrder?: readonly RowKey[]
    movedRowKeys?: readonly RowKey[]
    mutations: readonly GridCellMutation<RowKey>[]
    label: string
    action: string
  }>) => {
    const attempted = invokeGridCallback(() =>
      applyAtomicDraftTransaction({
        draft: input.base.draft,
        createdRows: input.createdRows,
        ...(input.removedRowKeys
          ? { removedRowKeys: input.removedRowKeys }
          : {}),
        ...(input.rowOrder ? { rowOrder: input.rowOrder } : {}),
        ...(input.movedRowKeys ? { movedRowKeys: input.movedRowKeys } : {}),
        mutations: input.mutations,
        columns,
        getRowKey: options.dataSource.getRowKey,
        ...(options.dataSource.cloneRow
          ? { cloneRow: options.dataSource.cloneRow }
          : {}),
        label: input.label,
        transactionId: `tx-${++sequence}`,
      }),
    )
    if (!attempted.ok) {
      const message = attempted.message
      return Object.freeze({
        dispatch: no(message),
        commit: null,
        issues: Object.freeze([
          transactionIssue<RowKey>('exception', message),
        ]),
      })
    }
    const result = attempted.value
    if (!result.ok) {
      const issues = Object.freeze(
        result.issues.map((issue) =>
          transactionIssue<RowKey>(issue.code, issue.message, issue),
        ),
      )
      return Object.freeze({
        dispatch: no(issues[0]?.message ?? 'The transaction is invalid.'),
        commit: null,
        issues,
      })
    }
    const commit = Object.freeze({
      createdRowKeys: result.createdRowKeys,
      deletedRowKeys: result.deletedRowKeys,
      movedRowKeys: result.movedRowKeys,
      changedCells: result.changedCells,
    })
    const dispatched = executeDraftCommand({
      owner: externalCommandOwner,
      action: input.action,
      draft: result.draft,
      affectedCells: result.changedCells,
      transactionCost: gridTransactionCost(
        result.changedCells.length,
        result.createdRowKeys.length +
          result.deletedRowKeys.length +
          result.movedRowKeys.length,
      ),
      publishCommand: publishDraft,
      payload: commit,
      expectedSnapshot: input.base,
    })
    return dispatched.accepted
      ? Object.freeze({
          dispatch: dispatched,
          commit,
          issues: Object.freeze([]) as readonly GridTransactionIssue<RowKey>[],
        })
      : Object.freeze({
          dispatch: dispatched,
          commit: null,
          issues: Object.freeze([
            transactionIssue<RowKey>(
              'rejected',
              dispatched.reason ?? 'The transaction was rejected.',
            ),
          ]),
        })
  }

  const applyTransaction: GridController<
    Row,
    RowKey,
    Schema,
    Effect
  >['applyTransaction'] = (build, transactionOptions) => {
    const reject = (
      issue: GridTransactionIssue<RowKey>,
    ) => Object.freeze({
      accepted: false,
      revision: snapshot.revision,
      result: null,
      issues: Object.freeze([issue]) as readonly [
        GridTransactionIssue<RowKey>,
      ],
    })
    if (destroyed)
      return reject(transactionIssue(
        'destroyed',
        'The GridController has been destroyed.',
      ))
    if (transactionInProgress)
      return reject(transactionIssue(
        'transaction-active',
        'A grid transaction is currently being applied.',
      ))
    const blocked = draftCommandIssue(
      externalCommandOwner,
      'applying a transaction',
    )
    if (blocked)
      return reject(transactionIssue(
        'session-active',
        blocked.reason ?? 'The transaction is unavailable.',
      ))

    const base = snapshot
    const createdRows: Row[] = []
    const mutations: GridCellMutation<RowKey>[] = []
    const targets = new Set<string>()
    const removedRowKeys = new Set<RowKey>()
    const movedRowKeys = new Set<RowKey>()
    const reservedKeys = new Set<RowKey>([
      ...base.draft.baselineRows.map(options.dataSource.getRowKey),
      ...base.draft.rows.map(options.dataSource.getRowKey),
    ])
    const targetKeys = new Set<RowKey>(
      base.draft.rows.map(options.dataSource.getRowKey),
    )
    const stagedRowKeys = base.draft.rows.map(options.dataSource.getRowKey)
    const rowByKey = new Map(
      base.draft.rows.map(
        (row) => [options.dataSource.getRowKey(row), row] as const,
      ),
    )
    const createdInTransaction = new Set<RowKey>()
    const abortToken = Object.freeze({})
    let transactionOpen = true,
      operationCost = 0
    const abort = (issue: GridTransactionIssue<RowKey> | string): never => {
      throw Object.freeze({
        token: abortToken,
        issue: typeof issue === 'string'
          ? transactionIssue<RowKey>('aborted', issue)
          : freezeTransactionIssue(issue),
      })
    }
    const assertOpen = () => {
      if (!transactionOpen) {
        abort(transactionIssue(
          'transaction-closed',
          'The transaction builder is no longer active.',
        ))
      }
    }
    const reserveMutation = (count = 1) => {
      assertOpen()
      const issue = mutationLimitIssue(operationCost + count)
      if (issue) abort(transactionIssue('mutation-limit', issue))
      operationCost += count
    }
    const positionBefore = (
      position: GridTransactionRowPosition<RowKey> | undefined,
    ) => {
      const beforeRowKey = position?.beforeRowKey ?? null
      if (beforeRowKey !== null) {
        if (options.dataSource.rows?.ordering !== 'mutable') {
          abort(transactionIssue(
            'row-order-unavailable',
            'This data source does not allow row ordering.',
          ))
        }
        if (!targetKeys.has(beforeRowKey)) {
          abort(transactionIssue(
            'unknown-row',
            'The row-order anchor does not exist.',
          ))
        }
      }
      return beforeRowKey
    }
    const stageCreatedRow = (
      create: () => Row,
      failureCode: string,
      position: GridTransactionRowPosition<RowKey> | undefined,
    ) => {
      const beforeRowKey = positionBefore(position)
      reserveMutation()
      const created = invokeGridCallback(create)
      if (!created.ok) {
        return abort(transactionIssue(failureCode, created.message))
      }
      const keyed = invokeGridCallback(() => ({
        row: created.value,
        key: options.dataSource.getRowKey(created.value),
      }))
      if (!keyed.ok) {
        return abort(transactionIssue('invalid-row-key', keyed.message))
      }
      if (reservedKeys.has(keyed.value.key)) {
        return abort(transactionIssue(
          'duplicate-row-key',
          'A created row must have a unique key.',
        ))
      }
      reservedKeys.add(keyed.value.key)
      targetKeys.add(keyed.value.key)
      createdInTransaction.add(keyed.value.key)
      createdRows.push(keyed.value.row)
      rowByKey.set(keyed.value.key, keyed.value.row)
      const insertion = beforeRowKey === null
        ? stagedRowKeys.length
        : stagedRowKeys.findIndex((rowKey) =>
            gridRowKeysEqual(rowKey, beforeRowKey),
          )
      stagedRowKeys.splice(insertion, 0, keyed.value.key)
      return keyed.value.key
    }
    const assertUniqueRowTargets = (rowKeys: readonly RowKey[]) => {
      const unique = new Set(rowKeys)
      if (unique.size !== rowKeys.length) {
        abort(transactionIssue(
          'duplicate-row-target',
          'A row operation cannot contain the same row more than once.',
        ))
      }
      for (const rowKey of rowKeys) {
        if (!targetKeys.has(rowKey)) {
          abort(transactionIssue(
            'unknown-row',
            'A row operation target does not exist.',
          ))
        }
      }
      return unique
    }
    const rowHasMutation = (rowKey: RowKey) => mutations.some((mutation) =>
      gridRowKeysEqual(mutation.cell.rowKey, rowKey),
    )
    const transaction = Object.freeze({
      base,
      createRow: (position?: GridTransactionRowPosition<RowKey>) => {
        assertOpen()
        const create = options.dataSource.rows?.create
        if (!create) {
          return abort(transactionIssue(
            'row-create-unavailable',
            'Creating rows is unavailable.',
          ))
        }
        return stageCreatedRow(create, 'row-create-failed', position)
      },
      duplicateRow: (
        sourceRowKey: RowKey,
        position?: GridTransactionRowPosition<RowKey>,
      ) => {
        assertOpen()
        const duplicate = options.dataSource.rows?.duplicate
        if (!duplicate) {
          return abort(transactionIssue(
            'row-duplicate-unavailable',
            'Duplicating rows is unavailable.',
          ))
        }
        if (!targetKeys.has(sourceRowKey)) {
          return abort(transactionIssue(
            'unknown-row',
            'The row selected for duplication does not exist.',
          ))
        }
        if (rowHasMutation(sourceRowKey)) {
          return abort(transactionIssue(
            'duplicate-after-set',
            'Duplicate a row before staging cell changes to that source row.',
          ))
        }
        const row = rowByKey.get(sourceRowKey)!
        const cloned = cloneGridRow(row, options.dataSource.cloneRow)
        if (!cloned.ok) {
          return abort(transactionIssue('row-clone-failed', cloned.message))
        }
        return stageCreatedRow(
          () => duplicate(cloned.value),
          'row-duplicate-failed',
          position,
        )
      },
      moveRows: (
        requestedRowKeys: readonly RowKey[],
        position?: GridTransactionRowPosition<RowKey>,
      ) => {
        assertOpen()
        const rowKeys = [...requestedRowKeys]
        const chosen = assertUniqueRowTargets(rowKeys)
        if (rowKeys.length === 0) return
        if (options.dataSource.rows?.ordering !== 'mutable') {
          abort(transactionIssue(
            'row-order-unavailable',
            'This data source does not allow row ordering.',
          ))
        }
        const beforeRowKey = positionBefore(position)
        if (beforeRowKey !== null && chosen.has(beforeRowKey)) return
        const moving = stagedRowKeys.filter((rowKey) => chosen.has(rowKey))
        const remaining = stagedRowKeys.filter((rowKey) => !chosen.has(rowKey))
        const insertion = beforeRowKey === null
          ? remaining.length
          : remaining.findIndex((rowKey) =>
              gridRowKeysEqual(rowKey, beforeRowKey),
            )
        const next = [
          ...remaining.slice(0, insertion),
          ...moving,
          ...remaining.slice(insertion),
        ]
        if (sameKeyOrder(stagedRowKeys, next)) return
        reserveMutation(moving.length)
        stagedRowKeys.splice(0, stagedRowKeys.length, ...next)
        moving.forEach((rowKey) => movedRowKeys.add(rowKey))
      },
      deleteRows: (requestedRowKeys: readonly RowKey[]) => {
        assertOpen()
        const rowKeys = [...requestedRowKeys]
        assertUniqueRowTargets(rowKeys)
        if (rowKeys.length === 0) return
        reserveMutation(rowKeys.length)
        const canDelete = options.dataSource.rows?.canDelete
        for (const rowKey of rowKeys) {
          if (rowHasMutation(rowKey)) {
            abort(transactionIssue(
              'delete-after-set',
              'Delete a row before staging cell changes to that row.',
            ))
          }
          if (createdInTransaction.has(rowKey)) continue
          if (!canDelete) {
            return abort(transactionIssue(
              'row-delete-unavailable',
              'Deleting rows is unavailable.',
            ))
          }
          const cloned = cloneGridRow(
            rowByKey.get(rowKey)!,
            options.dataSource.cloneRow,
          )
          if (!cloned.ok) {
            return abort(transactionIssue('row-clone-failed', cloned.message))
          }
          const eligible = invokeGridCallback(() => canDelete(cloned.value))
          if (!eligible.ok) {
            return abort(transactionIssue(
              'row-delete-check-failed',
              eligible.message,
            ))
          }
          if (!eligible.value) {
            return abort(transactionIssue(
              'row-delete-blocked',
              'A row is not eligible for deletion.',
            ))
          }
        }
        rowKeys.forEach((rowKey) => {
          targetKeys.delete(rowKey)
          removedRowKeys.add(rowKey)
          const index = stagedRowKeys.findIndex((candidate) =>
            gridRowKeysEqual(candidate, rowKey),
          )
          if (index >= 0) stagedRowKeys.splice(index, 1)
        })
      },
      set: (
        column: (typeof options.dataSource.columns)[number],
        rowKey: RowKey,
        value: unknown,
      ) => {
        assertOpen()
        if (!configuredColumns.has(column))
          abort(transactionIssue(
            'unknown-column',
            'The transaction column is not configured by this data source.',
          ))
        if (!targetKeys.has(rowKey))
          abort(transactionIssue(
            'unknown-row',
            'The transaction row does not exist.',
            { rowKey, columnKey: column.key },
          ))
        const cell = Object.freeze({ rowKey, columnKey: column.key })
        const identity = encodeCellIdentity(cell)
        if (targets.has(identity))
          abort(transactionIssue(
            'duplicate-cell',
            'A transaction cannot set the same cell more than once.',
            cell,
          ))
        reserveMutation()
        targets.add(identity)
        mutations.push(Object.freeze({ cell, value }))
      },
      abort,
    })

    transactionInProgress = true
    try {
      let returned: unknown
      try {
        returned = (
          build as (value: typeof transaction) => unknown
        )(transaction)
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'token' in error &&
          error.token === abortToken &&
          'issue' in error
        ) {
          return reject(error.issue as GridTransactionIssue<RowKey>)
        }
        return reject(transactionIssue(
          'builder-exception',
          `The transaction builder failed: ${message(error)}`,
        ))
      }
      if (isThenable(returned)) {
        void Promise.resolve(returned).catch(() => undefined)
        return reject(transactionIssue(
          'async-builder',
          'Grid transactions must be built synchronously.',
        ))
      }
      if (snapshot !== base)
        return reject(transactionIssue(
          'stale-base',
          'The grid changed while the transaction was being prepared.',
        ))
      const committed = commitAtomicTransaction({
        base,
        createdRows: Object.freeze(createdRows),
        removedRowKeys: Object.freeze([...removedRowKeys]),
        rowOrder: Object.freeze(stagedRowKeys),
        movedRowKeys: Object.freeze([...movedRowKeys]),
        mutations: Object.freeze(mutations),
        label: transactionOptions?.label?.trim() || 'Update grid',
        action: 'applying a transaction',
      })
      if (!committed.dispatch.accepted || !committed.commit) {
        return Object.freeze({
          accepted: false as const,
          revision: committed.dispatch.revision,
          result: null,
          issues: committed.issues as readonly [
            GridTransactionIssue<RowKey>,
            ...GridTransactionIssue<RowKey>[],
          ],
        })
      }
      return Object.freeze({
        accepted: true as const,
        revision: committed.dispatch.revision,
        result: committed.commit,
        issues: Object.freeze([]) as readonly [],
      })
    } catch (error) {
      return reject(transactionIssue(
        'transaction-exception',
        `The grid transaction failed: ${message(error)}`,
      ))
    } finally {
      transactionOpen = false
      transactionInProgress = false
    }
  }

  const copy = () => {
    const chosen = selectedCells(
      snapshot.interaction.ranges,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
    if (!chosen.length) return no('There is no selection to copy.')
    const rows = snapshot.view.visibleRowKeys,
      cols = columnKeys(),
      chosenSet = new Set(chosen.map(cellKey))
    const ri = chosen.map((item) =>
        rows.findIndex((key) => gridRowKeysEqual(key, item.rowKey)),
      ),
      ci = chosen.map((item) => cols.indexOf(item.columnKey))
    const matrix: string[][] = []
    for (let r = Math.min(...ri); r <= Math.max(...ri); r++) {
      const line: string[] = []
      for (let c = Math.min(...ci); c <= Math.max(...ci); c++) {
        const target = { rowKey: rows[r]!, columnKey: cols[c]! },
          resolved = cell(target)
        if (!chosenSet.has(cellKey(target))) line.push('')
        else if (!resolved?.column.behavior.clipboard)
          return no(`Column "${target.columnKey}" cannot be copied.`)
        else {
          const formatted = invokeGridCallback(() =>
            resolved.column.behavior.clipboard!.format(
              resolved.value,
              context(resolved.row, resolved.column),
            ),
          )
          if (!formatted.ok) return no(formatted.message)
          line.push(formatted.value)
        }
      }
      matrix.push(line)
    }
    const text = encodeClipboardMatrix(matrix)
    return new TextEncoder().encode(text).byteLength >
      (options.maxClipboardBytes ?? 2_000_000)
      ? no('The copied data exceeds the clipboard limit.')
      : ok({ text })
  }
  const paste = (text: string) => {
    const blocked = draftCommandIssue(externalCommandOwner, 'pasting cells')
    if (blocked) return blocked
    const base = snapshot
    if (
      new TextEncoder().encode(text).byteLength >
      (options.maxClipboardBytes ?? 2_000_000)
    )
      return no('The pasted data exceeds the clipboard limit.')
    const active = snapshot.interaction.activeCell
    if (!active) return no('There is no active paste target.')
    const matrix = decodeClipboardMatrix(text)
    const visibleKeys = [...snapshot.view.visibleRowKeys]
    const cols = columnKeys()
    const startR = visibleKeys.findIndex((key) =>
      gridRowKeysEqual(key, active.rowKey),
    )
    const startC = cols.indexOf(active.columnKey)
    const missingRows = Math.max(0, startR + matrix.length - visibleKeys.length)
    const rowLimitIssue = mutationLimitIssue(gridTransactionCost(0, missingRows))
    if (rowLimitIssue) return no(rowLimitIssue)
    const created: Row[] = []
    const create = options.dataSource.rows?.create
    if (missingRows > 0 && !create)
      return no(
        'Paste requires new rows, but this data source cannot create them.',
      )
    const knownKeys = new Set([
      ...base.draft.baselineRows.map(options.dataSource.getRowKey),
      ...base.draft.rows.map(options.dataSource.getRowKey),
    ])
    for (let index = 0; index < missingRows; index += 1) {
      const result = invokeGridCallback(create!)
      if (!result.ok) return no(result.message)
      const row = result.value
      const rowKey = options.dataSource.getRowKey(row)
      if (knownKeys.has(rowKey))
        return no('A row created for paste has a duplicate key.')
      knownKeys.add(rowKey)
      created.push(row)
      visibleKeys.push(rowKey)
    }
    const rowByKey = new Map(
      [...base.draft.rows, ...created].map(
        (row) => [options.dataSource.getRowKey(row), row] as const,
      ),
    )
    const mutations: GridCellMutation<RowKey>[] = []
    for (let r = 0; r < matrix.length; r += 1)
      for (let c = 0; c < matrix[r]!.length; c += 1) {
        const rowKey = visibleKeys[startR + r]
        const columnKey = cols[startC + c]
        if (rowKey === undefined || columnKey === undefined)
          return no('The paste target is outside the grid.')
        const row = rowByKey.get(rowKey)
        const column = columns.find((candidate) => candidate.key === columnKey)
        const parse = column?.behavior.clipboard?.parse
        if (!row || !column || !parse || !column.isEditable(row))
          return no('A paste target is read-only or incompatible.')
        const parsed = safely(() => parse(matrix[r]![c]!, context(row, column)))
        if (!parsed.ok) return no(parsed.issue.message)
        mutations.push({ cell: { rowKey, columnKey }, value: parsed.value })
      }
    const committed = commitAtomicTransaction({
      base,
      createdRows: Object.freeze(created),
      mutations: Object.freeze(mutations),
      label: 'Paste cells',
      action: 'pasting cells',
    })
    return committed.dispatch.accepted
      ? ok({
          changedCells: committed.commit!.changedCells.length,
          createdRows: committed.commit!.createdRowKeys.length,
        })
      : committed.dispatch
  }
  const clearValues = () => {
    const blocked = draftCommandIssue(externalCommandOwner, 'clearing cells')
    if (blocked) return blocked
    const plan = planGridClear({
      targets: selectedCells(
        snapshot.interaction.ranges,
        snapshot.view.visibleRowKeys,
        columnKeys(),
      ),
      rows: snapshot.draft.rows,
      columns,
      getRowKey: options.dataSource.getRowKey,
    })
    if (!plan.ok) return no(plan.reason)
    const result = mutate(plan.value.mutations, 'Clear cells')
    return result.accepted
      ? ok({
          changedCells: plan.value.mutations.length,
          skippedCells: plan.value.skippedCells,
        })
      : result
  }
  const fill = (target: GridRange<RowKey>) => {
    const blocked = draftCommandIssue(externalCommandOwner, 'filling cells')
    if (blocked) return blocked
    const activeIndex = snapshot.interaction.activeRangeIndex
    const source =
      activeIndex === null ? null : snapshot.interaction.ranges[activeIndex]
    if (!source) return no('The fill range is invalid.')
    const planned = invokeGridCallback(() =>
      planGridFill({
        source,
        target,
        visibleRowKeys: snapshot.view.visibleRowKeys,
        rows: snapshot.draft.rows,
        columns,
        getRowKey: options.dataSource.getRowKey,
      }),
    )
    if (!planned.ok) return no(planned.message)
    const plan = planned.value
    return plan.ok ? mutate(plan.value, 'Fill cells') : no(plan.reason)
  }

  const revertCells = (targets: readonly GridPoint<RowKey>[]) => {
    const blocked = draftCommandIssue(externalCommandOwner, 'restoring cells')
    if (blocked) return blocked
    if (targets.length === 0) return no('There are no cells to restore.')
    const planned = invokeGridCallback(() =>
      planRestoreCells({
        rows: snapshot.draft.rows,
        baselineRows: snapshot.draft.baselineRows,
        targets,
        columns,
        getRowKey: options.dataSource.getRowKey,
        ...(options.dataSource.cloneRow
          ? { cloneRow: options.dataSource.cloneRow }
          : {}),
      }),
    )
    if (!planned.ok) return no(planned.message)
    const plan = planned.value
    if (!plan.ok) return no(plan.reason)
    const restoredIds = new Set(plan.value.restored.map(cellKey))
    return recoveryTransaction(
      plan.value.rows,
      snapshot.draft.insertedRowKeys,
      snapshot.draft.deletedRowKeys,
      snapshot.draft.conflicts.filter((conflict) =>
        conflict.columnKey === null || !restoredIds.has(cellKey({ rowKey: conflict.rowKey, columnKey: conflict.columnKey })),
      ),
      'Restore original cells',
      plan.value.restored,
    )
  }

  const revertRows = (rowKeys: readonly RowKey[]) => {
    const blocked = draftCommandIssue(externalCommandOwner, 'restoring rows')
    if (blocked) return blocked
    if (rowKeys.length === 0) return no('There are no rows to restore.')
    const chosen = new Set(rowKeys)
    const rows = planRestoreRows({
      rows: snapshot.draft.rows,
      baselineRows: snapshot.draft.baselineRows,
      rowKeys,
      getRowKey: options.dataSource.getRowKey,
    })
    return recoveryTransaction(
      rows,
      snapshot.draft.insertedRowKeys.filter((rowKey) => !chosen.has(rowKey)),
      snapshot.draft.deletedRowKeys.filter((rowKey) => !chosen.has(rowKey)),
      snapshot.draft.conflicts.filter((conflict) => !chosen.has(conflict.rowKey)),
      'Restore original rows',
      rowKeys.flatMap((rowKey) => columns.map((column) => ({ rowKey, columnKey: column.key }))),
      rowKeys.length,
    )
  }

  const resolveConflict = (
    rowKey: RowKey,
    columnKey: string | null,
    resolution: 'accept-remote' | 'keep-local',
  ) => {
    const blocked = draftCommandIssue(externalCommandOwner, 'resolving conflicts')
    if (blocked) return blocked
    const conflict = snapshot.draft.conflicts.find((candidate) =>
      gridRowKeysEqual(candidate.rowKey, rowKey) &&
      candidate.columnKey === columnKey)
    if (!conflict) return no('The conflict is no longer available.')
    if (resolution === 'accept-remote') {
      return columnKey === null
        ? revertRows([rowKey])
        : revertCells([{ rowKey, columnKey }])
    }

    const conflicts = snapshot.draft.conflicts.filter((candidate) => candidate !== conflict)
    if (columnKey !== null) {
      return recoveryTransaction(
        snapshot.draft.rows,
        snapshot.draft.insertedRowKeys,
        snapshot.draft.deletedRowKeys,
        conflicts,
        'Keep local cell',
        [{ rowKey, columnKey }],
      )
    }

    const baseline = snapshot.draft.baselineRows.some((row) =>
      gridRowKeysEqual(options.dataSource.getRowKey(row), rowKey),
    )
    const locallyDeleted = snapshot.draft.deletedRowKeys.some((key) =>
      gridRowKeysEqual(key, rowKey),
    )
    const rows = locallyDeleted
      ? snapshot.draft.rows.filter(
          (row) =>
            !gridRowKeysEqual(options.dataSource.getRowKey(row), rowKey),
        )
      : snapshot.draft.rows
    const inserted = new Set(snapshot.draft.insertedRowKeys)
    const deleted = new Set(snapshot.draft.deletedRowKeys)
    if (!baseline && !locallyDeleted) inserted.add(rowKey)
    else inserted.delete(rowKey)
    if (locallyDeleted) deleted.add(rowKey)
    else deleted.delete(rowKey)
    return recoveryTransaction(
      rows,
      [...inserted],
      [...deleted],
      conflicts,
      'Keep local row',
      columns.map((column) => ({ rowKey, columnKey: column.key })),
      1,
    )
  }

  const recoveryTransaction = (
    rows: readonly Row[],
    insertedRowKeys: readonly RowKey[],
    deletedRowKeys: readonly RowKey[],
    conflicts: typeof snapshot.draft.conflicts,
    label: string,
    affectedCells: readonly GridPoint<RowKey>[],
    cost = affectedCells.length,
  ) => {
    const blocked = draftCommandIssue(externalCommandOwner, label.toLowerCase())
    if (blocked) return blocked
    const attempted = invokeGridCallback(() =>
      createRowTransaction({
        draft: snapshot.draft,
        rows,
        insertedRowKeys,
        deletedRowKeys,
        conflicts,
        columns,
        getRowKey: options.dataSource.getRowKey,
        label,
        transactionId: `tx-${++sequence}`,
      }),
    )
    if (!attempted.ok) return no(attempted.message)
    return executeDraftCommand({
      owner: externalCommandOwner,
      action: label.toLowerCase(),
      draft: attempted.value,
      affectedCells,
      transactionCost: cost,
      publishCommand: publishDraft,
      payload: { changedCells: affectedCells.length },
    })
  }

  const startBulk = (key = snapshot.interaction.activeCell?.columnKey) => {
    if (snapshot.filterSession)
      return no('Close the filter editor before starting a bulk edit.')
    const blocked = prepareTransition('starting a bulk edit')
    if (blocked) return blocked
    const column = columns.find((candidate) => candidate.key === key),
      bulk = column?.behavior.bulk
    if (!column || !bulk || !column.bulkEditable)
      return no('This column does not support bulk editing.')
    const resolved = selectedCells(
      snapshot.interaction.ranges,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
      .filter((target) => target.columnKey === key)
      .map(cell)
      .filter(defined)
      .filter((item) => item.column.isEditable(item.row))
    if (!resolved.length) return no('There are no bulk-editable cells.')
    const begun = invokeGridCallback(() =>
      bulk.begin(
        resolved.map((item) => item.value),
        resolved.map((item) => context(item.row, item.column)),
      ),
    )
    if (!begun.ok) return no(begun.message)
    publish({
      bulk: Object.freeze({
        revision: (snapshot.bulk?.revision ?? 0) + 1,
        sourceRevision: snapshot.source.revision,
        draftRevision: snapshot.draft.revision,
        viewRevision: snapshot.view.revision,
        selectionSignature: selectionSignature(resolved.map((item) => item.cell)),
        columnKey: column.key,
        targetCells: Object.freeze(resolved.map((item) => item.cell)),
        draft: begun.value,
        error: null,
      }),
    })
    return ok()
  }
  const applyBulk = () => {
    const session = snapshot.bulk
    if (!session) return no('There is no active bulk session.')
    const owner = Object.freeze({
      kind: 'bulk-apply' as const,
      bulkRevision: session.revision,
    })
    const blocked = draftCommandIssue(owner, 'applying the bulk edit')
    if (blocked) return blocked
    const currentTargets = selectedCells(
      snapshot.interaction.ranges,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
      .filter((target) => target.columnKey === session.columnKey)
      .map(cell)
      .filter(defined)
      .filter((item) => item.column.isEditable(item.row))
      .map((item) => item.cell)
    if (
      session.sourceRevision !== snapshot.source.revision ||
      session.draftRevision !== snapshot.draft.revision ||
      session.viewRevision !== snapshot.view.revision ||
      session.selectionSignature !== selectionSignature(currentTargets)
    ) {
      const reason = 'The data or selection changed after this bulk edit opened. Cancel it and start again.'
      publish({ bulk: Object.freeze({ ...session, revision: session.revision + 1, error: reason }) })
      return no(reason)
    }
    const mutations: GridCellMutation<RowKey>[] = []
    for (const target of session.targetCells) {
      const resolved = cell(target),
        bulk = resolved?.column.behavior.bulk
      if (!resolved || !bulk || !resolved.column.isEditable(resolved.row))
        return no('The bulk target changed.')
      const value = safely(() =>
        bulk.apply(
          resolved.value,
          session.draft,
          context(resolved.row, resolved.column),
        ),
      )
      if (!value.ok) {
        publish({
          bulk: Object.freeze({
            ...session,
            revision: session.revision + 1,
            error: value.issue.message,
          }),
        })
        return no(value.issue.message)
      }
      mutations.push({ cell: target, value: value.value })
    }
    const result = mutate(mutations, 'Bulk edit', owner)
    if (result.accepted) {
      publish({ bulk: null })
      return ok(result.payload)
    }
    return result
  }
  const openFilter = (columnKey: string) => {
    const blocked = prepareTransition('opening a filter editor')
    if (blocked) return blocked
    const column = columns.find((candidate) => candidate.key === columnKey),
      filter = column?.behavior.filter
    if (!column || !filter || !column.filterable)
      return no('This column does not support filtering.')
    const current = snapshot.view.columnFilters.filter(
      (candidate) => candidate.columnKey === columnKey,
    )
    publish({
      interaction: frozenInteraction({
        ...snapshot.interaction,
        actionSession: null,
      }),
      filterSession: Object.freeze({
        revision: (snapshot.filterSession?.revision ?? 0) + 1,
        columnKey,
        conditions: Object.freeze(
          current.length > 0
            ? current.map(({ operator, value }) =>
                Object.freeze({ operator, value }),
              )
            : [Object.freeze({ operator: filter.defaultOperator, value: '' })],
        ),
        combine: current[0]?.combine ?? 'all',
        error: null,
      }),
    })
    return ok()
  }
  const changeFilter = (
    index: number,
    operator: string | undefined,
    value: unknown,
    combine: 'all' | 'any' | undefined,
  ) => {
    const session = snapshot.filterSession
    const current = session?.conditions[index]
    if (!session || !current) return no('The filter condition is unavailable.')
    const conditions = Object.freeze(
      session.conditions.map((condition, at) =>
        at === index
          ? Object.freeze({
              operator: operator ?? condition.operator,
              value: value === undefined ? condition.value : value,
            })
          : condition,
      ),
    )
    publish({
      filterSession: Object.freeze({
        ...session,
        revision: session.revision + 1,
        conditions,
        combine: combine ?? session.combine,
        error: null,
      }),
    })
    return ok()
  }
  const addFilterCondition = () => {
    const session = snapshot.filterSession
    const filter = columns.find((column) => column.key === session?.columnKey)
      ?.behavior.filter
    if (!session || !filter) return no('There is no active filter session.')
    publish({
      filterSession: Object.freeze({
        ...session,
        revision: session.revision + 1,
        conditions: Object.freeze([
          ...session.conditions,
          Object.freeze({ operator: filter.defaultOperator, value: '' }),
        ]),
        error: null,
      }),
    })
    return ok()
  }
  const removeFilterCondition = (index: number) => {
    const session = snapshot.filterSession
    if (!session?.conditions[index])
      return no('The filter condition is unavailable.')
    publish({
      filterSession: Object.freeze({
        ...session,
        revision: session.revision + 1,
        conditions: Object.freeze(
          session.conditions.filter((_, at) => at !== index),
        ),
        error: null,
      }),
    })
    return ok()
  }
  const applyFilter = () => {
    const session = snapshot.filterSession
    if (!session) return no('There is no active filter session.')
    const filter = columns.find(
      (candidate) => candidate.key === session.columnKey,
    )?.behavior.filter
    if (!filter) return no('The filter is unavailable.')
    const nextConditions: { operator: string; value: unknown }[] = []
    for (const condition of session.conditions) {
      const operator = filter.operators.find(
        (candidate) => candidate.id === condition.operator,
      )
      if (!operator) return no('The filter operator is unavailable.')
      const value = operator.validate
        ? invokeGridResult(() => operator.validate!(condition.value))
        : undefined
      if (value && !value.ok) {
        publish({
          filterSession: Object.freeze({
            ...session,
            revision: session.revision + 1,
            error: value.issue.message,
          }),
        })
        return no(value.issue.message)
      }
      nextConditions.push({
        operator: condition.operator,
        value: value?.ok ? value.value : condition.value,
      })
    }
    const filters = [
      ...snapshot.view.columnFilters.filter(
        (candidate) => candidate.columnKey !== session.columnKey,
      ),
      ...nextConditions.map((condition) => ({
        columnKey: session.columnKey,
        operator: condition.operator,
        value: condition.value,
        combine: session.combine,
      })),
    ]
    const result = updateView({ columnFilters: filters }, true)
    if (result.accepted) {
      publish({ filterSession: null })
      return ok(result.payload)
    }
    return result
  }
  const clearFilter = () => {
    const session = snapshot.filterSession
    if (!session) return no('There is no active filter session.')
    const result = updateView({
      columnFilters: snapshot.view.columnFilters.filter(
        (candidate) => candidate.columnKey !== session.columnKey,
      ),
    }, true)
    if (result.accepted) publish({ filterSession: null })
    return result
  }
  const history = (direction: 'undo' | 'redo') => {
    const blocked = draftCommandIssue(externalCommandOwner, 'changing history')
    if (blocked) return blocked
    const draft = restoreHistory(snapshot.draft, direction)
    if (!draft) return no(`There is nothing to ${direction}.`)
    changedCellsBetweenRows(snapshot.draft.rows, draft.rows)
      .forEach(invalidateCell)
    publishDraft(draft)
    return ok()
  }

  const addRow = () => {
    const blocked = draftCommandIssue(externalCommandOwner, 'adding a row')
    if (blocked) return blocked
    const create = options.dataSource.rows?.create
    if (!create) return no('Adding rows is unavailable.')
    const limitIssue = mutationLimitIssue(gridTransactionCost(0, 1))
    if (limitIssue) return no(limitIssue)
    const created = invokeGridCallback(create)
    if (!created.ok) return no(created.message)
    const row = created.value,
      key = options.dataSource.getRowKey(row)
    if (
      snapshot.draft.rows.some((item) =>
        gridRowKeysEqual(options.dataSource.getRowKey(item), key),
      )
    )
      return no('The new row key is not unique.')
    return rowTransaction(
      [...snapshot.draft.rows, row],
      [...snapshot.draft.insertedRowKeys, key],
      snapshot.draft.deletedRowKeys,
      [key],
      'Add row',
    )
  }
  const duplicateRows = () => {
    const blocked = draftCommandIssue(externalCommandOwner, 'duplicating rows')
    if (blocked) return blocked
    const duplicate = options.dataSource.rows?.duplicate
    const plan = selectGridRowDuplicatePlan(snapshot)
    if (!duplicate || !plan.canDuplicate)
      return no('Select rows that can be duplicated.')
    const limitIssue = mutationLimitIssue(
      gridTransactionCost(0, plan.rowKeys.length),
    )
    if (limitIssue) return no(limitIssue)
    const rows = [...snapshot.draft.rows],
      selected = new Set(plan.rowKeys),
      insertion = options.dataSource.rows?.ordering === 'mutable'
        ? Math.max(
            ...rows.map((row, at) =>
              selected.has(options.dataSource.getRowKey(row)) ? at : -1,
            ),
          ) + 1
        : rows.length,
      duplicated = invokeGridCallback(() =>
        plan.rowKeys.map((key) => {
          const source = rows.find((row) =>
            gridRowKeysEqual(options.dataSource.getRowKey(row), key),
          )!
          const cloned = cloneGridRow(source, options.dataSource.cloneRow)
          if (!cloned.ok) throw new Error(cloned.message)
          return duplicate(cloned.value)
        }),
      )
    if (!duplicated.ok) return no(duplicated.message)
    const copies = duplicated.value,
      copyKeys = copies.map(options.dataSource.getRowKey),
      existing = new Set(rows.map(options.dataSource.getRowKey))
    if (
      copyKeys.some(
        (key, at) =>
          existing.has(key) ||
          copyKeys.slice(0, at).some((prior) =>
            gridRowKeysEqual(prior, key),
          ),
      )
    )
      return no('Duplicate rows must receive unique keys.')
    rows.splice(insertion, 0, ...copies)
    return rowTransaction(
      rows,
      [...snapshot.draft.insertedRowKeys, ...copyKeys],
      snapshot.draft.deletedRowKeys,
      copyKeys,
      'Duplicate rows',
    )
  }
  const deleteRows = () => {
    const blocked = draftCommandIssue(externalCommandOwner, 'deleting rows')
    if (blocked) return blocked
    const plan = selectGridRowDeletePlan(snapshot)
    if (!options.dataSource.rows?.canDelete)
      return no('Deleting rows is unavailable.')
    if (plan.rowKeys.length === 0) return no('Select rows to delete.')
    if (plan.blockedCount > 0)
      return no('Every selected row must be deletable before the selection can be deleted.')
    const limitIssue = mutationLimitIssue(
      gridTransactionCost(0, plan.rowKeys.length),
    )
    if (limitIssue) return no(limitIssue)
    const chosen = new Set(plan.rowKeys),
      inserted = new Set(snapshot.draft.insertedRowKeys),
      rows = snapshot.draft.rows.filter(
        (row) => !chosen.has(options.dataSource.getRowKey(row)),
      ),
      firstIndex = snapshot.view.visibleRowKeys.findIndex((key) =>
        chosen.has(key),
      ),
      remainingVisible = snapshot.view.visibleRowKeys.filter(
        (key) => !chosen.has(key),
      ),
      nearest = remainingVisible.length
        ? remainingVisible[clamp(firstIndex, 0, remainingVisible.length - 1)]!
        : undefined
    return rowTransaction(
      rows,
      snapshot.draft.insertedRowKeys.filter((key) => !chosen.has(key)),
      [
        ...snapshot.draft.deletedRowKeys,
        ...plan.rowKeys.filter((key) => !inserted.has(key)),
      ],
      nearest === undefined ? [] : [nearest],
      'Delete rows',
    )
  }
  const rowTransaction = (
    rows: readonly Row[],
    inserted: readonly RowKey[],
    deleted: readonly RowKey[],
    select: readonly RowKey[],
    label: string,
  ) => {
    const blocked = draftCommandIssue(externalCommandOwner, label.toLowerCase())
    if (blocked) return blocked
    const identityIssue = findRowIdentityIssue(rows, options.dataSource.getRowKey)
    if (identityIssue) return no(identityIssue)
    const attempted = invokeGridCallback(() =>
      createRowTransaction({
        draft: snapshot.draft,
        rows,
        insertedRowKeys: inserted,
        deletedRowKeys: deleted,
        columns,
        getRowKey: options.dataSource.getRowKey,
        label,
        transactionId: `tx-${++sequence}`,
      }),
    )
    if (!attempted.ok) return no(attempted.message)
    const draft = attempted.value,
      view = derive(draft.rows, snapshot.view, snapshot.view.revision + 1)
    const affectedRowKeys = changedRowKeys(snapshot.draft.rows, draft.rows)
    const affectedCells = affectedRowKeys.flatMap((rowKey) =>
      columns.map((column) => ({ rowKey, columnKey: column.key })),
    )
    let interaction = clearInteraction<RowKey>()
    const ranges = select
      .map((rowKey) =>
        rangeForHitTarget(
          { kind: 'row', rowKey },
          view.visibleRowKeys,
          columnKeys(),
        ),
      )
      .filter(defined)
    if (ranges.length)
      interaction = frozenInteraction({
        ...interaction,
        ranges: Object.freeze(ranges),
        activeRangeIndex: ranges.length - 1,
        activeCell: ranges.at(-1)!.focus,
      })
    return executeDraftCommand({
      owner: externalCommandOwner,
      action: label.toLowerCase(),
      draft,
      affectedCells,
      transactionCost: gridTransactionCost(0, affectedRowKeys.length),
      publishCommand: () => {
        publish({
          draft,
          view,
          layout: layoutFor(view, snapshot.layout.revision + 1),
          interaction,
          edit: null,
          bulk: null,
        })
        persistence.schedule()
      },
      payload: { rows: select.length },
    })
  }

  const changedRowKeys = (before: readonly Row[], after: readonly Row[]) => {
    const beforeByKey = new Map(
      before.map((row) => [options.dataSource.getRowKey(row), row] as const),
    )
    const afterByKey = new Map(
      after.map((row) => [options.dataSource.getRowKey(row), row] as const),
    )
    return [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].filter(
      (rowKey) => {
        const left = beforeByKey.get(rowKey)
        const right = afterByKey.get(rowKey)
        return !left || !right || !areGridAuthorityRowsEqual(
          [left],
          [right],
          options.dataSource.getRowKey,
        )
      },
    )
  }

  const changedCellsBetweenRows = (
    before: readonly Row[],
    after: readonly Row[],
  ) => {
    const beforeByKey = new Map(
      before.map((row) => [options.dataSource.getRowKey(row), row] as const),
    )
    const afterByKey = new Map(
      after.map((row) => [options.dataSource.getRowKey(row), row] as const),
    )
    const points: GridPoint<RowKey>[] = []
    for (const rowKey of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
      const left = beforeByKey.get(rowKey)
      const right = afterByKey.get(rowKey)
      if (left === undefined || right === undefined) {
        for (const column of columns) {
          points.push(Object.freeze({ rowKey, columnKey: column.key }))
        }
        continue
      }
      for (const column of columns) {
        const leftValue = resolveGridCellValue(left, column)
        const rightValue = resolveGridCellValue(right, column)
        if (areGridResolvedCellValuesEqual(leftValue, rightValue)) continue
        points.push(Object.freeze({ rowKey, columnKey: column.key }))
      }
    }
    return Object.freeze(points)
  }

  const updateView = (
    changes: Partial<
      Pick<typeof snapshot.view, 'globalFilter' | 'columnFilters' | 'sort'>
    >,
    filterSessionOwned = false,
  ) => {
    if (!filterSessionOwned) {
      const blocked = prepareTransition('changing the view')
      if (blocked) return blocked
    }
    const issue = viewChangeIssue(changes)
    if (issue) return no(issue)
    const view = derive(
        snapshot.draft.rows,
        { ...snapshot.view, ...changes },
        snapshot.view.revision + 1,
      )
    const interaction = reconcileInteractionAfterViewChange(
      snapshot.interaction,
      view.visibleRowKeys,
      columnKeys(),
    )
    publish({
      view,
      layout: layoutFor(view, snapshot.layout.revision + 1),
      interaction,
    })
    return ok()
  }

  const viewChangeIssue = (
    changes: Partial<
      Pick<typeof snapshot.view, 'columnFilters' | 'sort'>
    >,
  ) => {
    for (const sort of changes.sort ?? []) {
      const column = columns.find((candidate) => candidate.key === sort.columnKey)
      if (!column?.sortable || !column.behavior.compare) {
        return `Column "${sort.columnKey}" does not support sorting.`
      }
    }
    for (const filter of changes.columnFilters ?? []) {
      const column = columns.find(
        (candidate) => candidate.key === filter.columnKey,
      )
      if (!column?.filterable || !column.behavior.filter) {
        return `Column "${filter.columnKey}" does not support filtering.`
      }
      if (
        !column.behavior.filter.operators.some(
          (operator) => operator.id === filter.operator,
        )
      ) {
        return `Filter operator "${filter.operator}" is unavailable for column "${filter.columnKey}".`
      }
    }
    return null
  }

  const prepareTransition = (action: string): GridDispatchResult | null => {
    if (snapshot.bulk)
      return no(`Apply or cancel the bulk edit before ${action}.`)
    if (snapshot.filterSession)
      return no(`Apply or cancel the filter edit before ${action}.`)
    if (!snapshot.edit) return null
    const resolved = cell(snapshot.edit.cell)
    if (resolved?.column.behavior.edit?.exit === 'explicit')
      return no(`Apply or cancel the cell edit before ${action}.`)
    const committed = commitEdit()
    return committed.accepted ? null : committed
  }

  const draftCommandIssue = (
    owner: GridDraftCommandOwner<RowKey>,
    action: string,
  ): GridDispatchResult | null => {
    if (snapshot.bulk) {
      if (
        owner.kind === 'bulk-apply' &&
        owner.bulkRevision === snapshot.bulk.revision
      ) {
        return null
      }
      return no(`Apply or cancel the bulk edit before ${action}.`)
    }
    if (owner.kind === 'bulk-apply') {
      return no('The bulk edit session is no longer current.')
    }
    if (snapshot.filterSession) {
      return no(`Apply or cancel the filter edit before ${action}.`)
    }
    if (snapshot.edit) {
      const ownsEdit =
        (owner.kind === 'edit-commit' || owner.kind === 'cell-effect') &&
        owner.editRevision === editRevision &&
        samePoint(owner.cell, snapshot.edit.cell)
      if (ownsEdit) return null
      return no(`Commit or cancel the cell edit before ${action}.`)
    }
    if (owner.kind === 'edit-commit') {
      return no('The cell edit session is no longer current.')
    }
    if (owner.kind === 'cell-effect' && owner.editRevision !== null) {
      return no('The cell effect no longer belongs to the current edit session.')
    }
    return null
  }

  const mutationLimitIssue = (count: number) =>
    count > (options.maxMutations ?? 10_000)
      ? 'This operation exceeds the mutation limit.'
      : null
  const gridTransactionCost = (cellChanges: number, rowChanges: number) =>
    cellChanges + rowChanges

  const applyRemote = (remote: GridDataSourceSnapshot<Row>) => {
    if (Object.is(remote.version, snapshot.source.version)) {
      if (
        !areGridAuthorityRowsEqual(
          snapshot.source.rows,
          remote.rows,
          options.dataSource.getRowKey,
        )
      ) {
        throw new Error(
          'The data source reused one version for different authoritative rows.',
        )
      }
      if (
        remote.status !== snapshot.source.status ||
        (remote.error ?? null) !== snapshot.source.error
      ) {
        publish({
          source: Object.freeze({
            ...snapshot.source,
            status: remote.status,
            error: remote.error ?? null,
          }),
        })
      }
      return
    }
    const draft = dirty(snapshot.draft) || hasHistory(snapshot.draft)
      ? rebaseGridDraft({
          draft: snapshot.draft,
          remoteRows: remote.rows,
          remoteVersion: remote.version,
          columns,
          getRowKey: options.dataSource.getRowKey,
          ...(options.dataSource.cloneRow
            ? { cloneRow: options.dataSource.cloneRow }
            : {}),
        })
      : freshDraft(remote)
    publishRemote(remote, draft)
  }

  const applyCommitted = (
    applied: GridDataSourceSnapshot<Row> & { status: 'ready' },
    latest: GridDataSourceSnapshot<Row>,
    committedRows: readonly Row[],
    committedDraftRevision: number,
    keyRemap: readonly GridRowKeyRemap<RowKey>[],
  ) => {
    let draft = replayDraftAfterCommit({
      current: snapshot.draft,
      committedRows,
      committedDraftRevision,
      publishedRows: applied.rows,
      publishedVersion: applied.version,
      columns,
      getRowKey: options.dataSource.getRowKey,
      keyRemap,
      ...(options.dataSource.cloneRow
        ? { cloneRow: options.dataSource.cloneRow }
        : {}),
    })
    if (!Object.is(latest.version, applied.version)) {
      draft = rebaseGridDraft({
        draft,
        remoteRows: latest.rows,
        remoteVersion: latest.version,
        columns,
        getRowKey: options.dataSource.getRowKey,
        ...(options.dataSource.cloneRow
          ? { cloneRow: options.dataSource.cloneRow }
          : {}),
      })
    }
    publishRemote(latest, draft, keyRemap)
  }

  const publishRemote = (
    remote: GridDataSourceSnapshot<Row>,
    draft: typeof snapshot.draft,
    keyRemap: readonly GridRowKeyRemap<RowKey>[] = [],
  ) => {
    assertCompleteDataSourceSnapshot(remote)
    assertUniqueDataSourceRowKeys(remote, options.dataSource.getRowKey)
    const source = Object.freeze({
        revision: snapshot.source.revision + 1,
        status: remote.status,
        rows: Object.freeze([...remote.rows]),
        version: remote.version,
        scope: Object.freeze({ kind: 'complete' as const }),
        error: remote.error ?? null,
      }),
      view = derive(draft.rows, snapshot.view, snapshot.view.revision + 1),
      previousVisibleRowKeys = remapGridRowKeys(
        snapshot.view.visibleRowKeys,
        keyRemap,
      ),
      previousInteraction = remapGridInteraction(
        snapshot.interaction,
        keyRemap,
      ),
      interaction = sameKeyOrder(
        previousVisibleRowKeys,
        view.visibleRowKeys,
      )
        ? previousInteraction
        : reconcileInteractionAfterViewChange(
            previousInteraction,
            view.visibleRowKeys,
            columnKeys(),
          ),
      nextEdit = reconcileEditAfterRemote(
        remapGridEditSession(snapshot.edit, keyRemap),
        draft,
        source.revision,
      ),
      nextBulk = snapshot.bulk
        ? Object.freeze({
            ...snapshot.bulk,
            targetCells: Object.freeze(
              snapshot.bulk.targetCells.map((target) =>
                remapGridPoint(target, keyRemap),
              ),
            ),
            revision: snapshot.bulk.revision + 1,
            error: 'Data changed while this bulk edit was open. Cancel it and start again.',
          })
        : null
    abortSourceEffects()
    publish({
      source,
      draft,
      view,
      layout: layoutFor(view, snapshot.layout.revision + 1),
      interaction,
      edit: nextEdit,
      bulk: nextBulk,
    })
  }

  const reconcileEditAfterRemote = (
    session: typeof snapshot.edit,
    draft: typeof snapshot.draft,
    sourceRevision: number,
  ): typeof snapshot.edit => {
    if (!session) return null
    const row = draft.rows.find((candidate) =>
      gridRowKeysEqual(
        options.dataSource.getRowKey(candidate),
        session.cell.rowKey,
      ),
    )
    const column = columns.find((candidate) => candidate.key === session.cell.columnKey)
    if (!row || !column) {
      return Object.freeze({
        ...session,
        revision: ++editRevision,
        status: 'invalid',
        error: 'This edit target was removed remotely. Cancel the edit to continue.',
      })
    }
    const resolved = resolveGridCellValue(row, column)
    if (
      resolved.valid &&
      equalsColumnValue(column, resolved.value, session.originalValue)
    ) {
      return Object.freeze({ ...session, sourceRevision })
    }
    return Object.freeze({
      ...session,
      revision: ++editRevision,
      status: 'invalid',
      error: 'This cell changed remotely while it was being edited. Cancel or restart the edit.',
    })
  }

  persistence = new GridPersistenceCoordinator({
    columns,
    getRowKey: options.dataSource.getRowKey,
    getControllerSnapshot: getSnapshot,
    getPublishedSnapshot: options.dataSource.getSnapshot,
    commit: options.dataSource.persistence.commit,
    ...(options.dataSource.refresh
      ? { requestRefresh: options.dataSource.refresh }
      : {}),
    ...(options.dataSource.persistence.debounceMs === undefined
      ? {}
      : { debounceMs: options.dataSource.persistence.debounceMs }),
    publish: (next) => publish({ persistence: next }),
    reportRefreshError: (error) =>
      publish({
        source: Object.freeze({
          ...snapshot.source,
          revision: snapshot.source.revision + 1,
          status: 'error',
          error,
        }),
      }),
    applyRemote,
    applyCommitted,
    isDestroyed: () => destroyed,
    ok,
    no,
  })

  const runCellAction = (target: GridPoint<RowKey>, id: string) => {
    const blocked = draftCommandIssue(
      externalCommandOwner,
      'running a cell action',
    )
    if (blocked) return blocked
    const resolved = cell(target),
      action = resolved?.column.behavior.actions?.find((item) => item.id === id)
    if (!resolved || !action) return no('The action is unavailable.')
    const editable = resolved.column.isEditable(resolved.row),
      ctx = {
        ...context(resolved.row, resolved.column),
        value: resolved.value,
        editable,
      }
    const availability = invokeGridCallback(() => ({
      hidden: action.hidden?.(ctx) ?? false,
      disabled: action.disabled?.(ctx) ?? false,
    }))
    if (!availability.ok) return no(availability.message)
    if (
      (action.requiresEditable && !editable) ||
      availability.value.hidden ||
      availability.value.disabled
    )
      return no('The action is disabled.')
    const labelDefinition = action.label
    const label =
      typeof labelDefinition === 'function'
        ? invokeGridCallback(() => labelDefinition(ctx))
        : { ok: true as const, value: labelDefinition }
    if (!label.ok) return no(label.message)
    const result = safely(() => action.run(ctx))
    if (!result.ok) return no(result.issue.message)
    return result.value.kind === 'set-value'
      ? mutate([{ cell: target, value: result.value.value }], label.value)
      : result.value.kind === 'effect'
        ? runCellEffect(target, result.value.effect, result.value.input)
        : ok()
  }
  const runCellEffect = (
    target: GridPoint<RowKey>,
    id: string,
    input: unknown,
  ) => {
    const owner = Object.freeze({
      kind: 'cell-effect' as const,
      cell: point(target),
      editRevision:
        snapshot.edit && samePoint(snapshot.edit.cell, target)
          ? editRevision
          : null,
    })
    const blocked = draftCommandIssue(owner, 'starting a cell effect')
    if (blocked) return blocked
    const resolved = cell(target)
    const effect = resolved?.column.behavior.effects?.resolve(id)
    if (!resolved || !effect || !resolved.column.isEditable(resolved.row))
      return no('The cell effect is unavailable.')
    const scopeKey = cellKey(target)
    const key = `${scopeKey}\u0001${effect.id}\u0001${++sequence}`
    const active = effectCoordinator.startCell(key, scopeKey, {
      source: snapshot.source.revision,
      cell: point(target),
      cellRevision: revision(target),
      ...(snapshot.edit && samePoint(snapshot.edit.cell, target)
        ? { edit: editRevision }
        : {}),
    })
    void Promise.resolve()
      .then(() =>
        effect.run(
          input,
          context(resolved.row, resolved.column),
          active.abort.signal,
        ),
      )
      .then((result) => {
        if (destroyed) return
        if (!effectCoordinator.isCellCurrent(key, active)) {
          effectCoordinator.finishCell(key, active)
          return
        }
        effectCoordinator.finishCell(key, active)
        if (!result.ok) {
          dispatch({
            type: 'feedback/push',
            item: {
              id: `effect:${key}`,
              kind: 'error',
              message: result.issue.message,
              persistent: true,
            },
          })
          return
        }
        const committed = mutate(
          [{ cell: target, value: result.value }],
          effect.id,
          owner,
        )
        if (!committed.accepted) {
          dispatch({
            type: 'feedback/push',
            item: {
              id: `effect:${key}`,
              kind: 'error',
              message: committed.reason ?? 'The effect result could not be applied.',
              persistent: true,
            },
          })
          return
        }
        if (
          committed.accepted &&
          active.edit !== undefined &&
          snapshot.edit &&
          samePoint(snapshot.edit.cell, target) &&
          active.edit === editRevision
        ) {
          editRevision += 1
          publish({ edit: null })
        }
      })
      .catch((error: unknown) => {
        if (!effectCoordinator.isCellCurrent(key, active)) {
          effectCoordinator.finishCell(key, active)
          return
        }
        if (!destroyed) {
          effectCoordinator.finishCell(key, active)
          dispatch({
            type: 'feedback/push',
            item: {
              id: `effect:${key}`,
              kind: 'error',
              message: message(error),
              persistent: true,
            },
          })
        }
      })
    return ok({ effectId: key })
  }
  const cancelCellEffect = (effectId: string) => {
    if (!effectCoordinator.cancelCell(effectId))
      return no('The cell effect is not running.')
    return ok()
  }
  const externalEffect = (request: GridEffectRequest<RowKey, Effect>) => {
    if (!options.effects) return no('No effect port is configured.')
    const id = request.id ?? `effect-${++sequence}`
    const active = effectCoordinator.startExternal(
      id,
      guard(request.owner),
      request.concurrency === 'replace',
    )
    if (!active) return no('The effect id is already running.')
    void Promise.resolve()
      .then(() =>
        options.effects!.run(request.effect, {
          signal: active.abort.signal,
          getSnapshot,
        }),
      )
      .then((result) => {
        if (destroyed) return
        if (!effectCoordinator.isExternalCurrent(id, active)) {
          effectCoordinator.finishExternal(id, active)
          return
        }
        effectCoordinator.finishExternal(id, active)
        if (result === undefined) return
        for (const next of Array.isArray(result) ? result : [result]) {
          const dispatched = dispatch(next as GridIntent<RowKey, Effect>)
          if (!dispatched.accepted) {
            dispatch({
              type: 'feedback/push',
              item: {
                id: `effect:${id}`,
                kind: 'error',
                message: dispatched.reason ?? 'The effect result could not be applied.',
                persistent: true,
              },
            })
            break
          }
        }
      })
      .catch((error: unknown) => {
        if (!effectCoordinator.isExternalCurrent(id, active)) {
          effectCoordinator.finishExternal(id, active)
          return
        }
        if (!destroyed) {
          effectCoordinator.finishExternal(id, active)
          dispatch({
            type: 'feedback/push',
            item: {
              id: `effect:${id}`,
              kind: 'error',
              message: message(error),
              persistent: true,
            },
          })
        }
      })
    return ok({ effectId: id })
  }

  const cell = (target: GridPoint<RowKey>) => {
    const row = rowIndex.byKey.get(target.rowKey),
      column = columnByKey.get(target.columnKey)
    if (!row || !column) return null
    const resolved = resolveGridCellValue(row, column)
    return resolved.valid
      ? { cell: point(target), row, column, value: resolved.value }
      : null
  }
  const columnKeys = () => columns.map((column) => column.key)
  const derive = (
    rows: readonly Row[],
    current: typeof snapshot.view,
    revision: number,
  ) =>
    deriveLocalView({
      rows,
      columns,
      getRowKey: options.dataSource.getRowKey,
      globalFilter: current.globalFilter,
      columnFilters: current.columnFilters,
      sort: current.sort,
      revision,
    })
  const layoutFor = (view: typeof snapshot.view, at: number) =>
    layout(columns, view.visibleRowKeys.length, snapshot.layout, sizes, at)
  const context = (row: Row, column: GridCompiledColumn<Row>) =>
    Object.freeze({
      row,
      columnKey: column.key,
      typeOptions: column.typeOptions,
    })
  const revision = (target: GridPoint<RowKey>) =>
    effectCoordinator.cellRevision(cellKey(target))
  const invalidateCell = (target: GridPoint<RowKey>) => {
    effectCoordinator.invalidateCell(cellKey(target))
  }
  const guard = (
    owner: GridEffectOwner<RowKey>,
  ): Omit<GridActiveEffect<RowKey>, 'abort'> => ({
    ...(owner.kind === 'controller'
      ? {}
      : { source: snapshot.source.revision }),
    ...(owner.kind === 'edit' ? { edit: editRevision } : {}),
    ...(owner.kind === 'persistence'
      ? { persistence: snapshot.persistence.revision }
      : {}),
    ...(owner.kind === 'cell'
      ? { cell: point(owner.cell), cellRevision: revision(owner.cell) }
      : {}),
  })
  const abortSourceEffects = () => {
    effectCoordinator.abortSourceOwned()
  }
  const freshDraft = (
    remote: GridDataSourceSnapshot<Row>,
  ): typeof snapshot.draft => {
    const rows = Object.freeze([...remote.rows])
    return Object.freeze({
      revision: snapshot.draft.revision + 1,
      baselineVersion: remote.version,
      baselineRows: rows,
      rows,
      dirtyCells: Object.freeze([]),
      validationIssues: collectRowValidationIssues(rows, columns, options.dataSource.getRowKey),
      conflicts: Object.freeze([]),
      insertedRowKeys: Object.freeze([]),
      deletedRowKeys: Object.freeze([]),
      orderDirty: false,
      undoStack: Object.freeze([]),
      redoStack: Object.freeze([]),
    })
  }
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    unsubscribe?.()
    unsubscribe = null
    persistence.destroy()
    effectCoordinator.destroy()
    listeners.clear()
  }
  unsubscribe = options.dataSource.subscribe(() => {
    persistence.syncPublished()
  })
  return Object.freeze({
    getSnapshot,
    subscribe,
    subscribeSelector,
    applyTransaction,
    dispatch,
    destroy,
  })
}

function initialSnapshot<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
>(
  dataSource: GridDataSource<Row, RowKey, Schema>,
  columns: readonly GridCompiledColumn<Row>[],
  sizes: { rowHeight: number; headerHeight: number; rowIndicatorWidth: number },
): GridControllerSnapshot<Row, RowKey> {
  const remote = dataSource.getSnapshot()
  assertCompleteDataSourceSnapshot(remote)
  assertUniqueDataSourceRowKeys(remote, dataSource.getRowKey)
  const rows = Object.freeze([...remote.rows]),
    view = deriveLocalView({
      rows,
      columns,
      getRowKey: dataSource.getRowKey,
      globalFilter: '',
      columnFilters: [],
      sort: [],
      revision: 0,
    })
  return Object.freeze({
    revision: 0,
    columns,
    getRowKey: dataSource.getRowKey,
    rowOperations: Object.freeze({
      canAdd: dataSource.rows?.create !== undefined,
      canDuplicate: dataSource.rows?.duplicate !== undefined,
      canOrder: dataSource.rows?.ordering === 'mutable',
      canDelete: dataSource.rows?.canDelete
        ? (row: Row) => {
            const cloned = cloneGridRow(row, dataSource.cloneRow)
            return cloned.ok
              ? dataSource.rows!.canDelete!(cloned.value)
              : false
          }
        : null,
    }),
    sourceOperations: Object.freeze({
      canRefresh: dataSource.refresh !== undefined,
    }),
    source: Object.freeze({
      revision: 0,
      status: remote.status,
      rows,
      version: remote.version,
      scope: Object.freeze({ kind: 'complete' as const }),
      error: remote.error ?? null,
    }),
    draft: Object.freeze({
      revision: 0,
      baselineVersion: remote.version,
      baselineRows: rows,
      rows,
      dirtyCells: Object.freeze([]),
      validationIssues: collectRowValidationIssues(rows, columns, dataSource.getRowKey),
      conflicts: Object.freeze([]),
      insertedRowKeys: Object.freeze([]),
      deletedRowKeys: Object.freeze([]),
      orderDirty: false,
      undoStack: Object.freeze([]),
      redoStack: Object.freeze([]),
    }),
    view,
    layout: layout(
      columns,
      view.visibleRowKeys.length,
      { viewportWidth: 0, viewportHeight: 0, scrollLeft: 0, scrollTop: 0 },
      sizes,
      0,
    ),
    interaction: clearInteraction<RowKey>(),
    edit: null,
    bulk: null,
    filterSession: null,
    persistence: Object.freeze({
      revision: 0,
      mode: dataSource.persistence.mode,
      status: 'idle',
      inFlightOperationId: null,
      pendingDraftRevision: null,
      error: null,
      retryOperationId: null,
    }),
    feedback: Object.freeze({ revision: 0, items: Object.freeze([]) }),
  })
}
function layout<Row>(
  columns: readonly GridCompiledColumn<Row>[],
  count: number,
  viewport: {
    viewportWidth: number
    viewportHeight: number
    scrollLeft: number
    scrollTop: number
  },
  sizes: { rowHeight: number; headerHeight: number; rowIndicatorWidth: number },
  revision: number,
) {
  const geometryColumns = columns.map((column) => ({
    key: column.key,
    label: column.label,
    type: column.type,
    layout: column.layout,
    getValue: column.getValue,
  }))
  const value = resolveGridGeometry({
    columns: geometryColumns,
    visibleRowCount: count,
    viewportWidth: viewport.viewportWidth,
    viewportHeight: viewport.viewportHeight,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
    ...sizes,
  })
  return Object.freeze({
    revision,
    viewportWidth: value.viewportWidth,
    viewportHeight: value.viewportHeight,
    scrollLeft: value.scrollLeft,
    scrollTop: value.scrollTop,
    rowHeight: value.rowHeight,
    headerHeight: value.headerHeight,
    rowIndicatorWidth: value.rowIndicatorWidth,
    contentWidth: value.contentWidth,
    contentHeight: value.contentHeight,
    columns: value.columns,
  })
}
function safely<Value>(
  operation: () => GridValueResult<Value>,
): GridValueResult<Value> {
  try {
    return operation()
  } catch (error) {
    return { ok: false, issue: { code: 'exception', message: message(error) } }
  }
}
function point<RowKey extends GridRowKey>(value: GridPoint<RowKey>) {
  return Object.freeze({ ...value })
}
function frozenInteraction<RowKey extends GridRowKey>(
  value: GridInteractionState<RowKey>,
) {
  return Object.freeze(value)
}
function samePoint<RowKey extends GridRowKey>(
  left: GridPoint<RowKey>,
  right: GridPoint<RowKey>,
) {
  return (
    gridRowKeysEqual(left.rowKey, right.rowKey) &&
    left.columnKey === right.columnKey
  )
}
function cellKey<RowKey extends GridRowKey>(value: GridPoint<RowKey>) {
  return encodeCellIdentity(value)
}
function selectionSignature<RowKey extends GridRowKey>(
  points: readonly GridPoint<RowKey>[],
) {
  return points.map(cellKey).sort().join('\u0001')
}
function sameKeyOrder<RowKey extends GridRowKey>(
  left: readonly RowKey[],
  right: readonly RowKey[],
) {
  return (
    left.length === right.length &&
    left.every((key, index) => gridRowKeysEqual(key, right[index]))
  )
}
function sameKeySet<RowKey extends GridRowKey>(
  left: readonly RowKey[],
  right: readonly RowKey[],
) {
  if (left.length !== right.length) return false
  const keys = new Set(right)
  return left.every((key) => keys.has(key))
}
function sameGridRowsIgnoringOrder<
  Row,
  RowKey extends GridRowKey,
>(
  left: readonly Row[],
  right: readonly Row[],
  getRowKey: (row: Row) => RowKey,
) {
  if (left.length !== right.length) return false
  const rightByKey = new Map(
    right.map((row) => [getRowKey(row), row] as const),
  )
  return left.every((row) => {
    const candidate = rightByKey.get(getRowKey(row))
    return candidate !== undefined && areGridAuthorityRowsEqual(
      [row],
      [candidate],
      getRowKey,
    )
  })
}
function equalsColumnValue<Row>(
  column: GridCompiledColumn<Row>,
  left: unknown,
  right: unknown,
) {
  return areGridValuesEqual(column, left, right)
}
function dirty<Row, RowKey extends GridRowKey>(
  value: GridControllerSnapshot<Row, RowKey>['draft'],
) {
  return (
    value.dirtyCells.length > 0 ||
    value.insertedRowKeys.length > 0 ||
    value.deletedRowKeys.length > 0 ||
    value.orderDirty
  )
}
function hasHistory<Row, RowKey extends GridRowKey>(
  value: GridControllerSnapshot<Row, RowKey>['draft'],
) {
  return value.undoStack.length > 0 || value.redoStack.length > 0
}
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
function defined<Value>(value: Value | null | undefined): value is Value {
  return value !== null && value !== undefined
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function transactionIssue<RowKey extends GridRowKey>(
  code: string,
  message: string,
  cell?: GridPoint<RowKey>,
): GridTransactionIssue<RowKey> {
  return Object.freeze({
    code,
    message,
    ...(cell ? { cell: point(cell) } : {}),
  })
}

function freezeTransactionIssue<RowKey extends GridRowKey>(
  issue: GridTransactionIssue<RowKey>,
) {
  return transactionIssue(issue.code, issue.message, issue.cell)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function'
  ) && typeof (value as PromiseLike<unknown>).then === 'function'
}

function validateControllerOptions<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>(options: GridControllerOptions<Row, RowKey, Schema, Effect>) {
  const dimensions = [
    ['rowHeight', options.rowHeight ?? 36],
    ['headerHeight', options.headerHeight ?? 36],
    ['rowIndicatorWidth', options.rowIndicatorWidth ?? 48],
  ] as const
  for (const [name, value] of dimensions) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be finite and greater than zero.`)
    }
  }
  const limits = [
    ['maxMutations', options.maxMutations ?? 10_000],
    ['maxClipboardBytes', options.maxClipboardBytes ?? 2_000_000],
  ] as const
  for (const [name, value] of limits) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`)
    }
  }
}
