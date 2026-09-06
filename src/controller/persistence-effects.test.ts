import { afterEach, describe, expect, it, vi } from 'vitest'
import { GridPersistenceEffectRunner } from './persistence-effects.js'

afterEach(() => vi.useRealTimers())

describe('persistence effect resources', () => {
  it('replaces a debounce timer and invalidates queued immediate work on cancellation', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const runner = new GridPersistenceEffectRunner({ commit: vi.fn(), send })
    runner.run({ type: 'schedule', token: 1, delay: 800, retry: false })
    runner.run({ type: 'schedule', token: 2, delay: 800, retry: true })
    await vi.advanceTimersByTimeAsync(800)
    expect(send.mock.calls).toEqual([[{ type: 'schedule/due', token: 2, retry: true }]])
    send.mockClear()
    runner.run({ type: 'schedule', token: 3, delay: 0, retry: false })
    runner.run({ type: 'cancel-schedule' })
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    runner.destroy()
  })

  it('aborts replaced refreshes and ignores their late completion', async () => {
    const send = vi.fn()
    const pending: Array<{ signal: AbortSignal; resolve: () => void }> = []
    const runner = new GridPersistenceEffectRunner({
      commit: vi.fn(), send,
      refresh: ({ signal }) => new Promise<void>((resolve) => pending.push({ signal, resolve })),
    })
    runner.run({ type: 'refresh', token: 1 })
    await Promise.resolve()
    runner.run({ type: 'refresh', token: 2 })
    await Promise.resolve()
    expect(pending[0]?.signal.aborted).toBe(true)
    pending[0]!.resolve()
    pending[1]!.resolve()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith({ type: 'refresh/completed', token: 2 })
    runner.destroy()
  })

  it('cancels timers and aborts refresh on destroy without publishing a late result', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    let signal: AbortSignal | undefined
    let resolve: (() => void) | undefined
    const runner = new GridPersistenceEffectRunner({
      commit: vi.fn(), send,
      refresh: (context) => {
        signal = context.signal
        return new Promise<void>((done) => { resolve = done })
      },
    })
    runner.run({ type: 'refresh', token: 1 })
    runner.run({ type: 'schedule', token: 2, delay: 800, retry: false })
    await Promise.resolve()
    runner.destroy()
    expect(signal?.aborted).toBe(true)
    resolve!()
    await vi.runAllTimersAsync()
    expect(send).not.toHaveBeenCalled()
  })
})
