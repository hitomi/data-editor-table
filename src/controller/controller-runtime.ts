/** A prepared transition is private until the runtime commits its entire state. */
export type GridTransition<State, Effect, Result = void, Internal = undefined> = Readonly<{
  state: State
  internalState?: Internal
  effects: readonly Effect[]
  result: Result
}>

export type GridRuntimeIssue =
  | Readonly<{ code: 'destroyed'; message: string }>
  | Readonly<{ code: 'busy'; message: string }>
  | Readonly<{ code: 'exception'; message: string }>

type GridRuntimeOptions<State, Event, Effect, Internal> = Readonly<{
  initialState: State
  initialInternalState?: Internal
  handleEvent: (state: State, event: Event) => GridTransition<State, Effect, void, Internal>
  eventFailed: (state: State, event: Event, error: unknown) => GridTransition<State, Effect, void, Internal>
  runEffect: (effect: Effect) => void
  effectFailed: (effect: Effect, error: unknown) => Event
}>

/**
 * Owns publication and resource execution, not domain rules. Public commands
 * return their completed result synchronously; reentrant commands are rejected.
 * Internal events are drained after the current notification/effect batch.
 */
export class GridControllerRuntime<State extends Readonly<{ revision: number }>, Event, Effect, Internal = undefined> {
  readonly #options: GridRuntimeOptions<State, Event, Effect, Internal>
  readonly #listeners = new Set<() => void>()
  readonly #events: Event[] = []
  #state: State
  #internal: Internal
  #busy = false
  #destroyed = false

  constructor(options: GridRuntimeOptions<State, Event, Effect, Internal>) {
    this.#options = options
    this.#state = options.initialState
    this.#internal = options.initialInternalState as Internal
  }

  getSnapshot = (): State => this.#state

  getInternalState = (): Internal => this.#internal

  get destroyed() {
    return this.#destroyed
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.#destroyed) return () => undefined
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  execute<Result extends Readonly<{ revision: number }>>(
    prepare: (state: State) => GridTransition<State, Effect, Result, Internal>,
    reject: (issue: GridRuntimeIssue, revision: number) => Result,
  ): Result {
    if (this.#destroyed) return reject(destroyedIssue(), this.#state.revision)
    if (this.#busy) return reject({
      code: 'busy',
      message: 'The GridController is processing another input.',
    }, this.#state.revision)

    this.#busy = true
    try {
      let transition: GridTransition<State, Effect, Result, Internal>
      try {
        transition = prepare(this.#state)
      } catch (error) {
        return reject({
          code: 'exception',
          message: error instanceof Error ? error.message : String(error),
        }, this.#state.revision)
      }
      if (this.#destroyed) return reject(destroyedIssue(), this.#state.revision)

      const changed = this.#commit(transition.state, 'internalState' in transition ? transition.internalState : this.#internal)
      // Capture this command's revision before draining any subsequent event.
      const result = { ...transition.result, revision: this.#state.revision }
      this.#notifyAndRun(changed, transition.effects)
      return result
    } finally {
      this.#busy = false
      this.#drain()
    }
  }

  send = (event: Event): void => {
    if (this.#destroyed) return
    this.#events.push(event)
    this.#drain()
  }

  destroy() {
    this.#destroyed = true
    this.#events.length = 0
    this.#listeners.clear()
  }

  #commit(next: State, internal: Internal) {
    const changed = next !== this.#state
    const snapshot = changed
      ? Object.freeze({ ...next, revision: this.#state.revision + 1 })
      : this.#state
    this.#state = snapshot
    this.#internal = internal
    return changed
  }

  #notifyAndRun(changed: boolean, effects: readonly Effect[]) {
    if (changed) {
      // New listeners start with the already committed snapshot. They do not
      // join the notification currently being delivered.
      const listeners = [...this.#listeners]
      for (const listener of listeners) {
        if (this.#destroyed) break
        if (!this.#listeners.has(listener)) continue
        try {
          listener()
        } catch {
          // Consumer failures cannot undo publication or prevent other readers.
        }
      }
    }
    for (const effect of effects) {
      if (this.#destroyed) break
      try {
        this.#options.runEffect(effect)
      } catch (error) {
        this.send(this.#options.effectFailed(effect, error))
      }
    }
  }

  #drain() {
    if (this.#busy || this.#destroyed) return
    this.#busy = true
    try {
      // Use a cursor so a burst of publications does not repeatedly shift the
      // whole queue. Events enqueued by a handler or effect join this same drain.
      for (let index = 0; index < this.#events.length && !this.#destroyed; index++) {
        const event = this.#events[index]!
        let transition: GridTransition<State, Effect, void, Internal>
        try {
          transition = this.#options.handleEvent(this.#state, event)
        } catch (error) {
          transition = this.#options.eventFailed(this.#state, event, error)
        }
        if (this.#destroyed) break
        const changed = this.#commit(transition.state, 'internalState' in transition ? transition.internalState : this.#internal)
        this.#notifyAndRun(changed, transition.effects)
      }
    } finally {
      this.#events.length = 0
      this.#busy = false
    }
  }
}

function destroyedIssue(): GridRuntimeIssue {
  return { code: 'destroyed', message: 'The GridController has been destroyed.' }
}
