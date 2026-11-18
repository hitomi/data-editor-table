import { submissionDispute } from '../kernel/state.js'
import { runnableSaveSchedule } from '../kernel/save-schedule.js'
import { authorityCovers, authorityCoversFrontier } from '../kernel/protocol.js'
import { isGridBusinessIntent, isGridInteractionInput, type GridInteractionInput, type GridKeyboardCommand } from './controller-interaction.js'
import { resolveGridLayout as layout } from './controller-state.js'
import { GridIssueError, gridExceptionIssue, gridValueIssue, type GridIssue, type GridIssueCode } from '../model/grid-result.js'
import type { GridControllerInternalState, GridControllerEvent, GridControllerEffect } from './controller-protocol.js'
import { prepareGridDraftPublication } from './draft-commands.js'
import { beginGridBulkSession, prepareGridBulkValues } from './bulk-transitions.js'
import { beginGridFilterSession, changeGridFilterSession, prepareGridFilterApply } from './filter-transitions.js'
import { beginGridEditSession, gridEditSourceIssue, prepareGridEditValue, invalidateGridEditSession } from './editing-transitions.js'
import { decideGridSessionExit, gridDraftSessionIssue, type GridDraftCommandOwner } from './session-policy.js'
import { transitionGridView } from './view-transitions.js'
import {
  decodeClipboardMatrix,
  encodeClipboardMatrix,
} from '../data/clipboard-matrix.js'
import type { GridCellMutation } from '../data/command-planner.js'
import {
  planGridClear,
  planGridFill,
} from '../data/command-planner.js'
import {
  areGridResolvedCellValuesEqual,
  resolveGridCellValue,
} from '../data/runtime-cell-resolver.js'
import { reconcileGridEditAfterAuthority, remapGridAuthorityTargets } from './source-reconciliation.js'
import {
  createGridColumnIndex,
  createGridRowIndex,
} from '../data/runtime-index.js'
import { invokeGridCallback } from '../data/safe-callback.js'
import type {
  GridCompiledColumn,
  GridControllerSnapshot,
  GridHitTarget,
  GridInteractionState,
  GridPoint,
  GridPointerModifiers,
  GridRange,
  GridRowKey,
  GridSaveTarget,
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
  GridCommandResult,
  GridEffectInput,
  GridEffectPort,
  GridEffectRequest,
  GridIntent,
  GridTransactionIssue,
} from './controller-contracts.js'
import {
  selectGridActions,
  selectGridRowDeletePlan,
  selectGridRowDuplicatePlan,
} from './grid-selectors.js'
import {
  GridEffectCoordinator,
  type GridActiveEffect,
} from './effect-coordinator.js'
import type { GridControllerEffectEvent } from './controller-effects.js'
import { copyGridCellEffectResult, copyGridHostEffectResult } from './effect-results.js'
import { assertGridRowDeletable, type GridAuthoredCommand } from '../data/kernel-authoring.js'
import { captureGridInput, copyGridInput } from '../cell-types/input-codec.js'
import { kernelId, type AuthorityFrontier, type OwnedInput } from '../kernel/model.js'
import { encodeRow } from '../kernel/schema.js'
import { ownEncodedValue, encodedValuesEqual } from '../kernel/document.js'
import type { KernelTransition } from '../kernel/transition.js'
import type { ServerAuthority } from '../kernel/source.js'
import type { ResolutionRequest } from '../kernel/resolution.js'
import { fieldResolutionIssues } from '../kernel/field-resolution.js'
import { projectGridReadModel } from '../data/kernel-read-model.js'
import type { createInitialGridKernelData } from './controller-state.js'
import type { GridKernelPersistenceEffect, GridKernelPersistenceEvent } from './kernel-persistence-effects.js'
import { projectGridPersistence, gridRecoveryOutcome, type GridSaveOutcome, type GridSaveRecovery, type GridSaveFeedback } from './controller-persistence.js'

import { buildGridTransaction, createGridTransactionIssue as transactionIssue } from './transaction-builder.js'
import type { GridTransition } from './controller-runtime.js'
import {
  activateGridPoint,
  endGridPointer,
  moveGridPoint,
  moveGridPointLinear,
  moveGridPointer,
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
    kernel: ReturnType<typeof createInitialGridKernelData<Row, RowKey, Schema>>
    allocate: () => string
    initialSnapshot: GridControllerSnapshot<Row, RowKey>
    getEffectPort: () => GridEffectPort<Row, RowKey, Effect> | undefined
    isDestroyed: () => boolean
  }>,
) {
  const { backend, model } = environment.kernel
  const allocate = environment.allocate
  let data = environment.kernel.internal.data
  let saveFeedback: GridSaveFeedback | null = null
  let saveAttempt = environment.kernel.internal.saveAttempt
  let saveReadTicket = environment.kernel.internal.saveReadTicket
  let refreshTicket = environment.kernel.internal.refreshTicket
  let retainedEffects = environment.kernel.internal.retainedEffects
  const columns = environment.initialSnapshot.columns
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
  const effectContextCurrent = (active: GridActiveEffect<RowKey>) =>
    (active.source === undefined || active.source === snapshot.source.revision)
    && (active.persistence === undefined || active.persistence === snapshot.persistence.revision)
    && (active.edit === undefined || active.edit === editRevision)
    && (!active.sessionId || snapshot.edit?.id === active.sessionId)
    && active.targets.every(target => targets().unchanged(target) !== undefined)
  const effectCoordinator = new GridEffectCoordinator<RowKey>(effectContextCurrent,
    (active) => {
      if (preparing) pendingEffects.push({ type: 'effect/cancel', active })
      else throw new Error('Effect cancellation requires a Runtime input.')
    },
  )
  const externalCommandOwner = Object.freeze({
    kind: 'external' as const,
  })
  const ok = (value?: unknown): GridCommandResult => ({ accepted: true, revision: snapshot.revision, value })
  const no = (code: GridIssueCode, message: string, cell?: GridPoint<RowKey>, domainCode?: string): GridCommandResult => ({
    accepted: false, revision: snapshot.revision, issue: Object.freeze({ code, message,
      ...(cell ? { cell: point(cell) } : {}), ...(domainCode === undefined ? {} : { domainCode }) }),
  })
  const rejectIssue = (issue: GridIssue): GridCommandResult => ({ accepted: false, revision: snapshot.revision,
    issue: Object.freeze({ ...issue, ...(issue.cell ? { cell: point(issue.cell) } : {}),
      ...(issue.target ? { target: Object.freeze({ ...issue.target }) } : {}) }) })
  const exception = (error: unknown) => rejectIssue(gridExceptionIssue(error))
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
    intent: GridIntent<RowKey, Effect> | GridInteractionInput<RowKey>,
  ): GridCommandResult => {
    switch (intent.type) {
      case 'viewport/configure': {
        const sizes = { rowHeight: intent.rowHeight, headerHeight: intent.headerHeight, rowIndicatorWidth: intent.rowIndicatorWidth }
        if (!Object.values(sizes).every(value => Number.isFinite(value) && value > 0))
          return no('invalid-input', 'Grid dimensions must be finite and greater than zero.')
        if (Object.entries(sizes).every(([key, value]) => snapshot.layout[key as keyof typeof sizes] === value)) return ok()
        publish({ layout: layout(columns, snapshot.view.visibleRowKeys.length, snapshot.layout, sizes, snapshot.layout.revision + 1) })
        return ok()
      }
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
          return no('stale-target', 'The action target no longer exists.')
        publish({
          interaction: frozenInteraction({
            ...snapshot.interaction,
            actionSession: Object.freeze({
              entityIds: Object.freeze([...new Set([entityForReview(intent.target.rowKey),
                ...selectedRowKeys(snapshot.interaction.ranges, snapshot.view.visibleRowKeys, columnKeys()).map(entityForReview)])]),
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
        if (!snapshot.edit) return no('stale-target', 'There is no active edit session.')
        publish({
          edit: Object.freeze({
            ...snapshot.edit,
            revision: ++editRevision,
            draftValue: copyGridInput(intent.value, columnByKey.get(snapshot.edit.cell.columnKey)?.behavior.edit?.inputCodec),
            status: 'editing',
            error: null,
          }),
        })
        return ok()
      case 'edit/set-composing':
        if (!snapshot.edit) return no('stale-target', 'There is no active edit session.')
        publish({
          edit: Object.freeze({
            ...snapshot.edit,
            revision: ++editRevision,
            composing: intent.composing,
            draftValue: intent.finalValue === undefined ? snapshot.edit.draftValue : copyGridInput(intent.finalValue, columnByKey.get(snapshot.edit.cell.columnKey)?.behavior.edit?.inputCodec),
          }),
        })
        return ok()
      case 'edit/set-status':
        if (!snapshot.edit) return no('stale-target', 'There is no active edit session.')
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
        return ok({ committed: true, moved: moved.accepted })
      }
      case 'edit/cancel':
        if (!snapshot.edit) return no('stale-target', 'There is no active edit session.')
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
        if (!snapshot.bulk) return no('stale-target', 'There is no active bulk session.')
        publish({
          bulk: Object.freeze({
            ...snapshot.bulk,
            revision: snapshot.bulk.revision + 1,
            draft: copyGridInput(intent.value, columnByKey.get(snapshot.bulk.columnKey)?.behavior.bulk?.inputCodec),
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
      case 'history/compensate-insertion': {
        const action = data.journal.actions.find(action => action.applicationId === intent.applicationId)
        if (!action) return no('stale-target', 'The transfer action is unavailable.')
        const records = data.journal.intents.filter(record => action.intentIds.includes(record.id))
        const creations = records.flatMap(record => record.operation.kind === 'create' ? [record.operation.entityId] : [])
        if (!creations.length || records.some(record => record.operation.kind !== 'create' && record.operation.kind !== 'write' && record.operation.kind !== 'order'))
          return no('invalid-input', 'Only a specific insertion can be compensated by this command.')
        if (records.some(record => record.operation.kind === 'write' && !creations.includes(record.operation.entityId)))
          return no('conflict', 'The transfer also changed existing rows; review it before compensating.')
        if (records.some(record => record.operation.kind === 'order' && !encodedValuesEqual(
          ownEncodedValue(record.operation.desired.filter(id => !creations.includes(id))), ownEncodedValue(action.beforeOrder))))
          return no('conflict', 'The transfer also reordered existing rows; review it before compensating.')
        const later = data.journal.intents.filter(record => record.sequence > (records.at(-1)?.sequence ?? 0))
        if (later.some(record => 'entityId' in record.operation && creations.includes(record.operation.entityId)))
          return no('conflict', 'Transferred rows have later work. Review both grids before removing them.')
        return admitCommands(creations.map(entityId => ({ kind: 'delete', entityId })), 'Compensate row transfer', externalCommandOwner,
          captureGridInput({ applicationId: intent.applicationId }))
      }
      case 'effect/inspect-result': {
        const event = retainedEffects.find(event => effectResultId(event) === intent.effectId)
        if (!event) return no('stale-target', 'The retained result is unavailable.')
        if (event.type === 'cell/completed') return ok({ kind: 'cell', input: structuredClone(event.operation.input),
          target: point(event.operation.target), entityId: event.operation.active.targets[0]!.entityId,
          result: copyGridCellEffectResult(model, event.operation.target.columnKey, event.result) })
        const captured = event.operation.active.targets.map(({ rowKey, columnKey, entityId, access }) => ({
          cell: { rowKey, columnKey }, entityId, access,
        }))
        return ok({ kind: 'external', request: structuredClone(event.operation.request), targets: captured,
          ...(event.type === 'external/completed' ? { state: 'completed', result: copyGridHostEffectResult(model, event.operation, event.result) }
            : { state: 'failed', issue: gridExceptionIssue(event.error) }) })
      }
      case 'effect/apply-host-result': {
        const event = retainedEffects.find(event => effectResultId(event) === intent.effectId)
        if (!event) return no('stale-target', 'The retained result is unavailable.')
        if (event.type !== 'external/completed') return no('invalid-input', 'Only a reviewed completed host result can be applied. Inspect failed requests through the host before deciding whether to retry.')
        const failure = applyExternalResult(event)
        if (failure) return rejectIssue(failure)
        discardEffectResult(intent.effectId)
        return ok()
      }
      case 'effect/reapply-cell-result': return reapplyEffect(intent.effectId, intent.target)
      case 'effect/discard-result':
        return discardEffectResult(intent.effectId) ? ok() : no('stale-target', 'The retained result is unavailable.')
      case 'order/resolve': {
        if (intent.resolution !== 'accept-remote' && intent.resolution !== 'keep-local')
          return no('invalid-input', 'Choose whether to accept remote order or keep local order explicitly.')
        const blocked = draftCommandIssue(externalCommandOwner, 'resolving row order')
        if (blocked) return blocked
        if (data.authority.content.kind !== 'complete') return no('source-unavailable', 'Authority is unavailable.')
        const order = backend.project(data).data.order
        if (!order.issues.length) return no('stale-target', 'The row order has no conflict to review.')
        return acceptData(backend.resolve(data, { revision: data.revision, observation: data.authority.content.snapshot.observation,
          issueIds: order.issues.map(issue => issue.id), target: { kind: 'order' },
          choice: { kind: intent.resolution === 'accept-remote' ? 'use-authority' : 'keep-local' },
        }, { actionId: kernelId<'action'>(allocate()), applicationId: kernelId<'application'>(allocate()), controlId: kernelId<'intent'>(allocate()) }))
      }
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
          return no('stale-target', 'The effect is not running.')
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
      return no('invalid-input', 'Viewport values must be finite and non-negative.')
    publish({
      layout: layout(
        columns,
        snapshot.view.visibleRowKeys.length,
        { viewportWidth: width, viewportHeight: height, scrollLeft, scrollTop },
        snapshot.layout,
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
    if (!transition.ok) return no('invalid-input', transition.reason)
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
    if (!transition.ok) return no('invalid-input', transition.reason)
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
    if (!transition.ok) return no('invalid-input', transition.reason)
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
    if (!transition.ok) return no('invalid-input', transition.reason)
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
    if (!transition.ok) return no('invalid-input', transition.reason)
    publish({ interaction: transition.state })
    return gesture?.kind === 'fill' && preview ? fill(preview) : ok()
  }
  const pointerCancel = (pointerId: number) => {
    const transition = endGridPointer(snapshot.interaction, pointerId)
    if (!transition.ok) return no('invalid-input', transition.reason)
    publish({ interaction: transition.state })
    return ok()
  }
  const keyboard = (command: GridKeyboardCommand, extend: boolean) => {
    if (snapshot.bulk) {
      if (command === 'cancel') {
        publish({ bulk: null })
        return ok()
      }
      return no('session-open', 'Apply or cancel the bulk edit before continuing.')
    }
    if (snapshot.edit?.composing)
      return no('session-open', 'Keyboard commands are paused during composition.')
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
        return no('invalid-input', 'There is no active cell.')
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
      return range ? setRanges([range], 0) : no('invalid-input', 'The selection is unavailable.')
    }
    if (!active) return no('invalid-input', 'There is no active cell.')
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
    if (!active) return no('invalid-input', 'There is no active cell.')
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
      return no('session-open', 'Close the current grid editing surface before editing a cell.')
    if (snapshot.edit) {
      if (target && samePoint(snapshot.edit.cell, target)) {
        targets().capture(target.rowKey, snapshot.edit.entityId)
        return ok()
      }
      const committed = commitEdit()
      if (!committed.accepted) return committed
    }
    if (!target) return no('invalid-input', 'There is no active cell to edit.')
    if (!rowIndex.byKey.has(target.rowKey)) return no('stale-target', 'The edit target no longer exists.', target)
    if (!columnByKey.has(target.columnKey)) return no('invalid-input', 'The edit column is unavailable.', target)
    const resolved = cell(target)
    if (!resolved) return no('invalid-input', 'The current cell value is invalid.', target)
    const begun = beginGridEditSession(resolved, target, snapshot.source.revision, editRevision + 1, { id: allocate(), entityId: targets().capture(target.rowKey).entityId })
    if (!begun.ok) return rejectIssue(gridValueIssue(begun.issue, 'permission-denied'))
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
      return no(session ? 'session-open' : 'stale-target',
        session
          ? 'The edit is still composing.'
          : 'There is no active edit session.',
      )
    targets().capture(session.cell.rowKey, session.entityId)
    const resolved = cell(session.cell),
      edit = resolved?.column.behavior.edit
    if (!resolved || !edit) return no('stale-target', 'The edit target is unavailable.')
    const value = prepareGridEditValue(session, resolved, snapshot.source.revision)
    if (!value.ok) {
      publish({ edit: invalidateGridEditSession(session, value.issue.message, ++editRevision) })
      return rejectIssue(gridValueIssue(value.issue, value.issue.code === 'edit-source-changed' ? 'conflict' : 'invalid-input'))
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
        edit: invalidateGridEditSession(session, result.issue.message, ++editRevision),
      })
      return result
    }
    editRevision++
    publish({ edit: null })
    return ok(result.value)
  }
  const targets = () => backend.project(data).targets
  const captureEditTarget = (session: NonNullable<Snapshot['edit']>) => {
    const captured = targets().capture(session.cell.rowKey, session.entityId)
    const resolved = cell(session.cell)
    if (!resolved) throw new GridIssueError({ code: 'stale-target', message: 'The edit target is unavailable.' })
    const changed = gridEditSourceIssue(session, resolved, snapshot.source.revision)
    if (changed) throw new GridIssueError(gridValueIssue(changed, 'conflict'))
    return captured
  }
  const entityForReview = (rowKey: RowKey) => {
    const entity = targets().entityAt(rowKey)
    if (entity) return entity
    const binding = data.entities.find(entry => entry.kind !== 'local' && gridRowKeysEqual(entry.identity.key, rowKey))
    if (binding) return binding.entityId
    throw new GridIssueError({ code: 'stale-target', message: 'The row identity is no longer available.' })
  }
  const authoredInput = (commands: readonly GridAuthoredCommand<Row>[]): OwnedInput => captureGridInput(commands.map(command => {
    if (command.kind === 'create' || command.kind === 'restore-row') return { ...command, row: encodeRow(model.codec, command.row) }
    if (command.kind === 'set-cell') {
      const binding = model.columns.find(entry => entry.column.key === command.columnKey)
      return { ...command, value: captureGridInput(command.value, binding?.valueCodec) }
    }
    return command
  }))
  const admitCommands = (commands: readonly GridAuthoredCommand<Row>[], label: string, owner: GridDraftCommandOwner<RowKey> = externalCommandOwner,
    raw?: OwnedInput, selectRows?: readonly RowKey[]) => {
    const blocked = draftCommandIssue(owner, label.toLowerCase())
    if (blocked) return blocked
    if (data.authority.content.kind !== 'complete') return no('source-unavailable', 'Authority is unavailable.')
    try {
      const input = raw ?? (owner.kind === 'edit-commit' && snapshot.edit
        ? captureGridInput(snapshot.edit.draftValue, columnByKey.get(snapshot.edit.cell.columnKey)?.behavior.edit?.inputCodec)
        : owner.kind === 'bulk-apply' && snapshot.bulk
          ? captureGridInput(snapshot.bulk.draft, columnByKey.get(snapshot.bulk.columnKey)?.behavior.bulk?.inputCodec)
          : authoredInput(commands))
      const ref = { id: kernelId<'input'>(allocate()), version: 0 }
      const prepared = backend.prepare(data, { revision: data.revision,
        action: { id: kernelId<'action'>(allocate()), applicationId: kernelId<'application'>(allocate()), label, saveAtomicity: 'transaction' },
        cause: owner.kind === 'cell-effect' ? 'task' : 'user', inputs: [{ ref, input }],
        commands: commands.map(command => ({ id: kernelId<'intent'>(allocate()), command, inputs: [ref], dependencies: [] })),
      })
      if (!prepared.prepared) return ok({ changedCells: 0, applicationId: null })
      const before = snapshot.draft.rows
      const result = acceptData(backend.apply(data, prepared.prepared))
      if (!result.accepted) return result
      if (selectRows) {
        const selection = prepareGridDraftPublication({ transition: { kind: 'local', draft: snapshot.draft, selectRows, transactionCost: 0 },
          currentDraft: { ...snapshot.draft }, view: snapshot.view, interaction: snapshot.interaction, layout: snapshot.layout,
          columns, getRowKey: options.dataSource.getRowKey, sizes: snapshot.layout, maxMutations: options.maxMutations ?? 10_000 })
        if (selection.ok && selection.changes) publish(selection.changes)
      }
      return ok({ changedCells: changedCellsBetweenRows(before, snapshot.draft.rows).length, applicationId: prepared.prepared.action.applicationId })
    } catch (error) { return exception(error) }
  }
  const mutate = (mutations: readonly GridCellMutation<RowKey>[], label: string,
    owner: GridDraftCommandOwner<RowKey> = externalCommandOwner) => {
    const limit = mutationLimitIssue(uniqueMutationCount(mutations))
    if (limit) return no('limit-exceeded', limit)
    try {
      const normalized = new Map(mutations.map(mutation => [cellKey(mutation.cell), mutation]))
      for (const mutation of normalized.values()) if (!columnByKey.has(mutation.cell.columnKey))
        return no('invalid-input', 'The target column is not configured.', mutation.cell)
      return admitCommands([...normalized.values()].map(mutation => ({ kind: 'set-cell', entityId: targets().capture(mutation.cell.rowKey).entityId,
        columnKey: mutation.cell.columnKey, value: mutation.value })), label, owner)
    } catch (error) { return exception(error) }
  }
  const commitAtomicTransaction = (input: Readonly<{
    base: typeof snapshot; createdRows: readonly Row[]; removedRowKeys?: readonly RowKey[]; rowOrder?: readonly RowKey[];
    movedRowKeys?: readonly RowKey[]; mutations: readonly GridCellMutation<RowKey>[]; label: string; action: string; raw?: OwnedInput
  }>) => {
    const rejected = (issue: GridIssue) => ({ dispatch: rejectIssue(issue), commit: null,
      issues: Object.freeze([issue as GridTransactionIssue<RowKey>]) })
    if (snapshot !== input.base) return rejected({ code: 'stale-target', message: 'The grid changed while this transaction was prepared.' })
    const limit = mutationLimitIssue(uniqueMutationCount(input.mutations) + input.createdRows.length
      + new Set(input.removedRowKeys ?? []).size + new Set(input.movedRowKeys ?? []).size)
    if (limit) return rejected({ code: 'limit-exceeded', message: limit })
    try {
      const removed = new Set(input.removedRowKeys ?? [])
      const creations = input.createdRows.filter(row => !removed.has(options.dataSource.getRowKey(row)))
      const createdIds = new Map(creations.map(row => [options.dataSource.getRowKey(row), kernelId<'entity'>(allocate())]))
      const resolve = (key: RowKey) => createdIds.get(key) ?? targets().capture(key).entityId
      const commands: GridAuthoredCommand<Row>[] = creations.map(row => ({ kind: 'create', entityId: resolve(options.dataSource.getRowKey(row)), row }))
      for (const mutation of input.mutations) if (!removed.has(mutation.cell.rowKey)) commands.push({ kind: 'set-cell',
        entityId: resolve(mutation.cell.rowKey), columnKey: mutation.cell.columnKey, value: mutation.value })
      const existingDeleted = [...removed].filter(key => input.base.draft.rows.some(row => gridRowKeysEqual(options.dataSource.getRowKey(row), key)))
      for (const key of existingDeleted) commands.push({ kind: 'delete', entityId: resolve(key) })
      if (input.rowOrder) commands.push({ kind: 'order', desired: input.rowOrder.map(resolve) })
      const before = snapshot.draft.rows
      const dispatched = admitCommands(commands, input.label, externalCommandOwner, input.raw)
      if (!dispatched.accepted) return rejected(dispatched.issue)
      const commit = Object.freeze({ createdRowKeys: Object.freeze([...createdIds.keys()]), deletedRowKeys: Object.freeze(existingDeleted),
        movedRowKeys: Object.freeze([...(input.movedRowKeys ?? [])]), changedCells: changedCellsBetweenRows(before, snapshot.draft.rows),
        applicationId: (dispatched.value as { applicationId?: string } | undefined)?.applicationId ?? null,
      })
      return { dispatch: dispatched, commit, issues: Object.freeze([]) as readonly GridTransactionIssue<RowKey>[] }
    } catch (error) { return rejected(gridExceptionIssue(error)) }
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
    if (blocked && !blocked.accepted) return reject(blocked.issue as GridTransactionIssue<RowKey>)
    if (data.authority.content.kind !== 'complete') return reject({ code: 'source-unavailable', message: 'Authority is unavailable.' })
    const base = snapshot
    const planned = buildGridTransaction({
      base, commandRows: backend.commandRows(data), build, configuredColumns,
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
    if (!chosen.length) return no('invalid-input', 'There is no selection to copy.')
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
          return no('permission-denied', `Column "${target.columnKey}" cannot be copied.`, target)
        else {
          const formatted = invokeGridCallback(() =>
            resolved.column.behavior.clipboard!.format(
              resolved.value,
              context(resolved.row, resolved.column),
            ),
          )
          if (!formatted.ok) return no('adapter-error', formatted.message)
          line.push(formatted.value)
        }
      }
      matrix.push(line)
    }
    const text = encodeClipboardMatrix(matrix)
    return new TextEncoder().encode(text).byteLength >
      (options.maxClipboardBytes ?? 2_000_000)
      ? no('limit-exceeded', 'The copied data exceeds the clipboard limit.')
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
      return no('limit-exceeded', 'The pasted data exceeds the clipboard limit.')
    const active = snapshot.interaction.activeCell
    if (!active) return no('invalid-input', 'There is no active paste target.')
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
    if (pasteLimitIssue) return no('limit-exceeded', pasteLimitIssue)
    const created: Row[] = []
    const create = options.dataSource.rows?.create
    if (missingRows > 0 && !create)
      return no('permission-denied',
        'Paste requires new rows, but this data source cannot create them.',
      )
    const knownKeys = new Set([
      ...base.draft.baselineRows.map(options.dataSource.getRowKey),
      ...base.draft.rows.map(options.dataSource.getRowKey),
    ])
    for (let index = 0; index < missingRows; index += 1) {
      const result = invokeGridCallback(create!)
      if (!result.ok) return no('adapter-error', result.message)
      const row = result.value
      const rowKey = options.dataSource.getRowKey(row)
      if (knownKeys.has(rowKey))
        return no('adapter-error', 'A row created for paste has a duplicate key.')
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
          return no('stale-target', 'The paste target is outside the grid.')
        const column = columns.find((candidate) => candidate.key === columnKey)
        const parse = column?.behavior.clipboard?.parse
        if (!rowByKey.has(rowKey) || !column || !parse)
          return no('permission-denied', 'A paste target is read-only or incompatible.')
        const row = rowByKey.get(rowKey) as Row
        if (!column.isEditable(row))
          return no('permission-denied', 'A paste target is read-only or incompatible.')
        const parsed = safely(() => parse(matrix[r]![c]!, context(row, column)))
        if (!parsed.ok) return rejectIssue(gridValueIssue(parsed.issue))
        mutations.push({ cell: { rowKey, columnKey }, value: parsed.value })
      }
    const committed = commitAtomicTransaction({
      base,
      createdRows: Object.freeze(created),
      mutations: Object.freeze(mutations),
      label: 'Paste cells',
      action: 'pasting cells',
      raw: captureGridInput(text),
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
    if (!plan.ok) return rejectIssue(plan.issue)
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
    if (!source) return no('invalid-input', 'The fill range is invalid.')
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
    if (fillLimitIssue) return no('limit-exceeded', fillLimitIssue)
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
    if (!planned.ok) return no('adapter-error', planned.message)
    const plan = planned.value
    return plan.ok ? mutate(plan.value, 'Fill cells') : rejectIssue(plan.issue)
  }

  const revertCells = (targets: readonly GridPoint<RowKey>[]) => {
    if (!targets.length) return no('invalid-input', 'There are no cells to restore.')
    const baseline = new Map(snapshot.draft.baselineRows.map(row => [options.dataSource.getRowKey(row), row]))
    const mutations: GridCellMutation<RowKey>[] = []
    for (const target of targets) {
      const row = baseline.get(target.rowKey), column = columnByKey.get(target.columnKey)
      if (!row || !column) return no('stale-target', 'This cell has no authoritative original value.')
      const value = resolveGridCellValue(row, column)
      if (!value.valid) return no('invalid-input', 'The original value is invalid.')
      mutations.push({ cell: target, value: value.value })
    }
    return mutate(mutations, 'Restore original cells')
  }
  const revertRows = (rowKeys: readonly RowKey[]) => {
    const limit = mutationLimitIssue(rowKeys.length)
    if (limit) return no('limit-exceeded', limit)
    try {
      const blocked = draftCommandIssue(externalCommandOwner, 'restoring rows')
      if (blocked) return blocked
      if (data.authority.content.kind !== 'complete') return no('source-unavailable', 'Authority is unavailable.')
      const targets = [...new Set(rowKeys)].flatMap(key => {
        const entityId = entityForReview(key), projected = backend.project(data).data.rows.find(row => row.entityId === entityId)
        return projected?.intentIds.length ? [{ entityId, issueIds: projected.issues.map(issue => issue.id) }] : []
      })
      if (!targets.length) return ok()
      return acceptData(backend.event(data, { kind: 'restore-contributions', request: {
        revision: data.revision, observation: data.authority.content.snapshot.observation, targets,
        actionId: kernelId<'action'>(allocate()), applicationId: kernelId<'application'>(allocate()),
      } }))
    } catch (error) { return exception(error) }
  }
  const resolveConflict = (rowKey: RowKey, columnKey: string | null, resolution: 'accept-remote' | 'keep-local') => {
    if (resolution !== 'accept-remote' && resolution !== 'keep-local')
      return no('invalid-input', 'Choose whether to accept remote data or keep local data explicitly.')
    const blocked = draftCommandIssue(externalCommandOwner, 'resolving conflicts')
    if (blocked) return blocked
    try {
      if (data.authority.content.kind !== 'complete') return no('source-unavailable', 'Authority is unavailable.')
      const entityId = entityForReview(rowKey), projected = backend.project(data).data.rows.find(row => row.entityId === entityId)
      if (!projected?.issues.length) return no('stale-target', 'The conflict is no longer available.')
      const binding = columnKey === null ? null : model.columns.find(binding => binding.column.key === columnKey)
      if (columnKey !== null && !binding) return no('stale-target', 'The reviewed column is no longer bound in this document model.')
      const field = binding?.fields ?? null
      if (field && field.length !== 1) return no('conflict', 'This column changes multiple fields. Review the complete row conflict.')
      const target: ResolutionRequest['target'] = field ? { kind: 'field', entityId, fieldId: field[0]!.id } : { kind: 'row', entityId }
      const issues = field ? fieldResolutionIssues(projected.issues, entityId, field[0]!.path) : projected.issues
      if (!issues.length) return no('conflict', 'This conflict has no field review for this column. Review the complete row conflict.')
      if (resolution === 'keep-local' && projected.existence === 'pending-delete')
        assertGridRowDeletable(model, projected.preview ?? projected.authority!, options.dataSource.rows?.canDelete)
      const choice: ResolutionRequest['choice'] = resolution === 'accept-remote' ? { kind: 'use-authority' }
        : projected.existence === 'remote-deleted' ? { kind: 'recreate', entityId: kernelId<'entity'>(allocate()) }
        : projected.issues.some(issue => issue.code === 'create-key-collision') ? {
          kind: 'adopt-existing', entityId: data.entities.find(binding => binding.kind === 'bound'
            && binding.entityId !== entityId && gridRowKeysEqual(binding.identity.key as RowKey, rowKey))!.entityId,
          document: projected.preview!,
        } : target.kind === 'row' ? {
          // A whole-row review explicitly accepts the retained concrete result
          // against today's authority; it must not replay stale setter reads.
          kind: 'merge', commands: projected.existence === 'pending-delete'
            ? [{ kind: 'delete', entityId }]
            : [{ kind: 'replace', entityId, document: projected.preview! }],
          input: captureGridInput({ decision: 'keep-local-row', entityId, existence: projected.existence, document: projected.preview }),
        } : { kind: 'keep-local' }
      return acceptData(backend.resolve(data, { revision: data.revision, observation: data.authority.content.snapshot.observation,
        issueIds: issues.map(issue => issue.id), target, choice,
      }, { actionId: kernelId<'action'>(allocate()), applicationId: kernelId<'application'>(allocate()), controlId: kernelId<'intent'>(allocate()) }))
    } catch (error) { return exception(error) }
  }

  const startBulk = (key = snapshot.interaction.activeCell?.columnKey) => {
    if (snapshot.filterSession)
      return no('session-open', 'Close the filter editor before starting a bulk edit.')
    const blocked = prepareTransition('starting a bulk edit')
    if (blocked) return blocked
    const column = columns.find((candidate) => candidate.key === key),
      bulk = column?.behavior.bulk
    if (!column || !bulk || !column.bulkEditable)
      return no('permission-denied', 'This column does not support bulk editing.')
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
      id: allocate(), capture: target => targets().capture(target.rowKey), column, cells: resolved,
      maxMutations: options.maxMutations ?? 10_000, revision: (snapshot.bulk?.revision ?? 0) + 1,
    })
    if (!begun.ok) return rejectIssue(gridValueIssue(begun.issue, begun.issue.code === 'mutation-limit' ? 'limit-exceeded' : 'permission-denied'))
    publish({ bulk: begun.value })
    return ok()
  }
  const applyBulk = () => {
    const session = snapshot.bulk
    if (!session) return no('stale-target', 'There is no active bulk session.')
    const owner = Object.freeze({
      kind: 'bulk-apply' as const,
      bulkRevision: session.revision,
    })
    const blocked = draftCommandIssue(owner, 'applying the bulk edit')
    if (blocked) return blocked
    const planned = prepareGridBulkValues({
      session, maxMutations: options.maxMutations ?? 10_000,
      resolveCell: target => {
        const row = targets().unchanged(target)
        return row ? cell({ rowKey: row.rowKey, columnKey: session.columnKey }) : null
      },
    })
    if (!planned.ok) {
      if (planned.session !== session) publish({ bulk: planned.session })
      return rejectIssue(planned.issue)
    }
    const result = mutate(planned.mutations, 'Bulk edit', owner)
    if (result.accepted) {
      publish({ bulk: null })
      return ok(result.value)
    }
    return result
  }
  const openFilter = (columnKey: string) => {
    const blocked = prepareTransition('opening a filter editor')
    if (blocked) return blocked
    const begun = beginGridFilterSession(
      columns.find((column) => column.key === columnKey),
      snapshot.view.columnFilters, allocate(),
    )
    if (!begun.ok) return rejectIssue(gridValueIssue(begun.issue, 'permission-denied'))
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
    if (!next.ok) return rejectIssue(gridValueIssue(next.issue))
    publish({ filterSession: next.value })
    return ok()
  }
  const addFilterCondition = () => {
    const filter = columns.find((column) => column.key === snapshot.filterSession?.columnKey)?.behavior.filter
    if (!filter) return no('stale-target', 'There is no active filter session.')
    const next = changeGridFilterSession(snapshot.filterSession, { type: 'add', defaultOperator: filter.defaultOperator })
    if (!next.ok) return rejectIssue(gridValueIssue(next.issue))
    publish({ filterSession: next.value })
    return ok()
  }
  const removeFilterCondition = (index: number) => {
    const next = changeGridFilterSession(snapshot.filterSession, { type: 'remove', index })
    if (!next.ok) return rejectIssue(gridValueIssue(next.issue))
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
      return rejectIssue(next.issue)
    }
    const result = updateView({ columnFilters: next.filters }, true)
    if (result.accepted) {
      publish({ filterSession: null })
      return ok(result.value)
    }
    return result
  }
  const clearFilter = () => {
    const session = snapshot.filterSession
    if (!session) return no('stale-target', 'There is no active filter session.')
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
    try { return acceptData(backend.history(data, direction, allocate)) } catch (error) { return exception(error) }
  }

  const addRow = () => {
    return rowTransaction(transaction => { transaction.createRow() }, 'Add row')
  }
  const duplicateRows = () => {
    const blocked = draftCommandIssue(externalCommandOwner, 'duplicating rows')
    if (blocked) return blocked
    const duplicate = options.dataSource.rows?.duplicate
    const plan = selectGridRowDuplicatePlan(snapshot)
    if (!duplicate || !plan.canDuplicate)
      return no('invalid-input', 'Select rows that can be duplicated.')
    const keys = backend.commandRows(data).keys
    const selected = new Set(plan.rowKeys)
    const lastSelected = keys.reduce((last, key, index) => selected.has(key) ? index : last, -1)
    const beforeRowKey = options.dataSource.rows?.ordering === 'mutable' ? keys[lastSelected + 1] ?? null : null
    return rowTransaction(transaction => {
      for (const key of plan.rowKeys) transaction.duplicateRow(key, { beforeRowKey })
    }, 'Duplicate rows')
  }
  const deleteRows = () => {
    const blocked = draftCommandIssue(externalCommandOwner, 'deleting rows')
    if (blocked) return blocked
    const plan = selectGridRowDeletePlan(snapshot)
    if (!options.dataSource.rows?.canDelete)
      return no('permission-denied', 'Deleting rows is unavailable.')
    if (plan.rowKeys.length === 0) return no('invalid-input', 'Select rows to delete.')
    if (plan.blockedCount > 0)
      return no('permission-denied', 'Every selected row must be deletable before the selection can be deleted.')
    const limitIssue = mutationLimitIssue(
      gridTransactionCost(0, plan.rowKeys.length),
    )
    if (limitIssue) return no('limit-exceeded', limitIssue)
    const chosen = new Set(plan.rowKeys),
      firstIndex = snapshot.view.visibleRowKeys.findIndex((key) =>
        chosen.has(key),
      ),
      remainingVisible = snapshot.view.visibleRowKeys.filter(
        (key) => !chosen.has(key),
      ),
      nearest = remainingVisible.length
        ? remainingVisible[clamp(firstIndex, 0, remainingVisible.length - 1)]!
        : undefined
    return rowTransaction(transaction => { transaction.deleteRows(plan.rowKeys) }, 'Delete rows', nearest === undefined ? [] : [nearest])
  }
  const rowTransaction = (
    build: Parameters<typeof applyTransaction>[0],
    label: string,
    select?: readonly RowKey[],
  ) => {
    const blocked = draftCommandIssue(externalCommandOwner, label.toLowerCase())
    if (blocked) return blocked
    const committed = applyTransaction(build, { label })
    if (committed.accepted) {
      const selection = prepareGridDraftPublication({ transition: { kind: 'local', draft: snapshot.draft, selectRows: select ?? committed.result.createdRowKeys, transactionCost: 0 },
        currentDraft: { ...snapshot.draft }, view: snapshot.view, interaction: snapshot.interaction, layout: snapshot.layout,
        columns, getRowKey: options.dataSource.getRowKey, sizes: snapshot.layout, maxMutations: options.maxMutations ?? 10_000 })
      if (selection.ok && selection.changes) publish(selection.changes)
    }
    return committed.accepted ? ok({ changedCells: committed.result.changedCells.length, applicationId: committed.result.applicationId })
      : rejectIssue(committed.issues[0])
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
      if (Object.is(left, right)) continue
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
      columns, getRowKey: options.dataSource.getRowKey, sizes: snapshot.layout,
    })
    if (!transition.ok) return rejectIssue(transition.issue)
    publish(transition.changes)
    return ok()
  }

  const prepareTransition = (action: string): GridCommandResult | null => {
    const explicitEdit = !snapshot.bulk && !snapshot.filterSession && snapshot.edit
      ? cell(snapshot.edit.cell)?.column.behavior.edit?.exit === 'explicit'
      : false
    const decision = decideGridSessionExit(snapshot, action, explicitEdit)
    if (decision.kind === 'blocked') return no('session-open', decision.reason)
    if (decision.kind === 'allow') return null
    const committed = commitEdit()
    return committed.accepted ? null : committed
  }

  const draftCommandIssue = (
    owner: GridDraftCommandOwner<RowKey>,
    action: string,
  ): GridCommandResult | null => {
    const issue = gridDraftSessionIssue(snapshot, editRevision, owner, action)
    if (issue) return rejectIssue(issue)
    if (snapshot.edit && owner.kind === 'cell-effect') captureEditTarget(snapshot.edit)
    return null
  }

  const mutationLimitIssue = (count: number) =>
    count > (options.maxMutations ?? 10_000)
      ? 'This operation exceeds the mutation limit.'
      : null
  const gridTransactionCost = (cellChanges: number, rowChanges: number) =>
    cellChanges + rowChanges
  const uniqueMutationCount = (
    mutations: readonly GridCellMutation<RowKey>[],
  ) => {
    const identities = new Set<string>()
    for (const mutation of mutations) {
      identities.add(encodeCellIdentity(mutation.cell))
    }
    return identities.size
  }

  const persistenceView = () => projectGridPersistence(data, saveFeedback, saveAttempt)
  const recordSaveFailure = (message: string, settled = false) => {
    const p = data.persistence
    saveFeedback = !settled && 'submission' in p
      ? { operationId: p.submission.operationId, message }
      : { scheduleToken: saveAttempt?.scheduleToken ?? data.schedule.token, message }
  }
  const acceptData = (transition: KernelTransition, allowLookup = true): GridCommandResult => {
    if (transition.result.kind === 'rejected' || transition.result.kind === 'unresolved') return no(
      transition.result.kind === 'unresolved' ? 'conflict' : 'adapter-error', transition.result.issue.message,
      undefined, transition.result.issue.code,
    )
    if (transition.result.kind === 'ignored') return ok()
    const previous = data, oldProjection = backend.project(previous)
    data = transition.state
    const settled = 'submission' in previous.persistence && data.persistence.kind === 'idle'
    if (settled) {
      saveReadTicket = null
      if (previous.persistence.kind === 'committed-awaiting-authority') saveFeedback = null
    }
    const projected = backend.project(data)
    const rowContext = (projection: ReturnType<typeof backend.project>) => projection.data.rows.map(row => ({
      entityId: row.entityId, preview: row.preview, existence: row.existence, issues: row.issues,
    }))
    const changed = projected.rows !== oldProjection.rows || !encodedValuesEqual(ownEncodedValue(rowContext(projected)), ownEncodedValue(rowContext(oldProjection)))
    const draft = Object.freeze({ ...projectGridReadModel(data, projected, model, columns, options.dataSource.getRowKey),
      revision: snapshot.draft.revision + (changed ? 1 : 0),
    })
    const remap: { from: RowKey; to: RowKey }[] = []
    const unavailable = new Set<RowKey>()
    for (const before of oldProjection.byKey.values()) {
      const after = projected.targets.locate(before.entityId)
      if (!after || (oldProjection.targets.live(before.entityId) && !projected.targets.live(before.entityId)))
        unavailable.add(before.rowKey)
      if (after && !gridRowKeysEqual(before.rowKey, after.rowKey)) remap.push({ from: before.rowKey, to: after.rowKey })
    }
    const interaction = snapshot.interaction
    const selected = unavailable.size && selectedRowKeys(interaction.fillPreview ? [...interaction.ranges, interaction.fillPreview] : interaction.ranges,
      snapshot.view.visibleRowKeys, columnKeys()).some(key => unavailable.has(key))
    const stale = selected || (interaction.activeCell && unavailable.has(interaction.activeCell.rowKey))
      || interaction.actionSession?.entityIds.some(id => !projected.targets.locate(id))
    const translated = remapGridAuthorityTargets({ visibleRowKeys: snapshot.view.visibleRowKeys,
      interaction: stale ? clearInteraction<RowKey>() : interaction, edit: snapshot.edit, bulk: snapshot.bulk }, remap)
    const publication = prepareGridDraftPublication({ transition: { kind: 'history', draft }, currentDraft: snapshot.draft,
      view: { ...snapshot.view, visibleRowKeys: translated.visibleRowKeys }, interaction: translated.interaction,
      layout: snapshot.layout, columns, getRowKey: options.dataSource.getRowKey,
      sizes: snapshot.layout, maxMutations: options.maxMutations ?? 10_000 })
    if (!publication.ok) throw new Error(publication.reason)
    const authorityChanged = previous.authority.content !== data.authority.content
    const sourceRevision = snapshot.source.revision + (authorityChanged ? 1 : 0)
    const reconciled = authorityChanged ? reconcileGridEditAfterAuthority({ session: translated.edit, columns,
      resolveRow: session => projected.targets.live(session.entityId)?.row, sourceRevision, editRevision }) : { edit: translated.edit, editRevision }
    editRevision = reconciled.editRevision
    const read = data.authority.read
    const source = Object.freeze({ revision: sourceRevision, rows: draft.baselineRows, version: draft.baselineVersion,
      scope: Object.freeze({ kind: 'complete' as const }), status: read.kind === 'failed' ? 'error' as const
        : data.authority.content.kind === 'uninitialized' ? 'loading' as const : read.kind === 'loading' ? 'refreshing' as const : 'ready' as const,
      error: read.kind === 'failed' ? read.issue.message : null,
    })
    publish({ interaction: translated.interaction, ...publication.changes, draft, source, edit: reconciled.edit, bulk: translated.bulk, persistence: persistenceView() })
    for (const effect of transition.effects) {
      if (effect.kind !== 'submit' && effect.kind !== 'lookup' && effect.kind !== 'read-at-least')
        throw new Error('The controller data backend cannot own a second task runner.')
      // Disputed receipts require an explicit review. Repeating an adapter's
      // identical malformed response must not launch an endless lookup loop.
      if (submissionDispute(data) || data.persistence.kind === 'receipt-blocked') continue
      if (effect.kind === 'lookup' && !allowLookup) continue
      if (effect.kind === 'read-at-least') {
        const ticket = allocate()
        if (data.persistence.kind === 'committed-awaiting-authority') {
          saveReadTicket = ticket
          pendingEffects.push({ type: 'persistence/run', effect: { type: 'read', state: data, ticket } })
        } else {
          // An incomparable feed publication needs the same read ownership,
          // loading, supersession and failure transitions as an explicit refresh.
          persistence.refresh(ticket)
        }
      } else pendingEffects.push({ type: 'persistence/run', effect: { type: 'kernel', effect } })
    }
    if (settled)
      pendingEffects.push({ type: 'persistence/run', effect: { type: 'release', state: data } })
    return ok()
  }
  const applyRemote = (remote: ServerAuthority) => {
    const transition = backend.authority(data, remote, allocate)
    const accepted = acceptData(transition)
    if (!accepted.accepted) throw new GridIssueError(accepted.issue)
  }
  const emitPersistence = (effect: GridKernelPersistenceEffect) => pendingEffects.push({ type: 'persistence/run', effect })
  const completeSave = (outcome?: GridSaveOutcome) => {
    if (!saveAttempt?.ticket) return
    const ticket = saveAttempt.ticket
    saveAttempt = 'submission' in data.persistence ? Object.freeze({ ...saveAttempt, ticket: null, retryAfterLookup: false }) : null
    const view = persistenceView()
    if (!outcome) publish({ persistence: view })
    pendingEffects.push({ type: 'persistence/complete', kind: 'save', ticket, result: outcome ?? gridRecoveryOutcome(data, view) })
  }
  const settleSave = () => {
    if (!saveAttempt?.ticket) return
    const p = data.persistence
    if (p.kind === 'idle') {
      const operationId = saveAttempt.operationId
      const rejection = operationId && data.rejections.find(fact => fact.submission.operationId === operationId)
      if (rejection) completeSave({ status: 'failed', operationId, issue: {
        code: 'source-unavailable', domainCode: rejection.proof.reason.code, message: rejection.proof.reason.message,
      } })
      else if (operationId && data.commits.some(fact => fact.submission.operationId === operationId)) {
        const excluded = saveAttempt.excluded
        completeSave(excluded.length ? { status: 'partial', operationId, excluded: excluded as readonly [GridIssue, ...GridIssue[]] }
          : { status: 'confirmed', operationId })
      } else if (!operationId) completeSave({ status: 'no-changes' })
    }
  }
  const requestSave = (scheduleToken?: number, requestedTicket?: string, target?: GridSaveTarget<RowKey>): GridCommandResult => {
    const action = selectGridActions(snapshot, target).save
    if (action.issue && action.issue.code !== 'no-changes') return rejectIssue(action.issue)
    const blocked = scheduleToken === undefined ? prepareTransition('saving changes') : null
    if (blocked) return blocked
    const projection = backend.project(data).data
    if (!projection.changes.length && !projection.orderChange) {
      const excluded = snapshot.draft.savePlan.excluded
      if (excluded.length) return rejectIssue(excluded[0]!)
      saveFeedback = null
      saveAttempt = Object.freeze({ ticket: requestedTicket ?? allocate(), operationId: null, scheduleToken: data.schedule.token, excluded: Object.freeze([]), retryAfterLookup: false })
      publish({ persistence: persistenceView() }); completeSave({ status: 'no-changes' }); return ok()
    }
    const ticket = requestedTicket ?? allocate()
    saveFeedback = null
    const accepted = acceptData(backend.event(data, { kind: 'save-requested', ticket, ...(scheduleToken === undefined ? {} : { scheduleToken }) }))
    if (accepted.accepted && backend.project(data).persistence.kind === 'waiting-for-gateway') {
      saveAttempt = Object.freeze({ ticket, operationId: null, scheduleToken: data.schedule.token, excluded: Object.freeze([]), retryAfterLookup: false })
      emitPersistence({ type: 'acquire', state: data, ticket })
    }
    return accepted
  }
  const prepareSaveHash = (ticket: string) => {
    if (data.persistence.kind !== 'waiting-for-gateway' || data.persistence.ticket !== ticket) return
    const projection = backend.project(data).data
    if (!projection.changes.length && !projection.orderChange) {
      acceptData(backend.event(data, { kind: 'save-wait-ended', ticket })); emitPersistence({ type: 'abandon', ticket })
      const excluded = snapshot.draft.savePlan.excluded
      completeSave(excluded.length ? { status: 'blocked', issue: excluded[0]! } : { status: 'no-changes' }); return
    }
    const draft = backend.prepareSave(data, { operationId: kernelId<'operation'>(allocate()),
      items: projection.changes.map(change => ({ entityId: change.entityId, itemId: kernelId<'item'>(allocate()) })),
      ...(projection.orderChange ? { orderItemId: kernelId<'item'>(allocate()) } : {}),
    })
    emitPersistence({ type: 'hash', ticket, draft })
  }
  const failSaveWait = (ticket: string, issue: GridIssue) => {
    if (data.persistence.kind !== 'waiting-for-gateway' || data.persistence.ticket !== ticket) return
    const dispute = data.protocolFaults[0]
    if (!dispute) recordSaveFailure(issue.message)
    acceptData(backend.event(data, { kind: 'save-wait-ended', ticket })); emitPersistence({ type: 'abandon', ticket })
    completeSave(dispute ? { status: 'blocked', issue: { code: 'save-unresolved', message: dispute.issue.message } }
      : { status: 'failed', operationId: null, issue })
  }
  const handlePersistence = (event: GridKernelPersistenceEvent) => {
    switch (event.type) {
      case 'schedule/due': if (runnableSaveSchedule(data)?.token === event.token) requestSave(event.token); return
      case 'gateway/ready':
        if (data.persistence.kind !== 'waiting-for-gateway' || data.persistence.ticket !== event.ticket) { emitPersistence({ type: 'abandon', ticket: event.ticket }); return }
        try {
          const content = data.authority.content
          if (content.kind !== 'complete' || !authorityCovers(content.snapshot.version, event.version)
            || !authorityCoversFrontier(content.snapshot.version, data.authorityFrontier))
            throw new Error('The workspace has not installed the authority required for saving.')
          prepareSaveHash(event.ticket)
        } catch (error) { failSaveWait(event.ticket, gridExceptionIssue(error)) }
        return
      case 'gateway/failed': case 'hash/failed': failSaveWait(event.ticket, event.issue); return
      case 'hash/ready':
        if (data.persistence.kind !== 'waiting-for-gateway' || data.persistence.ticket !== event.ticket) return
        if (data.revision !== event.prepared.revision) { prepareSaveHash(event.ticket); return }
        { const excluded = snapshot.draft.savePlan.excluded
          const result = acceptData(backend.freezeSave(data, event.prepared))
          if (!result.accepted) failSaveWait(event.ticket, result.issue)
          else saveAttempt = Object.freeze({ ticket: event.ticket, operationId: event.prepared.submission.operationId, scheduleToken: data.schedule.token, excluded, retryAfterLookup: false })
        }
        return
      case 'read/ready': case 'read/superseded': {
        if (event.ticket !== refreshTicket && event.ticket !== saveReadTicket) return
        if (event.ticket === refreshTicket) {
          refreshTicket = null
          const entered = event.type === 'read/ready' && data.authority.content.kind === 'complete'
            && authorityCovers(event.version, data.authority.content.snapshot.version)
            && authorityCovers(data.authority.content.snapshot.version, event.version)
          const identityUnresolved = 'submission' in data.persistence && data.persistence.submission.items.some(item => item.kind === 'create')
          pendingEffects.push({ type: 'persistence/complete', kind: 'refresh', ticket: event.ticket,
            result: entered ? { status: 'refreshed' } : event.type === 'read/ready' && identityUnresolved
              ? { status: 'blocked', issue: { code: 'save-unresolved', message: 'Confirm the original creation before adopting its server identity.' } }
              : { status: 'superseded' } })
        }
        if (event.ticket === saveReadTicket) {
          saveReadTicket = null; saveFeedback = null
          if (data.persistence.kind !== 'idle') completeSave()
        }
        return
      }
      case 'read/failed': {
        if (event.ticket !== refreshTicket && event.ticket !== saveReadTicket) return
        const failedSaveRead = event.ticket === saveReadTicket
        if (failedSaveRead) { saveReadTicket = null; recordSaveFailure(event.issue.message) }
        if (data.authority.read.kind === 'loading' && data.authority.read.ticket === event.ticket)
          acceptData(backend.event(data, { kind: 'read-failed', ticket: event.ticket, issue: event.issue }))
        else publish({ persistence: persistenceView() })
        if (event.ticket === refreshTicket) {
          refreshTicket = null
          pendingEffects.push({ type: 'persistence/complete', kind: 'refresh', ticket: event.ticket,
            result: { status: 'failed', issue: event.issue } })
        }
        if (failedSaveRead) completeSave()
        return
      }
      case 'operation/result': {
        const result = event.result, submission = event.effect.submission
        if (!('submission' in data.persistence) || data.persistence.submission.operationId !== submission.operationId) return
        const ref = { scope: submission.scope, operationId: submission.operationId, payloadHash: submission.payloadHash }
        const unusableResult = () => {
          const issue = { code: 'invalid-operation-result', message: 'The source confirmation does not match the original save. Confirm its outcome before saving again.' }
          recordSaveFailure(issue.message)
          if (data.persistence.kind === 'sending') acceptData(backend.event(data, { kind: 'mutation-uncertain', ref,
            attempt: data.persistence.attempt, issue,
          }))
          completeSave()
        }
        // Scope subscription owns both the fence and its explicit resolution.
        if (result.kind === 'disputed') return
        if (submissionDispute(data)) return
        if (result.kind === 'applied') {
          saveFeedback = null
          const accepted = acceptData(backend.receipt(data, result.receipt))
          if (!accepted.accepted || data.persistence.kind === 'sending' || data.persistence.kind === 'outcome-unknown'
            || data.persistence.kind === 'committed-awaiting-receipt') unusableResult()
        }
        else if (result.kind === 'not-applied') {
          recordSaveFailure(result.proof.reason.message, true)
          const accepted = acceptData(backend.event(data, { kind: 'not-applied', proof: result.proof, verifiedByScope: true }))
          if (accepted.accepted && backend.project(data).persistence.kind === 'idle') persistence.refresh(allocate())
          else if (!submissionDispute(data)) unusableResult()
        } else if (result.kind === 'applied-without-receipt') {
          const accepted = acceptData(backend.event(data, { kind: 'applied-without-receipt', ref, commitToken: result.commitToken }), event.effect.kind !== 'lookup')
          if (!accepted.accepted || data.persistence.kind === 'sending' || data.persistence.kind === 'outcome-unknown') unusableResult()
          else if (event.effect.kind === 'lookup') completeSave()
        } else {
          const issue = result.kind === 'unknown' ? result.issue : { code: 'pending', message: 'The save is still pending. Retry confirmation.' }
          if (event.effect.kind === 'lookup' && result.kind === 'unknown' && saveAttempt?.retryAfterLookup
            && data.persistence.kind === 'outcome-unknown' && !submissionDispute(data)) {
            // The source promises fenced operation identities. Query first;
            // only then retry the same frozen bytes, at most once per call.
            saveAttempt = Object.freeze({ ...saveAttempt, retryAfterLookup: false })
            acceptData(backend.event(data, { kind: 'retry-persistence' }))
          } else {
            recordSaveFailure(issue.message)
            acceptData(backend.event(data, { kind: 'mutation-uncertain', ref,
              attempt: event.effect.kind === 'submit' ? event.effect.attempt : 'attempt' in data.persistence ? data.persistence.attempt : 1, issue,
            }))
            completeSave()
          }
        }
        if (data.persistence.kind === 'receipt-blocked' || submissionDispute(data)) completeSave()
      }
    }
  }
  const persistence = {
    refresh: (ticket: string, required: AuthorityFrontier = data.authorityFrontier) => {
      if (refreshTicket) pendingEffects.push({ type: 'persistence/complete', kind: 'refresh', ticket: refreshTicket, result: { status: 'superseded' } })
      refreshTicket = ticket
      const result = acceptData(backend.event(data, { kind: 'read-started', ticket, required }))
      emitPersistence({ type: 'read', state: data, ticket }); return result
    },
    save: (ticket: string, target?: GridSaveTarget<RowKey>) => requestSave(undefined, ticket, target),
    recover: (recovery: GridSaveRecovery, ticket: string): GridCommandResult => {
      const p = data.persistence, action = selectGridActions(snapshot).recoverSave
      if ('submission' in p && p.submission.operationId !== recovery.operationId) return no('stale-target', 'The requested save is no longer the current recovery target.')
      if (action.issue) return rejectIssue(action.issue)
      if (!('submission' in p) || !action.target || action.target.action !== recovery.action) return no('invalid-input', 'Use the current save recovery action.')
      saveAttempt = Object.freeze({ ticket, operationId: p.submission.operationId, excluded: saveAttempt?.excluded ?? Object.freeze([]),
        scheduleToken: saveAttempt?.scheduleToken ?? data.schedule.token,
        ...(p.kind === 'receipt-blocked' ? { reviewedReceipt: p.receipt } : {}),
        retryAfterLookup: p.kind === 'outcome-unknown' })
      if (recovery.action === 'review') {
        completeSave()
        return ok()
      }
      saveFeedback = null
      if (recovery.action === 'refresh') {
        saveReadTicket = allocate()
        emitPersistence({ type: 'read', state: data, ticket: saveReadTicket })
      } else emitPersistence({ type: 'kernel', effect: { kind: 'lookup', submission: p.submission } })
      publish({ persistence: persistenceView() }); return ok()
    },
    setMode: (mode: GridControllerSnapshot<Row, RowKey>['persistence']['mode']) => acceptData(backend.event(data, {
      kind: 'save-schedule-configured', expectedToken: data.schedule.token,
      options: { mode: mode === 'manual-save' ? 'manual' : mode === 'immediate' ? 'immediate' : 'debounced',
        debounceMs: mode === 'auto-save' ? options.dataSource.persistence.debounceMs ?? 250 : 0 },
    })),
  }

  const runCellAction = (target: GridPoint<RowKey>, id: string) => {
    const blocked = draftCommandIssue(
      externalCommandOwner,
      'running a cell action',
    )
    if (blocked) return blocked
    const resolved = cell(target),
      action = resolved?.column.behavior.actions?.find((item) => item.id === id)
    if (!resolved || !action) return no('stale-target', 'The action is unavailable.')
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
    if (!availability.ok) return no('adapter-error', availability.message)
    if (
      (action.requiresEditable && !editable) ||
      availability.value.hidden ||
      availability.value.disabled
    )
      return no('permission-denied', 'The action is disabled.')
    const labelDefinition = action.label
    const label =
      typeof labelDefinition === 'function'
        ? invokeGridCallback(() => labelDefinition(ctx))
        : { ok: true as const, value: labelDefinition }
    if (!label.ok) return no('adapter-error', label.message)
    const result = safely(() => action.run(ctx))
    if (!result.ok) return rejectIssue(gridValueIssue(result.issue))
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
      return no('permission-denied', 'The cell effect is unavailable.')
    const targetGuard = targets().capture(target.rowKey)
    const scopeKey = `${targetGuard.entityId}:${target.columnKey}`
    const key = `${scopeKey}\u0001${effect.id}\u0001${++sequence}`
    const active = effectCoordinator.startCell(key, scopeKey, {
      targets: [{ ...targetGuard, columnKey: target.columnKey, access: 'write' }],
      ...(snapshot.edit && samePoint(snapshot.edit.cell, target)
        ? { edit: editRevision, sessionId: snapshot.edit.id }
        : {}),
    })
    pendingEffects.push({
      type: 'cell/run',
      operation: { key, active, target: point(target), definition: effect, input: structuredClone(input), context: context(model.codec.copy(resolved.row), resolved.column) },
    })
    return ok({ effectId: key })
  }
  const cancelCellEffect = (effectId: string) => {
    if (!effectCoordinator.cancelCell(effectId))
      return no('stale-target', 'The cell effect is not running.')
    return ok()
  }
  const externalEffect = (requested: GridEffectRequest<RowKey, Effect>) => {
    const port = environment.getEffectPort()
    if (!port) return no('invalid-configuration', 'No effect port is configured.')
    const request = structuredClone(requested)
    const { owner } = request
    const session = owner.kind === 'edit' ? snapshot.edit : null
    if (owner.kind === 'edit' && !session) return no('stale-target', 'An edit-owned task requires its active editor.')
    if (session) captureEditTarget(session)
    const write = owner.kind === 'cells' ? owner.write : owner.kind === 'cell' ? [owner.cell] : session ? [session.cell] : []
    const read = owner.kind === 'cells' ? owner.read ?? [] : []
    if (owner.kind === 'cells' && (!Array.isArray(write) || !Array.isArray(read) || !write.length && !read.length))
      return no('invalid-input', 'Declare at least one read or write target for a cell batch.')
    if (write.length) {
      const blocked = draftCommandIssue(session ? { kind: 'cell-effect', cell: session.cell, editRevision } : externalCommandOwner, 'starting a host task')
      if (blocked) return blocked
    }
    const limit = mutationLimitIssue(read.length + write.length)
    if (limit) return no('limit-exceeded', limit)
    const seen = new Set<string>()
    const inputs: GridEffectInput<Row, RowKey>[] = []
    const capture = (target: GridPoint<RowKey>, access: 'write' | 'read') => {
      const address = cellKey(target)
      if (seen.has(address)) throw new GridIssueError({ code: 'invalid-input', message: 'Declare each task cell exactly once.' })
      seen.add(address)
      const rowTarget = targets().capture(target.rowKey)
      const column = columnByKey.get(target.columnKey)
      const row = model.codec.copy(targets().live(rowTarget.entityId)!.row)
      if (!column) throw new GridIssueError({ code: 'stale-target', message: 'A task column is unavailable.' })
      if (access === 'write' && !column.isEditable(row))
        throw new GridIssueError({ code: 'permission-denied', message: 'A task target is read-only.' })
      const value = resolveGridCellValue(row, column)
      if (!value.valid) throw new GridIssueError({ code: 'invalid-input', message: 'A task cell value cannot be read.' })
      inputs.push({ cell: point(target), entityId: rowTarget.entityId, row, value: value.value, access })
      return { ...rowTarget, access, columnKey: target.columnKey }
    }
    const captured = [...write.map(target => capture(target, 'write')), ...read.map(target => capture(target, 'read'))]
    const id = request.id ?? `effect-${++sequence}`
    const active = effectCoordinator.startExternal(id, { generation: allocate(), targets: captured,
      ...(owner.kind === 'source' ? { source: snapshot.source.revision } : {}),
      ...(owner.kind === 'persistence' ? { persistence: snapshot.persistence.revision } : {}),
      ...(session ? { sessionId: session.id, edit: editRevision } : {}),
    }, request.concurrency === 'replace')
    if (!active) return no('busy', 'The effect id is already running.')
    pendingEffects.push({ type: 'external/run', operation: { id, active, request }, port, cells: inputs })
    return ok({ effectId: id })
  }

  function effectFeedback(id: string, reason: string) {
    dispatchUnchecked({
      type: 'feedback/push',
      item: { id: `effect:${id}`, kind: 'error', message: reason, persistent: true },
    })
  }

  function publishEffectResults() {
    publish({ pendingEffects: Object.freeze(retainedEffects.map(event => ({
      id: event.type === 'cell/completed' ? event.operation.key : `${event.operation.id}:${event.operation.active.generation}`,
      cell: event.type === 'cell/completed' ? event.operation.target : null,
      message: event.type === 'cell/completed' && !event.result.ok ? event.result.issue.message
        : event.type === 'external/failed' ? message(event.error) : 'A task result is retained for review.',
    }))) })
  }
  function retainEffect(event: GridControllerEffectEvent<Row, RowKey, Effect>, reason: string) {
    const id = event.type === 'cell/completed' ? event.operation.key : `${event.operation.id}:${event.operation.active.generation}`
    retainedEffects = Object.freeze([...retainedEffects.filter(previous =>
      effectResultId(previous) !== id), event])
    publishEffectResults(); effectFeedback(id, reason)
  }
  function discardEffectResult(id: string) {
    if (!retainedEffects.some(event => effectResultId(event) === id)) return false
    retainedEffects = retainedEffects.filter(event => effectResultId(event) !== id)
    publishEffectResults()
    dispatchUnchecked({ type: 'feedback/dismiss', id: `effect:${id}` })
    return true
  }
  function reapplyEffect(id: string, explicitTarget?: GridPoint<RowKey>) {
    const event = retainedEffects.find(event => effectResultId(event) === id)
    if (!event) return no('stale-target', 'The retained result is unavailable.')
    if (event.type !== 'cell/completed') return no('invalid-input', 'This result requires recovery through its host effect port.')
    const { active } = event.operation
    if (!explicitTarget && !effectContextCurrent(active)) return no('stale-target', 'The task inputs changed. Review and choose an explicit target.')
    const entity = targets().live(active.targets[0]!.entityId)
    const target = explicitTarget ?? (entity ? { rowKey: entity.rowKey, columnKey: event.operation.target.columnKey } : null)
    if (!target) return no('stale-target', 'The original target changed. Review and choose an explicit target.')
    targets().capture(target.rowKey)
    if (snapshot.edit && snapshot.edit.id !== event.operation.active.sessionId)
      return no('session-open', 'Commit or cancel the current edit before applying the retained result.')
    const owner = { kind: 'cell-effect' as const, cell: target,
      editRevision: snapshot.edit && samePoint(snapshot.edit.cell, target) ? editRevision : null }
    const result = event.result.ok ? mutate([{ cell: target, value: event.result.value }], 'Apply retained result', owner)
      : runCellEffect(target, event.operation.definition.id, event.operation.input)
    if (result.accepted) {
      discardEffectResult(id)
      if (event.result.ok && snapshot.edit && samePoint(snapshot.edit.cell, target)) { editRevision++; publish({ edit: null }) }
    }
    return result
  }
  function handleEffectEvent(event: GridControllerEffectEvent<Row, RowKey, Effect>) {
    if (event.type === 'cell/completed') {
      const { key, active, definition } = event.operation
      const current = effectCoordinator.isCellCurrent(key, active)
      effectCoordinator.finishCell(key, active)
      if (!current || !event.result.ok) {
        retainEffect(event, event.result.ok ? 'The target or input changed. The task result is retained; review it before applying.' : event.result.issue.message)
        return
      }
      const entity = targets().unchanged(active.targets[0]!)
      if (!entity) { retainEffect(event, 'The target was removed. The result is retained.'); return }
      const target = { rowKey: entity.rowKey, columnKey: event.operation.target.columnKey }
      const committed = mutate([{ cell: target, value: event.result.value }], definition.id, {
        kind: 'cell-effect', cell: target, editRevision: active.edit ?? null,
      })
      if (!committed.accepted) { retainEffect(event, committed.issue.message); return }
      if (active.edit !== undefined && snapshot.edit && active.sessionId === snapshot.edit.id) {
        editRevision++; publish({ edit: null })
      }
      return
    }
    const { id, active } = event.operation
    const current = effectCoordinator.isExternalCurrent(id, active)
    effectCoordinator.finishExternal(id, active)
    if (!current || event.type === 'external/failed') {
      retainEffect(event, event.type === 'external/failed' ? message(event.error) : 'The external result no longer belongs to the current context.'); return
    }
    if (event.result === undefined) return
    const failure = applyExternalResult(event)
    if (failure) retainEffect(event, failure.message)
  }
  function effectResultId(event: GridControllerEffectEvent<Row, RowKey, unknown>) {
    return event.type === 'cell/completed' ? event.operation.key : `${event.operation.id}:${event.operation.active.generation}`
  }
  function applyExternalResult(event: Extract<GridControllerEffectEvent<Row, RowKey, unknown>, { type: 'external/completed' }>): GridIssue | null {
    const { active } = event.operation
    if (!effectContextCurrent(active)) return { code: 'stale-target', message: 'The host result no longer matches its authorized cells or session.' }
    if (event.result === undefined) return null
    const values = event.result.kind === 'value' ? [event.result.value] : event.result.values
    const destinations = active.targets.filter(target => target.access === 'write')
    const mutations = destinations.map(({ entityId, columnKey }, index) => ({
      cell: { rowKey: targets().live(entityId)!.rowKey, columnKey }, value: values[index],
    }))
    const owner = active.sessionId ? { kind: 'cell-effect' as const, cell: mutations[0]!.cell, editRevision: active.edit! } : externalCommandOwner
    const result = mutate(mutations, 'Apply host task values', owner)
    if (!result.accepted) return result.issue
    if (active.sessionId) { editRevision++; publish({ edit: null }) }
    return null
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
  const context = (row: Row, column: GridCompiledColumn<Row>) =>
    Object.freeze({
      row,
      columnKey: column.key,
      typeOptions: column.typeOptions,
    })
  function prepareInput<Result>(
    base: Snapshot,
    internal: InternalState,
    operation: () => Result,
  ): GridTransition<Snapshot, EffectCommand, Result, InternalState> {
    snapshot = base
    inputRevision = base.revision
    editRevision = internal.editRevision
    sequence = internal.sequence
    data = internal.data
    saveFeedback = internal.saveFeedback
    saveAttempt = internal.saveAttempt
    saveReadTicket = internal.saveReadTicket
    refreshTicket = internal.refreshTicket
    retainedEffects = internal.retainedEffects
    effectCoordinator.restoreState(internal.effects)
    if (indexedRows !== base.draft.rows) {
      rowIndex = createGridRowIndex(base.draft.rows, options.dataSource.getRowKey)
      indexedRows = base.draft.rows
    }
    pendingEffects = []
    preparing = true
    try {
      const result = operation()
      settleSave()
      effectCoordinator.revokeStale()
      const owners = effectCoordinator.captureState()
      const activeEffectCount = owners.pending.size
      if (snapshot.activeEffectCount !== activeEffectCount) publish({ activeEffectCount })
      const previous = runnableSaveSchedule(internal.data), next = runnableSaveSchedule(data)
      const previousToken = previous && selectGridActions(base).save.enabled ? previous.token : null
      const nextToken = next && selectGridActions(snapshot).save.enabled ? next.token : null
      if (previousToken !== nextToken) {
        if (next && nextToken !== null) emitPersistence({ type: 'schedule', token: nextToken, delay: next.debounceMs })
        else emitPersistence({ type: 'cancel-schedule' })
      }
      return {
        state: snapshot,
        internalState: Object.freeze({
          data, saveFeedback, saveAttempt, saveReadTicket, refreshTicket, retainedEffects,
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
      data = internal.data
      saveFeedback = internal.saveFeedback
      saveAttempt = internal.saveAttempt
      saveReadTicket = internal.saveReadTicket
      refreshTicket = internal.refreshTicket
      retainedEffects = internal.retainedEffects
      effectCoordinator.restoreState(internal.effects)
    }
  }

  const prepareEvent = (base: Snapshot, internal: InternalState, event: Event) => prepareInput(base, internal, () => {
      if (event.type === 'effect/event') handleEffectEvent(event.event)
      else if (event.type === 'source/dispute') {
        const report = event.event
        if (report.kind === 'disputed') {
          acceptData(backend.event(data, { kind: 'operation-disputed', ref: report.ref, disputeId: report.id, issue: report.issue }))
          if ('submission' in data.persistence && data.persistence.submission.operationId === report.ref.operationId) completeSave()
        } else {
          if ('submission' in data.persistence && data.persistence.submission.operationId === report.ref.operationId) {
            if (report.result.kind === 'not-applied') recordSaveFailure(report.result.proof.reason.message, true)
            else saveFeedback = null
          }
          acceptData(backend.event(data, { kind: 'operation-dispute-resolved', ref: report.ref, disputeId: report.id, result: report.result }))
        }
      }
      else if (event.type === 'source/required') {
        if (event.origin === data.workspace.id && 'submission' in data.persistence) return
        const read = data.authority.read
        if (read.kind !== 'loading' || !event.frontier.every(v => read.required.some(head => authorityCovers(head, v))))
          persistence.refresh(allocate(), event.frontier)
      }
      else if (event.type === 'source/published') applyRemote(event.remote)
      else if (event.type === 'persistence/event') handlePersistence(event.event)
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
          retainEffect(completed, message(error))
        } else {
          const { id, active } = completed.operation
          effectCoordinator.finishExternal(id, active)
          retainEffect(completed, message(error))
        }
      } else {
        if (event.type === 'persistence/event') {
          const failed = event.event
          if ('ticket' in failed && failed.ticket === refreshTicket) {
            refreshTicket = null
            pendingEffects.push({ type: 'persistence/complete', kind: 'refresh', ticket: failed.ticket,
              result: { status: 'failed', issue: gridExceptionIssue(error) } })
          }
          if ('ticket' in failed && data.persistence.kind === 'waiting-for-gateway' && failed.ticket === data.persistence.ticket)
            failSaveWait(failed.ticket, gridExceptionIssue(error))
          else if (failed.type === 'operation/result' || ('ticket' in failed && failed.ticket === saveReadTicket)) {
            recordSaveFailure(message(error))
            completeSave()
          }
        }
        publish({ source: Object.freeze({
          ...base.source, revision: base.source.revision + 1, status: 'error', error: message(error),
        }), persistence: persistenceView() })
      }
    })

  return Object.freeze({
    prepareIntent: (base: Snapshot, internal: InternalState, intent: GridIntent<RowKey, Effect>) =>
      prepareInput(base, internal, () => isGridBusinessIntent(intent) ? dispatchUnchecked(intent)
        : no('invalid-input', 'Use a business command, an interaction port, or the dedicated persistence methods.')),
    prepareInteraction: (base: Snapshot, internal: InternalState, input: GridInteractionInput<RowKey>) =>
      prepareInput(base, internal, () => isGridInteractionInput(input) ? dispatchUnchecked(input)
        : no('invalid-input', 'An interaction port accepts only view and input events.')),
    preparePersistence: (base: Snapshot, internal: InternalState, ticket: string, operation:
      Readonly<{ kind: 'save'; target?: GridSaveTarget<RowKey> }> | Readonly<{ kind: 'refresh' }> | Readonly<{ kind: 'recover'; recovery: GridSaveRecovery }>) =>
      prepareInput(base, internal, () => operation.kind === 'save' ? persistence.save(ticket, operation.target)
        : operation.kind === 'refresh' ? persistence.refresh(ticket) : persistence.recover(operation.recovery, ticket)),
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
