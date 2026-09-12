import { describe, expect, it } from 'vitest'
import { entityId, KernelFixture } from '../../tests/kernel/fixtures.js'
import { ReferenceServer, type SpecRow } from '../../tests/kernel/reference-model.js'
import { kernelId, type ExactReceipt, type FrozenSubmission, type NotAppliedProof, type ServerIdentity } from './model.js'
import { prepareSubmission } from './submission.js'

const ref = (submission: FrozenSubmission) => ({ scope: submission.scope, operationId: submission.operationId, payloadHash: submission.payloadHash })
const uncertain = (fixture: KernelFixture, submission: FrozenSubmission, attempt = 1) => fixture.dispatch({ kind: 'mutation-uncertain', ref: ref(submission), attempt, issue: { code: 'timeout', message: 'Outcome unknown' } })
const rejected = (submission: FrozenSubmission): NotAppliedProof => ({ ...ref(submission), rejectionToken: 'server-fenced-this-operation', reason: { code: 'cas', message: 'The write base changed.' } })
const authorityDocument = (fixture: KernelFixture, id = 'a') => fixture.state.authority.content.kind === 'complete'
  ? fixture.state.authority.content.snapshot.entities.find(row => row.entityId === entityId(id))?.document : undefined
const preview = (fixture: KernelFixture, id = 'a') => fixture.project().rows.find(row => row.entityId === entityId(id))?.preview

/** Only translates the protocol to the independent scalar server. Neither
 * its execution nor the expected canonical outputs use production helpers. */
function applyServer(server: ReferenceServer, request: FrozenSubmission, normalize?: (entity: string, row: SpecRow) => SpecRow): ExactReceipt {
  if (request.baseAuthority.kind !== 'ordered') throw new Error('Scalar fixture uses ordered versions')
  const result = server.apply({ id: request.operationId, version: Number(request.baseAuthority.position), coverage: [], items: request.items.map(item => {
    if (item.kind === 'order') throw new Error('Scalar fixture does not order')
    return { entity: item.entityId, value: item.kind === 'delete' ? null : (item.kind === 'create' ? item.document : item.after) as SpecRow }
  }) }, normalize)
  return { ...ref(request), committedVersion: { kind: 'ordered', position: String(result.version), token: `version:${result.version}` },
    results: request.items.map(item => {
      if (item.kind === 'order') throw new Error('Scalar fixture does not order')
      if (item.kind === 'delete') return { kind: 'deleted', itemId: item.id, identity: item.identity }
      const canonical = result.outputs.find(output => output.entity === item.entityId)!.value!
      return item.kind === 'create' ? { kind: 'created', itemId: item.id, identity: { key: item.proposedKey ?? `assigned:${item.entityId}`, incarnation: `created:${request.operationId}` }, canonical }
        : { kind: 'updated', itemId: item.id, identity: item.identity, canonical }
    }),
  }
}

describe('exact persistence through the kernel reducer', () => {
  it('rejects a changed document at the same authority version without losing local input', () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
    fixture.apply([fixture.write('a', { x: 2 })], 'row', 'retained local edit')
    const before = fixture.state
    if (before.authority.content.kind !== 'complete') throw new Error('Expected initial authority')
    const original = before.authority.content.snapshot
    const result = fixture.dispatch({ kind: 'authority-observed', snapshot: { ...original,
      observation: kernelId<'observation'>('inconsistent-read'), entities: original.entities.map(row => ({ ...row, document: { x: 99, hidden: 99 } })) } })
    expect(result.result).toMatchObject({ kind: 'rejected', issue: { message: 'An immutable authority version cannot change content.' } })
    expect(result.effects).toEqual([])
    expect(fixture.state).toBe(before)
    expect(preview(fixture)).toEqual({ x: 2, hidden: 7 })
    fixture.observe({ a: { x: 0, hidden: 8 } }, 1)
    expect(preview(fixture)).toEqual({ x: 2, hidden: 8 })
    expect(fixture.state.inputs).toEqual(before.inputs)
    expect(fixture.prepareSave().submission.items).toMatchObject([{ before: { x: 0, hidden: 8 }, after: { x: 2, hidden: 8 } }])
  })

  it.each(['applied', 'not-applied'] as const)('retains the first %s fact when contradictory terminal evidence arrives', first => {
    const server = new ReferenceServer({ a: { x: 0, hidden: 7 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const receipt = applyServer(server, submission, () => ({ x: 1.5, hidden: 9 })), proof = rejected(submission)
    // Deliberately inconsistent source evidence: the physical write happened,
    // but the source also claims definitive rejection of that same operation.
    if (first === 'applied') {
      fixture.dispatch({ kind: 'exact-receipt', receipt }); fixture.observe(server.rows, server.version)
    } else fixture.dispatch({ kind: 'not-applied', proof })
    fixture.apply([fixture.write('a', { x: 2 })], 'row', 'unsent successor')
    const before = fixture.state, frozenBytes = JSON.stringify(submission)
    const event = first === 'applied' ? { kind: 'not-applied' as const, proof } : { kind: 'exact-receipt' as const, receipt }
    const transition = fixture.dispatch(event)
    expect(transition.effects).toEqual([])
    expect(fixture.state.protocolFaults).toHaveLength(1)
    expect(fixture.state.commits).toEqual(before.commits)
    expect(fixture.state.rejections).toEqual(before.rejections)
    expect(fixture.state.settlements).toEqual(before.settlements)
    expect(fixture.state.journal).toEqual(before.journal)
    expect(fixture.state.inputs).toEqual(before.inputs)
    expect(fixture.state.inputs.at(-1)?.input).toEqual({ kind: 'encoded', value: 'unsent successor' })
    expect(preview(fixture)).toEqual({ x: 2, hidden: first === 'applied' ? 9 : 7 })
    expect(() => fixture.prepareSave()).toThrow('Conflicting protocol evidence')
    const disputed = fixture.state
    expect(fixture.dispatch(event).result.kind).toBe('ignored')
    expect(fixture.state).toBe(disputed)
    expect(JSON.stringify(submission)).toBe(frozenBytes)
    expect(server.rows).toEqual({ a: { x: 1.5, hidden: 9 } })
    expect(server.writes).toBe(1)
  })

  it('ignores an identical rejection but quarantines a changed fencing proof without consuming input', () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
    fixture.apply([fixture.write('a', { x: 1 })], 'row', 'retry material')
    const { submission } = fixture.freeze(), proof = rejected(submission)
    expect(fixture.dispatch({ kind: 'not-applied', proof }).result.kind).toBe('accepted')
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'not-applied', proof: structuredClone(proof) }).result.kind).toBe('ignored')
    expect(fixture.state).toBe(before)
    const result = fixture.dispatch({ kind: 'not-applied', proof: { ...proof, rejectionToken: 'different-fence' } })
    expect(result.effects).toEqual([])
    expect(fixture.state.protocolFaults).toHaveLength(1)
    expect(fixture.state.rejections).toEqual([{ submission, proof }])
    expect(fixture.state.commits).toEqual([])
    expect(fixture.state.settlements).toEqual([])
    expect(fixture.state.inputs).toEqual(before.inputs)
    expect(preview(fixture)).toEqual({ x: 1, hidden: 7 })
    expect(() => fixture.prepareSave()).toThrow('Conflicting protocol evidence')
  })

  it('keeps reported application unresolved when commit tokens or rejection evidence conflict', () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    fixture.apply([fixture.write('a', { x: 2 })], 'row', 'later input')
    const event = { kind: 'applied-without-receipt' as const, ref: ref(submission), commitToken: 'commit-a' }
    expect(fixture.dispatch(event).result.kind).toBe('accepted')
    const before = fixture.state
    expect(fixture.dispatch(event).result.kind).toBe('ignored')
    expect(fixture.state).toBe(before)
    for (const conflicting of [{ ...event, commitToken: 'commit-b' }, { kind: 'not-applied' as const, proof: rejected(submission) }]) {
      expect(fixture.dispatch(conflicting).effects).toEqual([])
      expect(fixture.state.persistence).toEqual(before.persistence)
      expect(fixture.state.inputs).toEqual(before.inputs)
      expect(fixture.state.commits).toEqual([])
      expect(fixture.state.rejections).toEqual([])
      expect(fixture.state.settlements).toEqual([])
      expect(preview(fixture)).toEqual({ x: 2, hidden: 7 })
    }
    expect(fixture.state.protocolFaults).toHaveLength(2)
    expect(() => fixture.prepareSave()).toThrow('previous scope write is still unresolved')
    expect(fixture.dispatch({ kind: 'retry-persistence' }).effects.some(effect => effect.kind === 'submit')).toBe(false)
  })

  it('preserves a conflicted deletion through an actual partial server commit', () => {
    const server = new ReferenceServer({ a: { x: 0 }, b: { x: 0 } }), fixture = new KernelFixture(server.rows)
    const deletion = fixture.apply([{ kind: 'delete', entityId: entityId('a') }], 'row', 'delete a')
    server.external({ a: { x: 1 }, b: { x: 0 } }); fixture.observe(server.rows, server.version)
    const edit = fixture.apply([fixture.write('b', { x: 2 })])
    const frozen = fixture.freeze()
    expect(frozen.effects).toEqual([{ kind: 'submit', submission: frozen.submission, attempt: 1 }])
    expect(frozen.submission.coverage.flatMap(entry => entry.intentIds)).toEqual(edit.action.intentIds)
    fixture.dispatch({ kind: 'exact-receipt', receipt: applyServer(server, frozen.submission) })
    expect(fixture.state.persistence.kind).toBe('committed-awaiting-authority')
    fixture.observe(server.rows, server.version)
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(server.rows).toEqual({ a: { x: 1 }, b: { x: 2 } })
    expect(fixture.project().rows.find(row => row.entityId === entityId('a'))).toMatchObject({ existence: 'pending-delete', persistence: 'blocked' })
    expect(fixture.state.journal.intents[0]).toEqual(deletion.intents[0])
    expect(fixture.state.settlements.map(proof => proof.intentId)).toEqual(edit.action.intentIds)
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
    expect(server.writes).toBe(1)
  })

  it('retains the frozen display until authority arrives and rebases only successor write bases to canonical output', () => {
    const server = new ReferenceServer({ a: { x: 0, hidden: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })])
    const { submission } = fixture.freeze(), bytes = JSON.stringify(submission)
    const successor = fixture.apply([fixture.write('a', { x: 2 })], 'row', 'later input')
    const receipt = applyServer(server, submission, () => ({ x: 1.5, hidden: 1 }))
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    expect(preview(fixture)).toEqual({ x: 2, hidden: 0 })
    expect(fixture.state.settlements).toEqual([])
    expect(() => fixture.prepareSave()).toThrow('unresolved')
    fixture.observe(server.rows, server.version)
    expect(preview(fixture)).toEqual({ x: 2, hidden: 1 })
    expect(fixture.state.journal.intents.at(-1)).toEqual(successor.intents[0])
    const next = fixture.freeze().submission
    expect(next.items[0]).toMatchObject({ kind: 'update', before: { x: 1.5, hidden: 1 }, after: { x: 2, hidden: 1 } })
    fixture.dispatch({ kind: 'exact-receipt', receipt: applyServer(server, next) }); fixture.observe(server.rows, server.version)
    expect(server.rows).toEqual({ a: { x: 2, hidden: 1 } })
    expect(fixture.state.inputs.every(input => input.disposition.kind === 'settled-intents')).toBe(true)
    expect(JSON.stringify(submission)).toBe(bytes)
    expect(server.writes).toBe(2)
  })

  it('keeps newer authority and compares successors to the exact delayed receipt', () => {
    const server = new ReferenceServer({ a: { x: 0, hidden: 0 } }), fixture = new KernelFixture(server.rows)
    const predecessor = fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const frozenBytes = JSON.stringify(submission)
    const successor = fixture.apply([fixture.write('a', { x: 2 })], 'row', 'unsent successor')
    const receipt = applyServer(server, submission, () => ({ x: 1.5, hidden: 1 }))
    server.external({ a: { x: 3, hidden: 2 } }); fixture.observe(server.rows, server.version)
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    expect(authorityDocument(fixture)).toEqual({ x: 3, hidden: 2 })
    expect(preview(fixture)).toEqual({ x: 2, hidden: 2 })
    expect(fixture.project().rows[0]?.issues[0]?.comparison).toMatchObject({ base: [{ kind: 'value', value: 1.5 }], local: [{ kind: 'value', value: 2 }], remote: [{ kind: 'value', value: 3 }] })
    expect(() => fixture.prepareSave()).toThrow('no saveable')
    const settled = fixture.state
    expect(fixture.dispatch({ kind: 'exact-receipt', receipt }).result.kind).toBe('ignored')
    expect(fixture.state).toBe(settled)
    for (const [version, document] of [[0, { x: 0, hidden: 0 }], [1, { x: 1.5, hidden: 1 }], [2, { x: 3, hidden: 2 }]] as const) {
      fixture.observe({ a: document }, version)
      expect(authorityDocument(fixture)).toEqual({ x: 3, hidden: 2 })
      expect(preview(fixture)).toEqual({ x: 2, hidden: 2 })
      expect(fixture.project().rows[0]?.issues[0]?.comparison).toMatchObject({ base: [{ kind: 'value', value: 1.5 }], local: [{ kind: 'value', value: 2 }], remote: [{ kind: 'value', value: 3 }] })
      expect(fixture.state.settlements.map(proof => proof.intentId)).toEqual(predecessor.action.intentIds)
      expect(fixture.state.journal.intents.at(-1)).toEqual(successor.intents[0])
      expect(fixture.state.inputs[1]).toMatchObject({ input: { kind: 'encoded', value: 'unsent successor' }, disposition: { kind: 'intents' } })
      expect(() => fixture.prepareSave()).toThrow('no saveable')
    }
    expect(JSON.stringify(submission)).toBe(frozenBytes)
    expect(server.rows).toEqual({ a: { x: 3, hidden: 2 } })
    expect(server.writes).toBe(1)
  })

  it('does not satisfy a derived value whose semantic read changed during normalization', () => {
    const server = new ReferenceServer({ a: { qty: 1, total: 10 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { qty: 2 })]); const { submission } = fixture.freeze()
    fixture.apply([fixture.write('a', { total: 20 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: entityId('a'), path: ['qty'] } }] })])
    fixture.dispatch({ kind: 'exact-receipt', receipt: applyServer(server, submission, () => ({ qty: 3, total: 10 })) })
    fixture.observe(server.rows, server.version)
    expect(preview(fixture)).toEqual({ qty: 3, total: 20 })
    expect(fixture.project().rows[0]?.issues.map(issue => issue.code)).toContain('semantic-read-changed')
    expect(fixture.state.inputs[1]?.disposition.kind).toBe('intents')
    expect(() => fixture.prepareSave()).toThrow('no saveable')
    expect(server.rows).toEqual({ a: { qty: 3, total: 10 } })
    expect(server.writes).toBe(1)
  })

  it('keeps ordered groups within a successor action relative to their local prefix after canonicalization', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    fixture.apply([{ kind: 'write', entityId: entityId('a'), groups: [2, 3].map(value => ({
      id: kernelId<'write-group'>(`ordered-group:${value}`), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['x'], value }],
    })) }])
    fixture.dispatch({ kind: 'exact-receipt', receipt: applyServer(server, submission, () => ({ x: 1.5 })) })
    fixture.observe(server.rows, server.version)
    expect(fixture.project().rows[0]?.issues).toEqual([])
    expect(fixture.prepareSave().submission.items[0]).toMatchObject({ kind: 'update', before: { x: 1.5 }, after: { x: 3 } })
  })

  it('keeps a bulk input pending when only one of its contributions is committed', () => {
    const server = new ReferenceServer({ a: { x: 0 }, b: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 }), fixture.write('b', { x: 2 })], 'row', 'bulk')
    server.external({ a: { x: 3 }, b: { x: 0 } }); fixture.observe(server.rows, server.version)
    const { submission } = fixture.freeze()
    fixture.dispatch({ kind: 'exact-receipt', receipt: applyServer(server, submission) }); fixture.observe(server.rows, server.version)
    expect(fixture.state.settlements).toHaveLength(1)
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
    server.external({ a: { x: 1 }, b: { x: 2 } }); fixture.observe(server.rows, server.version)
    expect(fixture.state.inputs[0]?.disposition).toMatchObject({ kind: 'settled-intents', proofs: [{ kind: 'externally-satisfied' }, { kind: 'committed' }] })
  })

  it('never resends an applied write when its covering refresh fails', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const receipt = applyServer(server, submission, () => ({ x: 1.5 }))
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    fixture.dispatch({ kind: 'read-started', ticket: 'covering-read' })
    fixture.dispatch({ kind: 'read-failed', ticket: 'covering-read', issue: { code: 'offline', message: 'Offline' } })
    fixture.observe({ a: { x: 0 } }, 0)
    expect(preview(fixture)).toEqual({ x: 1 })
    expect(fixture.state.persistence.kind).toBe('committed-awaiting-authority')
    expect(fixture.state.commits).toHaveLength(1)
    expect(fixture.state.settlements).toHaveLength(0)
    expect(fixture.dispatch({ kind: 'retry-persistence' }).effects.map(effect => effect.kind)).toEqual(['read-at-least'])
    fixture.observe(server.rows, server.version)
    expect(preview(fixture)).toEqual({ x: 1.5 })
    expect(server.writes).toBe(1)
  })

  it('retries unknown results with identical payload and ignores an old attempt failure', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const receipt = applyServer(server, submission)
    uncertain(fixture, submission)
    fixture.apply([fixture.write('a', { x: 2 })])
    const retry = fixture.dispatch({ kind: 'retry-persistence' })
    expect(retry.effects).toEqual([{ kind: 'submit', submission, attempt: 2 }])
    const current = fixture.state
    expect(uncertain(fixture, submission, 1).result.kind).toBe('ignored')
    expect(fixture.state).toBe(current)
    expect(applyServer(server, submission)).toEqual(receipt)
    fixture.dispatch({ kind: 'exact-receipt', receipt }); fixture.observe(server.rows, server.version)
    expect(server.writes).toBe(1)
    expect(preview(fixture)).toEqual({ x: 2 })
  })

  it('uses logical fallback after definitive non-application without rebasing to arbitrary latest values', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    fixture.apply([fixture.write('a', { x: 2 })]); uncertain(fixture, submission)
    fixture.observe({ a: { x: 3 } }, 1)
    fixture.dispatch({ kind: 'not-applied', proof: rejected(submission) })
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(fixture.state.settlements).toEqual([])
    expect(fixture.project().rows[0]?.issues[0]?.comparison?.base).toEqual([{ kind: 'value', value: 0 }])
    fixture.observe({ a: { x: 0 } }, 2)
    const candidate = fixture.prepareSave()
    expect(() => prepareSubmission(fixture.state, { operationId: submission.operationId, payloadHash: submission.payloadHash,
      items: candidate.submission.items.map(item => { if (item.kind === 'order') throw new Error('Unexpected fixture'); return { entityId: item.entityId, itemId: item.id } }),
    }, fixture.schema)).toThrow('terminal operation')
  })

  it('requires an exact receipt even after success evidence and a complete refresh', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const receipt = applyServer(server, submission, () => ({ x: 1.5 }))
    fixture.dispatch({ kind: 'applied-without-receipt', ref: ref(submission), commitToken: 'server-commit' })
    fixture.observe(server.rows, server.version)
    expect(fixture.state.persistence.kind).toBe('committed-awaiting-receipt')
    expect(fixture.state.settlements).toEqual([])
    expect(fixture.dispatch({ kind: 'retry-persistence' }).effects).toEqual([{ kind: 'lookup', submission }])
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(preview(fixture)).toEqual({ x: 1.5 })
  })

  it('blocks partial receipts while retaining the original request and later accepts complete evidence', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const receipt = applyServer(server, submission)
    fixture.dispatch({ kind: 'exact-receipt', receipt: { ...receipt, results: [] } })
    expect(fixture.state.persistence.kind).toBe('receipt-blocked')
    expect(fixture.state.commits).toEqual([])
    expect(fixture.dispatch({ kind: 'retry-persistence' }).effects).toEqual([{ kind: 'lookup', submission }])
    fixture.observe(server.rows, server.version)
    expect(fixture.state.settlements).toEqual([])
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(fixture.state.settlements).toHaveLength(1)
  })

  it('quarantines conflicting receipts instead of changing an already recorded exact fact', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const receipt = applyServer(server, submission)
    fixture.dispatch({ kind: 'exact-receipt', receipt }); fixture.observe(server.rows, server.version)
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'exact-receipt', receipt }).result.kind).toBe('ignored')
    expect(fixture.state).toBe(before)
    const result = receipt.results[0]!
    if (result.kind !== 'updated') throw new Error('Unexpected fixture')
    fixture.dispatch({ kind: 'exact-receipt', receipt: { ...receipt, results: [{ ...result, canonical: { x: 99 } }] } })
    expect(fixture.state.protocolFaults).toHaveLength(1)
    expect(fixture.state.commits[0]?.receipt).toEqual(receipt)
    fixture.apply([fixture.write('a', { x: 2 })])
    expect(() => fixture.prepareSave()).toThrow('Conflicting protocol evidence')
  })

  it('treats reordered result envelopes as the same exact item facts', () => {
    const server = new ReferenceServer({ a: { x: 0 }, b: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 }), fixture.write('b', { x: 2 })]); const { submission } = fixture.freeze()
    const receipt = applyServer(server, submission)
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'exact-receipt', receipt: { ...receipt, results: [...receipt.results].reverse() } }).result.kind).toBe('ignored')
    expect(fixture.state).toBe(before)
    expect(fixture.state.protocolFaults).toEqual([])
  })

  it('retains blocked receipt evidence when a less precise success notification arrives later', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const incomplete = { ...applyServer(server, submission), results: [] }
    fixture.dispatch({ kind: 'exact-receipt', receipt: incomplete })
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'applied-without-receipt', ref: ref(submission), commitToken: 'less-precise' }).result.kind).toBe('ignored')
    expect(fixture.state).toBe(before)
    expect(fixture.state.persistence).toMatchObject({ kind: 'receipt-blocked', receipt: incomplete })
  })

  it('refuses forged coverage and stale freezes before emitting any write effect', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })])
    const prepared = fixture.prepareSave(), before = fixture.state
    const invalid = { ...prepared, submission: { ...prepared.submission, coverage: [{ itemId: prepared.submission.items[0]!.id, intentIds: [kernelId<'intent'>('not-in-plan')] }] } }
    const result = fixture.dispatch({ kind: 'freeze-submission', prepared: invalid })
    expect(result.result.kind).toBe('rejected'); expect(result.effects).toEqual([]); expect(fixture.state).toBe(before)
    fixture.apply([fixture.write('a', { x: 2 })])
    expect(fixture.dispatch({ kind: 'freeze-submission', prepared }).result.kind).toBe('rejected')
    expect(fixture.state.persistence.kind).toBe('idle')
  })

  it('binds a saved creation without changing its identity or losing successor edits', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([{ kind: 'create', entityId: entityId('local'), document: { x: 1 } }])
    const { submission } = fixture.freeze()
    fixture.apply([fixture.write('local', { x: 2 }), fixture.write('a', { x: 3 })])
    const receipt = applyServer(server, submission, (_id, row) => ({ ...row, x: 1.5 }))
    const created = receipt.results[0]!
    if (created.kind !== 'created') throw new Error('Unexpected fixture')
    fixture.dispatch({ kind: 'exact-receipt', receipt }); fixture.observe(server.rows, server.version, { local: created.identity })
    expect(fixture.state.entities.find(entry => entry.entityId === entityId('local'))).toEqual({ kind: 'bound', entityId: entityId('local'), identity: created.identity })
    expect(preview(fixture, 'local')).toEqual({ x: 2 })
    expect(preview(fixture, 'a')).toEqual({ x: 3 })
    expect(fixture.prepareSave().submission.items.find(item => item.kind !== 'order' && item.entityId === entityId('local'))).toMatchObject({ kind: 'update', identity: created.identity, after: { x: 2 } })
  })

  it('holds an ambiguous new incarnation and preserves its newer read frontier until exact binding arrives', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([{ kind: 'create', entityId: entityId('local'), document: { x: 1 } }]); const { submission } = fixture.freeze()
    fixture.apply([fixture.write('local', { x: 2 })])
    const receipt = applyServer(server, submission, () => ({ x: 1.5 })), created = receipt.results[0]!
    if (created.kind !== 'created') throw new Error('Unexpected fixture')
    const held = fixture.observe({ a: { x: 5 }, guessed: { x: 3 } }, 2, { guessed: created.identity })
    expect(held.effects).toEqual([{ kind: 'lookup', submission }])
    expect(authorityDocument(fixture)).toEqual({ x: 0 })
    expect(fixture.state.entities.some(entry => entry.entityId === entityId('guessed'))).toBe(false)
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    expect(fixture.state.persistence).toMatchObject({ kind: 'committed-awaiting-authority', requiredFrontier: [{ position: '2' }] })
    fixture.observe(server.rows, 1, { local: created.identity })
    expect(fixture.state.settlements).toEqual([])
    fixture.observe({ a: { x: 5 }, local: { x: 3 } }, 2, { local: created.identity })
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(fixture.state.entities.some(entry => entry.entityId === entityId('guessed'))).toBe(false)
    expect(fixture.project().rows.find(row => row.entityId === entityId('local'))?.issues[0]?.comparison?.base).toEqual([{ kind: 'value', value: 1.5 }])
  })

  it('retains a created-and-remotely-deleted incarnation as retired without recreating successor input', () => {
    const server = new ReferenceServer({}), fixture = new KernelFixture(server.rows)
    fixture.apply([{ kind: 'create', entityId: entityId('local'), document: { x: 1 } }]); const { submission } = fixture.freeze()
    fixture.apply([fixture.write('local', { x: 2 })])
    const receipt = applyServer(server, submission)
    server.external({}); fixture.observe(server.rows, server.version)
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    expect(fixture.state.entities.find(entry => entry.entityId === entityId('local'))?.kind).toBe('retired')
    expect(fixture.project().rows[0]).toMatchObject({ existence: 'remote-deleted', persistence: 'blocked' })
    expect(fixture.project().changes).toEqual([])
    expect(fixture.state.inputs[1]?.disposition.kind).toBe('intents')
  })

  it('does not settle a receipt against contradictory content at the exact commit version', () => {
    const server = new ReferenceServer({ a: { x: 0 } }), fixture = new KernelFixture(server.rows)
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    const receipt = applyServer(server, submission)
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    fixture.observe({ a: { x: 9 } }, 1)
    expect(fixture.state.persistence.kind).toBe('receipt-blocked')
    expect(fixture.state.settlements).toEqual([])
    expect(authorityDocument(fixture)).toEqual({ x: 0 })
    expect(preview(fixture)).toEqual({ x: 1 })
  })

  it('ignores another epoch and requires a causal snapshot to cover both the read and write frontier', () => {
    const fixture = new KernelFixture()
    const scope = fixture.state.workspace.scope, identity: ServerIdentity = { key: 'a', incarnation: 'life:1' }
    const version = (stamp: string, covers: string[]) => ({ kind: 'causal' as const, token: stamp, stamp: kernelId<'causal-stamp'>(stamp), covers: covers.map(value => kernelId<'causal-stamp'>(value)) })
    const snapshot = (stamp: string, covers: string[], x: number) => ({ scope, observation: kernelId<'observation'>(`read:${stamp}`), version: version(stamp, covers), entities: [{ entityId: entityId('a'), identity, document: { x } }], order: [entityId('a')] })
    fixture.dispatch({ kind: 'authority-observed', snapshot: snapshot('base', [], 0) })
    fixture.apply([fixture.write('a', { x: 1 })]); const { submission } = fixture.freeze()
    fixture.apply([fixture.write('a', { x: 2 })])
    fixture.dispatch({ kind: 'authority-observed', snapshot: snapshot('external', ['base'], 3) })
    const receipt: ExactReceipt = { ...ref(submission), committedVersion: version('commit', ['base']), results: [{ kind: 'updated', itemId: submission.items[0]!.id, identity, canonical: { x: 1.5 } }] }
    const before = fixture.state
    fixture.dispatch({ kind: 'exact-receipt', receipt: { ...receipt, scope: { ...scope, epoch: kernelId<'scope-epoch'>('other') } } })
    expect(fixture.state).toBe(before)
    fixture.dispatch({ kind: 'exact-receipt', receipt })
    expect(fixture.state.persistence.kind).toBe('committed-awaiting-authority')
    expect(fixture.state.authorityFrontier).toHaveLength(2)
    fixture.dispatch({ kind: 'authority-observed', snapshot: snapshot('joined', ['base', 'external', 'commit'], 4) })
    expect(fixture.state.persistence.kind).toBe('idle')
    expect(authorityDocument(fixture)).toEqual({ x: 4 })
    expect(fixture.project().rows[0]?.issues[0]?.comparison?.base).toEqual([{ kind: 'value', value: 1.5 }])
  })
})
