import { replayStructureTrace, type StructureEvent, type StructureScenario } from '../../tests/kernel/structure-trace.js'
import { describe, expect, it, vi } from 'vitest'
import { KernelFixture, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { ReferenceStructure } from '../../tests/kernel/structure-model.js'
import { prepareHistoryCommand } from './history-command.js'
import { kernelId } from './model.js'
import { bindServerAuthority, unboundServerIdentities } from './source.js'
import { minimizeTrace, seededRandom } from '../../tests/kernel/generated-trace.js'

const cases = (['create', 'delete'] as const).flatMap(kind => [false, true].flatMap(commitOriginal => [false, true].flatMap(commitUndo => [false, true].flatMap(normalize => [false, true].map(restoreDeleted => ({ kind, commitOriginal, commitUndo, normalize, restoreDeleted }))))))
type ScheduleEvent = StructureEvent
const generated = Array.from({ length: 64 }, (_, seed) => {
  const random = seededRandom(seed), schedule: ScheduleEvent[] = []
  for (let index = 0, count = 8 + random(24); index < count; index++) schedule.push((['save', 'undo', 'redo'] as const)[random(3)]!)
  // Finish with an actual save attempt, including no-op or rejected histories.
  schedule.push('save')
  return { kind: random(2) ? 'create' as const : 'delete' as const, commitOriginal: false, commitUndo: false,
    normalize: !!random(2), restoreDeleted: !!random(2), seed, schedule }
})
const scenarios: readonly StructureScenario[] = [...cases, ...generated]

describe('independent structural identity model', () => {
  it('propagates source infrastructure failures instead of shrinking them', async () => {
    const failure = new Error('Source transport fixture failed')
    const submit = vi.spyOn(SourceFixture.prototype, 'submit').mockRejectedValueOnce(failure)
    try {
      await expect(replayStructureTrace({ kind: 'create', commitOriginal: false, commitUndo: false,
        normalize: false, restoreDeleted: true, schedule: ['save'] })).rejects.toBe(failure)
    } finally { submit.mockRestore() }
  })

  it.each(scenarios)('preserves lifetimes through $kind/$commitOriginal/$commitUndo/$normalize/$restoreDeleted seed=$seed', async scenario => {
    const result = await replayStructureTrace(scenario)
    if (result.kind === 'fail' && scenario.schedule) {
      const minimized = await minimizeTrace(scenario.schedule, schedule => replayStructureTrace({ ...scenario, schedule }))
      throw new Error(JSON.stringify({ scenario, ...minimized }, null, 2))
    }
    expect(result).toEqual({ kind: 'pass' })
  })

  it.each([false, true])('isolates a reused business key when restoration is committed=%s', async commitRestore => {
    const document = { x: 1, hidden: 7 }, peer = { x: 99, hidden: 99 }, initial = { a: document }
    const fixture = new KernelFixture(initial, permissiveSchema, { restoreDeleted: true }), source = new SourceFixture(fixture.state.workspace.scope, initial, true)
    const model = new ReferenceStructure('delete', document, true)
    const read = async () => {
      const snapshot = await source.readAtLeast()
      const allocations = unboundServerIdentities(fixture.state, snapshot).map(identity => ({ identity, entityId: kernelId<'entity'>(`external:${fixture.next()}`) }))
      expect(fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, snapshot, allocations) }).result.kind).toBe('accepted')
    }
    const save = async () => {
      const expected = model.changes(), changes = fixture.project().changes
      expect(changes.map(change => change.kind).sort()).toEqual(expected.map(change => change.kind).sort())
      if (!expected.length) return
      const submission = fixture.freeze().submission
      // No update/delete may bind the new row that merely reused key "a".
      for (const item of submission.items) if ((item.kind === 'delete' || item.kind === 'update') && source.version > 1)
        expect(item.identity).not.toEqual([...source.rows.values()].find(row => row.identity.key === 'a')?.identity)
      const result = await source.submit(submission)
      if (result.kind !== 'applied') throw new Error('Expected structural commit')
      model.commit(document => document)
      expect(fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }).result.kind).toBe('accepted'); await read()
      expect(source.writes).toBe(model.writes)
    }
    fixture.apply([{ kind: 'delete', entityId: kernelId<'entity'>('a') }]); model.begin(); await save()
    source.external({ a: peer }); await read()
    const peerRow = fixture.project().rows.find(row => row.preview?.x === 99)!, peerId = peerRow.entityId
    expect(peerId).not.toBe('a')
    const control = (kind: 'undo' | 'redo') => {
      model[kind]()
      expect(fixture.dispatch(prepareHistoryCommand(fixture.state, fixture.schema, kind, () => `history:${fixture.next()}`)).result.kind).toBe('accepted')
      expect(fixture.project().rows.find(row => row.entityId === peerId)?.preview).toEqual(peer)
      expect(fixture.project().rows.filter(row => row.entityId !== peerId && row.preview !== null).map(row => row.preview)).toEqual(model.project() ? [model.project()!.document] : [])
    }
    control('undo')
    const restored = fixture.project().rows.find(row => row.entityId !== peerId && row.preview !== null)!.entityId
    expect(restored).not.toBe('a'); expect(restored).not.toBe(peerId)
    if (commitRestore) await save()
    control('redo'); await save()
    expect([...source.rows.values()].map(row => row.document)).toEqual([peer])
    expect(fixture.state.entities.find(entity => entity.entityId === 'a')?.kind).toBe('retired')
    expect(fixture.state.entities.find(entity => entity.entityId === peerId)?.kind).toBe('bound')
  })

})
