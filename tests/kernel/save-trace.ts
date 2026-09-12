import { ReferenceEditor, ReferenceServer, type SpecReceipt, type SpecRequest } from './reference-model.js'
import { KernelFixture } from './fixtures.js'
import { SourceFixture } from './source-fixture.js'
import { seededRandom, type TraceOutcome } from './generated-trace.js'
import type { FrozenSubmission } from '../../src/kernel/model.js'
import type { SourceMutationResult } from '../../src/kernel/source.js'
import { prepareHistoryCommand } from '../../src/kernel/history-command.js'

export type SaveEvent =
  | Readonly<{ kind: 'write'; entity: 'a' | 'b'; value: number }>
  | Readonly<{ kind: 'freeze' | 'unknown' | 'execute' | 'receipt' | 'read' | 'old-read' | 'undo' | 'redo' }>
  | Readonly<{ kind: 'external'; entity: 'a' | 'b'; value: number }>

/** Generated inputs are integers. Rank strictly decreases so shrinking cannot
 * oscillate, even when zero or a sign change triggers a different property. */
export const saveValueShrinker = {
  rank: (event: SaveEvent) => 'value' in event ? Math.abs(event.value) : 0,
  candidates: (event: SaveEvent): readonly SaveEvent[] => 'value' in event && event.value !== 0
    ? [...new Set([0, Math.sign(event.value), Math.trunc(event.value / 2)])]
      .filter(value => Math.abs(value) < Math.abs(event.value)).map(value => ({ ...event, value })) : [],
}

/** One request lifecycle with independently interleaved local input, server
 * execution, external writes, exact delivery, current and cached reads.
 * Repeated cycles have a separate generator below. The history generator adds
 * explicit controls rather than disguising undo as a field write. Events
 * remain plain JSON for direct replay. */
export function generateSaveTrace(seed: number): readonly SaveEvent[] {
  const random = seededRandom(seed), events: SaveEvent[] = []
  let value = 1
  const write = (): SaveEvent => ({ kind: 'write', entity: random(2) ? 'a' : 'b', value: value++ })
  for (let n = 1 + random(5); n > 0; n--) events.push(write())
  events.push({ kind: 'freeze' })
  let executed = false, delivered = false, unknown = false
  for (let n = 5 + random(20); n > 0; n--) {
    const choice = random(7)
    if (choice < 2) events.push(write())
    else if (choice === 2) events.push({ kind: 'external', entity: random(2) ? 'a' : 'b', value: 30 + random(8) })
    else if (choice === 3) events.push({ kind: random(2) ? 'read' : 'old-read' })
    else if (!executed) { events.push({ kind: 'execute' }); executed = true }
    else if (!unknown && !delivered) { events.push({ kind: 'unknown' }); unknown = true }
    else if (!delivered) { events.push({ kind: 'receipt' }); delivered = true }
    else events.push({ kind: 'read' })
  }
  if (!executed) events.push({ kind: 'execute' })
  if (!delivered) events.push({ kind: 'receipt' })
  events.push({ kind: 'read' })
  return events
}

export function generateHistoryTrace(seed: number): readonly SaveEvent[] {
  const random = seededRandom((seed ^ 0x12345678) >>> 0), events: SaveEvent[] = []
  let undo = 0, redo = 0, frozen = false
  for (const event of generateSaveTrace(seed)) {
    events.push(event)
    if (event.kind === 'write') { undo++; redo = 0 }
    if (event.kind === 'freeze') frozen = true
    if (!frozen) continue
    const choice = random(4)
    if (choice === 0 && undo) { events.push({ kind: 'undo' }); undo--; redo++ }
    else if (choice === 1 && redo) { events.push({ kind: 'redo' }); undo++; redo-- }
  }
  return events
}

/** Multiple normalized commits in one owner, with successor input and history
 * controls crossing request boundaries. External conflict schedules remain in
 * generateHistoryTrace; this generator guarantees each next freeze has work. */
export function generateRepeatedSaveTrace(seed: number): readonly SaveEvent[] {
  const random = seededRandom((seed ^ 0x5a71c903) >>> 0), events: SaveEvent[] = []
  let value = 100
  for (let cycle = 0, count = 3 + random(6); cycle < count; cycle++) {
    for (const entity of ['a', 'b'] as const) events.push({ kind: 'write', entity, value: value++ })
    events.push({ kind: 'freeze' })
    if (random(2)) events.push({ kind: 'unknown' })
    if (random(2)) events.push({ kind: 'undo' }, { kind: 'redo' })
    if (random(2)) events.push({ kind: 'write', entity: random(2) ? 'a' : 'b', value: value++ })
    events.push({ kind: 'execute' })
    if (random(2)) events.push({ kind: 'read' })
    if (random(2)) events.push({ kind: 'old-read' })
    events.push({ kind: 'receipt' }, { kind: 'read' })
    if (random(2)) events.push({ kind: 'undo' }, { kind: 'redo' })
  }
  return events
}

/** External authority changes between normalized save cycles and after server
 * execution but before receipt delivery. Pre-execution conflicts reject the
 * request; explicit undo removes those unsent requirements before the next
 * cycle. Both rows and full hidden documents
 * remain in the independent oracle across every cycle. */
export function generateRepeatedExternalSaveTrace(seed: number): readonly SaveEvent[] {
  const random = seededRandom((seed ^ 0x34af1709) >>> 0), events: SaveEvent[] = []
  for (let cycle = 0, count = 3 + random(6); cycle < count; cycle++) {
    events.push({ kind: 'external', entity: random(2) ? 'a' : 'b', value: 1000 + cycle }, { kind: 'read' })
    for (const entity of ['a', 'b'] as const) events.push({ kind: 'write', entity, value: 100 + cycle * 2 + (entity === 'b' ? 1 : 0) })
    events.push({ kind: 'freeze' })
    if (random(2)) events.push({ kind: 'unknown' })
    const rejected = random(2) === 1
    if (rejected) events.push({ kind: 'external', entity: random(2) ? 'a' : 'b', value: 3000 + cycle })
    events.push({ kind: 'execute' })
    events.push({ kind: 'external', entity: random(2) ? 'a' : 'b', value: 2000 + cycle })
    if (random(2)) events.push({ kind: 'read' })
    if (random(2)) events.push({ kind: 'old-read' })
    events.push({ kind: 'receipt' }, { kind: 'read' })
    if (rejected) events.push({ kind: 'undo' }, { kind: 'undo' })
  }
  return events
}

const initial = { a: { x: 0, hidden: 7 }, b: { x: 0, hidden: 9 } }
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export async function replaySaveTrace(events: readonly SaveEvent[]): Promise<TraceOutcome> {
  const fixture = new KernelFixture(initial), oracle = new ReferenceEditor(initial)
  const source = new SourceFixture(fixture.state.workspace.scope, initial), server = new ReferenceServer(initial)
  source.normalize = document => ({ ...document, x: Number(document.x) + 0.5, hidden: Number(document.hidden) + 1 })
  let request: SpecRequest | null = null, submission: FrozenSubmission | null = null
  let result: SourceMutationResult | null = null, receipt: SpecReceipt | null = null, delivered = false, bytes = ''
  let requestSequence = 0
  const inputs: { id: string; raw: string }[] = []
  const frozenRequests: { submission: FrozenSubmission; bytes: string }[] = []
  const undo: number[] = [], redo: number[] = []
  const failed = (property: string, actual: unknown, expected: unknown, step: number): TraceOutcome => ({ kind: 'fail', failure: { property,
    diagnostics: { step, actual, expected, journal: fixture.state.journal, receipts: fixture.state.commits, request, serverRows: server.rows } } })
  for (const [step, event] of events.entries()) {
    switch (event.kind) {
      case 'write': {
        const raw = JSON.stringify(event), prepared = fixture.apply([fixture.write(event.entity, { x: event.value })], 'row', raw)
        undo.push(oracle.write(event.entity, { x: event.value })); redo.length = 0
        inputs.push({ id: prepared.inputs[0]!.ref.id, raw })
        break
      }
      case 'undo':
      case 'redo': {
        const target = (event.kind === 'undo' ? undo : redo).at(-1)
        if (target === undefined) return { kind: 'invalid' }
        try {
          const command = prepareHistoryCommand(fixture.state, fixture.schema, event.kind, () => `generated-history:${fixture.next()}`)
          const transition = fixture.dispatch(command)
          if (transition.result.kind !== 'accepted') return failed('history-acceptance', transition.result, 'accepted', step)
        } catch (error) { return failed('history-acceptance', error instanceof Error ? error.message : String(error), 'accepted', step) }
        if (event.kind === 'undo') { oracle.undo(target); undo.pop(); redo.push(target) }
        else { undo.push(oracle.redo(target)); redo.pop() }
        break
      }
      case 'freeze': {
        if (oracle.request) return { kind: 'invalid' }
        try { request = oracle.freeze(`request:${++requestSequence}`) } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Nothing can be saved') throw error
          return { kind: 'invalid' }
        }
        result = null; receipt = null; delivered = false
        // Independent row item enumeration is not persisted row order.
        const expected = Object.fromEntries(request.items.map(item => [item.entity, item.value]))
        const actual = Object.fromEntries(fixture.project().changes.map(item => [item.entityId, item.kind === 'delete' ? null : item.after]))
        if (canonical(actual) !== canonical(expected)) return failed('save-plan', actual, expected, step)
        submission = fixture.freeze().submission; bytes = JSON.stringify(submission)
        frozenRequests.push({ submission, bytes })
        break
      }
      case 'execute': {
        if (!request || !submission || result) return { kind: 'invalid' }
        result = await source.submit(submission)
        try { receipt = server.apply(request, (_entity, row) => ({ ...row, x: Number(row.x) + 0.5, hidden: Number(row.hidden) + 1 })) }
        catch (error) { if (!(error instanceof Error) || error.message !== 'Definitely not applied') throw error }
        if ((result.kind === 'applied') !== !!receipt) return failed('server-outcome', result, receipt, step)
        break
      }
      case 'unknown': {
        if (!submission || delivered || oracle.outcome !== 'sending') return { kind: 'invalid' }
        const transition = fixture.dispatch({ kind: 'mutation-uncertain', ref: submission, attempt: 1, issue: { code: 'lost', message: 'Response lost' } })
        if (transition.result.kind !== 'accepted') return failed('unknown-acceptance', transition.result, 'accepted', step)
        oracle.unknown()
        break
      }
      case 'receipt': {
        if (!submission || !result || delivered) return { kind: 'invalid' }
        if (result.kind === 'applied' && receipt) {
          const transition = fixture.dispatch({ kind: 'exact-receipt', receipt: result.receipt })
          if (transition.result.kind !== 'accepted') return failed('receipt-acceptance', transition.result, 'accepted', step)
          oracle.receive(receipt)
        } else if (result.kind === 'not-applied' && !receipt) {
          const transition = fixture.dispatch({ kind: 'not-applied', proof: result.proof })
          if (transition.result.kind !== 'accepted') return failed('rejection-acceptance', transition.result, 'accepted', step)
          oracle.notApplied()
        } else throw new Error('Trace source lacks an exact terminal result')
        delivered = true
        break
      }
      case 'external': {
        const rows = { ...server.rows, [event.entity]: { ...server.rows[event.entity], x: event.value } }
        source.external(rows); server.external(rows)
        break
      }
      case 'read':
      case 'old-read': {
        const rows = event.kind === 'read' ? server.rows : initial, version = event.kind === 'read' ? server.version : 0
        // Both are valid server snapshots. A production rejection is a
        // semantic failure too, and must retain a shrinkable trace. Exceptions
        // elsewhere (for example a broken fixture import) still propagate.
        try { fixture.observe(rows, version) }
        catch (error) { return failed('authority-observation', error instanceof Error ? error.message : String(error), 'accept current or ignore stale', step) }
        oracle.observe(rows, version)
        break
      }
    }
    const projection = fixture.project()
    const actual = Object.fromEntries(projection.rows.map(row => [row.entityId, row.preview]))
    if (canonical(actual) !== canonical(oracle.preview())) return failed('visible-values', actual, oracle.preview(), step)
    // Submitted contribution has its own display phase; once its outcome is
    // settled, compare the remaining requirements' conflict membership too.
    if (oracle.outcome === 'idle') {
      const blocked = projection.rows.filter(row => row.persistence === 'blocked').map(row => row.entityId).sort()
      const expected = oracle.blockedEntities().sort()
      if (canonical(blocked) !== canonical(expected)) return failed('conflict-membership', blocked, expected, step)
      const targets = Object.fromEntries(Object.entries(oracle.preview()).filter(([entity, document]) =>
        !expected.includes(entity) && canonical(document) !== canonical(oracle.authority[entity])))
      const changes = Object.fromEntries(projection.changes.map(change => [change.entityId, change.kind === 'delete' ? null : change.after]))
      if (canonical(changes) !== canonical(targets)) return failed('eligible-write-set', changes, targets, step)
    }
    const stored = Object.fromEntries([...source.rows.values()].map(row => [row.identity.key, row.document]))
    if (canonical(stored) !== canonical(server.rows) || source.writes !== server.writes)
      return failed('server-state', { stored, writes: source.writes }, { stored: server.rows, writes: server.writes }, step)
    for (const input of inputs) {
      const owned = fixture.state.inputs.find(record => record.ref.id === input.id)
      if (owned?.input.kind !== 'encoded' || owned.input.value !== input.raw) return failed('input-conservation', owned, input, step)
    }
    if ('submission' in fixture.state.persistence && JSON.stringify(fixture.state.persistence.submission) !== bytes)
      return failed('frozen-request', fixture.state.persistence.submission, submission, step)
    for (const frozen of frozenRequests) {
      if (JSON.stringify(frozen.submission) !== frozen.bytes) return failed('historical-frozen-request', frozen.submission, frozen.bytes, step)
    }
  }
  return { kind: 'pass' }
}
