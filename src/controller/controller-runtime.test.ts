import { describe, expect, it, vi } from 'vitest'
import { GridControllerRuntime, type GridRuntimeIssue } from './controller-runtime.js'

type State = Readonly<{ revision: number; value: number; error: string | null }>
type Event = Readonly<{ value: number }> | Readonly<{ error: string }>
type Effect = () => void
type Result = Readonly<{ revision: number; accepted: boolean; reason?: string }>

function fixture() {
  const runtime = new GridControllerRuntime<State, Event, Effect>({
    initialState: Object.freeze({ revision: 0, value: 0, error: null }),
    handleEvent: (state, event) => {
      if ('value' in event && event.value < 0) throw new Error('Invalid authority')
      return { state: { ...state, ...event }, effects: [], result: undefined }
    },
    eventFailed: (state, _event, error) => ({
      state: { ...state, error: String(error) }, effects: [], result: undefined,
    }),
    runEffect: (effect) => effect(),
    effectFailed: (_effect, error) => ({ error: String(error) }),
  })
  const reject = (issue: GridRuntimeIssue, revision: number): Result => ({
    accepted: false, revision, reason: issue.code,
  })
  const set = (value: number, effects: readonly Effect[] = []): Result => runtime.execute(
    (state) => ({
      state: { ...state, value }, effects,
      result: { accepted: true, revision: state.revision },
    }), reject,
  )
  return { runtime, set, reject }
}

describe('GridControllerRuntime publication protocol', () => {
  it('commits internal control state without exposing it or notifying unchanged snapshot readers', () => {
    const snapshot = Object.freeze({ revision: 0, value: 0, error: null })
    const runtime = new GridControllerRuntime<State, null, never, Readonly<{ token: number }> | null>({
      initialState: snapshot, initialInternalState: { token: 0 },
      handleEvent: (state) => ({ state, internalState: null, effects: [], result: undefined }),
      eventFailed: (state) => ({ state, effects: [], result: undefined }),
      runEffect: () => {}, effectFailed: () => { throw new Error('No effects') },
    })
    const listener = vi.fn()
    runtime.subscribe(listener)
    runtime.execute((state) => ({
      state, internalState: { token: 1 }, effects: [], result: { revision: state.revision },
    }), (_issue, revision) => ({ revision }))
    expect(runtime.getInternalState()).toEqual({ token: 1 })
    expect(runtime.getSnapshot()).toBe(snapshot)
    runtime.execute(() => { throw new Error('Preparation failed') }, (_issue, revision) => ({ revision }))
    expect(runtime.getInternalState()).toEqual({ token: 1 })
    runtime.execute((state) => ({ state, internalState: null, effects: [], result: { revision: 0 } }),
      (_issue, revision) => ({ revision }))
    expect(runtime.getInternalState()).toBeNull()
    runtime.execute((state) => ({ state, internalState: { token: 2 }, effects: [], result: { revision: 0 } }),
      (_issue, revision) => ({ revision }))
    runtime.send(null)
    expect(runtime.getInternalState()).toBeNull()
    expect(listener).not.toHaveBeenCalled()
    expect(runtime.getSnapshot()).toBe(snapshot)
  })

  it('keeps candidate work private and publishes once before running effects', () => {
    const { runtime, reject } = fixture()
    const initial = runtime.getSnapshot()
    const observations: string[] = []
    runtime.subscribe(() => observations.push(`notify:${runtime.getSnapshot().value}`))
    const result = runtime.execute((state) => {
      const candidate = { ...state, value: 2, revision: 900 }
      expect(runtime.getSnapshot()).toBe(initial)
      return {
        state: candidate,
        effects: [() => observations.push(`effect:${runtime.getSnapshot().value}`)],
        result: { accepted: true, revision: candidate.revision },
      }
    }, reject)
    expect(result).toEqual({ accepted: true, revision: 1 })
    expect(observations).toEqual(['notify:2', 'effect:2'])
    expect(Object.isFrozen(runtime.getSnapshot())).toBe(true)
  })

  it('rejects reentrant commands from preparation and notification', () => {
    const { runtime, set, reject } = fixture()
    const attempts: Result[] = []
    runtime.subscribe(() => attempts.push(set(8)))
    runtime.execute((state) => {
      attempts.push(set(9))
      return { state: { ...state, value: 1 }, effects: [], result: { revision: 0, accepted: true } }
    }, reject)
    expect(attempts).toEqual([
      { accepted: false, revision: 0, reason: 'busy' },
      { accepted: false, revision: 1, reason: 'busy' },
    ])
    expect(runtime.getSnapshot().value).toBe(1)
  })

  it('drains internal events after the current notification and effect batch', () => {
    const { runtime, set } = fixture()
    const observations: number[] = []
    runtime.subscribe(() => {
      observations.push(runtime.getSnapshot().value)
      if (runtime.getSnapshot().value === 1) runtime.send({ value: 2 })
    })
    const result = set(1, [() => {
      expect(runtime.getSnapshot().value).toBe(1)
      runtime.send({ value: 3 })
    }])
    expect(result.revision).toBe(1)
    expect(observations).toEqual([1, 2, 3])
    expect(runtime.getSnapshot()).toMatchObject({ revision: 3, value: 3 })
  })

  it('keeps snapshot identity and subscriptions stable for no-op commands', () => {
    const { runtime, reject } = fixture()
    const initial = runtime.getSnapshot()
    const listener = vi.fn()
    const effect = vi.fn()
    runtime.subscribe(listener)
    runtime.execute((state) => ({
      state, effects: [effect], result: { accepted: true, revision: state.revision },
    }), reject)
    expect(runtime.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()
    expect(effect).toHaveBeenCalledOnce()
  })

  it('publishes validation feedback even when the requested change is rejected', () => {
    const { runtime, reject } = fixture()
    const listener = vi.fn()
    runtime.subscribe(listener)
    const result = runtime.execute((state) => ({
      state: { ...state, error: 'Invalid value' }, effects: [],
      result: { revision: state.revision, accepted: false, reason: 'Invalid value' },
    }), reject)
    expect(result).toMatchObject({ accepted: false, revision: 1 })
    expect(runtime.getSnapshot()).toMatchObject({ value: 0, error: 'Invalid value' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('discards failed preparation and continues processing queued authority events', () => {
    const { runtime, reject, set } = fixture()
    const initial = runtime.getSnapshot()
    const result = runtime.execute(() => {
      runtime.send({ value: 3 })
      expect(runtime.getSnapshot()).toBe(initial)
      throw new Error('Setter failed')
    }, reject)
    expect(result).toEqual({ accepted: false, reason: 'exception', revision: 0 })
    expect(runtime.getSnapshot()).toMatchObject({ value: 3, revision: 1 })
    expect(set(4).accepted).toBe(true)
  })

  it('isolates subscriber exceptions and respects removal during notification', () => {
    const { runtime, set } = fixture()
    const removed = vi.fn()
    const remaining = vi.fn()
    let unsubscribe = () => {}
    runtime.subscribe(() => {
      unsubscribe()
      throw new Error('Consumer failed')
    })
    unsubscribe = runtime.subscribe(removed)
    runtime.subscribe(remaining)
    expect(set(2).accepted).toBe(true)
    expect(removed).not.toHaveBeenCalled()
    expect(remaining).toHaveBeenCalledOnce()
  })

  it('does not notify a new subscriber in a batch already in progress', () => {
    const { runtime, set } = fixture()
    const late = vi.fn()
    runtime.subscribe(() => runtime.subscribe(late))
    set(1)
    expect(late).not.toHaveBeenCalled()
    set(2)
    expect(late).toHaveBeenCalledOnce()
  })

  it('stops notification, pending effects and events when destroyed by a reader', () => {
    const { runtime, set } = fixture()
    const listener = vi.fn()
    const effect = vi.fn()
    runtime.subscribe(() => {
      runtime.send({ value: 8 })
      runtime.destroy()
    })
    runtime.subscribe(listener)
    expect(set(1, [effect]).accepted).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    runtime.send({ value: 9 })
    expect(runtime.getSnapshot().value).toBe(1)
    expect(set(2)).toMatchObject({ accepted: false, reason: 'destroyed' })
    runtime.destroy()
  })

  it('discards a candidate destroyed during preparation', () => {
    const { runtime, reject } = fixture()
    const initial = runtime.getSnapshot()
    const effect = vi.fn()
    const result = runtime.execute((state) => {
      runtime.destroy()
      return { state: { ...state, value: 2 }, effects: [effect], result: { accepted: true, revision: 0 } }
    }, reject)
    expect(result).toMatchObject({ accepted: false, reason: 'destroyed' })
    expect(runtime.getSnapshot()).toBe(initial)
    expect(effect).not.toHaveBeenCalled()
  })

  it('turns effect execution failure into an observable event after publication', () => {
    const { runtime, set } = fixture()
    const result = set(1, [() => { throw new Error('I/O failed') }])
    expect(result).toMatchObject({ accepted: true, revision: 1 })
    expect(runtime.getSnapshot()).toMatchObject({ value: 1, revision: 2, error: 'Error: I/O failed' })
  })

  it('retains committed data on event failure and continues the event queue', () => {
    const { runtime, set } = fixture()
    set(1, [() => {
      runtime.send({ value: -1 })
      runtime.send({ value: 2 })
    }])
    expect(runtime.getSnapshot()).toMatchObject({ value: 2, error: 'Error: Invalid authority' })
  })
})
