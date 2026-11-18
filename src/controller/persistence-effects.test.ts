import { afterEach, describe, expect, it, vi } from 'vitest'
import { GridKernelPersistenceRunner } from './kernel-persistence-effects.js'
import { deferred, testAuthority } from '../../tests/unit/authority.js'
import { persistenceGrid } from '../../tests/unit/persistence-grid.js'
import type { ServerAuthority } from '../kernel/source.js'

afterEach(() => vi.useRealTimers())

describe('persistence effect resources', () => {
  it('replaces a debounce timer and invalidates queued immediate work on cancellation', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const runner = new GridKernelPersistenceRunner(testAuthority([]).source, send, { readAtLeast: vi.fn() })
    runner.run({ type: 'schedule', token: 1, delay: 800 })
    runner.run({ type: 'schedule', token: 2, delay: 800 })
    await vi.advanceTimersByTimeAsync(800)
    expect(send.mock.calls).toEqual([[{ type: 'schedule/due', token: 2 }]])
    send.mockClear()
    runner.run({ type: 'schedule', token: 3, delay: 0 })
    runner.run({ type: 'cancel-schedule' })
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    runner.destroy()
  })

  it('supersedes a replaced refresh and ignores its late completion', async () => {
    const { grid, server } = await persistenceGrid()
    const early = deferred<ServerAuthority>()
    server.source.readAtLeast.mockReturnValueOnce(early.promise)
    const replaced = grid.refresh()
    const latest = server.snapshot([{ id: 'a', name: 'Current', count: 1 }], 2)
    server.source.readAtLeast.mockResolvedValueOnce(latest)
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    expect(await replaced).toEqual({ status: 'superseded' })
    early.resolve(server.current())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', version: 'v2' })
    grid.destroy()
  })

  it('cancels scheduled work and settles an outstanding read on destroy', async () => {
    const { grid, server } = await persistenceGrid()
    const pending = deferred<ServerAuthority>()
    server.source.readAtLeast.mockReturnValueOnce(pending.promise)
    const read = grid.refresh()
    const listener = vi.fn()
    grid.subscribe(listener)
    expect(grid.destroy()).toEqual({ status: 'closed' })
    expect(await read).toMatchObject({ status: 'blocked', issue: { code: 'closed' } })
    pending.resolve(server.current())
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()

    vi.useFakeTimers()
    const send = vi.fn()
    const runner = new GridKernelPersistenceRunner(server.source, send, { readAtLeast: vi.fn() })
    runner.run({ type: 'schedule', token: 1, delay: 100 })
    runner.destroy()
    await vi.runAllTimersAsync()
    expect(send).not.toHaveBeenCalled()
  })
})
