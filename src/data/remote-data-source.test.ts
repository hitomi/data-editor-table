import { describe, expect, it, vi } from 'vitest'
import { deferred, rejected } from '../../tests/unit/authority.js'
import { nameColumn, persistenceGrid } from '../../tests/unit/persistence-grid.js'
import type { ServerAuthority } from '../kernel/source.js'

describe('remote grid authority adapter', () => {
  it('settles a save from a peer read and ignores the original read failing later', async () => {
    const { grid, open, server, holdWrite } = await persistenceGrid()
    const peer = open()
    await peer.refresh()
    const { request, response, save } = await holdWrite()
    const started = deferred<void>(), late = deferred<ServerAuthority>()
    const peerRead = deferred<ServerAuthority>()
    server.source.readAtLeast.mockReturnValueOnce(peerRead.promise)
      .mockImplementationOnce(() => { started.resolve(); return late.promise })
    response.resolve(server.apply(request))
    await started.promise
    peerRead.resolve(server.current())
    expect(await save).toMatchObject({ status: 'confirmed', operationId: request.operationId })
    late.reject(new Error('late read failed'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(grid.getSnapshot().persistence).toMatchObject({ status: 'idle', error: null })
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    grid.destroy()
    peer.destroy()
  })

  it('keeps contradictory commit-version rows out of every reader and retries only the read', async () => {
    const { grid, open, server, dataSource, holdWrite } = await persistenceGrid()
    const peer = open()
    await peer.refresh()
    const { request, response, save } = await holdWrite()
    const receipt = server.apply(request)
    const valid = server.current()
    const wrong = { ...valid, rows: valid.rows.map(row => ({
      ...row, document: { ...row.document, name: 'Wrong' },
    })) }
    // Both existing readers receive the receipt barrier and try their transports.
    server.source.readAtLeast.mockResolvedValue(wrong)
    response.resolve(receipt)
    expect(await save).toMatchObject({ status: 'recovery-required', write: 'applied', recovery: { action: 'refresh' } })
    expect(() => dataSource.publish(wrong)).toThrow(/contradict/)
    expect(dataSource.getSnapshot()?.version.token).toBe('v1')
    expect(peer.getSnapshot().source.version).toBe('v1')
    server.source.readAtLeast.mockResolvedValue(valid)
    expect(await grid.recoverSave({ action: 'refresh', operationId: request.operationId })).toMatchObject({ status: 'confirmed' })
    expect(peer.getSnapshot().source.rows[0]?.name).toBe('Submitted')
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    grid.destroy()
    peer.destroy()
  })

  it('does not let stale refreshes overwrite newer authority publications', async () => {
    const { grid, server, push } = await persistenceGrid()
    const early = deferred<ServerAuthority>(), base = server.current()
    server.source.readAtLeast.mockReturnValueOnce(early.promise)
    const read = grid.refresh()
    push('Newer', 3)
    early.resolve(base)
    expect(await read).toMatchObject({ status: 'superseded' })
    expect(grid.getSnapshot().source.rows[0]?.name).toBe('Newer')
    expect(grid.getSnapshot().source.status).toBe('ready')
  })

  it('keeps the last usable snapshot when the source aborts a refresh', async () => {
    const { grid, server } = await persistenceGrid()
    const base = grid.getSnapshot().source
    server.source.readAtLeast.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    expect(await grid.refresh()).toMatchObject({ status: 'failed', issue: { code: 'source-unavailable' } })
    expect(grid.getSnapshot().source).toMatchObject({ rows: base.rows, version: base.version, status: 'error' })
    expect(await grid.refresh()).toMatchObject({ status: 'refreshed' })
    expect(grid.getSnapshot().source.status).toBe('ready')
  })

  it('keeps an active refresh alive when an external publication is rejected', async () => {
    const { grid, dataSource, server } = await persistenceGrid()
    const pending = deferred<ServerAuthority>()
    server.source.readAtLeast.mockReturnValueOnce(pending.promise)
    const read = grid.refresh()
    const base = server.current()
    expect(() => dataSource.publish({ ...base, order: [] })).toThrow()
    expect(grid.getSnapshot().source.status).toBe('refreshing')
    pending.resolve(server.snapshot([{ id: 'a', name: 'New', count: 1 }], 2))
    expect(await read).toMatchObject({ status: 'refreshed' })
    expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', rows: [{ name: 'New' }] })
  })

  it('ignores a stale return after a subscription proves a later server version', async () => {
    const { grid, dataSource, server, holdWrite, push } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    const applied = server.apply(request)
    const earlier = server.current()
    push('Later', 3)
    response.resolve(applied)
    expect(await save).toMatchObject({ status: 'confirmed' })
    dataSource.publish(earlier)
    expect(grid.getSnapshot().source.rows[0]?.name).toBe('Later')
    expect(dataSource.getSnapshot()?.version.token).toBe('v3')
  })

  it('keeps loading state separate from authoritative content', async () => {
    const { grid, dataSource, server } = await persistenceGrid()
    const base = dataSource.getSnapshot()
    const pending = deferred<ServerAuthority>()
    server.source.readAtLeast.mockReturnValueOnce(pending.promise)
    const read = grid.refresh()
    expect(grid.getSnapshot().source.status).toBe('refreshing')
    expect(dataSource.getSnapshot()).toBe(base)
    pending.resolve(server.current())
    expect(await read).toMatchObject({ status: 'refreshed' })
    expect(grid.getSnapshot().source.rows).toHaveLength(2)
  })

  it.each(['applied', 'rejected'])('serializes independent controllers and releases the next writer after %s', async terminal => {
    const { grid, open, server, holdWrite } = await persistenceGrid()
    const other = open()
    await other.refresh()
    const { request, response, save } = await holdWrite()
    expect(other.dispatch({ type: 'cell/set-value', cell: { rowKey: 'b', columnKey: 'name' }, value: 'Second' }).accepted).toBe(true)
    const queued = other.save()
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    response.resolve(terminal === 'applied' ? server.apply(request) : rejected(request))
    expect(await save).toMatchObject({ status: terminal === 'applied' ? 'confirmed' : 'failed' })
    expect(await queued).toMatchObject({ status: 'confirmed' })
    expect(server.source.submit).toHaveBeenCalledTimes(2)
    const rows = server.current().rows.map(row => row.document.name)
    expect(rows).toEqual([terminal === 'applied' ? 'Submitted' : 'Initial', 'Second'])
    expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(terminal === 'applied' ? 0 : 1)
    expect(other.getSnapshot().draft.dirtyCells).toEqual([])
  })

  it('does not let a read in flight before a successful commit roll back saved content', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const base = server.current(), slow = deferred<ServerAuthority>()
    server.source.readAtLeast.mockReturnValueOnce(slow.promise)
    const read = grid.refresh()
    const { request, response, save } = await holdWrite()
    response.resolve(server.apply(request))
    expect(await save).toMatchObject({ status: 'confirmed' })
    slow.resolve(base)
    expect((await read).status).not.toBe('refreshed')
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
  })

  it('settles overlapping refreshes even when the write is rejected', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    const slow = deferred<ServerAuthority>()
    server.source.readAtLeast.mockReturnValueOnce(slow.promise)
    const read = grid.refresh()
    response.resolve(rejected(request, 'Permission denied'))
    expect(await save).toMatchObject({ status: 'failed', issue: { message: 'Permission denied' } })
    slow.resolve(server.current())
    expect(await read).toMatchObject({ status: 'superseded' })
    await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('ready'))
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
  })

  it('allows refresh during an active write without using read success as confirmation', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    expect(grid.getSnapshot().persistence.inFlightOperationId).toBe(request.operationId)
    response.resolve(server.apply(request))
    expect(await save).toMatchObject({ status: 'confirmed' })
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    expect(grid.getSnapshot().source.rows[0]?.name).toBe('Submitted')
  })

  it('submits explicit CRUD and row placement, then adopts assigned keys and canonical documents', async () => {
    const { grid, server } = await persistenceGrid()
    expect(grid.applyTransaction(tx => {
      tx.deleteRows(['b'])
      tx.set(nameColumn, 'a', 'Changed')
      const key = tx.createRow({ beforeRowKey: 'a' })
      tx.set(nameColumn, key, 'Created')
    }).accepted).toBe(true)
    server.source.submit.mockImplementationOnce(async request => server.apply(request, {
      create: proposed => ({ ...proposed, id: 'server', name: 'Canonical' }),
    }))
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    expect(server.source.submit.mock.calls[0]![0].items.map(item => item.kind).sort()).toEqual(['create', 'delete', 'order', 'update'])
    expect(grid.getSnapshot().source.rows.map(row => [row.id, row.name])).toEqual([['server', 'Canonical'], ['a', 'Changed']])
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
  })

  it.each(['found', 'unknown'])('recovers the original write after lookup returns %s', async found => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    if (found === 'found') server.apply(request)
    response.reject(new Error('lost response'))
    expect(await save).toMatchObject({ status: 'recovery-required' })
    expect(await grid.save()).toMatchObject({ status: 'blocked' })
    expect(await grid.recoverSave({ operationId: request.operationId, action: 'confirm' })).toMatchObject({ status: 'confirmed' })
    expect(server.source.lookupOperation).toHaveBeenCalledTimes(1)
    expect(server.source.submit.mock.calls.map(([req]) => req)).toEqual(found === 'found' ? [request] : [request, request])
  })

  it.each(['wrong-item', 'missing-item'])('rejects a %s creation receipt and never resubmits an applied creation', async kind => {
    const { grid, server } = await persistenceGrid()
    expect(grid.applyTransaction(tx => { tx.createRow() }).accepted).toBe(true)
    server.source.submit.mockImplementationOnce(async request => {
      const result = server.apply(request, { create: row => ({ ...row, id: 'server' }) })
      return { ...result, receipt: { ...result.receipt, results: kind === 'missing-item' ? []
        : result.receipt.results.map(item => ({ ...item, itemId: 'wrong' as typeof item.itemId })) } }
    })
    const initial = await grid.save()
    expect(initial).toMatchObject({ status: 'recovery-required', recovery: { action: 'review' } })
    if (initial.status !== 'recovery-required') throw new Error('Expected receipt review')
    expect(await grid.save()).toMatchObject({ status: 'blocked' })
    expect(grid.getSnapshot().draft.rows.some(row => row.id === 'temp')).toBe(true)
    expect(await grid.recoverSave({ operationId: initial.recovery.operationId, action: 'confirm' })).toMatchObject({ status: 'blocked' })
    const reviewed = await grid.recoverSave(initial.recovery)
    expect(reviewed).toMatchObject({ status: 'recovery-required', recovery: { operationId: initial.recovery.operationId, action: 'confirm' } })
    if (reviewed.status !== 'recovery-required') throw new Error('Expected a lookup for the reviewed receipt')
    expect(server.source.lookupOperation).not.toHaveBeenCalled()
    expect(await grid.recoverSave(reviewed.recovery)).toMatchObject({ status: 'confirmed' })
    expect(server.source.lookupOperation).toHaveBeenCalledTimes(1)
    expect(grid.getSnapshot().draft.rows.map(row => row.id)).toEqual(['a', 'b', 'server'])
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })
})
