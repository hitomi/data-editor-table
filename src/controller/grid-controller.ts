import { gridTargetIssue } from './grid-selectors.js'
import { gridCommandAddressesTarget, registerGridInteractionPort, type GridInteractionPort, type GridInteractionInput, type GridInteractionValue } from './controller-interaction.js'
import { gridCloseBlockers, type GridCloseBlocker, type GridCloseResult, type GridCloseState } from './controller-lifecycle.js'
import type { GridIssue } from '../model/grid-result.js'
import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import type { GridControllerSnapshot, GridRowKey, GridSaveTarget } from '../model/grid-model.js'
import type { GridController, GridControllerOptions, GridCommandResult, GridCommandTarget, GridIntent, GridIntentValue, GridTransactionIssue } from './controller-contracts.js'
import { GridControllerRuntime } from './controller-runtime.js'
import { createGridControllerWorkflow } from './controller-workflow.js'
import { createInitialGridSnapshot, createInitialGridKernelData, validateControllerOptions } from './controller-state.js'
import { GridControllerEffectRunner } from './controller-effects.js'
import { GridKernelPersistenceRunner } from './kernel-persistence-effects.js'
import { kernelId } from '../kernel/model.js'
import { type GridControllerEvent, type GridControllerEffect, type GridControllerInternalState } from './controller-protocol.js'
import { createGridTransactionIssue } from './transaction-builder.js'
import { GridConfigurationError, GridIssueError, gridExceptionIssue } from '../model/grid-result.js'
import type { GridSaveResult, GridRefreshResult, GridSaveRecovery, GridPersistenceCompletion } from './controller-persistence.js'

export type * from './controller-contracts.js'

/** Public composition root: one Runtime, one workflow, and owned I/O resources. */
export function createGridController<
  Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect = never,
>(
  options: GridControllerOptions<Row, RowKey, Schema, Effect>,
): GridController<Row, RowKey, Schema, Effect> {
  validateControllerOptions(options)
  const columns = (() => {
    try {
      return compileGridColumns(options.dataSource.columns, options.cellBehaviors)
    } catch (error) {
      throw new GridConfigurationError(message(error), { cause: error })
    }
  })()
  const sizes = {
    rowHeight: options.rowHeight ?? 36,
    headerHeight: options.headerHeight ?? 36,
    rowIndicatorWidth: options.rowIndicatorWidth ?? 48,
  }
  const allocate = () => crypto.randomUUID()
  const kernel = createInitialGridKernelData(options.dataSource, columns, kernelId<'workspace'>(allocate()), allocate)
  const initial = createInitialGridSnapshot(options.dataSource, columns, sizes, kernel)
  let effects = options.effects
  type Snapshot = GridControllerSnapshot<Row, RowKey>
  type Event = GridControllerEvent<Row, RowKey, Effect>
  type EffectCommand = GridControllerEffect<Row, RowKey, Effect>
  type Internal = GridControllerInternalState<Row, RowKey>
  // Promise continuations only: no semantic save state or task queue. Facts
  // and ticket association are committed together by the existing Runtime.
  const completions = new Map<string,
    { kind: 'save'; resolve: (result: GridSaveResult) => void }
    | { kind: 'refresh'; resolve: (result: GridRefreshResult) => void }>()
  const complete = (effect: GridPersistenceCompletion) => {
    const continuation = completions.get(effect.ticket)
    completions.delete(effect.ticket)
    if (continuation?.kind === 'save' && effect.kind === 'save') continuation.resolve({ ...effect.result, remaining: Object.freeze(remainingWork()) })
    else if (continuation?.kind === 'refresh' && effect.kind === 'refresh') continuation.resolve(effect.result)
  }
  const runtime: GridControllerRuntime<Snapshot, Event, EffectCommand, Internal> = new GridControllerRuntime({
    initialState: initial,
    initialInternalState: kernel.internal,
    handleEvent: (base, event) => workflow.prepareEvent(base, runtime.getInternalState(), event),
    eventFailed: (base, event, error) => workflow.prepareEventFailure(base, runtime.getInternalState(), event, error),
    runEffect: (effect) => {
      switch (effect.type) {
        case 'effect/cancel': effectRunner.cancel(effect.active); break
        case 'persistence/run': persistenceRunner.run(effect.effect); break
        case 'persistence/complete': complete(effect); break
        case 'cell/run': effectRunner.runCell(effect.operation); break
        case 'external/run': effectRunner.runExternal(effect.operation, effect.port, effect.cells); break
      }
    },
    effectFailed: (effect, error) => {
      if (effect.type === 'persistence/run') {
        const operation = effect.effect
        const failure = message(error)
        if (operation.type === 'kernel') return { type: 'persistence/event', event: {
          type: 'operation/result', effect: operation.effect, result: { kind: 'unknown', issue: { code: 'source-unavailable', message: failure } },
        } }
        if (operation.type === 'acquire' || operation.type === 'hash' || operation.type === 'read') return { type: 'persistence/event', event: {
          type: operation.type === 'acquire' ? 'gateway/failed' : operation.type === 'hash' ? 'hash/failed' : 'read/failed', ticket: operation.ticket, issue: gridExceptionIssue(error),
        } }
      }
      return { type: 'source/failed', error: message(error) }
    },
  })
  const workflow = createGridControllerWorkflow(options, {
    initialSnapshot: initial, kernel, allocate, getEffectPort: () => effects, isDestroyed: () => runtime.destroyed,
  })
  const effectRunner = new GridControllerEffectRunner<Row, RowKey, Effect>(
    (event) => runtime.send({ type: 'effect/event', event }), kernel.model,
  )
  const persistenceRunner = new GridKernelPersistenceRunner(options.dataSource.source,
    event => runtime.send({ type: 'persistence/event', event }), options.dataSource)
  const getSnapshot = runtime.getSnapshot
  const subscribe = runtime.subscribe
  const subscribeSelector: GridController<Row, RowKey, Schema, Effect>['subscribeSelector'] =
    (selector, listener, equal = Object.is) => {
      let selected = selector(getSnapshot())
      return subscribe(() => {
        const next = selector(getSnapshot())
        if (!equal(selected, next)) {
          selected = next
          listener()
        }
      })
    }
  const assertTarget = (snapshot: Snapshot, command: GridIntent<RowKey, Effect> | GridInteractionInput<RowKey>, target?: GridCommandTarget<RowKey>) => {
    const issue = gridTargetIssue(snapshot, target)
    if (issue) throw new GridIssueError(issue)
    if (target && !gridCommandAddressesTarget(command, target, snapshot.edit)) {
      throw new GridIssueError({ code: 'stale-target', message: 'This command cannot act on its captured target.' })
    }
  }
  const dispatch = <Intent extends GridIntent<RowKey, Effect>>(intent: Intent, target?: GridCommandTarget<RowKey>): GridCommandResult<GridIntentValue<RowKey, Effect, Intent>> => {
    const result = runtime.execute(
      base => { assertTarget(base, intent, target); return workflow.prepareIntent(base, runtime.getInternalState(), intent) },
      (issue, revision): GridCommandResult => ({ accepted: false, revision, issue: issue.code === 'exception'
        ? gridExceptionIssue(issue.error)
        : { code: issue.code === 'destroyed' ? 'closed' : 'busy', message: issue.message },
      }),
    )
    // Workflow's exhaustive command switch defines the value for each intent.
    // Generic callers retain that correlation across the Runtime publication.
    return result as GridCommandResult<GridIntentValue<RowKey, Effect, Intent>>
  }
  const interaction: GridInteractionPort<RowKey> = Object.freeze({
    send: <Input extends GridInteractionInput<RowKey>>(input: Input, target?: GridCommandTarget<RowKey>): GridCommandResult<GridInteractionValue<Input>> => runtime.execute(
      base => { assertTarget(base, input, target); return workflow.prepareInteraction(base, runtime.getInternalState(), input) },
      (issue, revision): GridCommandResult => ({ accepted: false, revision, issue: issue.code === 'exception'
        ? gridExceptionIssue(issue.error)
        : { code: issue.code === 'destroyed' ? 'closed' : 'busy', message: issue.message } }),
    ) as GridCommandResult<GridInteractionValue<Input>>,
  })
  const applyTransaction: GridController<Row, RowKey, Schema, Effect>['applyTransaction'] =
    (build, transactionOptions) => runtime.execute(
      (base) => workflow.prepareTransaction(base, runtime.getInternalState(), build, transactionOptions),
      (issue, revision) => ({
        accepted: false as const, revision, result: null,
        issues: Object.freeze([issue.code === 'exception' ? gridExceptionIssue(issue.error) as GridTransactionIssue<RowKey>
          : createGridTransactionIssue<RowKey>(issue.code === 'busy' ? 'transaction-active' : issue.code, issue.message),
        ]) as readonly [GridTransactionIssue<RowKey>],
      }),
    )
  const updateEffects: GridController<Row, RowKey, Schema, Effect>['updateEffects'] = port => {
    const revision = getSnapshot().revision
    if (runtime.destroyed) return { accepted: false, revision, issue: { code: 'closed', message: 'This controller is closed.' } }
    if (runtime.busy) return { accepted: false, revision, issue: { code: 'busy', message: 'Finish the current command before updating the effect port.' } }
    effects = port
    return { accepted: true, revision, value: undefined }
  }
  let unsubscribe: (() => void) | null = null
  let unsubscribeDisputes: (() => void) | null = null
  let closing = false
  let closedResult: Exclude<GridCloseResult, { status: 'blocked' }> | null = null
  const dispose = (): Exclude<GridCloseResult, { status: 'blocked' }> => {
    runtime.destroy()
    const issue: GridIssue = { code: 'closed', message: 'This controller is closed.' }
    for (const continuation of completions.values()) {
      if (continuation.kind === 'save') continuation.resolve({ status: 'blocked', issue, remaining: Object.freeze(remainingWork()) })
      else continuation.resolve({ status: 'blocked', issue })
    }
    completions.clear()
    const releaseDisputes = unsubscribeDisputes
    unsubscribeDisputes = null
    const release = unsubscribe
    unsubscribe = null
    const issues: GridIssue[] = []
    // All resources get a cleanup attempt even when an adapter throws. Clear
    // references before calling host code so reentry cannot release twice.
    const cleanups = [
      ['scope-disputes', () => releaseDisputes?.()],
      ['source-subscription', () => release?.()],
      ['persistence-runner', () => persistenceRunner.destroy()],
      ['effect-runner', () => effectRunner.destroy()],
    ] as const
    for (const [domainCode, cleanup] of cleanups) {
      try { cleanup() } catch (error) {
        issues.push(Object.freeze({ code: 'adapter-error', domainCode, message: `Could not release ${domainCode}: ${message(error)}` }))
      }
    }
    return issues.length
      ? Object.freeze({ status: 'cleanup-failed', closed: true, issues: Object.freeze(issues as [GridIssue, ...GridIssue[]]) })
      : Object.freeze({ status: 'closed' })
  }
  // Read after the releasing effect has run. Completion and closing use the
  // same published work and physical gateway reservation.
  function remainingWork() {
    const data = runtime.getInternalState().data
    const reserved = data.persistence.kind !== 'idle'
      || persistenceRunner.gateway.workspaceReservation(data.workspace.scope, data.workspace.id) !== null
    return gridCloseBlockers(getSnapshot(), reserved)
  }
  const getCloseState = (): GridCloseState => {
    if (closing) return Object.freeze({ status: 'blocked', blockers: Object.freeze(['command-running'] as const) })
    if (runtime.destroyed) return Object.freeze({ status: 'closed', blockers: Object.freeze([] as const) })
    const blockers: GridCloseBlocker[] = remainingWork()
    if (runtime.busy) blockers.unshift('command-running')
    return blockers.length
      ? Object.freeze({ status: 'blocked', blockers: Object.freeze(blockers as [GridCloseBlocker, ...GridCloseBlocker[]]) })
      : Object.freeze({ status: 'ready', blockers: Object.freeze([] as const) })
  }
  const destroy = (): GridCloseResult => {
    if (closedResult) return closedResult
    const close = getCloseState()
    if (close.status === 'blocked') return close
    closing = true
    try {
      closedResult = dispose()
      return closedResult
    } finally { closing = false }
  }
  const runPersistence = (ticket: string, operation: Parameters<typeof workflow.preparePersistence>[3]) => {
    // A subscriber can synchronously invoke another table before that table's
    // own notification. Admit the shared fence before any implicit edit commit.
    if (operation.kind !== 'refresh') {
      const dispute = persistenceRunner.gateway.getDispute(options.dataSource.scope)
      if (dispute && getSnapshot().persistence.dispute?.id !== dispute.id)
        runtime.send({ type: 'source/dispute', event: dispute })
    }
    const result = runtime.execute(
      base => workflow.preparePersistence(base, runtime.getInternalState(), ticket, operation),
      (issue, revision): GridCommandResult => ({ accepted: false, revision, issue: issue.code === 'exception' ? gridExceptionIssue(issue.error)
        : { code: issue.code === 'destroyed' ? 'closed' : 'busy', message: issue.message } }),
    )
    if (!result.accepted) {
      if (operation.kind === 'refresh') complete({ type: 'persistence/complete', kind: 'refresh', ticket, result: { status: 'blocked', issue: result.issue } })
      else complete({ type: 'persistence/complete', kind: 'save', ticket,
        result: { status: 'blocked', issue: result.issue } })
    }
  }
  const save = (target?: GridSaveTarget<RowKey>) => new Promise<GridSaveResult>(resolve => {
    const ticket = allocate()
    completions.set(ticket, { kind: 'save', resolve })
    runPersistence(ticket, { kind: 'save', ...(target ? { target } : {}) })
  })
  const recoverSave = (recovery: GridSaveRecovery) => new Promise<GridSaveResult>(resolve => {
    const ticket = allocate()
    completions.set(ticket, { kind: 'save', resolve })
    runPersistence(ticket, { kind: 'recover', recovery })
  })
  const refresh = () => new Promise<GridRefreshResult>(resolve => {
    const ticket = allocate()
    completions.set(ticket, { kind: 'refresh', resolve })
    runPersistence(ticket, { kind: 'refresh' })
  })
  try {
    unsubscribeDisputes = persistenceRunner.gateway.subscribeDisputes(options.dataSource.scope, event => runtime.send({ type: 'source/dispute', event }))
    unsubscribe = options.dataSource.subscribe(event => {
      if (event.kind === 'snapshot') runtime.send({ type: 'source/published', remote: event.snapshot })
      else runtime.send({ type: 'source/required', frontier: event.frontier, ...(event.origin ? { origin: event.origin } : {}) })
    })
    if (runtime.getInternalState().data.authority.read.kind !== 'loading') void refresh()
  } catch (error) {
    dispose()
    throw error
  }
  const controller = Object.freeze({ getSnapshot, subscribe, subscribeSelector, dispatch, applyTransaction, updateEffects, getCloseState, destroy, save, recoverSave, refresh,
    undo: () => dispatch({ type: 'history/undo' }), redo: () => dispatch({ type: 'history/redo' }),
  })
  registerGridInteractionPort(controller, interaction)
  return controller
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
