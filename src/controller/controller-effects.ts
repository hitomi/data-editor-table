import { copyGridCellEffectResult, copyGridHostEffectResult } from './effect-results.js'
import type { GridCompiledDocumentModel } from '../data/runtime-columns.js'
import type { GridPoint, GridRowKey, GridRuntimeCellEffect, GridRuntimeValueContext, GridValueResult } from '../model/grid-model.js'
import type { GridEffectInput, GridEffectPort, GridEffectRequest, GridEffectResult } from './controller-contracts.js'
import type { GridActiveEffect } from './effect-coordinator.js'

export type GridCellEffectOperation<Row, RowKey extends GridRowKey> = Readonly<{
  key: string
  active: GridActiveEffect<RowKey>
  target: GridPoint<RowKey>
  definition: GridRuntimeCellEffect<Row>
  input: unknown
  context: GridRuntimeValueContext<Row>
}>

export type GridExternalEffectOperation<RowKey extends GridRowKey, Effect> = Readonly<{
  id: string
  active: GridActiveEffect<RowKey>
  request: GridEffectRequest<RowKey, Effect>
}>

export type GridControllerEffectEvent<Row, RowKey extends GridRowKey, Effect> =
  | Readonly<{ type: 'cell/completed'; operation: GridCellEffectOperation<Row, RowKey>; result: GridValueResult<unknown> }>
  | Readonly<{ type: 'external/completed'; operation: GridExternalEffectOperation<RowKey, Effect>; result: GridEffectResult }>
  | Readonly<{ type: 'external/failed'; operation: GridExternalEffectOperation<RowKey, Effect>; error: unknown }>

/** Owns AbortControllers, never semantic effect ownership or controller state. */
export class GridControllerEffectRunner<Row, RowKey extends GridRowKey, Effect> {
  readonly #active = new Map<GridActiveEffect<RowKey>, AbortController>()
  readonly #send: (event: GridControllerEffectEvent<Row, RowKey, Effect>) => void
  #destroyed = false

  constructor(send: (event: GridControllerEffectEvent<Row, RowKey, Effect>) => void, private readonly model: GridCompiledDocumentModel<Row>) {
    this.#send = send
  }

  runCell(operation: GridCellEffectOperation<Row, RowKey>) {
    const { active, definition, input, context } = operation
    this.#execute(active,
      async (signal) => copyGridCellEffectResult(this.model, operation.target.columnKey,
        await definition.run(structuredClone(input), context, signal)),
      (result) => this.#send({ type: 'cell/completed', operation, result }),
      (error) => this.#send({ type: 'cell/completed', operation, result: {
        ok: false, issue: { code: 'exception', message: error instanceof Error ? error.message : String(error) },
      } }),
    )
  }

  runExternal(
    operation: GridExternalEffectOperation<RowKey, Effect>,
    port: GridEffectPort<Row, RowKey, Effect>,
    cells: readonly GridEffectInput<Row, RowKey>[],
  ) {
    this.#execute(operation.active,
      async (signal) => {
        const owner = operation.request.owner
        const result = await port.run(structuredClone(operation.request.effect), { signal, owner: structuredClone(owner), cells })
        return copyGridHostEffectResult(this.model, operation, result)
      },
      (result) => this.#send({ type: 'external/completed', operation, result }),
      (error) => this.#send({ type: 'external/failed', operation, error }),
    )
  }

  cancel(active: GridActiveEffect<RowKey>) {
    this.#active.get(active)?.abort()
    this.#active.delete(active)
  }

  destroy() {
    this.#destroyed = true
    for (const abort of this.#active.values()) abort.abort()
    this.#active.clear()
  }

  #execute<Value>(
    owner: GridActiveEffect<RowKey>,
    run: (signal: AbortSignal) => Value | Promise<Value>,
    completed: (value: Value) => void,
    failed: (error: unknown) => void,
  ) {
    if (this.#destroyed) return
    const abort = new AbortController()
    this.#active.set(owner, abort)
    let started = false
    const current = () => !this.#destroyed && !abort.signal.aborted && this.#active.get(owner) === abort
    void Promise.resolve().then(() => {
      if (!current()) throw new Error('The task was cancelled before it started.')
      started = true
      return run(abort.signal)
    }).then((value) => {
      if (this.#destroyed) return
      if (this.#active.get(owner) === abort) this.#active.delete(owner)
      // Cancellation revokes application permission, not an already produced
      // result. The Runtime retains stale results for explicit review/reapply.
      completed(value)
    }, (error: unknown) => {
      if (this.#destroyed) return
      if (this.#active.get(owner) === abort) this.#active.delete(owner)
      failed(started ? error : new Error('The task was cancelled; its input is retained.'))
    })
  }
}
