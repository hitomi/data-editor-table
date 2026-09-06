import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import type { GridControllerSnapshot, GridRowKey } from '../model/grid-model.js'
import type { GridController, GridControllerOptions, GridDispatchResult, GridIntent, GridTransactionIssue } from './controller-contracts.js'
import { GridControllerRuntime } from './controller-runtime.js'
import { createGridControllerWorkflow } from './controller-workflow.js'
import { createInitialGridSnapshot, validateControllerOptions } from './controller-state.js'
import { GridControllerEffectRunner } from './controller-effects.js'
import { GridPersistenceEffectRunner } from './persistence-effects.js'
import { initialGridControllerInternal, type GridControllerEvent, type GridControllerEffect, type GridControllerInternalState } from './controller-protocol.js'
import { createGridTransactionIssue } from './transaction-builder.js'

export type * from './controller-contracts.js'

/** Public composition root: one Runtime, one workflow, and owned I/O resources. */
export function createGridController<
  Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect = never,
>(
  options: GridControllerOptions<Row, RowKey, Schema, Effect>,
): GridController<Row, RowKey, Schema, Effect> {
  validateControllerOptions(options)
  const columns = compileGridColumns(options.dataSource.columns, options.cellBehaviors)
  const sizes = {
    rowHeight: options.rowHeight ?? 36,
    headerHeight: options.headerHeight ?? 36,
    rowIndicatorWidth: options.rowIndicatorWidth ?? 48,
  }
  const initial = createInitialGridSnapshot(options.dataSource, columns, sizes)
  type Snapshot = GridControllerSnapshot<Row, RowKey>
  type Event = GridControllerEvent<Row, RowKey, Effect>
  type EffectCommand = GridControllerEffect<Row, RowKey, Effect>
  type Internal = GridControllerInternalState<Row, RowKey>
  const runtime: GridControllerRuntime<Snapshot, Event, EffectCommand, Internal> = new GridControllerRuntime({
    initialState: initial,
    initialInternalState: initialGridControllerInternal<Row, RowKey>(),
    handleEvent: (base, event) => workflow.prepareEvent(base, runtime.getInternalState(), event),
    eventFailed: (base, event, error) => workflow.prepareEventFailure(base, runtime.getInternalState(), event, error),
    runEffect: (effect) => {
      switch (effect.type) {
        case 'effect/cancel': effectRunner.cancel(effect.active); break
        case 'persistence/run': persistenceRunner.run(effect.effect); break
        case 'cell/run': effectRunner.runCell(effect.operation); break
        case 'external/run': effectRunner.runExternal(effect.operation, options.effects!, runtime.getSnapshot); break
      }
    },
    effectFailed: (_effect, error) => ({ type: 'source/failed', error: message(error) }),
  })
  const workflow = createGridControllerWorkflow(options, {
    initialSnapshot: initial, sizes, isDestroyed: () => runtime.destroyed,
  })
  const effectRunner = new GridControllerEffectRunner<Row, RowKey, Effect>(
    (event) => runtime.send({ type: 'effect/event', event }),
  )
  const persistenceRunner = new GridPersistenceEffectRunner<Row, RowKey>({
    commit: options.dataSource.persistence.commit,
    ...(options.dataSource.refresh ? { refresh: options.dataSource.refresh } : {}),
    send: (event) => runtime.send({ type: 'persistence/event', event }),
  })
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
  const dispatch = (intent: GridIntent<RowKey, Effect>): GridDispatchResult => runtime.execute(
    (base) => workflow.prepareIntent(base, runtime.getInternalState(), intent),
    (issue, revision) => ({
      accepted: false, revision,
      reason: issue.code === 'exception'
        ? `The grid command could not be completed: ${issue.message}`
        : issue.message,
    }),
  )
  const applyTransaction: GridController<Row, RowKey, Schema, Effect>['applyTransaction'] =
    (build, transactionOptions) => runtime.execute(
      (base) => workflow.prepareTransaction(base, runtime.getInternalState(), build, transactionOptions),
      (issue, revision) => ({
        accepted: false as const, revision, result: null,
        issues: Object.freeze([createGridTransactionIssue<RowKey>(
          issue.code === 'busy' ? 'transaction-active' : issue.code === 'exception' ? 'transaction-exception' : issue.code,
          issue.code === 'exception' ? `The grid transaction failed: ${issue.message}` : issue.message,
        )]) as readonly [GridTransactionIssue<RowKey>],
      }),
    )
  let unsubscribe: (() => void) | null = null
  const destroy = () => {
    if (runtime.destroyed) return
    runtime.destroy()
    const release = unsubscribe
    unsubscribe = null
    try {
      release?.()
    } finally {
      persistenceRunner.destroy()
      effectRunner.destroy()
    }
  }
  const readPublishedSource = () => {
    try {
      runtime.send({ type: 'source/published', remote: options.dataSource.getSnapshot() })
    } catch (error) {
      runtime.send({ type: 'source/failed', error: message(error) })
    }
  }
  try {
    unsubscribe = options.dataSource.subscribe(readPublishedSource)
    // Close the initial read/subscribe gap, including synchronous publication.
    readPublishedSource()
  } catch (error) {
    destroy()
    throw error
  }
  return Object.freeze({ getSnapshot, subscribe, subscribeSelector, dispatch, applyTransaction, destroy })
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
