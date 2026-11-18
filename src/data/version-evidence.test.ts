import { describe, expect, it, vi } from 'vitest'
import { createDataGridBinding } from '../index.js'
import { persistenceGateway } from '../kernel/gateway.js'
import { kernelId, type AuthorityVersion, type FrozenSubmission, type OperationLookup } from '../kernel/model.js'
import { hashSubmission, type ServerAuthority, type SourceMutationResult } from '../kernel/source.js'
import { deferred, rejected, testAuthority, testGridSource } from '../../tests/unit/authority.js'
import { cell, nameColumn, persistenceGrid } from '../../tests/unit/persistence-grid.js'
import { createFieldGridDocumentModel, createRemoteGridDataSource } from './remote-data-source.js'

const original = { id: 'a', name: 'original', count: 0 }

const causal = (stamp: string, ...parents: string[]): AuthorityVersion => ({
  kind: 'causal', token: stamp, stamp: kernelId<'causal-stamp'>(stamp), covers: parents.map(parent => kernelId<'causal-stamp'>(parent)),
})

async function deletionReservation(protocol: 'ordered' | 'causal') {
  const server = testAuthority([original]), base = server.current()
  const source = { ...server.source, capabilities: { ...server.source.capabilities, authorityOrder: protocol } }
  const gateway = persistenceGateway(source), authority = gateway.authority(server.scope)
  const version = (position: number, ...parents: number[]) => protocol === 'ordered' ? server.snapshot([], position).version
    : causal(String(position), ...parents.map(String))
  const baseAuthority = version(1)
  authority.publish({ ...base, version: baseAuthority })
  const intent = kernelId<'intent'>('intent'), id = kernelId<'item'>('delete'), row = base.rows[0]!
  const payload: FrozenSubmission = {
    scope: server.scope, workspaceId: kernelId<'workspace'>('workspace'), schema: kernelId<'schema-version'>('1'),
    operationId: kernelId<'operation'>('remove-a'), payloadHash: kernelId<'payload-hash'>('unhashed'), baseAuthority,
    items: [{ kind: 'delete', id, entityId: kernelId<'entity'>('row-a'), identity: row.identity, before: row.document }],
    frontier: [intent], coverage: [{ itemId: id, intentIds: [intent] }],
  }
  const request = { ...payload, payloadHash: await hashSubmission(payload) }
  const permit = await gateway.acquire(server.scope, request.workspaceId, 'save')
  const applied = server.apply(request)
  const receipt = (committedVersion: AuthorityVersion): typeof applied => ({ ...applied, receipt: { ...applied.receipt, committedVersion } })
  return { server, authority, gateway, permit, request, version, receipt }
}

describe('physical scope version evidence', () => {
  it.each(['push', 'seed', 'delayed read'] as const)('validates ordered history before recording a %s', async entry => {
    const { server, dataSource } = testGridSource([original], [nameColumn])
    const late = deferred<ServerAuthority>()
    if (entry === 'delayed read') server.source.readAtLeast.mockReturnValueOnce(late.promise)
    const oldRead = entry === 'delayed read' ? dataSource.readAtLeast([]) : null
    dataSource.publish(server.snapshot([original], 3))
    const removed = server.snapshot([], 2)
    if (oldRead) {
      late.resolve(removed)
      await expect(oldRead).rejects.toThrow(/retired/)
    } else if (entry === 'push') expect(() => dataSource.publish(removed)).toThrow(/retired/)
    else {
      const { source, scope, getRowKey, model, columns, persistence } = dataSource
      expect(() => createRemoteGridDataSource({ source, scope, getRowKey, model, columns, persistence, initialAuthority: removed })).toThrow(/retired/)
    }
    expect(() => dataSource.publish({ ...server.snapshot([original], 2), observation: removed.observation })).not.toThrow()
    expect(dataSource.getSnapshot()?.version.token).toBe('v3')
  })

  it.each([[1, 2, 3], [2, 3, 1], [3, 1, 2]])('checks ordered identity continuity in arrival order %i, %i, %i', (one, two, three) => {
    const server = testAuthority([])
    const dataSource = createRemoteGridDataSource({ source: server.source, scope: server.scope, columns: [nameColumn],
      model: createFieldGridDocumentModel([nameColumn]), getRowKey: row => row.id, persistence: { mode: 'manual-save' } })
    const observe = (position: number) => dataSource.publish(server.snapshot(position === 2 ? [] : [original], position))
    observe(one)
    observe(two)
    expect(() => observe(three)).toThrow(/retired/)
  })

  it.each(['ordered', 'causal'] as const)('validates later incarnations against a %s deletion receipt without its commit snapshot', async protocol => {
    const { server, authority, gateway, permit, request, version, receipt } = await deletionReservation(protocol)
    const applied = receipt(version(2, 1))
    server.source.submit.mockResolvedValueOnce(applied)
    expect(await gateway.submit(permit, request)).toMatchObject(applied)
    const corrupt = { ...server.snapshot([original], 3), version: version(3, 2) }
    expect(() => authority.publish(corrupt)).toThrow(/retired/)
    const identity = { key: original.id, incarnation: 'replacement' }
    expect(authority.publish({ ...corrupt, rows: [{ identity, document: original }], order: [identity] }).order).toEqual([identity])
  })

  it.each(['ordered', 'causal'] as const)('checks a late %s receipt against a version first seen by a peer', async protocol => {
    const { server, authority, gateway, permit, request, version, receipt } = await deletionReservation(protocol)
    const committedVersion = version(2, 1)
    authority.publish({ ...server.snapshot([original], 2), version: committedVersion })
    server.source.submit.mockResolvedValueOnce(receipt(committedVersion))
    expect(await gateway.submit(permit, request)).toMatchObject({ kind: 'applied-without-receipt' })
    const corrected = receipt(version(3, 2))
    server.source.lookupOperation.mockResolvedValueOnce(corrected)
    expect(await gateway.lookup(permit, request)).toMatchObject({ kind: 'applied', receipt: { committedVersion: { token: corrected.receipt.committedVersion.token } } })
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it.each(['scope', 'operationId', 'payloadHash'] as const)('checks receipt %s before interpreting application evidence', async field => {
    const { server, gateway, permit, request, version, receipt } = await deletionReservation('ordered')
    const expected = receipt(version(2))
    const other = { ...expected, receipt: { ...expected.receipt, [field]: field === 'scope'
      ? { ...server.scope, id: kernelId<'scope'>('elsewhere') } : 'other' } }
    server.source.lookupOperation.mockResolvedValueOnce(other)
    expect(await gateway.lookup(permit, request)).toMatchObject({ kind: 'unknown' })
    const rejection = rejected(request)
    server.source.submit.mockResolvedValueOnce(rejection)
    expect(await gateway.submit(permit, request)).toEqual(rejection)
    server.source.lookupOperation.mockResolvedValueOnce(other)
    expect(await gateway.lookup(permit, request)).toEqual(rejection)
    server.source.lookupOperation.mockResolvedValueOnce({ ...expected, receipt: { ...expected.receipt, results: [] } })
    expect(await gateway.lookup(permit, request)).toEqual(rejection)
    expect(gateway.getDispute(server.scope)).toBeNull()
    server.source.lookupOperation.mockResolvedValueOnce(expected)
    expect(await gateway.lookup(permit, request)).toMatchObject({ kind: 'disputed' })
  })

  it.each([true, false])('requires the missing causal edge before disputing a rejection, receipt first=%s', async receiptFirst => {
    const { server, authority, gateway, permit, request, version, receipt } = await deletionReservation('causal')
    const rejection = rejected(request), candidate = receipt(version(3, 2))
    const responses = receiptFirst ? [candidate, rejection] : [rejection, candidate]
    for (const result of responses) {
      server.source.lookupOperation.mockResolvedValueOnce(result)
      expect((await gateway.lookup(permit, request)).kind).not.toBe('disputed')
    }
    expect(gateway.getDispute(server.scope)).toBeNull()
    authority.publish({ ...server.snapshot([original], 2), version: version(2, 1) })
    expect(gateway.getDispute(server.scope)?.evidence).toEqual(expect.arrayContaining([candidate, rejection]))
  })

  it('combines preliminary ancestry from repeated lookups and rejects incompatible candidate receipts', async () => {
    const { server, authority, gateway, permit, request, version, receipt } = await deletionReservation('causal')
    server.source.submit.mockResolvedValueOnce(receipt(version(4, 2)))
    const receive = vi.fn()
    expect(await gateway.submit(permit, request, receive)).toMatchObject({ kind: 'applied-without-receipt' })
    server.source.lookupOperation.mockResolvedValueOnce(receipt(version(4, 3)))
    expect(await gateway.lookup(permit, request)).toMatchObject({ kind: 'applied-without-receipt' })
    authority.publish({ ...server.snapshot([original], 2), version: version(2, 1) })
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ kind: 'applied' }))
    const proof = receive.mock.calls[0]![0].receipt.committedVersion
    expect(new Set(proof.covers)).toEqual(new Set(['1', '2', '3']))

    const other = await deletionReservation('causal')
    other.server.source.submit.mockResolvedValueOnce(other.receipt(other.version(4, 2)))
    expect(await other.gateway.submit(other.permit, other.request)).toMatchObject({ kind: 'applied-without-receipt' })
    other.server.source.lookupOperation.mockResolvedValueOnce(other.receipt(other.version(5, 2)))
    expect(await other.gateway.lookup(other.permit, other.request)).toMatchObject({ kind: 'disputed' })
  })

  it.each([
    ['submit', 'receipt then snapshot'], ['submit', 'snapshot then receipt'],
    ['lookup', 'receipt then snapshot'], ['lookup', 'snapshot then receipt'],
  ] as const)('keeps corrected canonical rows admissible after a bad %s result, %s', async (entry, order) => {
    const { server, grid, dataSource, holdWrite } = await persistenceGrid()
    const { request, response, save } = await holdWrite()
    const correct = server.apply(request), snapshot = server.current()
    const invalid = { ...correct, receipt: { ...correct.receipt, results: correct.receipt.results.map(item => item.kind === 'updated'
      ? { ...item, canonical: { ...item.canonical, id: 'foreign-key' } } : item) } }
    const lookup = deferred<typeof correct>()
    if (entry === 'lookup') server.source.lookupOperation.mockResolvedValueOnce(invalid)
    server.source.lookupOperation.mockReturnValueOnce(lookup.promise)
    if (order === 'snapshot then receipt') dataSource.publish(snapshot)
    response.resolve(entry === 'submit' ? invalid : { kind: 'applied-without-receipt', commitToken: 'application' })
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(1))
    let recovered
    if (entry === 'lookup') {
      const outcome = await save
      if (outcome?.status !== 'recovery-required') throw new Error('Expected original submission to require confirmation')
      recovered = grid.recoverSave(outcome.recovery)
    }
    expect(grid.getSnapshot().persistence.inFlightOperationId).toEqual(request.operationId)
    expect(() => dataSource.publish(snapshot)).not.toThrow()
    lookup.resolve(correct)
    await vi.waitFor(() => expect(grid.getSnapshot().draft.dirtyCells).toEqual([]))
    await Promise.all([save, recovered])
    expect(grid.getSnapshot().source.rows[0]).toMatchObject({ id: 'a', name: 'Submitted' })
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    expect(grid.destroy().status).toBe('closed')
  })

  it('delivers the receipt frontier to already-open peers using independent source transports', async () => {
    const { server, grid, dataSource, holdWrite } = await persistenceGrid()
    const peerRead = deferred<ServerAuthority>()
    const read = vi.fn(async () => server.current())
    const peerSource = createRemoteGridDataSource({ scope: server.scope, columns: dataSource.columns, model: dataSource.model,
      getRowKey: dataSource.getRowKey, persistence: dataSource.persistence, source: { ...server.source, readAtLeast: read } })
    const peer = createDataGridBinding({ dataSource: peerSource }).controller
    await peer.refresh()
    const events: string[] = []
    const stop = peerSource.subscribe(event => events.push(event.kind))
    const { request, response, save } = await holdWrite(), result = server.apply(request)
    events.length = 0
    read.mockImplementationOnce(async () => peerRead.promise)
    server.source.readAtLeast.mockRejectedValueOnce(new Error('writer transport offline'))
    response.resolve(result)
    expect(await save).toMatchObject({ status: 'recovery-required' })
    expect(read).toHaveBeenLastCalledWith(server.scope, [result.receipt.committedVersion])
    expect(events).toEqual(['required'])
    peerRead.resolve(server.current())
    await vi.waitFor(() => expect(events).toEqual(['required', 'snapshot']))
    expect(peer.getSnapshot().source.version).toBe('v2')
    expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    stop()
    peer.destroy()
    grid.destroy()
  })

  it.each([false, true])('attributes a past lookup after the next write starts, second operation disputed=%s', async disputeBoth => {
    const { grid, open, server, dataSource, holdWrite } = await persistenceGrid()
    const peer = open()
    await peer.refresh()
    expect(grid.applyTransaction(transaction => transaction.createRow()).accepted).toBe(true)
    const first = await holdWrite(), early = deferred<OperationLookup>(), late = deferred<OperationLookup>()
    server.source.lookupOperation.mockReturnValueOnce(early.promise).mockReturnValueOnce(late.promise)
    const firstApplied = server.apply(first.request)
    dataSource.publish(server.current())
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(1))
    first.response.resolve({ kind: 'applied-without-receipt', commitToken: 'first-report' })
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(2))
    early.resolve(firstApplied)
    expect(await first.save).toMatchObject({ status: 'confirmed' })

    const sent = deferred<FrozenSubmission>(), answer = deferred<SourceMutationResult>()
    server.source.submit.mockImplementationOnce(request => { sent.resolve(request); return answer.promise })
    expect(peer.dispatch({ type: 'cell/set-value', cell: { ...cell, rowKey: 'b' }, value: 'second write' }).accepted).toBe(true)
    const secondSave = peer.save(), second = await sent.promise
    late.resolve(rejected(first.request))
    await vi.waitFor(() => expect(dataSource.getDispute()?.ref.operationId).toEqual(first.request.operationId))
    const earlierDispute = dataSource.getDispute()!
    expect(peer.getSnapshot().persistence.inFlightOperationId).toBe(second.operationId)
    const secondApplied = server.apply(second)
    if (disputeBoth) {
      server.source.lookupOperation.mockResolvedValueOnce(rejected(second))
      answer.resolve({ kind: 'applied-without-receipt', commitToken: 'second-report' })
      expect(await secondSave).toMatchObject({ status: 'blocked' })
      const reports: string[] = []
      const stop = dataSource.subscribeDisputes(event => { if (event.kind === 'disputed') reports.push(event.id) })
      expect(reports).toHaveLength(2)
      const current = dataSource.getDispute(reports[1])!
      expect(current.ref.operationId).toBe(second.operationId)
      dataSource.resolveDispute(current.id, secondApplied)
      await vi.waitFor(() => expect(peer.getSnapshot().persistence.inFlightOperationId).toBeNull())
      stop()
    } else {
      answer.resolve(secondApplied)
      expect(await secondSave).toMatchObject({ status: 'confirmed', operationId: second.operationId })
    }
    expect(peer.getSnapshot().source.rows.find(row => row.id === 'b')?.name).toBe('second write')
    expect(peer.getSnapshot().persistence.canStartSave).toBe(false)
    expect(dataSource.getDispute()?.id).toBe(earlierDispute.id)
    dataSource.resolveDispute(earlierDispute.id, firstApplied)
    expect(peer.getSnapshot().persistence.canStartSave).toBe(true)
    expect(server.source.submit).toHaveBeenCalledTimes(2)
    grid.destroy()
    peer.destroy()
  })

  it('keeps original row decoders for a lookup that returns after its controller closes', async () => {
    const { grid, server, holdWrite, dataSource } = await persistenceGrid()
    expect(grid.applyTransaction(tx => tx.createRow()).accepted).toBe(true)
    const { request, response, save } = await holdWrite()
    const early = deferred<OperationLookup>(), late = deferred<OperationLookup>()
    server.source.lookupOperation.mockReturnValueOnce(early.promise).mockReturnValueOnce(late.promise)
    const applied = server.apply(request)
    dataSource.publish(server.current())
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(1))
    response.resolve({ kind: 'applied-without-receipt', commitToken: 'original' })
    await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(2))
    early.resolve(applied)
    expect(await save).toMatchObject({ status: 'confirmed' })
    expect(grid.destroy().status).toBe('closed')
    const later = server.snapshot([], 3).version
    late.resolve({ ...applied, receipt: { ...applied.receipt, committedVersion: later,
      results: applied.receipt.results.map(item => item.kind === 'updated' ? { ...item, canonical: { ...item.canonical, id: 'wrong' } } : item),
    } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(dataSource.getDispute()).toBeNull()
    expect(dataSource.getSnapshot()?.version.token).toBe(applied.receipt.committedVersion.token)
  })

  it('lets an authoritative rejection settle an earlier unusable receipt and preserves the edit', async () => {
    const { grid, server, holdWrite, dataSource } = await persistenceGrid()
    const { request, response, save } = await holdWrite(), before = server.current()
    const applied = server.apply(request)
    server.install(before)
    server.source.lookupOperation.mockResolvedValueOnce(rejected(request))
    response.resolve({ ...applied, receipt: { ...applied.receipt, results: applied.receipt.results.map(item => item.kind === 'updated'
      ? { ...item, canonical: { ...item.canonical, id: 'wrong' } } : item) } })
    await save
    await vi.waitFor(() => expect(grid.getSnapshot().persistence).toMatchObject({ canStartSave: true, inFlightOperationId: null }))
    expect(dataSource.getDispute()).toBeNull()
    expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(1)
    expect(server.source.submit).toHaveBeenCalledTimes(1)
  })

  it('generations fence stale host decisions and all issued lookups contribute evidence', async () => {
    const { server, gateway, permit, request, receipt, version } = await deletionReservation('ordered')
    const answers = Array.from({ length: 6 }, () => deferred<OperationLookup>())
    const queries = []
    for (const answer of answers) {
      server.source.lookupOperation.mockReturnValueOnce(answer.promise)
      queries.push(gateway.lookup(permit, request))
      await vi.waitFor(() => expect(server.source.lookupOperation).toHaveBeenCalledTimes(queries.length))
    }
    const applied = receipt(version(2)), rejection = rejected(request)
    answers[0]!.resolve(applied)
    expect(await queries[0]).toMatchObject({ kind: 'applied' })
    answers[1]!.resolve(rejection)
    expect(await queries[1]).toMatchObject({ kind: 'disputed' })
    const first = gateway.getDispute(server.scope)!
    expect(first.evidence).toEqual(expect.arrayContaining([applied, rejection]))
    const invalid: OperationLookup[] = [
      { ...rejection, proof: { ...rejection.proof, rejectionToken: '' } },
      { ...applied, receipt: { ...applied.receipt, results: [] } },
      receipt(version(0)),
    ]
    for (const [index, result] of invalid.entries()) {
      answers[2 + index]!.resolve(result)
      await queries[2 + index]
      expect(gateway.getDispute(server.scope)).toBe(first)
    }
    answers[5]!.resolve(rejected(request, 'other definitive reason'))
    await queries[5]
    const current = gateway.getDispute(server.scope)!
    expect(current.id).not.toBe(first.id)
    expect(() => gateway.resolveDispute(server.scope, first.id, applied)).toThrow(/current/)
    expect(() => gateway.resolveDispute(server.scope, current.id, rejection)).toThrow(/epoch/)
    expect(() => gateway.resolveDispute(server.scope, current.id, { ...applied, receipt: {
      ...applied.receipt, payloadHash: kernelId<'payload-hash'>('foreign'),
    } })).toThrow(/match/)
    gateway.resolveDispute(server.scope, current.id, applied)
    expect(gateway.getDispute(server.scope)).toBeNull()
    expect(await gateway.submit(permit, request)).toMatchObject(applied)
    expect(server.source.submit).not.toHaveBeenCalled()
  })

  it.each(['ancestry before receipt', 'commit snapshot before receipt', 'ancestry after receipt'] as const)(
    'settles the same exact receipt with %s', async order => {
      const server = testAuthority([original])
      const snapshot = (stamp: string, ...parents: string[]): ServerAuthority => ({
        ...server.current(), observation: kernelId<'observation'>(crypto.randomUUID()),
        version: causal(stamp, ...parents),
      })
      const sent = deferred<FrozenSubmission>(), reply = deferred<Extract<OperationLookup, { kind: 'applied' }>>()
      let remote = snapshot('A')
      const source = { ...server.source, capabilities: { ...server.source.capabilities, authorityOrder: 'causal' as const },
        readAtLeast: vi.fn(async () => remote),
        submit: vi.fn(async (request: FrozenSubmission) => { sent.resolve(request); return reply.promise }),
        lookupOperation: vi.fn(async () => reply.promise),
      }
      const dataSource = createRemoteGridDataSource({ source, scope: server.scope, columns: [nameColumn],
        model: createFieldGridDocumentModel([nameColumn]), getRowKey: row => row.id, initialAuthority: remote,
        persistence: { mode: 'manual-save' } })
      const grid = createDataGridBinding({ dataSource }).controller
      await grid.refresh()
      expect(grid.dispatch({ type: 'cell/set-value', cell, value: 'saved' }).accepted).toBe(true)
      const save = grid.save(), request = await sent.promise
      expect(request.baseAuthority.token).toBe('A')
      const intermediate = snapshot('B', 'A')
      const applied = server.apply(request)
      remote = snapshot('C', 'B')
      const receipt = { ...applied.receipt, committedVersion: remote.version }
      if (order !== 'ancestry after receipt') dataSource.publish(intermediate)
      if (order === 'commit snapshot before receipt') dataSource.publish(remote)
      reply.resolve({ kind: 'applied', receipt })
      if (order === 'ancestry after receipt') {
        await vi.waitFor(() => expect(source.lookupOperation).toHaveBeenCalled())
        dataSource.publish(intermediate)
      }
      const outcome = await save
      if (order !== 'ancestry after receipt') expect(outcome.status).toBe('confirmed')
      await vi.waitFor(() => expect(grid.getSnapshot().draft.dirtyCells).toEqual([]))
      expect(grid.getSnapshot().source.version).toBe('C')
      expect(grid.getSnapshot().draft.rows[0]?.name).toBe('saved')
      expect(source.submit).toHaveBeenCalledTimes(1)
      expect(grid.destroy().status).toBe('closed')
      // Local coverage expansion is evidence; the original wire receipt stays unchanged.
      expect((receipt.committedVersion as Extract<AuthorityVersion, { kind: 'causal' }>).covers).toEqual(['B'])
      if (order === 'commit snapshot before receipt') {
        // On reopening a reservation, repeated lookup must return the original
        // canonical item outcome even when the proof graph has grown.
        const gateway = persistenceGateway(source)
        const permit = await gateway.acquire(server.scope, request.workspaceId, 'recovery')
        const first = await gateway.lookup(permit, request)
        dataSource.publish(snapshot('C', 'B', 'another predecessor'))
        expect(await gateway.lookup(permit, request)).toEqual(first)
      }
    })
})
