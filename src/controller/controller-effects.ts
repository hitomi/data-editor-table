import type { GridControllerSnapshot, GridPoint, GridRowKey, GridRuntimeCellEffect, GridRuntimeValueContext, GridValueResult } from '../model/grid-model.js'
import type { GridEffectPort, GridEffectRequest, GridEffectResult } from './controller-contracts.js'
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
  | Readonly<{ type: 'external/completed'; operation: GridExternalEffectOperation<RowKey, Effect>; result: GridEffectResult<RowKey, Effect> }>
  | Readonly<{ type: 'external/failed'; operation: GridExternalEffectOperation<RowKey, Effect>; error: unknown }>

/** Owns AbortControllers, never semantic effect ownership or controller state. */
export class GridControllerEffectRunner<Row, RowKey extends GridRowKey, Effect> {
  readonly #active = new Map<GridActiveEffect<RowKey>, AbortController>()
  readonly #send: (event: GridControllerEffectEvent<Row, RowKey, Effect>) => void
  #destroyed = false

  constructor(send: (event: GridControllerEffectEvent<Row, RowKey, Effect>) => void) {
    this.#send = send
  }

  runCell(operation: GridCellEffectOperation<Row, RowKey>) {
    const { active, definition, input, context } = operation
    this.#execute(active,
      (signal) => definition.run(input, context, signal),
      (result) => this.#send({ type: 'cell/completed', operation, result }),
      (error) => this.#send({ type: 'cell/completed', operation, result: {
        ok: false, issue: { code: 'exception', message: error instanceof Error ? error.message : String(error) },
      } }),
    )
  }

  runExternal(
    operation: GridExternalEffectOperation<RowKey, Effect>,
    port: GridEffectPort<Row, RowKey, Effect>,
    getSnapshot: () => GridControllerSnapshot<Row, RowKey>,
  ) {
    this.#execute(operation.active,
      (signal) => port.run(operation.request.effect, { signal, getSnapshot }),
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
    const current = () => !this.#destroyed && !abort.signal.aborted && this.#active.get(owner) === abort
    void Promise.resolve().then(() => {
      if (current()) return run(abort.signal)
      return undefined
    }).then((value) => {
      if (!current()) return
      this.#active.delete(owner)
      completed(value as Value)
    }, (error: unknown) => {
      if (!current()) return
      this.#active.delete(owner)
      failed(error)
    })
  }
}
