import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { projectHistory } from './history.js'
import { kernelId, type IntentRecord } from './model.js'

/** Count element visits rather than relying on machine speed or timing noise.
 * This read-only proxy observes a valid, immutable history workload. */
describe('history lookup cost', () => {
  it.each([256, 512])('indexes %i applications without repeatedly scanning the journal', count => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    const template = fixture.prepare([fixture.write('a', { x: 1 })])
    const actions = Array.from({ length: count }, (_, index) => Object.freeze({ ...template.action,
      id: kernelId<'action'>(`action:${index}`), applicationId: kernelId<'application'>(`application:${index}`), intentIds: Object.freeze([kernelId<'intent'>(`intent:${index}`)]) }))
    const records = Object.freeze(actions.map((action, index): IntentRecord => Object.freeze({ ...template.intents[0]!, id: action.intentIds[0]!,
      actionId: action.id, applicationId: action.applicationId, sequence: index + 1, inputs: Object.freeze([]),
      operation: template.intents[0]!.operation.kind === 'write' ? Object.freeze({ ...template.intents[0]!.operation,
        groups: Object.freeze(template.intents[0]!.operation.groups.map((group, groupIndex) => Object.freeze({ ...group, id: kernelId<'write-group'>(`group:${index}:${groupIndex}`) }))) }) : template.intents[0]!.operation })))
    let visits = 0
    const intents = new Proxy(records, { get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) visits++
      return Reflect.get(target, property, receiver)
    } })
    const state = Object.freeze({ ...fixture.state, journal: Object.freeze({ frontiers: template.frontiers, actions: Object.freeze(actions), intents }) })
    const history = projectHistory(state)
    expect(history.undo).toEqual(actions); expect(history.redo).toEqual([])
    expect(visits).toBeLessThanOrEqual(count * 2)
    visits = 0
    const discarded = { ...state, revision: count + 1, discards: [{ ticket: { workspaceId: state.workspace.id, semanticRevision: count,
      ingressGeneration: count, runtimeGeneration: 0, leaseEpoch: 'reviewed' }, applicationCount: actions.length, resources: [] }] }
    expect(projectHistory(discarded)).toEqual({ undo: [], redo: [] })
    expect(visits).toBe(0)
  })
})
