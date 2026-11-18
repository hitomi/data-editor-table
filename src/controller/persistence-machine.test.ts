import { describe, expect, it, vi } from 'vitest'
import { selectGridActions, selectGridToolbar } from './grid-selectors.js'
import type { FrozenSubmission, OperationLookup } from '../kernel/model.js'
import type { ServerAuthority, SourceMutationResult } from '../kernel/source.js'
import { persistenceGrid } from '../../tests/unit/persistence-grid.js'
import { deferred, rejected } from '../../tests/unit/authority.js'

describe('persistence operation ownership', () => {
  it('rejects concurrent saves and stale recovery targets while preserving the frozen request', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    expect(await grid.save()).toMatchObject({ status: 'blocked', issue: { code: 'save-in-progress' } })
    expect(await grid.recoverSave({ operationId: 'stale', action: 'confirm' })).toMatchObject({ status: 'blocked', issue: { code: 'stale-target' } })
    expect(grid.getSnapshot().persistence).toMatchObject({ inFlightOperationId: request.operationId, canStartSave: false })
    response.resolve(server.apply(request))
    expect(await save).toMatchObject({ status: 'confirmed', operationId: request.operationId })
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it('only retries the exact proposal after an unknown outcome, even after refresh', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    response.reject(new Error('offline'))
    expect(await save).toMatchObject({ status: 'recovery-required', write: 'unknown' })
    await grid.refresh()
    expect(await grid.save()).toMatchObject({ status: 'blocked', issue: { code: 'save-unresolved' } })
    expect(await grid.recoverSave({ operationId: request.operationId, action: 'confirm' })).toMatchObject({ status: 'confirmed' })
    expect(server.source.lookupOperation).toHaveBeenCalledTimes(1)
    expect(server.source.submit.mock.calls.map(([payload]) => payload)).toEqual([request, request])
  })

  it('exposes the same recovery action to callers and the snapshot only while it can run', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    response.reject(new Error('offline'))
    await save
    const action = grid.getSnapshot().persistence.recovery!
    const lookup = deferred<OperationLookup>()
    server.source.lookupOperation.mockImplementationOnce(() => lookup.promise)
    const recovering = grid.recoverSave(action)
    expect(grid.getSnapshot().persistence).toMatchObject({ status: 'saving', canStartSave: false, recovery: null })
    expect(await grid.recoverSave(action)).toMatchObject({ status: 'blocked', issue: { code: 'save-in-progress' } })
    lookup.resolve(server.apply(request))
    expect(await recovering).toMatchObject({ status: 'confirmed' })
    expect(grid.getSnapshot().persistence).toMatchObject({ status: 'idle', canStartSave: true, recovery: null })
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it('retains the receipt and prohibits resending an applied but unreconciled write', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    server.source.readAtLeast.mockRejectedValueOnce(new Error('offline'))
    response.resolve(server.apply(request))
    expect(await save).toMatchObject({ status: 'recovery-required', write: 'applied', recovery: { action: 'refresh' } })
    expect(await grid.save()).toMatchObject({ status: 'blocked' })
    expect(await grid.recoverSave({ operationId: request.operationId, action: 'refresh' })).toMatchObject({ status: 'confirmed' })
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    expect(server.source.lookupOperation).not.toHaveBeenCalled()
  })

  it.each(['auto-save', 'immediate', 'manual-save'] as const)('owns a definitive rejection separately from fresh %s work', async mode => {
    const { grid, edit, server, holdWrite } = await persistenceGrid(mode)
    const { request, response, save } = await holdWrite()
    response.resolve(rejected(request))
    if (save) expect(await save).toMatchObject({ status: 'failed' })
    await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('failed'))
    expect(grid.undo().accepted).toBe(true)
    expect(grid.getCloseState().status).toBe('ready')
    expect(grid.getSnapshot().persistence).toMatchObject({ status: 'idle', canStartSave: true, canRetrySave: false, error: null })
    edit('Fresh work')
    if (mode === 'manual-save') {
      expect(server.source.submit).toHaveBeenCalledTimes(1)
      expect((await grid.save()).status).toBe('confirmed')
    }
    await vi.waitFor(() => expect(grid.getSnapshot().draft.dirtyCells).toEqual([]))
    expect(server.source.submit).toHaveBeenCalledTimes(2)
    expect(server.current().rows[0]?.document.name).toBe('Fresh work')
    expect(grid.destroy().status).toBe('closed')
  })

  it.each(['auto-save', 'immediate'] as const)('saves later edits once after an in-flight %s attempt fails', async mode => {
    const { grid, edit, server, holdWrite } = await persistenceGrid(mode)
    const { request, response } = await holdWrite()
    edit('Edited while sending')
    response.resolve(rejected(request))
    await vi.waitFor(() => expect(grid.getSnapshot().draft.dirtyCells).toEqual([]))
    expect(server.source.submit).toHaveBeenCalledTimes(2)
    expect(server.current().rows[0]?.document.name).toBe('Edited while sending')
    expect(grid.destroy().status).toBe('closed')
  })

  it('consumes edits included before freeze and leaves a rejected request stopped', async () => {
    const { grid, edit, server } = await persistenceGrid('auto-save')
    const read = deferred<ServerAuthority>()
    const reading = deferred<void>()
    server.source.readAtLeast.mockImplementationOnce(() => { reading.resolve(); return read.promise })
    const sending = deferred<FrozenSubmission>(), response = deferred<SourceMutationResult>()
    server.source.submit.mockImplementationOnce(request => { sending.resolve(request); return response.promise })
    vi.useFakeTimers()
    try {
      edit('First')
      await vi.advanceTimersByTimeAsync(20)
      await reading.promise
      edit('Included before freeze')
      read.resolve(server.current())
      const request = await sending.promise
      expect(request.items[0]).toMatchObject({ after: { name: 'Included before freeze' } })
      response.resolve(rejected(request))
      await vi.waitFor(() => expect(grid.getSnapshot().persistence.canRetrySave).toBe(true))
      await vi.advanceTimersByTimeAsync(1000)
      expect(server.source.submit).toHaveBeenCalledTimes(1)
      expect(grid.getCloseState().blockers).toEqual(['unsaved-changes'])
    } finally { vi.useRealTimers() }
  })

  it('fences conflicting application and rejection evidence across save, recovery and close', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    server.source.lookupOperation.mockResolvedValueOnce(rejected(request))
    response.resolve({ kind: 'applied-without-receipt', commitToken: 'application' })
    expect(await save).toMatchObject({ status: 'blocked', issue: { code: 'save-unresolved' } })
    expect(grid.getSnapshot().persistence).toMatchObject({ status: 'failed', recovery: null, canStartSave: false, canRetrySave: false })
    expect(await grid.recoverSave({ operationId: request.operationId, action: 'confirm' })).toMatchObject({ status: 'blocked' })
    const retry = await grid.save()
    expect(retry.status).toBe('blocked')
    expect(retry.remaining).toEqual(grid.getCloseState().blockers)
    expect(retry.remaining).toContain('unsettled-save')
    expect(server.source.lookupOperation).toHaveBeenCalledTimes(1)
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it.each(['applied-first', 'rejection-first'] as const)('blocks every table on conflicting in-flight results arriving %s until verified', async order => {
    const { grid, open, server, dataSource, holdWrite } = await persistenceGrid()
    const peer = open()
    await peer.refresh()
    expect(grid.applyTransaction(transaction => transaction.createRow()).accepted).toBe(true)
    const { request, response, save } = await holdWrite()
    const earlier = deferred<OperationLookup>(), later = deferred<OperationLookup>()
    server.source.lookupOperation.mockImplementationOnce(() => earlier.promise).mockImplementationOnce(() => later.promise)
    const applied = server.apply(request)
    dataSource.publish(server.current())
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(1))
    response.resolve({ kind: 'applied-without-receipt', commitToken: 'application' })
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(2))
    peer.dispatch({ type: 'edit/start', cell: { rowKey: 'b', columnKey: 'name' } })
    peer.dispatch({ type: 'edit/change', value: 'Peer input' })
    if (order === 'applied-first') {
      earlier.resolve(applied)
      expect(await save).toMatchObject({ status: 'confirmed', operationId: request.operationId })
      later.resolve(rejected(request))
    } else {
      later.resolve(rejected(request))
      expect(await save).toMatchObject({ status: 'blocked', issue: { code: 'save-unresolved' } })
      earlier.resolve(applied)
    }
    await vi.waitFor(() => expect(dataSource.getDispute()?.evidence.map(e => e.kind)).toEqual(expect.arrayContaining(['applied', 'not-applied'])))
    const dispute = dataSource.getDispute()!
    const reopened = open()
    for (const instance of [grid, peer, reopened]) {
      await instance.refresh()
      const snapshot = instance.getSnapshot()
      expect(snapshot.persistence.dispute?.id).toBe(dispute.id)
      expect(selectGridActions(snapshot)).toMatchObject({
        save: { enabled: false, issue: { code: 'save-unresolved' } }, retrySave: { enabled: false }, recoverSave: { enabled: false },
      })
      expect(selectGridToolbar(snapshot).canSave).toBe(false)
      expect(await instance.save()).toMatchObject({ status: 'blocked', issue: { code: 'save-unresolved' } })
    }
    expect(peer.getSnapshot().edit?.draftValue).toBe('Peer input')
    expect(peer.getSnapshot().draft.dirtyCells).toEqual([])
    expect(() => dataSource.resolveDispute('obsolete', applied)).toThrow()
    expect(dataSource.getDispute()?.id).toBe(dispute.id)
    dataSource.resolveDispute(dispute.id, applied)
    await vi.waitFor(() => expect(grid.getSnapshot().persistence).toMatchObject({ inFlightOperationId: null, canStartSave: true, dispute: null }))
    expect(grid.getSnapshot().draft.insertedRowKeys).toEqual([])
    expect(peer.getSnapshot().edit?.draftValue).toBe('Peer input')
    expect(selectGridToolbar(peer.getSnapshot()).canSave).toBe(true)
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    expect(await peer.save(selectGridActions(peer.getSnapshot()).save.target)).toMatchObject({ status: 'confirmed' })
    expect(server.current().rows.find(row => row.identity.key === 'b')?.document.name).toBe('Peer input')
    for (const instance of [grid, peer, reopened]) expect(instance.destroy().status).toBe('closed')
  })

  it.each(['preparing', 'awaiting-confirmation'] as const)('keeps a later operation %s when an older lookup raises a dispute', async phase => {
    const { grid, open, dataSource, server, holdWrite } = await persistenceGrid()
    const peer = open()
    await peer.refresh()
    grid.applyTransaction(tx => tx.createRow())
    const first = await holdWrite(), applied = server.apply(first.request)
    const found = deferred<OperationLookup>(), late = deferred<OperationLookup>()
    server.source.lookupOperation.mockImplementationOnce(() => found.promise).mockImplementationOnce(() => late.promise)
    dataSource.publish(server.current())
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(1))
    first.response.resolve({ kind: 'applied-without-receipt', commitToken: 'application' })
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(2))
    found.resolve(applied)
    expect((await first.save)?.status).toBe('confirmed')

    const entered = deferred<void>(), read = deferred<ServerAuthority>(), confirmation = deferred<OperationLookup>()
    let second: FrozenSubmission | undefined
    if (phase === 'preparing') {
      server.source.readAtLeast.mockImplementationOnce(() => { entered.resolve(); return read.promise })
    } else {
      server.source.submit.mockImplementationOnce(async request => {
        second = request
        return { kind: 'applied-without-receipt', commitToken: 'second' }
      })
      server.source.lookupOperation.mockImplementationOnce(() => { entered.resolve(); return confirmation.promise })
    }
    expect(peer.dispatch({ type: 'cell/set-value', cell: { rowKey: 'b', columnKey: 'name' }, value: 'Next operation' }).accepted).toBe(true)
    const saving = peer.save()
    await entered.promise
    late.resolve(rejected(first.request))
    await vi.waitFor(() => expect(dataSource.getDispute()).not.toBeNull())
    const dispute = dataSource.getDispute()!
    if (phase === 'preparing') {
      read.resolve(server.current())
      await vi.waitFor(() => expect(peer.getSnapshot().persistence.inFlightOperationId).not.toBeNull())
      expect(server.source.submit).toHaveBeenCalledTimes(1)
      dataSource.resolveDispute(dispute.id, applied)
    } else {
      confirmation.resolve(server.apply(second!))
    }
    expect(await saving).toMatchObject({ status: 'confirmed' })
    expect(server.current().rows.find(row => row.identity.key === 'b')?.document.name).toBe('Next operation')
    if (phase === 'awaiting-confirmation') {
      expect(peer.getSnapshot().persistence.dispute?.id).toBe(dispute.id)
      dataSource.resolveDispute(dispute.id, applied)
    }
    expect(peer.getCloseState().status).toBe('ready')
    expect(server.source.submit).toHaveBeenCalledTimes(2)
    expect(grid.destroy().status).toBe('closed')
    expect(peer.destroy().status).toBe('closed')
  })

  it('keeps the scope fenced until each pending lookup dispute is resolved separately', async () => {
    const { grid, open, dataSource, server, holdWrite } = await persistenceGrid()
    async function settleCreation(key: string) {
      expect(grid.applyTransaction(tx => tx.createRow()).accepted).toBe(true)
      const { request, response, save } = await holdWrite()
      const found = deferred<OperationLookup>(), late = deferred<OperationLookup>()
      const initialCount = server.source.lookupOperation.mock.calls.length
      server.source.lookupOperation.mockImplementationOnce(() => found.promise).mockImplementationOnce(() => late.promise)
      const applied = server.apply(request, { create: row => ({ ...row, id: key }) })
      dataSource.publish(server.current())
      await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(initialCount + 1))
      response.resolve({ kind: 'applied-without-receipt', commitToken: key })
      await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(initialCount + 2))
      found.resolve(applied)
      expect((await save)?.status).toBe('confirmed')
      return { applied, late, request }
    }
    const first = await settleCreation('assigned-1'), second = await settleCreation('assigned-2')
    const raised = new Set<string>()
    const unsubscribe = dataSource.subscribeDisputes(event => { if (event.kind === 'disputed') raised.add(event.ref.operationId) })
    first.late.resolve(rejected(first.request))
    second.late.resolve(rejected(second.request))
    await vi.waitFor(() => expect(raised.size).toBe(2))
    const reopened = open()
    await reopened.refresh()
    const active = dataSource.getDispute()!
    const firstToResolve = active.ref.operationId === first.request.operationId ? first : second
    const last = firstToResolve === first ? second : first
    dataSource.resolveDispute(active.id, firstToResolve.applied)
    expect(reopened.getSnapshot().persistence.dispute?.operationId).toBe(last.request.operationId)
    expect((await reopened.save()).status).toBe('blocked')
    dataSource.resolveDispute(dataSource.getDispute()!.id, last.applied)
    expect(grid.getSnapshot().persistence.canStartSave).toBe(true)
    expect(reopened.getSnapshot().persistence.canStartSave).toBe(true)
    expect(server.source.submit).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(grid.destroy().status).toBe('closed')
    expect(reopened.destroy().status).toBe('closed')
  })

  it('resumes peer automatic work after the host clears the scope fence', async () => {
    const { grid, open, dataSource, server, holdWrite } = await persistenceGrid()
    const peer = open()
    await peer.refresh()
    const { request, response, save } = await holdWrite()
    const verified = rejected(request)
    server.source.lookupOperation.mockResolvedValueOnce(verified)
    response.resolve({ kind: 'applied-without-receipt', commitToken: 'application' })
    await save
    expect(peer.dispatch({ type: 'persistence/set-mode', mode: 'immediate' }).accepted).toBe(true)
    peer.dispatch({ type: 'cell/set-value', cell: { rowKey: 'b', columnKey: 'name' }, value: 'After review' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    dataSource.resolveDispute(dataSource.getDispute()!.id, verified)
    await vi.waitFor(() => expect(server.source.submit).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(peer.getCloseState().status).toBe('ready'))
    expect(server.current().rows.find(row => row.identity.key === 'b')?.document.name).toBe('After review')
    expect(grid.undo().accepted).toBe(true)
    expect(grid.destroy().status).toBe('closed')
    expect(peer.destroy().status).toBe('closed')
  })

  it('checks the shared fence when a subscriber calls save before the peer notification', async () => {
    const { dataSource, open, server, holdWrite } = await persistenceGrid()
    const called = deferred<ReturnType<ReturnType<typeof open>['save']>>()
    const unsubscribe = dataSource.subscribeDisputes(event => {
      if (event.kind === 'disputed') called.resolve(peer.save())
    })
    const peer = open()
    await peer.refresh()
    peer.dispatch({ type: 'edit/start', cell: { rowKey: 'b', columnKey: 'name' } })
    peer.dispatch({ type: 'edit/change', value: 'Pending' })
    const { request, response, save } = await holdWrite()
    server.source.lookupOperation.mockResolvedValueOnce(rejected(request))
    response.resolve({ kind: 'applied-without-receipt', commitToken: 'application' })
    await save
    expect(await called.promise).toMatchObject({ status: 'blocked', issue: { code: 'save-unresolved' } })
    expect(peer.getSnapshot().edit?.draftValue).toBe('Pending')
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('restores a rejected operation to its original draft after the host verifies non-application', async () => {
    const { grid, dataSource, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    const proof = rejected(request)
    server.source.lookupOperation.mockResolvedValueOnce(proof)
    response.resolve({ kind: 'applied-without-receipt', commitToken: 'application' })
    expect(await save).toMatchObject({ status: 'blocked' })
    const dispute = dataSource.getDispute()!
    dataSource.resolveDispute(dispute.id, proof)
    expect(grid.getSnapshot().persistence).toMatchObject({ canStartSave: true, inFlightOperationId: null, dispute: null })
    expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(1)
    expect(selectGridActions(grid.getSnapshot()).retrySave.enabled).toBe(true)
    expect((await grid.save()).status).toBe('confirmed')
    expect(server.source.submit).toHaveBeenCalledTimes(2)
  })

  it('keeps manual actions and editor state consistent during recovery and rejects a stale save target', async () => {
    const { grid, holdWrite, server } = await persistenceGrid()
    const { response, save } = await holdWrite()
    response.reject(new Error('offline'))
    await save
    grid.dispatch({ type: 'edit/start', cell: { rowKey: 'b', columnKey: 'name' } })
    grid.dispatch({ type: 'edit/change', value: 'Preserve this input' })
    const snapshot = grid.getSnapshot(), actions = selectGridActions(snapshot)
    expect(actions.save).toMatchObject({ enabled: false, issue: { code: 'save-unresolved' } })
    expect(selectGridToolbar(snapshot).canSave).toBe(false)
    expect(await grid.save(actions.save.target)).toMatchObject({ status: 'blocked', issue: actions.save.issue })
    expect(grid.getSnapshot().edit?.draftValue).toBe('Preserve this input')
    expect(actions.recoverSave.enabled).toBe(true)
    expect((await grid.recoverSave(actions.recoverSave.target!)).status).toBe('confirmed')
    const current = selectGridActions(grid.getSnapshot()).save
    expect(current.enabled).toBe(true)
    grid.dispatch({ type: 'edit/cancel' })
    const expired = selectGridActions(grid.getSnapshot(), current.target).save
    expect(expired.issue?.code).toBe('stale-target')
    expect(expired.target).toEqual(current.target)
    expect(await grid.save(expired.target)).toMatchObject({ status: 'blocked', issue: { code: 'stale-target' } })
    expect(server.source.submit).toHaveBeenCalledTimes(2)
  })

  it('rechecks the origin of a save advertised from a row target', async () => {
    const { grid, edit, server, dataSource } = await persistenceGrid()
    edit('Draft A')
    const before = grid.getSnapshot()
    const origin = { kind: 'row' as const, rowKey: 'b', entityId: before.draft.entityAt('b')! }
    const authorized = selectGridActions(before, origin).save
    expect(authorized.enabled).toBe(true)
    const newer = server.snapshot([{ id: 'a', name: 'Initial', count: 0 }, { id: 'b', name: 'Replaced', count: 0 }], 2)
    const replacement = { key: 'b', incarnation: 'replacement' }
    const changed = { ...newer, rows: newer.rows.map(row => row.identity.key === 'b' ? { ...row, identity: replacement } : row),
      order: newer.order.map(identity => identity.key === 'b' ? replacement : identity) }
    server.install(changed)
    dataSource.publish(changed)
    expect(selectGridActions(grid.getSnapshot(), authorized.target).save.issue?.code).toBe('stale-target')
    expect(await grid.save(authorized.target)).toMatchObject({ status: 'blocked', issue: { code: 'stale-target' } })
    expect(server.source.submit).not.toHaveBeenCalled()
    expect((await grid.save()).status).toBe('confirmed')
    expect(grid.destroy().status).toBe('closed')
  })

  it('distinguishes definitive rejection from an unknown result and allows a new proposal', async () => {
    const { grid, server, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    response.resolve(rejected(request))
    expect(await save).toMatchObject({ status: 'failed', operationId: request.operationId })
    expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(1)
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    expect(server.source.submit.mock.calls[1]![0].operationId).not.toBe(request.operationId)
  })
})
