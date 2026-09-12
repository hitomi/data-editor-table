import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { ReferenceEditor, ReferenceServer } from '../../tests/kernel/reference-model.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { prepareHistoryCommand } from './history-command.js'
import { kernelId } from './model.js'
import { projectHistory } from './history.js'

// Without a remote event, varying its unused value repeats the same trace.
const cases = [false, true].flatMap(commitOriginal => [false, true].flatMap(commitUndo => ['none', 'before-redo', 'after-redo'].flatMap(remoteAt => [1, 2].flatMap(target => (remoteAt === 'none' ? [0] : [0, 1, 9]).map(remote => ({ commitOriginal, commitUndo, remoteAt, target, remote }))))))

describe('independent field redo model', () => {
  it.each(cases)('agrees through $commitOriginal/$commitUndo/$remoteAt/$target/$remote', async scenario => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial)
    const source = new SourceFixture(fixture.state.workspace.scope, initial), oracle = new ReferenceEditor(initial), server = new ReferenceServer(initial)
    const trace: string[] = []
    const compare = (step: string) => {
      trace.push(step)
      const context = JSON.stringify({ scenario, trace })
      const actual = fixture.project(), expected = oracle.preview()
      expect(actual.rows.find(row => row.entityId === 'a')?.preview, context).toEqual(expected.a)
      expect(actual.rows.filter(row => row.persistence === 'blocked').map(row => row.entityId), context).toEqual(oracle.blockedEntities())
      expect(source.writes, context).toBe(server.writes)
      expect([...source.rows.values()].map(row => row.document), context).toEqual(Object.values(server.rows))
    }
    const save = async () => {
      const actual = fixture.project()
      let referenceRequest
      try { referenceRequest = oracle.freeze(`save:${fixture.next()}`) }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'Nothing can be saved') throw error
        expect(actual.changes).toEqual([])
        compare('save-unavailable'); return
      }
      expect(actual.changes.map(change => ({ entity: change.entityId, value: change.after }))).toEqual(referenceRequest.items)
      const request = fixture.freeze().submission, result = await source.submit(request)
      if (result.kind !== 'applied') throw new Error('Expected exact source receipt')
      const receipt = server.apply(referenceRequest)
      oracle.receive(receipt)
      expect(fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }).result.kind).toBe('accepted')
      compare('receipt-without-authority')
      fixture.observe(server.rows, server.version); oracle.observe(server.rows, server.version)
      compare('saved')
    }
    const control = (kind: 'undo' | 'redo') => {
      const command = prepareHistoryCommand(fixture.state, fixture.schema, kind, () => `history:${fixture.next()}`)
      expect(fixture.dispatch(command).result.kind).toBe('accepted')
    }
    const remote = () => {
      const rows = { a: { x: scenario.remote, hidden: 17 } }
      source.external(rows); server.external(rows)
      fixture.observe(rows, server.version); oracle.observe(rows, server.version)
      compare('remote')
    }
    const original = fixture.apply([fixture.write('a', { x: scenario.target })]), originalId = oracle.write('a', { x: scenario.target })
    compare('edit')
    if (scenario.commitOriginal) await save()
    control('undo'); oracle.undo(originalId); compare('undo')
    if (scenario.commitUndo) await save()
    if (scenario.remoteAt === 'before-redo') remote()
    const originalEvidence = structuredClone(oracle.requirements.find(requirement => requirement.id === originalId))
    control('redo'); const replayId = oracle.redo(originalId); compare('redo')
    const replay = projectHistory(fixture.state).undo.at(-1)!
    expect(replay.id).toBe(original.action.id); expect(replay.applicationId).not.toBe(original.action.applicationId)
    expect(oracle.requirements.find(requirement => requirement.id === originalId)).toEqual(originalEvidence)
    if (scenario.remoteAt === 'after-redo') remote()
    await save()
    control('undo'); oracle.undo(replayId); compare('undo-reapplication')
    await save()
    control('redo'); oracle.redo(replayId); compare('second-reapplication')
    await save()
  })

  // Rejected requests never execute normalization, so its value adds no case.
  it.each([false, true].flatMap(applied => [false, true].flatMap(earlyRedo => (applied ? [1, 11] : [1]).map(canonical => ({ applied, earlyRedo, canonical })))))
  ('keeps exact unknown-outcome identity through $applied/$earlyRedo/$canonical', async scenario => {
    const initial = { a: { x: 0, hidden: 7 } }, fixture = new KernelFixture(initial), oracle = new ReferenceEditor(initial), server = new ReferenceServer(initial)
    const source = new SourceFixture(fixture.state.workspace.scope, initial)
    const compare = () => {
      expect(fixture.project().rows.find(row => row.entityId === 'a')?.preview).toEqual(oracle.preview().a)
      expect(fixture.project().rows.filter(row => row.persistence === 'blocked').map(row => row.entityId)).toEqual(oracle.blockedEntities())
      expect(source.writes).toBe(server.writes)
      expect([...source.rows.values()].map(row => row.document)).toEqual(Object.values(server.rows))
    }
    const control = (kind: 'undo' | 'redo') => expect(fixture.dispatch(prepareHistoryCommand(fixture.state, fixture.schema, kind, () => `history:${fixture.next()}`)).result.kind).toBe('accepted')
    fixture.apply([fixture.write('a', { x: 1 })]); const original = oracle.write('a', { x: 1 })
    const frozen = fixture.freeze().submission, request = oracle.freeze('original'), originalBytes = JSON.stringify(frozen)
    if (!scenario.applied) { source.external(initial); server.external(initial) }
    source.normalize = document => ({ ...document, x: scenario.canonical, hidden: 17 })
    const actual = await source.submit(frozen)
    const receipt = scenario.applied ? server.apply(request, (_entity, row) => ({ ...row, x: scenario.canonical, hidden: 17 })) : null
    if (!scenario.applied) expect(() => server.apply(request)).toThrow('Definitely not applied')
    fixture.dispatch({ kind: 'mutation-uncertain', ref: frozen, attempt: 1, issue: { code: 'lost', message: 'Response lost' } }); oracle.unknown()
    control('undo'); oracle.undo(original)
    if (scenario.earlyRedo) { control('redo'); oracle.redo(original) }
    compare()
    expect(JSON.stringify('submission' in fixture.state.persistence ? fixture.state.persistence.submission : null)).toBe(originalBytes)
    expect(oracle.retry()).toEqual(request)
    if (actual.kind === 'applied' && receipt) {
      expect(fixture.dispatch({ kind: 'exact-receipt', receipt: actual.receipt }).result.kind).toBe('accepted'); oracle.receive(receipt)
    } else if (actual.kind === 'not-applied') {
      expect(fixture.dispatch({ kind: 'not-applied', proof: actual.proof }).result.kind).toBe('accepted'); oracle.notApplied()
    } else throw new Error('Missing exact outcome')
    fixture.observe(server.rows, server.version); oracle.observe(server.rows, server.version)
    compare()
    if (!scenario.earlyRedo) {
      // Inspect the undo branch before redo can hide an incorrect compensation.
      expect(fixture.project().rows[0]?.preview).toEqual({ x: 0, hidden: scenario.applied ? 17 : 7 })
      if (scenario.applied) {
        expect(fixture.prepareSave().submission.items).toMatchObject([{ kind: 'update',
          before: { x: scenario.canonical, hidden: 17 }, after: { x: 0, hidden: 17 } }])
      } else {
        expect(fixture.project().changes).toEqual([])
        expect(() => fixture.prepareSave()).toThrow('no saveable')
        expect(source.writes).toBe(0)
      }
    }
    if (!scenario.earlyRedo) { control('redo'); oracle.redo(original) }
    compare()
    source.normalize = document => document
    let followup
    try { followup = oracle.freeze('followup') } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Nothing can be saved') throw error
      expect(fixture.project().changes).toEqual([])
    }
    if (followup) {
      expect(fixture.project().changes.map(change => ({ entity: change.entityId, value: change.after }))).toEqual(followup.items)
      const next = fixture.freeze().submission, result = await source.submit(next)
      if (result.kind !== 'applied') throw new Error('Followup unexpectedly rejected')
      oracle.receive(server.apply(followup)); fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt })
      fixture.observe(server.rows, server.version); oracle.observe(server.rows, server.version)
    }
    compare()
    expect(source.requests.filter(submission => submission.operationId === frozen.operationId)).toHaveLength(1)
  })


  it.each([false, true].flatMap(earlyRedo => [1, 2, 3].map(rate => ({ earlyRedo, rate }))))
  ('retains the original computation input through $earlyRedo/$rate', scenario => {
    const initial = { a: { x: 0, rate: 1 } }, fixture = new KernelFixture(initial), oracle = new ReferenceEditor(initial)
    fixture.apply([fixture.write('a', { x: 10 }, { reads: [{ role: 'semantic-read', resource: { kind: 'path', entityId: kernelId<'entity'>('a'), path: ['rate'] } }] })])
    const original = oracle.write('a', { x: 10 }, { rate: 1 })
    const control = (kind: 'undo' | 'redo') => expect(fixture.dispatch(prepareHistoryCommand(fixture.state, fixture.schema, kind, () => `history:${fixture.next()}`)).result.kind).toBe('accepted')
    control('undo'); oracle.undo(original)
    if (scenario.earlyRedo) { control('redo'); oracle.redo(original) }
    const remote = { a: { x: 0, rate: scenario.rate } }
    fixture.observe(remote, 1); oracle.observe(remote, 1)
    if (!scenario.earlyRedo) {
      if (scenario.rate === 1) { control('redo'); oracle.redo(original) }
      else {
        const before = fixture.state, requirements = structuredClone(oracle.requirements)
        expect(fixture.dispatch(prepareHistoryCommand(fixture.state, fixture.schema, 'redo', () => `history:${fixture.next()}`)).result.kind).toBe('rejected')
        expect(() => oracle.redo(original)).toThrow('original computation input')
        expect(fixture.state).toBe(before); expect(oracle.requirements).toEqual(requirements)
      }
    }
    expect(fixture.project().rows[0]!.preview).toEqual(oracle.preview().a)
    expect(fixture.project().rows.filter(row => row.persistence === 'blocked').map(row => row.entityId)).toEqual(oracle.blockedEntities())
    // The stored result was computed using rate=1; redo cannot silently
    // reinterpret it as a fresh computation under the new rate.
    expect(oracle.blockedEntities()).toEqual(scenario.earlyRedo && scenario.rate !== 1 ? ['a'] : [])
    if (scenario.rate !== 1) {
      expect(() => oracle.freeze('invalid-computation')).toThrow('Nothing can be saved')
      expect(() => fixture.prepareSave()).toThrow('no saveable')
    }
  })

})
