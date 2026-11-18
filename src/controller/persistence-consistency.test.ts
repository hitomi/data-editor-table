import { describe, expect, it, vi } from 'vitest'
import { deferred } from '../../tests/unit/authority.js'
import { nameColumn, persistenceGrid, waitForSettled, type PersistenceRow } from '../../tests/unit/persistence-grid.js'
import { createStringCellType } from '../cell-types/standard.js'
import { createStandardCellTypeRegistry } from '../cell-types/standard-registry.js'
import type { FrozenSubmission } from '../kernel/model.js'
import type { SourceMutationResult, ServerAuthority } from '../kernel/source.js'

describe('persistence authority consistency across the adapter and controller', () => {
  it('continues a superseded peer read when only a receipt covers the new frontier', async () => {
    const { grid, open, server, holdWrite } = await persistenceGrid()
    const peer = open()
    await peer.refresh()
    const { response, request, save } = await holdWrite()
    const old = server.current(), late = deferred<ServerAuthority>(), confirmation = deferred<ServerAuthority>()
    // Keep both receipt-triggered reads outstanding so that the older response
    // arrives while the shared frontier has only the exact write receipt.
    server.source.readAtLeast.mockReturnValueOnce(late.promise)
      .mockReturnValueOnce(confirmation.promise).mockReturnValueOnce(confirmation.promise)
    const refresh = peer.refresh()
    const applied = server.apply(request)
    response.resolve(applied)
    await vi.waitFor(() => expect(server.source.readAtLeast).toHaveBeenCalledWith(server.scope, [applied.receipt.committedVersion]))
    expect(grid.getSnapshot().persistence).toMatchObject({ status: 'saving', recovery: null })
    late.resolve(old)
    expect(await refresh).toEqual({ status: 'superseded' })
    await vi.waitFor(() => expect(peer.getSnapshot().source).toMatchObject({ status: 'ready', version: 'v2' }))
    confirmation.resolve(server.current())
    expect(await save).toMatchObject({ status: 'confirmed' })
    peer.destroy()
    grid.destroy()
  })

  it('recovers a receipt rejected by scope admission without caching it as terminal', async () => {
    const { grid, dataSource, server, holdWrite } = await persistenceGrid()
    const { response, request, save } = await holdWrite()
    const correct = server.apply(request)
    dataSource.publish(server.current())
    response.resolve({ ...correct, receipt: { ...correct.receipt,
      committedVersion: { ...correct.receipt.committedVersion, token: 'contradictory' } } })
    const first = await save
    if (first?.status === 'recovery-required') {
      expect(await grid.recoverSave(first.recovery)).toMatchObject({ status: 'confirmed' })
    } else expect(first).toMatchObject({ status: 'confirmed' })
    expect(server.source.lookupOperation).toHaveBeenCalled()
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    expect(grid.destroy().status).toBe('closed')
  })

  it.each(['publication-first', 'receipt-first'])('accepts exact confirmation in %s order', async order => {
    const { grid, server, dataSource, holdWrite } = await persistenceGrid()
    const { response, request, save } = await holdWrite()
    const applied = server.apply(request)
    const canonical = server.current()
    if (order === 'publication-first') {
      dataSource.publish(canonical)
      expect(grid.getSnapshot().persistence.inFlightOperationId).toBe(request.operationId)
    } else {
      const read = deferred<ServerAuthority>()
      server.source.readAtLeast.mockReturnValueOnce(read.promise)
      response.resolve(applied)
      await vi.waitFor(() => expect(server.source.readAtLeast).toHaveBeenCalledWith(server.scope, [applied.receipt.committedVersion]))
      expect(grid.getSnapshot().persistence).toMatchObject({ status: 'saving', recovery: null })
      dataSource.publish(canonical)
      read.resolve(canonical)
    }
    response.resolve(applied)
    expect(await save).toMatchObject({ status: 'confirmed', operationId: request.operationId })
    expect(grid.getSnapshot().draft).toMatchObject({ baselineVersion: 'v2', dirtyCells: [], conflicts: [] })
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
  })

  it.each([true, false])('requires a read covering the write before accepting later content (covers=%s)', async covers => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    const applied = server.apply(request)
    server.source.readAtLeast.mockResolvedValueOnce(server.snapshot([{ id: 'a', name: 'Initial', count: 0 }], covers ? 3 : 1))
    response.resolve(applied)
    expect(await save).toMatchObject({ status: covers ? 'confirmed' : 'recovery-required' })
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe(covers ? 'Initial' : 'Submitted')
    expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(covers ? 0 : 1)
  })

  it.each(['manual-save', 'auto-save', 'immediate'] as const)('incorporates an intermediate publication before the exact %s commit', async mode => {
    const { grid, push, server, holdWrite } = await persistenceGrid(mode)
    const { response, request, save } = await holdWrite()
    push('Initial', 2)
    response.resolve(server.apply(request, { position: 3, update: proposed => ({ ...proposed, name: 'Canonical' }) }))
    if (save) expect(await save).toMatchObject({ status: 'confirmed' })
    await waitForSettled(grid)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Canonical')
    expect(grid.getSnapshot().draft.conflicts).toEqual([])
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it('retains a genuinely later server edit even when it restores the pre-write value', async () => {
    const { grid, push, server, holdWrite } = await persistenceGrid()
    const { response, request, save } = await holdWrite()
    const applied = server.apply(request)
    push('Initial', 3)
    response.resolve(applied)
    expect(await save).toMatchObject({ status: 'confirmed' })
    expect(grid.getSnapshot().source.version).toBe('v3')
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Initial')
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
  })

  it.each(['before', 'during'])('rejects a late read started %s the write, including a delayed push', async when => {
    const { grid, dataSource, server, holdWrite, push } = await persistenceGrid()
    const late = deferred<ServerAuthority>(), base = server.current()
    function startRead() {
      server.source.readAtLeast.mockReturnValueOnce(late.promise)
      return grid.refresh()
    }
    const early = when === 'before' ? startRead() : null
    const { response, request, save } = await holdWrite()
    const read = early ?? startRead()
    response.resolve(server.apply(request))
    expect(await save).toMatchObject({ status: 'confirmed' })
    late.resolve(base)
    expect((await read).status).not.toBe('refreshed')
    dataSource.publish(base)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
    push('Later', 3)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Later')
  })

  it('replays queued edits and history after a write is reconciled', async () => {
    const { grid, edit, server, holdWrite } = await persistenceGrid()
    const { response, request, save } = await holdWrite()
    edit('Queued')
    response.resolve(server.apply(request))
    expect(await save).toMatchObject({ status: 'confirmed', remaining: ['unsaved-changes'] })
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Queued')
    expect(grid.getSnapshot().draft.dirtyCells[0]?.originalValue).toBe('Submitted')
    expect(grid.undo().accepted).toBe(true)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    expect(grid.redo().accepted).toBe(true)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Queued')
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it('uses the original lookup without overwriting newer server authority after a lost response', async () => {
    const { grid, push, server, holdWrite } = await persistenceGrid()
    const { response, request, save } = await holdWrite()
    server.apply(request)
    response.reject(new Error('Lost response'))
    expect(await save).toMatchObject({ status: 'recovery-required', write: 'unknown' })
    push('Newer', 3)
    expect(await grid.recoverSave({ operationId: request.operationId, action: 'confirm' })).toMatchObject({ status: 'confirmed' })
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Newer')
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it.each(['manual-save', 'auto-save', 'immediate'] as const)('recovers a confirmed write after read failure without another %s submission', async mode => {
    const { grid, server, holdWrite } = await persistenceGrid(mode)
    const { request, response, save } = await holdWrite()
    server.source.readAtLeast.mockRejectedValueOnce(new Error('read offline'))
    response.resolve(server.apply(request))
    if (save) expect(await save).toMatchObject({ status: 'recovery-required', write: 'applied' })
    await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
    expect(await grid.save()).toMatchObject({ status: 'blocked' })
    expect(await grid.recoverSave({ operationId: request.operationId, action: 'refresh' })).toMatchObject({ status: 'confirmed' })
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
  })

  it.each(['wrong-scope', 'invalid-rows', 'stale-base'])('keeps confirmed writes recoverable when the barrier returns %s', async failure => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const old = server.current()
    const { request, response, save } = await holdWrite()
    const applied = server.apply(request)
    const current = server.current()
    server.source.readAtLeast.mockResolvedValueOnce(failure === 'stale-base' ? old : failure === 'wrong-scope'
      ? { ...current, scope: { ...server.scope, sourceId: 'other' } } : { ...current, order: [] })
    response.resolve(applied)
    expect(await save).toMatchObject({ status: 'recovery-required', write: 'applied' })
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Submitted')
    expect(await grid.recoverSave({ operationId: request.operationId, action: 'refresh' })).toMatchObject({ status: 'confirmed' })
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it.each(['applied', 'reload'])('reconciles assigned keys, deletions, queued edits and history through %s', async kind => {
    const { grid, server } = await persistenceGrid()
    expect(grid.applyTransaction(tx => {
      tx.deleteRows(['b'])
      const temp = tx.createRow({ beforeRowKey: 'a' })
      tx.set(nameColumn, temp, 'Created')
    }).accepted).toBe(true)
    const tempCell = { rowKey: 'temp', columnKey: 'name' }
    expect(grid.dispatch({ type: 'interaction/activate', cell: tempCell }).accepted).toBe(true)
    const entered = deferred<void>(), resume = deferred<void>()
    server.source.submit.mockImplementationOnce(async submission => {
      entered.resolve()
      await resume.promise
      const result = server.apply(submission, { create: row => ({ ...row, id: 'assigned', count: 1 }) })
      if (kind === 'reload') server.source.readAtLeast.mockRejectedValueOnce(new Error('offline'))
      return result
    })
    const save = grid.save()
    await entered.promise
    expect(grid.dispatch({ type: 'cell/set-value', cell: tempCell, value: 'Queued' }).accepted).toBe(true)
    resume.resolve()
    const result = await save
    if (kind === 'reload') {
      if (result.status !== 'recovery-required') throw new Error('Expected recoverable read barrier')
      expect(await grid.recoverSave(result.recovery)).toMatchObject({ status: 'confirmed' })
    } else expect(result).toMatchObject({ status: 'confirmed' })
    expect(grid.getSnapshot().source.rows.map(row => row.id)).toEqual(['assigned', 'a'])
    expect(grid.getSnapshot().interaction.activeCell).toMatchObject({ rowKey: 'assigned' })
    expect(grid.getSnapshot().draft).toMatchObject({ conflicts: [], deletedRowKeys: [], insertedRowKeys: [], orderDirty: false, savePlan: { canSave: true } })
    expect(grid.getSnapshot().draft.rows[0]).toEqual({ id: 'assigned', name: 'Queued', count: 1 })
    expect(grid.undo().accepted).toBe(true)
    expect(grid.getSnapshot().draft.rows[0]).toEqual({ id: 'assigned', name: 'Created', count: 1 })
    expect(grid.redo().accepted).toBe(true)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Queued')
    expect(grid.getSnapshot().draft.savePlan.canSave).toBe(true)
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it('retains the real row dependency of a replacement validator across key assignment and redo', async () => {
    const standard = createStringCellType().create<PersistenceRow>()
    const registry = createStandardCellTypeRegistry<PersistenceRow>().replace('string', {
      ...standard,
      behavior: { ...standard.behavior, value: { validate: (value, context) =>
        value === 'Queued' ? { ok: true, value: `Queued at ${context.row.count}` } : standard.behavior.value.validate(value, context) } },
    })
    const { grid, server } = await persistenceGrid('manual-save', registry)
    expect(grid.applyTransaction(tx => { tx.createRow() }).accepted).toBe(true)
    const response = deferred<SourceMutationResult>(), entered = deferred<FrozenSubmission>()
    server.source.submit.mockImplementationOnce(request => { entered.resolve(request); return response.promise })
    const save = grid.save(), request = await entered.promise
    expect(grid.dispatch({ type: 'cell/set-value', cell: { rowKey: 'temp', columnKey: 'name' }, value: 'Queued' }).accepted).toBe(true)
    response.resolve(server.apply(request, { create: row => ({ ...row, id: 'assigned', count: 7 }) }))
    expect(await save).toMatchObject({ status: 'confirmed' })
    const draft = grid.getSnapshot().draft
    expect(draft.rows.at(-1)).toEqual({ id: 'assigned', name: 'Queued at 0', count: 7 })
    expect(draft.conflicts).toContainEqual(expect.objectContaining({ rowKey: 'assigned', message: expect.stringContaining('dependency') }))
    expect(draft.savePlan.canSave).toBe(false)
    expect(grid.undo().accepted).toBe(true)
    expect(grid.redo().accepted).toBe(false)
    expect(grid.getSnapshot().draft.rows.at(-1)?.name).toBe('New')
  })

  it('requires explicit review of a malformed receipt despite successful subsequent reads', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    const valid = server.apply(request)
    response.resolve({ kind: 'applied', receipt: { ...valid.receipt, results: [] } })
    expect(await save).toMatchObject({ status: 'recovery-required', recovery: { action: 'review' } })
    await grid.refresh()
    expect(grid.getSnapshot().persistence.recovery?.operationId).toBe(request.operationId)
    expect(await grid.recoverSave({ operationId: request.operationId, action: 'confirm' })).toMatchObject({ status: 'blocked' })
    const review = await grid.recoverSave(grid.getSnapshot().persistence.recovery!)
    expect(review).toMatchObject({ status: 'recovery-required', recovery: { action: 'confirm' } })
    expect(server.source.lookupOperation).not.toHaveBeenCalled()
    expect(await grid.recoverSave(grid.getSnapshot().persistence.recovery!)).toMatchObject({ status: 'confirmed' })
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })
})
