import { ReferenceTaskSession, type TaskSessionEvent } from './task-session-model.js'
import { seededRandom, type TraceOutcome } from './generated-trace.js'
import { KernelFixture, permissiveSchema } from './fixtures.js'
import { defineKernelSchema } from '../../src/kernel/schema.js'
import { kernelId } from '../../src/kernel/model.js'
import type { KernelEvent } from '../../src/kernel/transition.js'

const sessionId = kernelId<'session'>('session'), viewId = kernelId<'view'>('view'), fieldId = kernelId<'field'>('x')
const ref = { taskId: kernelId<'task'>('task'), executionId: 'execution' }
const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: fieldId, path: ['x'], readonly: false }] })
export const taskValueShrinker = {
  rank: (event: TaskSessionEvent) => 'text' in event && event.text !== undefined ? Array.from(event.text).length : event.kind === 'remote' ? Math.abs(event.value) : 0,
  candidates: (event: TaskSessionEvent): readonly TaskSessionEvent[] => {
    if (event.kind === 'remote') return [...new Set([0, Math.sign(event.value), Math.trunc(event.value / 2)])]
      .filter(value => Math.abs(value) < Math.abs(event.value)).map(value => ({ ...event, value }))
    if ((event.kind !== 'type' && event.kind !== 'complete') || event.text === undefined) return []
    const points = Array.from(event.text)
    return [...new Set(['', points[0] ?? '', points.slice(0, Math.floor(points.length / 2)).join('')])]
      .filter(text => Array.from(text).length < points.length).map(text => ({ ...event, text }))
  },
}
class TaskFixture extends KernelFixture {
  private authorityVersion = 0
  constructor() {
    super({ a: { x: 0 }, b: { x: 0 } }, schema)
    const opened = this.dispatch({ kind: 'session-opened', revision: this.state.revision, sessionId, inputId: kernelId<'input'>('editor'), viewId,
      target: { kind: 'cell', field: { entityId: kernelId<'entity'>('a'), fieldId } }, input: { kind: 'encoded', value: 'original text' }, reads: [] })
    if (opened.result.kind !== 'accepted') throw new Error('Cannot initialize task trace session')
    const registered = this.dispatch({ kind: 'task-registered', ...ref, revision: this.state.revision,
      owner: { kind: 'session', sessionId, input: this.state.session!.input }, inputId: kernelId<'input'>('file'), input: { kind: 'encoded', value: 'original file' }, reads: [] })
    if (registered.result.kind !== 'accepted' || this.dispatch({ kind: 'task-started', ...ref }).result.kind !== 'accepted') throw new Error('Cannot initialize task trace execution')
  }
  applyEvent(event: TaskSessionEvent) {
    const session = this.state.session
    const editor = { lease: session?.editor!, inputVersion: session?.input.version ?? 0 }
    let command: KernelEvent
    switch (event.kind) {
      case 'type': command = { kind: 'session-input', ...editor, input: { kind: 'encoded', value: event.text }, composition: 'idle' }; break
      case 'detach': command = { kind: 'session-detached', ...editor }; break
      case 'attach': command = { kind: 'session-attached', sessionId, viewId }; break
      case 'confirm': command = { kind: 'session-reconfirmed', ...editor, revision: this.state.revision }; break
      case 'retarget': command = { kind: 'session-retargeted', ...editor, revision: this.state.revision,
        target: { kind: 'cell', field: { entityId: kernelId<'entity'>(event.target), fieldId } }, reads: [] }; break
      case 'cancel-task': command = { kind: 'task-cancelled', ...ref }; break
      case 'cancel-session': command = { kind: 'session-cancelled', sessionId, inputVersion: session!.input.version, lease: session!.editor }; break
      case 'consume': command = { kind: 'task-consume', ...ref }; break
      case 'reapply':
      case 'stale-reapply': command = { kind: 'task-reapply', ...ref, revision: this.state.revision - (event.kind === 'stale-reapply' ? 1 : 0),
        owner: { kind: 'session', sessionId, input: session?.input ?? { id: kernelId<'input'>('editor'), version: 0 } } }; break
      case 'complete': command = { kind: 'task-completed', ...ref, executionId: event.wrongExecution ? 'wrong-execution' : ref.executionId,
        result: { kind: 'session-candidate', sessionId: event.wrongSession ? kernelId<'session'>('wrong-session') : sessionId, input: { kind: 'encoded', value: event.text ?? 'converted result' } } }; break
      case 'remote': {
        const current = this.state.authority.content
        if (current.kind !== 'complete') throw new Error('Missing trace authority')
        const rows = Object.fromEntries(current.snapshot.entities.map(row => [row.entityId, row.document]))
        rows[event.target] = { x: event.value }
        return this.observe(rows, ++this.authorityVersion).result.kind
      }
    }
    return this.dispatch(command).result.kind
  }
  semanticSnapshot() {
    const task = this.state.tasks[0]!, session = this.state.session
    return {
      phase: task.kind, result: 'result' in task && !!task.result,
      resultText: 'result' in task && task.result?.kind === 'session-candidate' && task.result.input.kind === 'encoded' ? task.result.input.value : null, session: !!session,
      attached: !!session?.editor, target: session?.target.kind === 'cell' ? session.target.field.entityId : null,
      version: session?.input.version ?? null, text: session?.rawInput.kind === 'encoded' ? session.rawInput.value : null,
      retained: !!session?.retainedInputs.some(input => input.id === 'file'),
      inputs: this.state.inputs.map(input => ({ id: input.ref.id, version: input.ref.version,
        text: input.input.kind === 'encoded' ? input.input.value : null, disposition: input.disposition.kind,
        by: input.disposition.kind === 'superseded' ? input.disposition.by.version : null })),
    }
  }
}

export function generateTaskSessionTrace(seed: number): readonly TaskSessionEvent[] {
  const random = seededRandom(seed), model = new ReferenceTaskSession(), events: TaskSessionEvent[] = []
  for (let index = 0, length = 12 + random(30); index < length; index++) {
    const choices: TaskSessionEvent[] = [
      { kind: 'type', text: `text:${index}` }, { kind: 'detach' }, { kind: 'attach' },
      { kind: 'remote', target: random(2) ? 'a' : 'b', value: random(3) },
      { kind: 'retarget', target: random(2) ? 'a' : 'b' }, { kind: 'confirm' },
      { kind: 'complete', wrongExecution: false, wrongSession: false, text: ['', '转换结果', '😀\t原文\n', `result:${index}`][random(4)]! },
      { kind: 'complete', wrongExecution: random(2) === 0, wrongSession: true, text: ['', '错目标结果', '😀'][random(3)]! },
      { kind: 'consume' }, { kind: 'reapply' }, { kind: 'stale-reapply' },
      { kind: 'cancel-task' }, { kind: 'cancel-session' },
    ]
    const event = choices[random(choices.length)]!
    if (model.apply(event) !== 'invalid') events.push(event)
  }
  return events
}

export async function replayTaskSessionTrace(events: readonly TaskSessionEvent[]): Promise<TraceOutcome> {
  const fixture = new TaskFixture(), model = new ReferenceTaskSession()
  for (const [step, event] of events.entries()) {
    const expected = model.apply(event)
    if (expected === 'invalid') return { kind: 'invalid' }
    const before = fixture.state, actual = fixture.applyEvent(event), state = fixture.state
    const failure = (property: string, actual: unknown, expected: unknown): TraceOutcome => ({ kind: 'fail', failure: { property,
      diagnostics: { step, actual, expected, inputs: state.inputs, tasks: state.tasks, session: state.session, journal: state.journal, receipts: state.commits } } })
    if (actual !== expected) return failure('task-command-decision', actual, expected)
    if ((expected === 'ignored' || expected === 'rejected') && state !== before)
      return failure('task-rejection-atomicity', state, before)
    const observed = fixture.semanticSnapshot(), target = {
      phase: model.phase, result: model.result, resultText: model.resultText, session: model.session,
      attached: model.attached, target: model.session ? model.target : null,
      version: model.session ? model.version : null, text: model.session ? model.text : null,
      retained: model.session && model.retained,
      inputs: model.inputs,
    }
    if (JSON.stringify(observed) !== JSON.stringify(target)) return failure('task-input-ownership', observed, target)
    if (state.journal.intents.length || fixture.project().changes.length) return failure('candidate-wrote-data', state.journal, [])
    if (state.authority.content.kind !== 'complete') return failure('authority-completeness', state.authority, 'complete')
    for (const entity of ['a', 'b'] as const) {
      const row = state.authority.content.snapshot.entities.find(row => row.entityId === entity)
      if (row?.document.x !== model.authority[entity]) return failure('task-authority', row, model.authority[entity])
    }
  }
  return { kind: 'pass' }
}
