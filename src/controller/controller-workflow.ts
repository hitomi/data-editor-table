import type { GridControllerInternalState, GridControllerEvent, GridControllerEffect, GridControllerSizes } from './controller-protocol.js'
import { prepareGridDraftPublication, type GridDraftTransition } from './draft-commands.js'
import { beginGridBulkSession, prepareGridBulkValues } from './bulk-transitions.js'
import { beginGridFilterSession, changeGridFilterSession, prepareGridFilterApply } from './filter-transitions.js'
import { beginGridEditSession, prepareGridEditValue, invalidateGridEditSession } from './editing-transitions.js'
import { decideGridSessionExit, gridDraftSessionIssue, type GridDraftCommandOwner } from './session-policy.js'
import { transitionGridView } from './view-transitions.js'
import {
  resolveGridLayout as layout,
} from './controller-state.js'
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
  type GridDataSourceSnapshot,
  type GridRowKeyRemap,
} from '../data/data-source.js'
import { deriveLocalView } from '../data/local-view.js'
import {
  areGridResolvedCellValuesEqual,
  resolveGridCellValue,
} from '../data/runtime-cell-resolver.js'
import { rebaseGridAuthority, acknowledgeGridCommit, reconcileGridEditAfterAuthority, remapGridAuthorityTargets } from './source-reconciliation.js'
import { areGridAuthorityRowsEqual } from '../data/authority-snapshot.js'
import { findRowIdentityIssue } from '../data/row-invariants.js'
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
} from './controller-contracts.js'
import {
  selectGridRowDeletePlan,
  selectGridRowDuplicatePlan,
} from './grid-selectors.js'
import {
  GridEffectCoordinator,
  type GridActiveEffect,
} from './effect-coordinator.js'
import type { GridControllerEffectEvent } from './controller-effects.js'
import { GridPersistenceCoordinator } from './persistence-coordinator.js'
import { buildGridTransaction, createGridTransactionIssue as transactionIssue } from './transaction-builder.js'
import type { GridTransition } from './controller-runtime.js'
import {
  activateGridPoint,
  endGridPointer,
  moveGridPoint,
  moveGridPointLinear,
  moveGridPointer,
  reconcileInteractionAfterViewChange,
  replaceGridRanges,
  startGridPointer,
} from './interaction-transitions.js'


/**
 * Composes domain transitions within one private input. It owns no committed
 * state, subscriptions or asynchronous resources; the Runtime owns publication.
 */
export function createGridControllerWorkflow<
  Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect = never,
>(
  options: GridControllerOptions<Row, RowKey, Schema, Effect>,
  environment: Readonly<{
    initialSnapshot: GridControllerSnapshot<Row, RowKey>
    sizes: GridControllerSizes
    isDestroyed: () => boolean
  }>,
) {
  const columns = environment.initialSnapshot.columns
  const sizes = environment.sizes
  let snapshot = environment.initialSnapshot, editRevision = 0, sequence = 0
  let inputRevision = snapshot.revision
  type Snapshot = GridControllerSnapshot<Row, RowKey>
  type InternalState = GridControllerInternalState<Row, RowKey>
  type Event = GridControllerEvent<Row, RowKey, Effect>
  type EffectCommand = GridControllerEffect<Row, RowKey, Effect>
  let preparing = false
  let pendingEffects: EffectCommand[] = []
  const columnByKey = createGridColumnIndex(columns)
  const configuredColumns = new Set<object>(options.dataSource.columns)
  let rowIndex = createGridRowIndex(
    snapshot.draft.rows,
    options.dataSource.getRowKey,
  )
  let indexedRows = snapshot.draft.rows
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
    (active) => {
      if (preparing) pendingEffects.push({ type: 'effect/cancel', active })
      else throw new Error('Effect cancellation requires a Runtime input.')
    },
  )
  let persistence: GridPersistenceCoordinator<Row, RowKey>
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
    if (!preparing) throw new Error('Controller state changes require a Runtime input.')
    if (changes.draft && changes.draft !== snapshot.draft) {
      rowIndex = createGridRowIndex(
        changes.draft.rows,
        options.dataSource.getRowKey,
      )
      indexedRows = changes.draft.rows
    }
    snapshot = Object.freeze({
      ...snapshot,
      ...changes,
      revision: inputRevision + 1,
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
        const moved = intent.direction === 'down'
          ? keyboard('move-down', false)
          : moveLinear(intent.direction === 'next' ? 1 : -1)
        return moved.accepted
          ? moved
          : ok({ committed: true, moved: false })
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
    if (
      command === 'select-all' ||
      command === 'select-row' ||
      command === 'select-column'
    ) {
      if (command !== 'select-all' && !active) {
        return no('There is no active cell.')
      }
      const range = rangeForHitTarget(
        command === 'select-all'
          ? { kind: 'corner' }
          : command === 'select-row'
            ? { kind: 'row', rowKey: active!.rowKey }
            : { kind: 'column', columnKey: active!.columnKey },
        snapshot.view.visibleRowKeys,
        columnKeys(),
      )
      return range ? setRanges([range], 0) : no('The selection is unavailable.')
    }
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
    const resolved = target ? cell(target) : null
    if (!target || !resolved) return no('This cell does not support editing.')
    const begun = beginGridEditSession(resolved, target, snapshot.source.revision, editRevision + 1)
    if (!begun.ok) return no(begun.issue.message)
    editRevision = begun.value.revision
    publish({
      interaction: frozenInteraction({ ...snapshot.interaction, actionSession: null }),
      edit: begun.value,
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
    const value = prepareGridEditValue(session, resolved, snapshot.source.revision)
    if (!value.ok) {
      publish({ edit: invalidateGridEditSession(session, value.issue.message, ++editRevision) })
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
        edit: invalidateGridEditSession(session, result.reason ?? 'The value is invalid.', ++editRevision),
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
    const limitIssue = mutationLimitIssue(
      gridTransactionCost(uniqueMutationCount(mutations), 0),
    )
    if (limitIssue) return no(limitIssue)
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
      kind: 'local',
      payload: { changedCells: result.changedCells.length },
    })
  }
  const executeDraftCommand = (command: GridDraftTransition<Row, RowKey> & Readonly<{
    owner: GridDraftCommandOwner<RowKey>
    action: string
    affectedCells: readonly GridPoint<RowKey>[]
    payload: unknown
    expectedSnapshot?: typeof snapshot
  }>) => {
    const blocked = draftCommandIssue(command.owner, command.action)
    if (blocked) return blocked
    if (command.expectedSnapshot && snapshot !== command.expectedSnapshot)
      return no('The grid changed while the transaction was being prepared.')
    const prepared = prepareGridDraftPublication({
      transition: command, currentDraft: snapshot.draft, view: snapshot.view,
      interaction: snapshot.interaction, layout: snapshot.layout,
      columns, getRowKey: options.dataSource.getRowKey, sizes,
      maxMutations: options.maxMutations ?? 10_000,
    })
    if (!prepared.ok) return no(prepared.reason)
    if (!prepared.changes) return ok(command.payload)
    command.affectedCells.forEach(invalidateCell)
    publish(prepared.changes)
    persistence.schedule()
    return ok(command.payload)
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
    const plannedCost = gridTransactionCost(
      uniqueMutationCount(input.mutations),
      input.createdRows.length +
        new Set(input.removedRowKeys ?? []).size +
        new Set(input.movedRowKeys ?? []).size,
    )
    const plannedLimitIssue = mutationLimitIssue(plannedCost)
    if (plannedLimitIssue) {
      return Object.freeze({
        dispatch: no(plannedLimitIssue),
        commit: null,
        issues: Object.freeze([
          transactionIssue<RowKey>('mutation-limit', plannedLimitIssue),
        ]),
      })
    }
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
      kind: 'local',
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
    Row, RowKey, Schema, Effect
  >['applyTransaction'] = (build, transactionOptions) => {
    const reject = (issue: GridTransactionIssue<RowKey>) => Object.freeze({
      accepted: false as const,
      revision: snapshot.revision,
      result: null,
      issues: Object.freeze([issue]) as readonly [GridTransactionIssue<RowKey>],
    })
    const blocked = draftCommandIssue(externalCommandOwner, 'applying a transaction')
    if (blocked)
      return reject(transactionIssue(
        'session-active', blocked.reason ?? 'The transaction is unavailable.',
      ))
    const base = snapshot
    const planned = buildGridTransaction({
      base, build, configuredColumns,
      getRowKey: options.dataSource.getRowKey,
      ...(options.dataSource.cloneRow ? { cloneRow: options.dataSource.cloneRow } : {}),
      ...(options.dataSource.rows ? { rows: options.dataSource.rows } : {}),
      maxMutations: options.maxMutations ?? 10_000,
    })
    if (!planned.ok) return reject(planned.issue)
    if (environment.isDestroyed())
      return reject(transactionIssue('destroyed', 'The GridController has been destroyed.'))
    if (snapshot !== base)
      return reject(transactionIssue('stale-base', 'The grid changed while the transaction was being prepared.'))
    const committed = commitAtomicTransaction({
      ...planned.plan,
      base,
      label: transactionOptions?.label?.trim() || 'Update grid',
      action: 'applying a transaction',
    })
    if (!committed.dispatch.accepted || !committed.commit)
      return Object.freeze({
        accepted: false as const,
        revision: committed.dispatch.revision,
        result: null,
        issues: committed.issues as readonly [
          GridTransactionIssue<RowKey>, ...GridTransactionIssue<RowKey>[],
        ],
      })
    return Object.freeze({
      accepted: true as const,
      revision: committed.dispatch.revision,
      result: committed.commit,
      issues: Object.freeze([]) as readonly [],
    })
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
    const plannedCells = matrix.reduce((count, row) => count + row.length, 0)
    const pasteLimitIssue = mutationLimitIssue(
      gridTransactionCost(plannedCells, missingRows),
    )
    if (pasteLimitIssue) return no(pasteLimitIssue)
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
        const column = columns.find((candidate) => candidate.key === columnKey)
        const parse = column?.behavior.clipboard?.parse
        if (!rowByKey.has(rowKey) || !column || !parse)
          return no('A paste target is read-only or incompatible.')
        const row = rowByKey.get(rowKey) as Row
        if (!column.isEditable(row))
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
    const bounds = gridRangeBounds(
      target,
      snapshot.view.visibleRowKeys,
      columnKeys(),
    )
    const fillLimitIssue = mutationLimitIssue(
      gridTransactionCost(
        bounds === null ? 0 : bounds.rowCount * bounds.columnCount,
        0,
      ),
    )
    if (fillLimitIssue) return no(fillLimitIssue)
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
    const restoreLimitIssue = mutationLimitIssue(
      gridTransactionCost(uniquePointCount(targets), 0),
    )
    if (restoreLimitIssue) return no(restoreLimitIssue)
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
      return keepLocalConflictCell(conflict, rowKey, columnKey, conflicts)
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
      kind: 'recovery',
      payload: { changedCells: affectedCells.length },
    })
  }

  const keepLocalConflictCell = (
    conflict: typeof snapshot.draft.conflicts[number],
    rowKey: RowKey,
    columnKey: string,
    conflicts: typeof snapshot.draft.conflicts,
  ) => {
    const column = columnByKey.get(columnKey)
    if (!rowIndex.byKey.has(rowKey) || !column)
      return no('The conflicted cell no longer exists.')
    const row = rowIndex.byKey.get(rowKey) as Row
    const current = resolveGridCellValue(row, column)
    const local = invokeGridResult(() =>
      column.behavior.value.validate(
        conflict.localValue,
        context(row, column),
      ),
    )
    if (!local.ok) {
      if (
        !current.valid &&
        Object.is(current.rawValue, conflict.localValue)
      ) {
        return recoveryTransaction(
          snapshot.draft.rows,
          snapshot.draft.insertedRowKeys,
          snapshot.draft.deletedRowKeys,
          conflicts,
          'Keep local cell',
          [{ rowKey, columnKey }],
        )
      }
      return no(local.issue.message)
    }
    if (
      current.valid &&
      areGridValuesEqual(column, current.value, local.value)
    ) {
      return recoveryTransaction(
        snapshot.draft.rows,
        snapshot.draft.insertedRowKeys,
        snapshot.draft.deletedRowKeys,
        conflicts,
        'Keep local cell',
        [{ rowKey, columnKey }],
      )
    }

    const attempted = invokeGridCallback(() =>
      applyCellTransaction({
        draft: snapshot.draft,
        mutations: [{ cell: { rowKey, columnKey }, value: local.value }],
        columns,
        getRowKey: options.dataSource.getRowKey,
        ...(options.dataSource.cloneRow
          ? { cloneRow: options.dataSource.cloneRow }
          : {}),
        label: 'Keep local cell',
        transactionId: `tx-${++sequence}`,
      }),
    )
    if (!attempted.ok) return no(attempted.message)
    if (!attempted.value.ok) {
      return no(
        attempted.value.issues[0]?.message ??
        'The local value could not be restored.',
      )
    }
    if (attempted.value.draft === snapshot.draft) {
      return recoveryTransaction(
        snapshot.draft.rows,
        snapshot.draft.insertedRowKeys,
        snapshot.draft.deletedRowKeys,
        conflicts,
        'Keep local cell',
        [{ rowKey, columnKey }],
      )
    }

    const nextConflicts = Object.freeze([...conflicts])
    const undoStack = [...attempted.value.draft.undoStack]
    const latestHistory = undoStack.at(-1)
    if (latestHistory) {
      undoStack[undoStack.length - 1] = Object.freeze({
        ...latestHistory,
        afterConflicts: nextConflicts,
      })
    }
    const draft = Object.freeze({
      ...attempted.value.draft,
      conflicts: nextConflicts,
      undoStack: Object.freeze(undoStack),
    })
    return executeDraftCommand({
      owner: externalCommandOwner,
      action: 'keep local cell',
      draft,
      affectedCells: attempted.value.changedCells,
      transactionCost: attempted.value.changedCells.length,
      kind: 'recovery',
      payload: { changedCells: attempted.value.changedCells.length },
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
    const begun = beginGridBulkSession({
      column, cells: resolved, maxMutations: options.maxMutations ?? 10_000,
      revision: (snapshot.bulk?.revision ?? 0) + 1,
      revisions: {
        sourceRevision: snapshot.source.revision, draftRevision: snapshot.draft.revision,
        viewRevision: snapshot.view.revision,
      },
    })
    if (!begun.ok) return no(begun.issue.message)
    publish({ bulk: begun.value })
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
    const planned = prepareGridBulkValues({
      session, currentTargets, maxMutations: options.maxMutations ?? 10_000,
      resolveCell: cell,
      revisions: {
        sourceRevision: snapshot.source.revision, draftRevision: snapshot.draft.revision,
        viewRevision: snapshot.view.revision,
      },
    })
    if (!planned.ok) {
      if (planned.session !== session) publish({ bulk: planned.session })
      return no(planned.reason)
    }
    const result = mutate(planned.mutations, 'Bulk edit', owner)
    if (result.accepted) {
      publish({ bulk: null })
      return ok(result.payload)
    }
    return result
  }
  const openFilter = (columnKey: string) => {
    const blocked = prepareTransition('opening a filter editor')
    if (blocked) return blocked
    const begun = beginGridFilterSession(
      columns.find((column) => column.key === columnKey),
      snapshot.view.columnFilters, (snapshot.filterSession?.revision ?? 0) + 1,
    )
    if (!begun.ok) return no(begun.issue.message)
    publish({
      interaction: frozenInteraction({ ...snapshot.interaction, actionSession: null }),
      filterSession: begun.value,
    })
    return ok()
  }
  const changeFilter = (
    index: number, operator: string | undefined, value: unknown, combine: 'all' | 'any' | undefined,
  ) => {
    const next = changeGridFilterSession(snapshot.filterSession, { type: 'change', index, operator, value, combine })
    if (!next.ok) return no(next.issue.message)
    publish({ filterSession: next.value })
    return ok()
  }
  const addFilterCondition = () => {
    const filter = columns.find((column) => column.key === snapshot.filterSession?.columnKey)?.behavior.filter
    if (!filter) return no('There is no active filter session.')
    const next = changeGridFilterSession(snapshot.filterSession, { type: 'add', defaultOperator: filter.defaultOperator })
    if (!next.ok) return no(next.issue.message)
    publish({ filterSession: next.value })
    return ok()
  }
  const removeFilterCondition = (index: number) => {
    const next = changeGridFilterSession(snapshot.filterSession, { type: 'remove', index })
    if (!next.ok) return no(next.issue.message)
    publish({ filterSession: next.value })
    return ok()
  }
  const applyFilter = () => {
    const session = snapshot.filterSession
    const next = prepareGridFilterApply(
      session, columns.find((column) => column.key === session?.columnKey), snapshot.view.columnFilters,
    )
    if (!next.ok) {
      if (next.session !== session) publish({ filterSession: next.session })
      return no(next.reason)
    }
    const result = updateView({ columnFilters: next.filters }, true)
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
    return executeDraftCommand({
      kind: 'history', owner: externalCommandOwner, action: 'changing history', draft,
      affectedCells: changedCellsBetweenRows(snapshot.draft.rows, draft.rows), payload: undefined,
    })
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
      [...snapshot.draft.baselineRows, ...snapshot.draft.rows].some((item) =>
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
      existing = new Set([
        ...snapshot.draft.baselineRows.map(options.dataSource.getRowKey),
        ...rows.map(options.dataSource.getRowKey),
      ])
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
    const draft = attempted.value
    const affectedRowKeys = changedRowKeys(snapshot.draft.rows, draft.rows)
    const affectedCells = affectedRowKeys.flatMap((rowKey) =>
      columns.map((column) => ({ rowKey, columnKey: column.key })),
    )
    return executeDraftCommand({
      owner: externalCommandOwner,
      action: label.toLowerCase(),
      draft,
      affectedCells,
      transactionCost: gridTransactionCost(0, affectedRowKeys.length),
      kind: 'local',
      selectRows: select,
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
        if (!beforeByKey.has(rowKey) || !afterByKey.has(rowKey)) return true
        const left = beforeByKey.get(rowKey) as Row
        const right = afterByKey.get(rowKey) as Row
        return !areGridAuthorityRowsEqual(
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
      if (!beforeByKey.has(rowKey) || !afterByKey.has(rowKey)) {
        for (const column of columns) {
          points.push(Object.freeze({ rowKey, columnKey: column.key }))
        }
        continue
      }
      const left = beforeByKey.get(rowKey) as Row
      const right = afterByKey.get(rowKey) as Row
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
    const transition = transitionGridView({
      changes, view: snapshot.view, rows: snapshot.draft.rows,
      interaction: snapshot.interaction, layout: snapshot.layout,
      columns, getRowKey: options.dataSource.getRowKey, sizes,
    })
    if (!transition.ok) return no(transition.issue)
    publish(transition.changes)
    return ok()
  }

  const prepareTransition = (action: string): GridDispatchResult | null => {
    const explicitEdit = !snapshot.bulk && !snapshot.filterSession && snapshot.edit
      ? cell(snapshot.edit.cell)?.column.behavior.edit?.exit === 'explicit'
      : false
    const decision = decideGridSessionExit(snapshot, action, explicitEdit)
    if (decision.kind === 'blocked') return no(decision.reason)
    if (decision.kind === 'allow') return null
    const committed = commitEdit()
    return committed.accepted ? null : committed
  }

  const draftCommandIssue = (
    owner: GridDraftCommandOwner<RowKey>,
    action: string,
  ): GridDispatchResult | null => {
    const issue = gridDraftSessionIssue(snapshot, editRevision, owner, action)
    return issue ? no(issue) : null
  }

  const mutationLimitIssue = (count: number) =>
    count > (options.maxMutations ?? 10_000)
      ? 'This operation exceeds the mutation limit.'
      : null
  const gridTransactionCost = (cellChanges: number, rowChanges: number) =>
    cellChanges + rowChanges
  const uniquePointCount = (points: readonly GridPoint<RowKey>[]) => {
    const identities = new Set<string>()
    for (const point of points) identities.add(encodeCellIdentity(point))
    return identities.size
  }
  const uniqueMutationCount = (
    mutations: readonly GridCellMutation<RowKey>[],
  ) => {
    const identities = new Set<string>()
    for (const mutation of mutations) {
      identities.add(encodeCellIdentity(mutation.cell))
    }
    return identities.size
  }

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
    const draft = rebaseGridAuthority({
      draft: snapshot.draft, remote, columns,
      getRowKey: options.dataSource.getRowKey,
      ...(options.dataSource.cloneRow ? { cloneRow: options.dataSource.cloneRow } : {}),
    })
    publishRemote(remote, draft)
  }

  const applyCommitted = (
    applied: GridDataSourceSnapshot<Row> & { status: 'ready' },
    latest: GridDataSourceSnapshot<Row>,
    committedRows: readonly Row[],
    committedDraftRevision: number,
    keyRemap: readonly GridRowKeyRemap<RowKey>[],
  ) => {
    const draft = acknowledgeGridCommit({
      draft: snapshot.draft, applied, latest, committedRows, committedDraftRevision,
      keyRemap, columns,
      getRowKey: options.dataSource.getRowKey,
      ...(options.dataSource.cloneRow ? { cloneRow: options.dataSource.cloneRow } : {}),
    })
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
      targets = remapGridAuthorityTargets({
        visibleRowKeys: snapshot.view.visibleRowKeys,
        interaction: snapshot.interaction,
        edit: snapshot.edit,
        bulk: snapshot.bulk,
      }, keyRemap),
      interaction = sameKeyOrder(
        targets.visibleRowKeys,
        view.visibleRowKeys,
      )
        ? targets.interaction
        : reconcileInteractionAfterViewChange(
            targets.interaction,
            view.visibleRowKeys,
            columnKeys(),
          ),
      nextEdit = reconcileGridEditAfterAuthority({
        session: targets.edit,
        rows: draft.rows, columns,
        getRowKey: options.dataSource.getRowKey,
        sourceRevision: source.revision,
        editRevision,
      })
    editRevision = nextEdit.editRevision
    abortSourceEffects()
    publish({
      source,
      draft,
      view,
      layout: layoutFor(view, snapshot.layout.revision + 1),
      interaction,
      edit: nextEdit.edit,
      bulk: targets.bulk,
    })
  }

  persistence = new GridPersistenceCoordinator({
    columns,
    getRowKey: options.dataSource.getRowKey,
    getControllerSnapshot: () => snapshot,
    getPublishedSnapshot: options.dataSource.getSnapshot,
    canRefresh: options.dataSource.refresh !== undefined,
    emitEffect: (effect) => {
      if (preparing) pendingEffects.push({ type: 'persistence/run', effect })
      else throw new Error('Persistence effects require a Runtime input.')
    },
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
    isDestroyed: environment.isDestroyed,
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
    pendingEffects.push({
      type: 'cell/run',
      operation: { key, active, target: point(target), definition: effect, input, context: context(resolved.row, resolved.column) },
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
    pendingEffects.push({ type: 'external/run', operation: { id, active, request } })
    return ok({ effectId: id })
  }

  function effectFeedback(id: string, reason: string) {
    dispatchUnchecked({
      type: 'feedback/push',
      item: { id: `effect:${id}`, kind: 'error', message: reason, persistent: true },
    })
  }

  function handleEffectEvent(event: GridControllerEffectEvent<Row, RowKey, Effect>) {
    if (event.type === 'cell/completed') {
      const { key, active, target, definition } = event.operation
      const current = effectCoordinator.isCellCurrent(key, active)
      effectCoordinator.finishCell(key, active)
      if (!current) return
      if (!event.result.ok) {
        effectFeedback(key, event.result.issue.message)
        return
      }
      const committed = mutate([{ cell: target, value: event.result.value }], definition.id, {
        kind: 'cell-effect', cell: target, editRevision: active.edit ?? null,
      })
      if (!committed.accepted) {
        effectFeedback(key, committed.reason ?? 'The effect result could not be applied.')
        return
      }
      if (active.edit !== undefined && snapshot.edit
        && samePoint(snapshot.edit.cell, target) && active.edit === editRevision) {
        editRevision += 1
        publish({ edit: null })
      }
      return
    }
    const { id, active } = event.operation
    const current = effectCoordinator.isExternalCurrent(id, active)
    effectCoordinator.finishExternal(id, active)
    if (!current) return
    if (event.type === 'external/failed') {
      effectFeedback(id, message(event.error))
      return
    }
    if (event.result === undefined) return
    for (const next of Array.isArray(event.result) ? event.result : [event.result]) {
      const dispatched = dispatchUnchecked(next as GridIntent<RowKey, Effect>)
      if (!dispatched.accepted) {
        effectFeedback(id, dispatched.reason ?? 'The effect result could not be applied.')
        break
      }
    }
  }

  const cell = (target: GridPoint<RowKey>) => {
    const column = columnByKey.get(target.columnKey)
    if (!rowIndex.byKey.has(target.rowKey) || !column) return null
    const row = rowIndex.byKey.get(target.rowKey) as Row
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
  ): GridActiveEffect<RowKey> => ({
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
  function prepareInput<Result>(
    base: Snapshot,
    internal: InternalState,
    operation: () => Result,
  ): GridTransition<Snapshot, EffectCommand, Result, InternalState> {
    snapshot = base
    inputRevision = base.revision
    editRevision = internal.editRevision
    sequence = internal.sequence
    persistence.restoreState(internal.persistence)
    effectCoordinator.restoreState(internal.effects)
    if (indexedRows !== base.draft.rows) {
      rowIndex = createGridRowIndex(base.draft.rows, options.dataSource.getRowKey)
      indexedRows = base.draft.rows
    }
    pendingEffects = []
    preparing = true
    try {
      const result = operation()
      return {
        state: snapshot,
        internalState: Object.freeze({
          persistence: persistence.captureState(),
          effects: effectCoordinator.captureState(),
          editRevision, sequence,
        }),
        effects: pendingEffects,
        result,
      }
    } finally {
      preparing = false
      pendingEffects = []
      snapshot = base
      editRevision = internal.editRevision
      sequence = internal.sequence
      persistence.restoreState(internal.persistence)
      effectCoordinator.restoreState(internal.effects)
    }
  }

  const prepareEvent = (base: Snapshot, internal: InternalState, event: Event) => prepareInput(base, internal, () => {
      if (event.type === 'effect/event') handleEffectEvent(event.event)
      else if (event.type === 'source/published') persistence.syncPublished(event.remote)
      else if (event.type === 'persistence/event') persistence.handleEvent(event.event)
      else publish({ source: Object.freeze({
        ...snapshot.source, revision: snapshot.source.revision + 1,
        status: 'error', error: event.error,
      }) })
    })

  const prepareEventFailure = (base: Snapshot, internal: InternalState, event: Event, error: unknown) => prepareInput(base, internal, () => {
      if (event.type === 'effect/event') {
        const completed = event.event
        if (completed.type === 'cell/completed') {
          const { key, active } = completed.operation
          effectCoordinator.finishCell(key, active)
          effectFeedback(key, message(error))
        } else {
          const { id, active } = completed.operation
          effectCoordinator.finishExternal(id, active)
          effectFeedback(id, message(error))
        }
      } else publish({ source: Object.freeze({
        ...base.source, revision: base.source.revision + 1,
        status: 'error', error: message(error),
      }) })
    })

  return Object.freeze({
    prepareIntent: (base: Snapshot, internal: InternalState, intent: GridIntent<RowKey, Effect>) =>
      prepareInput(base, internal, () => dispatchUnchecked(intent)),
    prepareTransaction: (
      base: Snapshot, internal: InternalState,
      build: Parameters<typeof applyTransaction>[0],
      transactionOptions?: Parameters<typeof applyTransaction>[1],
    ) => prepareInput(base, internal, () => applyTransaction(build, transactionOptions)),
    prepareEvent,
    prepareEventFailure,
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
function sameKeyOrder<RowKey extends GridRowKey>(
  left: readonly RowKey[],
  right: readonly RowKey[],
) {
  return (
    left.length === right.length &&
    left.every((key, index) => gridRowKeysEqual(key, right[index]))
  )
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
import { selectedCells, gridRangeBounds } from '../model/range-geometry.js'
