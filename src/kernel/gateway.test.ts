import { createKernelState } from './state.js'
import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { deferred, SourceFixture } from '../../tests/kernel/source-fixture.js'
import { persistenceGateway } from './gateway.js'
import { kernelId, type Document, type FrozenSubmission } from './model.js'
import { bindServerAuthority, hashSubmission, unboundServerIdentities, type PersistenceSource, type ServerAuthority, type SourceMutationResult } from './source.js'
import { draftSubmission } from './submission.js'

let serial = 0
function workspace(initial: Readonly<Record<string, Document>>, sourceId = `gateway-source:${++serial}`) {
  const fixture = new KernelFixture()
  fixture.state = createKernelState({ ...fixture.state.workspace, id: kernelId<'workspace'>(`workspace:${++serial}`), scope: { ...fixture.state.workspace.scope, sourceId } }, fixture.state.policy)
  fixture.observe(initial, 0)
  return fixture
}
async function freeze(fixture: KernelFixture): Promise<FrozenSubmission> {
  const id = ++serial
  const draft = draftSubmission(fixture.state, { operationId: kernelId<'operation'>(`gateway-operation:${id}`),
    items: fixture.project().changes.map(change => ({ entityId: change.entityId, itemId: kernelId<'item'>(`gateway-item:${id}:${change.entityId}`) })),
  }, fixture.schema)
  const submission = { ...draft.payload, payloadHash: await hashSubmission(draft.payload) }
  const result = fixture.dispatch({ kind: 'freeze-submission', prepared: { revision: draft.revision, submission } })
  expect(result.result.kind).toBe('accepted')
  return submission
}
function observe(fixture: KernelFixture, snapshot: ServerAuthority) {
  const allocations = unboundServerIdentities(fixture.state, snapshot).map(identity => ({ identity, entityId: kernelId<'entity'>(`allocated:${++serial}`) }))
  const result = fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, snapshot, allocations) })
  expect(result.result.kind).toBe('accepted')
}
function accept(fixture: KernelFixture, submission: FrozenSubmission, result: SourceMutationResult) {
  if (result.kind === 'applied') fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt })
  else if (result.kind === 'not-applied') fixture.dispatch({ kind: 'not-applied', proof: result.proof })
  else if (result.kind === 'applied-without-receipt') fixture.dispatch({ kind: 'applied-without-receipt', ref: submission, commitToken: result.commitToken })
  else fixture.dispatch({ kind: 'mutation-uncertain', ref: submission, attempt: fixture.state.persistence.kind === 'sending' ? fixture.state.persistence.attempt : 1,
    issue: result.kind === 'unknown' ? result.issue : { code: 'pending', message: 'The operation is still pending' },
  })
}

describe('shared persistence gateway', () => {
  it('rejects changed content at the same authority version and accepts a subsequent consistent read', async () => {
    const fixture = workspace({ a: { x: 0, hidden: 7 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0, hidden: 7 } })
    const gateway = persistenceGateway(source), scope = fixture.state.workspace.scope
    const original = await gateway.readAtLeast(scope, [])
    observe(fixture, original)
    fixture.apply([fixture.write('a', { x: 2 })], 'row', 'retained edit')
    const before = fixture.state
    source.readHook = async () => ({ ...original, rows: original.rows.map(row => ({ ...row, document: { x: 99, hidden: 99 } })) })
    await expect(gateway.readAtLeast(scope, [])).rejects.toThrow('inconsistent complete content')
    expect(fixture.state).toBe(before)
    source.readHook = null
    const consistent = await gateway.readAtLeast(scope, [])
    expect(consistent.rows).toEqual(original.rows)
    observe(fixture, consistent)
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 2, hidden: 7 })
    expect(fixture.state.inputs).toEqual(before.inputs)
    expect(source.writes).toBe(0)
    expect(source.requests).toEqual([])
  })

  it('reconstructs a cold gateway terminal from a durable receipt without bypassing the authority barrier', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    const oldRead = source.snapshot()
    fixture.apply([fixture.write('a', { x: 1 })])
    const submission = await freeze(fixture)
    // No gateway has existed in this process for the committed operation.
    const result = await source.submit(submission)
    expect(result.kind).toBe('applied')
    accept(fixture, submission, result)
    const gateway = persistenceGateway(source)
    const recovered = await gateway.acquireRecovery(fixture.state, 'cold-recovery', { epoch: 'new-process', isActive: () => true })
    expect(recovered.submission).toEqual(submission)
    expect(() => gateway.releaseSettled(recovered.permit, fixture.state)).toThrow('kernel still reserves')
    source.readHook = async () => oldRead
    await expect(gateway.readAtLeast(fixture.state.workspace.scope, [])).rejects.toThrow('frontier')
    source.readHook = null
    observe(fixture, await gateway.readAtLeast(fixture.state.workspace.scope, []))
    gateway.releaseSettled(recovered.permit, fixture.state)
    expect(source.requests).toHaveLength(1)
    expect(source.lookups).toBe(0)
    expect(fixture.project().rows[0]!.preview).toEqual({ x: 1 })
    const next = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'next')
    gateway.abandonUnused(next)
  })

  it('binds a queued source snapshot against exact creation evidence accepted after its candidate IDs were allocated', async () => {
    const fixture = workspace({}), source = new SourceFixture(fixture.state.workspace.scope, {}), gateway = persistenceGateway(source)
    const local = kernelId<'entity'>('local-created')
    fixture.apply([{ kind: 'create', entityId: local, document: { x: 1 } }])
    const submission = await freeze(fixture), permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'create')
    const result = await gateway.submit(permit, submission), snapshot = await source.readAtLeast()
    const candidates = snapshot.rows.map(row => ({ identity: row.identity, entityId: kernelId<'entity'>(`unused:${++serial}`) }))
    accept(fixture, submission, result)
    expect(fixture.dispatch({ kind: 'server-authority-received', snapshot, candidates }).result.kind).toBe('accepted')
    expect(fixture.project().rows.map(row => row.entityId)).toEqual([local])
    expect(fixture.state.entities.some(entry => candidates.some(candidate => candidate.entityId === entry.entityId))).toBe(false)
    gateway.releaseSettled(permit, fixture.state)
  })

  it('checks the executor lease again after hashing and refuses recovery without exact durable operation evidence', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    let active = true
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'old', { epoch: 'old', isActive: () => active })
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    const pending = gateway.submit(permit, submission)
    active = false
    await expect(pending).rejects.toThrow('fenced')
    expect(source.requests).toEqual([])
    const next = await gateway.acquireRecovery(fixture.state, 'new', { epoch: 'new', isActive: () => true })
    expect(next.submission).toEqual(submission)
    accept(fixture, submission, await gateway.submit(next.permit, submission))
    observe(fixture, await gateway.readAtLeast(fixture.state.workspace.scope, fixture.state.authorityFrontier))
    gateway.releaseSettled(next.permit, fixture.state)
    expect(source.writes).toBe(1)
  })

  it('rejects a restored root that omits the old holder\'s operation and preserves the scope for proper recovery', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    let active = true
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'old', { epoch: 'old', isActive: () => active })
    const incomplete = fixture.state
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    source.submitHook = async (_request, execute) => { execute(); throw new Error('Lost network receipt') }
    await gateway.submit(permit, submission); active = false
    const nextFence = { epoch: 'new', isActive: () => true }
    await expect(gateway.acquireRecovery(incomplete, 'missing', nextFence)).rejects.toThrow('lacks evidence')
    const inherited = await gateway.acquireRecovery(fixture.state, 'complete', nextFence)
    accept(fixture, submission, await gateway.lookup(inherited.permit, submission))
    observe(fixture, await gateway.readAtLeast(fixture.state.workspace.scope, fixture.state.authorityFrontier))
    gateway.releaseSettled(inherited.permit, fixture.state)
    expect(source.requests).toHaveLength(1)
  })

  it('holds a second workspace until exact commit and complete authority are published', async () => {
    const a = workspace({ a: { x: 0 } }), b = workspace({ a: { x: 0 } }, a.state.workspace.scope.sourceId)
    const source = new SourceFixture(a.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    const permitA = await gateway.acquire(a.state.workspace.scope, a.state.workspace.id, 'a')
    let grantedB = false
    const waitingB = gateway.acquire(b.state.workspace.scope, b.state.workspace.id, 'b').then(permit => { grantedB = true; return permit })
    a.apply([a.write('a', { x: 1 })]); const submissionA = await freeze(a)
    const result = await gateway.submit(permitA, submissionA); accept(a, submissionA, result)
    expect(() => gateway.releaseSettled(permitA, a.state)).toThrow('still reserves')
    await Promise.resolve(); expect(grantedB).toBe(false)
    observe(a, await gateway.readAtLeast(a.state.workspace.scope, a.state.authorityFrontier))
    gateway.releaseSettled(permitA, a.state)
    const permitB = await waitingB
    observe(b, await gateway.readAtLeast(b.state.workspace.scope, b.state.authorityFrontier))
    b.apply([b.write('a', { x: 2 })]); const submissionB = await freeze(b)
    accept(b, submissionB, await gateway.submit(permitB, submissionB))
    observe(b, await gateway.readAtLeast(b.state.workspace.scope, b.state.authorityFrontier)); gateway.releaseSettled(permitB, b.state)
    expect(source.writes).toBe(2)
    expect(source.requests.map(request => request.items[0]?.kind === 'update' ? request.items[0].after.x : null)).toEqual([1, 2])
    expect(b.project().rows[0]?.preview).toEqual({ x: 2 })
  })

  it('shares exclusion across distinct adapter wrappers with the same physical source id', async () => {
    const fixture = workspace({}), source = new SourceFixture(fixture.state.workspace.scope, {})
    const wrapper: PersistenceSource = { id: source.id, capabilities: source.capabilities,
      readAtLeast: () => source.readAtLeast(), submit: request => source.submit(request), lookupOperation: ref => source.lookupOperation(ref),
    }
    const a = persistenceGateway(source), b = persistenceGateway(wrapper)
    expect(persistenceGateway(source)).toBe(a)
    const first = await a.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'first')
    let ready = false
    const waiting = b.acquire(fixture.state.workspace.scope, kernelId<'workspace'>('other'), 'second').then(permit => { ready = true; return permit })
    await Promise.resolve(); expect(ready).toBe(false)
    a.abandonUnused(first)
    const second = await waiting
    expect(() => a.abandonUnused(second)).toThrow('no longer owned')
    b.abandonUnused(second)
  })

  it('retains exclusion through response loss and resolves by lookup without a second mutation', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    source.submitHook = async (_request, execute) => { execute(); throw new Error('Response lost') }
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'first')
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    accept(fixture, submission, await gateway.submit(permit, submission))
    expect(fixture.state.persistence.kind).toBe('outcome-unknown')
    expect(() => gateway.abandonUnused(permit)).toThrow('reserved operation')
    expect(() => gateway.releaseSettled(permit, fixture.state)).toThrow('unresolved')
    const lookup = await gateway.lookup(permit, submission); accept(fixture, submission, lookup)
    observe(fixture, await gateway.readAtLeast(fixture.state.workspace.scope, fixture.state.authorityFrontier))
    gateway.releaseSettled(permit, fixture.state)
    expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1); expect(source.lookups).toBe(1)
  })

  it('treats lookup 404 as unknown and only retries the original immutable operation', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    source.lookupHook = async () => { throw new Error('HTTP 404') }
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'recovery')
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    const lookup = await gateway.lookup(permit, submission)
    expect(lookup.kind).toBe('unknown'); expect(source.requests).toEqual([])
    expect(() => gateway.releaseSettled(permit, fixture.state)).toThrow('unresolved')
    await expect(gateway.submit(permit, { ...submission, operationId: kernelId<'operation'>('different') })).rejects.toThrow('digest')
    accept(fixture, submission, await gateway.submit(permit, submission))
    observe(fixture, await gateway.readAtLeast(fixture.state.workspace.scope, fixture.state.authorityFrontier)); gateway.releaseSettled(permit, fixture.state)
    expect(source.writes).toBe(1)
  })

  it.each(['404', 'unknown', 'pending'] as const)('keeps applied-without-receipt fenced through %s lookup and old/current reads', async mode => {
    const initial = { a: { x: 0, hidden: 0 } }, fixture = workspace(initial)
    const source = new SourceFixture(fixture.state.workspace.scope, initial), gateway = persistenceGateway(source), old = source.snapshot()
    source.normalize = document => ({ ...document, x: 1.5, hidden: 7 })
    source.submitHook = async (_request, execute) => { execute(); return { kind: 'applied-without-receipt', commitToken: 'known-applied' } }
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'receipt-recovery')
    const predecessor = fixture.apply([fixture.write('a', { x: 1 })]), submission = await freeze(fixture), bytes = JSON.stringify(submission)
    const successor = fixture.apply([fixture.write('a', { x: 2 })], 'row', 'unsubmitted successor')
    accept(fixture, submission, await gateway.submit(permit, submission))
    source.lookupHook = async () => {
      if (mode === '404') throw new Error('HTTP 404')
      return mode === 'pending' ? { kind: 'pending' } : { kind: 'unknown', issue: { code: 'missing', message: 'No receipt available' } }
    }
    for (const snapshot of [old, source.snapshot()]) {
      accept(fixture, submission, await gateway.lookup(permit, submission))
      observe(fixture, snapshot)
      expect(fixture.state.persistence.kind).toBe('committed-awaiting-receipt')
      expect(fixture.state.settlements).toEqual([])
      expect(fixture.state.rejections).toEqual([])
      expect(fixture.dispatch({ kind: 'retry-persistence' }).effects).toEqual([{ kind: 'lookup', submission }])
      expect(() => gateway.releaseSettled(permit, fixture.state)).toThrow('unresolved')
      expect((await gateway.submit(permit, submission)).kind).toBe('applied-without-receipt')
      expect(source.requests).toHaveLength(1)
    }
    source.lookupHook = null
    accept(fixture, submission, await gateway.lookup(permit, submission))
    gateway.releaseSettled(permit, fixture.state)
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(fixture.state.settlements.map(proof => proof.intentId)).toEqual(predecessor.action.intentIds)
    expect(fixture.state.journal.intents.at(-1)).toEqual(successor.intents[0])
    expect(fixture.state.inputs[1]).toMatchObject({ input: { kind: 'encoded', value: 'unsubmitted successor' }, disposition: { kind: 'intents' } })
    expect(fixture.project().rows[0]?.preview).toEqual({ x: 2, hidden: 7 })
    expect(source.snapshot().rows[0]?.document).toEqual({ x: 1.5, hidden: 7 })
    expect(source.writes).toBe(1)
    expect(JSON.stringify(submission)).toBe(bytes)
  })

  it('rejects a changed digest before source I/O and permits cancellation of the still-unused grant', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'hash')
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    await expect(gateway.submit(permit, { ...submission, payloadHash: kernelId<'payload-hash'>('tampered') })).rejects.toThrow('digest')
    expect(source.requests).toEqual([])
    gateway.abandonUnused(permit)
    await expect(gateway.submit(permit, submission)).rejects.toThrow('no longer owned')
  })

  it('cannot use another workspace permit even for a valid request in the same scope', async () => {
    const a = workspace({ a: { x: 0 } }), b = workspace({ a: { x: 0 } }, a.state.workspace.scope.sourceId)
    const source = new SourceFixture(a.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    const permit = await gateway.acquire(a.state.workspace.scope, a.state.workspace.id, 'owner')
    b.apply([b.write('a', { x: 1 })]); const foreign = await freeze(b)
    await expect(gateway.submit(permit, foreign)).rejects.toThrow('another workspace')
    expect(source.requests).toEqual([])
    gateway.abandonUnused(permit)
  })

  it('deduplicates live submit calls and cannot resend after incomplete application evidence', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    const entered = deferred<void>(), finish = deferred<SourceMutationResult>()
    source.submitHook = async (_request, execute) => { const result = execute(); entered.resolve(); await finish.promise; return result.kind === 'applied' ? { ...result, receipt: { ...result.receipt, results: [] } } : result }
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'dedupe')
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    const first = gateway.submit(permit, submission); await entered.promise
    const second = gateway.submit(permit, submission)
    finish.resolve({ kind: 'pending' })
    expect((await first).kind).toBe('applied'); expect((await second).kind).toBe('applied')
    expect(source.requests).toHaveLength(1)
    expect((await gateway.submit(permit, submission)).kind).toBe('applied')
    expect(source.requests).toHaveLength(1)
    accept(fixture, submission, await gateway.lookup(permit, submission))
    observe(fixture, await gateway.readAtLeast(fixture.state.workspace.scope, fixture.state.authorityFrontier)); gateway.releaseSettled(permit, fixture.state)
  })

  it('recovers a synchronous source exception without leaving a completed in-flight promise stuck', async () => {
    const fixture = workspace({ a: { x: 0 } }), backend = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    let attempts = 0
    const source: PersistenceSource = { id: backend.id, capabilities: backend.capabilities, readAtLeast: () => backend.readAtLeast(), lookupOperation: ref => backend.lookupOperation(ref),
      submit(request) { if (++attempts === 1) throw new Error('Synchronous failure'); return backend.submit(request) },
    }
    const gateway = persistenceGateway(source), permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'sync')
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    expect((await gateway.submit(permit, submission)).kind).toBe('unknown')
    accept(fixture, submission, await gateway.submit(permit, submission))
    observe(fixture, await gateway.readAtLeast(fixture.state.workspace.scope, fixture.state.authorityFrontier)); gateway.releaseSettled(permit, fixture.state)
    expect(attempts).toBe(2); expect(backend.writes).toBe(1)
  })

  it('rejects stale reads after a commit and cancels queued waits without cancelling the active write', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    const stale = source.snapshot(), permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'owner')
    const waiting = gateway.acquire(fixture.state.workspace.scope, kernelId<'workspace'>('waiting'), 'cancelled')
    const cancellation = expect(waiting).rejects.toThrow('explicitly cancelled')
    expect(gateway.cancelWaiting(fixture.state.workspace.scope, kernelId<'workspace'>('waiting'), 'cancelled')).toBe(true)
    await cancellation
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    accept(fixture, submission, await gateway.submit(permit, submission))
    source.readHook = async () => stale
    await expect(gateway.readAtLeast(fixture.state.workspace.scope, [])).rejects.toThrow('frontier')
    expect(() => gateway.releaseSettled(permit, fixture.state)).toThrow('still reserves')
    source.readHook = null
    observe(fixture, await gateway.readAtLeast(fixture.state.workspace.scope, fixture.state.authorityFrontier)); gateway.releaseSettled(permit, fixture.state)
  })

  it('releases a definitive rejected write only after the owning kernel records its proof', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'rejected')
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    source.external({ a: { x: 2 } })
    const result = await gateway.submit(permit, submission)
    expect(result.kind).toBe('not-applied')
    expect(() => gateway.releaseSettled(permit, fixture.state)).toThrow('still reserves')
    accept(fixture, submission, result)
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
    gateway.releaseSettled(permit, fixture.state)
    expect(source.writes).toBe(0)
  })

  it('rechecks permit ownership after asynchronous hashing before any source call', async () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'hash-race')
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    const attempt = gateway.submit(permit, submission)
    gateway.abandonUnused(permit)
    await expect(attempt).rejects.toThrow('no longer owned')
    expect(source.requests).toEqual([])
  })

  it('requires explicit backend fencing and identity guarantees before enabling writes', () => {
    const fixture = workspace({}), source = new SourceFixture(fixture.state.workspace.scope, {})
    for (const unsupported of [
      { atomicScopeWrites: false }, { durableOperationLookup: false }, { operationIdFence: 'receipt-retention-only' }, { identity: 'unknown' },
    ]) {
      const invalid = { id: `${source.id}:${JSON.stringify(unsupported)}`, capabilities: { ...source.capabilities, ...unsupported },
        readAtLeast: () => source.readAtLeast(), submit: (request: FrozenSubmission) => source.submit(request), lookupOperation: source.lookupOperation.bind(source),
      } as unknown as PersistenceSource
      expect(() => persistenceGateway(invalid)).toThrow('Writable sources require')
    }
    expect(source.requests).toEqual([])
  })
})

describe('server snapshot identity and payload boundaries', () => {
  it('owns read scope across awaits and ignores identity-object property order when comparing complete content', async () => {
    const fixture = workspace({ a: { x: 0 }, b: { x: 1 } })
    const source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 }, b: { x: 1 } }), gateway = persistenceGateway(source)
    const scope = { ...fixture.state.workspace.scope }, result = deferred<ServerAuthority>()
    source.readHook = () => result.promise
    const reading = gateway.readAtLeast(scope, [])
    scope.sourceId = 'mutated-by-caller'
    result.resolve(source.snapshot())
    await expect(reading).resolves.toHaveProperty('scope.sourceId', source.id)
    const second = source.snapshot()
    source.readHook = async () => ({ ...second, rows: [...second.rows].reverse().map((row, index) => ({ ...row,
      identity: index === 0 ? { incarnation: row.identity.incarnation, key: row.identity.key } : row.identity,
    })) })
    await expect(gateway.readAtLeast(fixture.state.workspace.scope, [])).resolves.toHaveProperty('version.position', '0')
  })

  it('isolates physical sources even when dataset, epoch, row keys and versions coincide', async () => {
    const a = workspace({ a: { x: 0 } }), b = workspace({ a: { x: 0 } })
    const source = new SourceFixture(a.state.workspace.scope, { a: { x: 0 } }), gateway = persistenceGateway(source)
    expect(() => gateway.acquire(b.state.workspace.scope, b.state.workspace.id, 'foreign')).toThrow('another physical source')
    await expect(gateway.readAtLeast(b.state.workspace.scope, [])).rejects.toThrow('another physical source')
    expect(source.reads).toBe(0)
    expect(() => bindServerAuthority(b.state, source.snapshot(), [])).toThrow('another workspace scope')
    const state = b.state
    const authority = a.state.authority.content
    if (authority.kind !== 'complete') throw new Error('Missing fixture authority')
    expect(b.dispatch({ kind: 'authority-observed', snapshot: authority.snapshot }).result.kind).toBe('ignored')
    expect(b.state).toBe(state)
    a.apply([a.write('a', { x: 1 })]); const submission = await freeze(a)
    expect(await hashSubmission({ ...submission, scope: b.state.workspace.scope })).not.toBe(submission.payloadHash)
  })

  it('binds exact creation output to the original local entity, including before coverage settlement', async () => {
    const fixture = workspace({}), source = new SourceFixture(fixture.state.workspace.scope, {}), gateway = persistenceGateway(source)
    const permit = await gateway.acquire(fixture.state.workspace.scope, fixture.state.workspace.id, 'creation')
    const local = kernelId<'entity'>('local')
    fixture.apply([{ kind: 'create', entityId: local, document: { x: 1 } }]); const submission = await freeze(fixture)
    accept(fixture, submission, await gateway.submit(permit, submission))
    const snapshot = await gateway.readAtLeast(fixture.state.workspace.scope, fixture.state.authorityFrontier)
    expect(unboundServerIdentities(fixture.state, snapshot)).toEqual([])
    const bound = bindServerAuthority(fixture.state, snapshot, [])
    expect(bound.entities[0]?.entityId).toBe(local)
    fixture.dispatch({ kind: 'authority-observed', snapshot: bound }); gateway.releaseSettled(permit, fixture.state)
  })

  it('keeps different incarnations separate and never uses a proposed key as binding evidence', () => {
    const fixture = workspace({ a: { x: 0 } }), source = new SourceFixture(fixture.state.workspace.scope, { a: { x: 0 } })
    fixture.apply([{ kind: 'create', entityId: kernelId<'entity'>('local'), proposedKey: 'new', document: { x: 1 } }])
    const raw = source.snapshot(), identity = { key: 'new', incarnation: 'external' }
    const snapshot: ServerAuthority = { ...raw, rows: [...raw.rows, { identity, document: { x: 7 } }], order: [...raw.order, identity] }
    expect(unboundServerIdentities(fixture.state, snapshot)).toEqual([identity])
    expect(() => bindServerAuthority(fixture.state, snapshot, [{ identity, entityId: kernelId<'entity'>('local') }])).toThrow('unused entity')
    const bound = bindServerAuthority(fixture.state, snapshot, [{ identity, entityId: kernelId<'entity'>('external') }])
    expect(bound.entities.at(-1)?.entityId).toBe('external')
  })

  it('hashes the full canonical payload and excludes only the digest field itself', async () => {
    const fixture = workspace({ a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); const submission = await freeze(fixture)
    expect(submission.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await hashSubmission(submission)).toBe(submission.payloadHash)
    expect(await hashSubmission({ ...submission, scope: { ...submission.scope, epoch: kernelId<'scope-epoch'>('another') } })).not.toBe(submission.payloadHash)
    expect(await hashSubmission({ ...submission, coverage: [] })).not.toBe(submission.payloadHash)
  })
})
