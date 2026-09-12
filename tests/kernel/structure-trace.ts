import { expect } from 'vitest'
import { KernelFixture, permissiveSchema } from './fixtures.js'
import { SourceFixture } from './source-fixture.js'
import { ReferenceStructure, type StructureDocument } from './structure-model.js'
import { prepareHistoryCommand } from '../../src/kernel/history-command.js'
import { kernelId, type EntityId } from '../../src/kernel/model.js'
import { bindServerAuthority, unboundServerIdentities } from '../../src/kernel/source.js'
import type { TraceOutcome } from './generated-trace.js'

export type StructureEvent = 'save' | 'undo' | 'redo'
export type StructureScenario = Readonly<{ kind: 'create' | 'delete'; commitOriginal: boolean; commitUndo: boolean;
  normalize: boolean; restoreDeleted: boolean; seed?: number; schedule?: readonly StructureEvent[] }>
class StructureMismatch extends Error {
  constructor(readonly property: string, readonly diagnostics: unknown) { super(property) }
}

/** Each replay allocates fresh production, server and independent-model state.
 * Only explicit comparisons become shrinkable failures; infrastructure errors propagate.
 * Rejected/no-op history commands are valid events and are checked, never discarded. */
export async function replayStructureTrace(scenario: StructureScenario): Promise<TraceOutcome> {
  const trace: string[] = []
  const check = (property: string, actual: unknown, expected: unknown) => {
    try { expect(actual).toEqual(expected) }
    catch (error) { throw new StructureMismatch(property, { scenario, trace: [...trace], actual, expected,
      message: error instanceof Error ? error.message : String(error) }) }
  }
  const run = async () => {
    const document = { x: 1, hidden: 7 }, initial = scenario.kind === 'delete' ? { a: document } : {}
    const fixture = new KernelFixture(initial, permissiveSchema, { restoreDeleted: scenario.restoreDeleted })
    const source = new SourceFixture(fixture.state.workspace.scope, initial, scenario.restoreDeleted)
    const model = new ReferenceStructure(scenario.kind, document, scenario.restoreDeleted), identities = new Map<number, EntityId>()
    if (scenario.kind === 'delete') identities.set(0, kernelId<'entity'>('a'))
    const normalize = (row: StructureDocument) => scenario.normalize ? { ...row, x: Number(row.x) + 10, hidden: Number(row.hidden) + 1 } : row
    source.normalize = row => normalize(row as StructureDocument)
    const compare = (step: string) => {
      trace.push(step)
      const expected = model.project(), actual = fixture.project().rows.filter(row => row.preview !== null)
      check('visible-documents', actual.map(row => row.preview), expected ? [expected.document] : [])
      if (expected) {
        const id = actual[0]!.entityId, prior = identities.get(expected.lifetime)
        if (prior) check('stable-lifetime', id, prior)
        else {
          check('fresh-lifetime', [...identities.values()].includes(id), false)
          identities.set(expected.lifetime, id)
        }
      }
      check('projection-issues', fixture.project().rows.flatMap(row => row.issues), [])
      check('server-write-count', source.writes, model.writes)
      check('server-documents', [...source.rows.values()].map(row => row.document), [...model.stored.values()])
    }
    const save = async () => {
      const expected = model.changes(), changes = fixture.project().changes
      check('structural-write-set', changes.map(change => ({ kind: change.kind, lifetime: [...identities].find(([, entity]) => entity === change.entityId)?.[0], document: change.kind === 'delete' ? change.before : change.after }))
        .sort((a, b) => a.kind.localeCompare(b.kind)), [...expected].sort((a, b) => a.kind.localeCompare(b.kind)))
      if (!expected.length) { compare('no-write'); return }
      const submission = fixture.freeze().submission, result = await source.submit(submission)
      if (result.kind !== 'applied') { check('source-application', result.kind, 'applied'); return }
      const oldBindings = new Map(fixture.state.entities.filter(binding => binding.kind !== 'local').map(binding => [binding.entityId, binding.identity]))
      model.commit(normalize)
      check('receipt-acceptance', fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt }).result.kind, 'accepted')
      const snapshot = await source.readAtLeast()
      const allocations = unboundServerIdentities(fixture.state, snapshot).map(identity => ({ identity, entityId: kernelId<'entity'>(`read:${fixture.next()}`) }))
      check('authority-acceptance', fixture.dispatch({ kind: 'authority-observed', snapshot: bindServerAuthority(fixture.state, snapshot, allocations) }).result.kind, 'accepted')
      check('save-settled', fixture.state.persistence.kind, 'idle')
      for (const binding of fixture.state.entities) if (binding.kind !== 'local' && oldBindings.has(binding.entityId)) check('stable-server-identity', binding.identity, oldBindings.get(binding.entityId))
      // Every later materialized lifetime must also get a new server identity.
      const serverIdentities = fixture.state.entities.filter(binding => binding.kind !== 'local').map(binding => JSON.stringify(binding.identity))
      check('unique-server-identity', new Set(serverIdentities).size, serverIdentities.length)
      compare('saved')
    }
    const control = (kind: 'undo' | 'redo') => {
      let rejected = false
      try { model[kind]() }
      catch (error) {
        if (!(error instanceof Error) || ![`No structural action to ${kind}`, 'The source cannot restore deleted rows'].includes(error.message)) throw error
        rejected = true
      }
      const before = fixture.state
      let result: string
      try { result = fixture.dispatch(prepareHistoryCommand(fixture.state, fixture.schema, kind, () => `history:${fixture.next()}`)).result.kind }
      catch (error) {
        if (!(error instanceof Error) || ![`There is no action to ${kind}.`, 'This source cannot restore a committed deletion.'].includes(error.message)) throw error
        result = 'rejected'
      }
      check('history-acceptance', result, rejected ? 'rejected' : 'accepted')
      if (rejected) check('rejected-history-state', fixture.state === before, true)
      compare(kind)
      return !rejected
    }
    fixture.apply([scenario.kind === 'create' ? { kind: 'create', entityId: kernelId<'entity'>('local'), document } : { kind: 'delete', entityId: kernelId<'entity'>('a') }])
    model.begin(); compare('begin')
    if (scenario.schedule) {
      for (const event of scenario.schedule) {
        if (event === 'save') await save()
        else control(event)
      }
      return
    }
    if (scenario.commitOriginal) await save()
    for (let cycle = 0; cycle < 3; cycle++) {
      if (!control('undo')) return
      if (scenario.commitUndo) await save()
      control('redo'); await save()
    }
    if (control('undo')) await save()
  }
  try { await run(); return { kind: 'pass' } }
  catch (error) {
    if (!(error instanceof StructureMismatch)) throw error
    return { kind: 'fail', failure: { property: error.property, diagnostics: error.diagnostics } }
  }
}
