import type { DurableTaskOutcome, DurableTaskRequest, TaskResult } from '../../src/kernel/model.js'
import type { DurableTaskDefinition } from '../../src/kernel/durable-task.js'

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
async function digest(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** External task-service oracle: owns request identities and terminal results
 * independently of the kernel, storage fixture and production hash helpers. */
export class DurableTaskFixture {
  readonly requests: DurableTaskRequest[] = []
  readonly lookups: DurableTaskRequest[] = []
  readonly records = new Map<string, { request: DurableTaskRequest; outcome: DurableTaskOutcome }>()
  executions = 0
  loseResponse = false
  fail = false
  beforeStart: (() => Promise<void>) | null = null
  result: (request: DurableTaskRequest) => TaskResult = request => {
    if (request.owner.kind !== 'session') throw new Error('Fixture expects session ownership')
    return { kind: 'session-candidate', sessionId: request.owner.sessionId, input: { kind: 'encoded', value: 42 } }
  }
  readonly definition: DurableTaskDefinition = {
    ref: { id: 'upload', version: 'v1' }, capabilities: { idempotentStart: true, durableOutcomeLookup: true, executionIdFence: 'workspace' },
    start: async (raw, context) => {
      const request = structuredClone(raw), ref = { ...request.ref }
      delete (ref as Partial<typeof ref>).payloadHash
      const hash = `sha256:${await digest(new TextEncoder().encode(canonical({ ...request, ref })))}`
      if (hash !== request.ref.payloadHash) throw new Error('Bad task request digest')
      if (request.resource && (!context.resource || await digest(await context.resource.arrayBuffer()) !== request.resource.sha256)) throw new Error('Bad task resource bytes')
      this.requests.push(request)
      if (this.beforeStart) await this.beforeStart()
      const key = JSON.stringify([request.workspace.id, request.ref.executionId]), previous = this.records.get(key)
      if (previous && canonical(previous.request) !== canonical(request)) throw new Error('One execution cannot change its request')
      let outcome = previous?.outcome
      if (!outcome) {
        this.executions++
        outcome = this.fail ? { kind: 'failed', ref: request.ref, issue: { code: 'execution-rejected', message: 'The external operation failed' } }
          : { kind: 'succeeded', ref: request.ref, result: this.result(request) }
        this.records.set(key, { request, outcome: structuredClone(outcome) })
      }
      if (this.loseResponse) { this.loseResponse = false; throw new Error('Task response lost') }
      return structuredClone(outcome)
    },
    lookup: async raw => {
      const request = structuredClone(raw)
      this.lookups.push(request)
      const existing = this.records.get(JSON.stringify([request.workspace.id, request.ref.executionId]))
      if (existing && canonical(existing.request) !== canonical(request)) throw new Error('Lookup changed original request')
      return structuredClone(existing?.outcome ?? { kind: 'unknown', ref: request.ref, issue: { code: 'missing-result', message: 'No exact result is available' } })
    },
  }
}
