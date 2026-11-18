import { canonicalEncodedValue, encodedValuesEqual, ownEncodedValue } from './document.js'
import type { DurableTaskOutcome, DurableTaskRequest, OwnedInput, TaskDefinitionRef, TaskId, TaskOwner } from './model.js'
import { ResourceStore } from './resource-store.js'
import type { KernelState } from './state.js'

export type DurableTaskContext = Readonly<{ signal: AbortSignal; resource: Blob | null }>
/** An external execution service must fence execution identities for the
 * workspace lifetime, own an immutable request and retain exact outcomes.
 * Repeating start with the same request cannot repeat its external action.
 * A missing lookup is unknown, never permission to invent a new execution.
 * AbortSignal stops local waiting; it is not a proof of remote cancellation. */
export type DurableTaskDefinition = Readonly<{
  ref: TaskDefinitionRef
  capabilities: Readonly<{ idempotentStart: true; durableOutcomeLookup: true; executionIdFence: 'workspace' }>
  start(request: DurableTaskRequest, context: DurableTaskContext): Promise<DurableTaskOutcome>
  lookup(request: DurableTaskRequest, context: DurableTaskContext): Promise<DurableTaskOutcome>
}>
const own = <const T>(value: T): T => ownEncodedValue(value) as unknown as T
const same = (left: unknown, right: unknown) => encodedValuesEqual(ownEncodedValue(left), ownEncodedValue(right))
const key = (ref: TaskDefinitionRef) => JSON.stringify([ref.id, ref.version])

export class DurableTaskDefinitions {
  #definitions = new Map<string, DurableTaskDefinition>()
  constructor(definitions: readonly DurableTaskDefinition[] = []) {
    for (const definition of definitions) {
      const ref = own(definition.ref), capabilities = own(definition.capabilities)
      if (!ref.id || !ref.version || this.#definitions.has(key(ref)) || capabilities.idempotentStart !== true || capabilities.durableOutcomeLookup !== true
        || capabilities.executionIdFence !== 'workspace' || typeof definition.start !== 'function' || typeof definition.lookup !== 'function')
        throw new Error('Durable tasks require unique versioned definitions, idempotent execution and durable exact outcome lookup.')
      this.#definitions.set(key(ref), Object.freeze({ ref, capabilities, start: definition.start.bind(definition), lookup: definition.lookup.bind(definition) }))
    }
  }
  has(ref: TaskDefinitionRef): boolean { return this.#definitions.has(key(ref)) }
  get(ref: TaskDefinitionRef): DurableTaskDefinition {
    const definition = this.#definitions.get(key(ref))
    if (!definition) throw new Error('The exact durable task definition version is unavailable. Restore that definition before recovering this execution.')
    return definition
  }
}

async function sha256(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function payload(request: DurableTaskRequest) {
  const { payloadHash: _hash, ...ref } = request.ref
  return { ...request, ref }
}
async function requestHash(request: DurableTaskRequest) {
  return `sha256:${await sha256(new TextEncoder().encode(canonicalEncodedValue(ownEncodedValue(payload(request)))))}`
}

export async function prepareDurableTaskRequest(state: KernelState, taskId: TaskId, executionId: string, definition: TaskDefinitionRef,
  owner: TaskOwner, rawInput: OwnedInput, resources: ResourceStore): Promise<DurableTaskRequest> {
  const input = own(rawInput), captured = own({ workspace: state.workspace, taskId, executionId, definition, owner })
  let resource: DurableTaskRequest['resource'] = null
  if (input.kind === 'resource') {
    const record = state.resources.find(record => record.descriptor.id === input.id && record.status === 'available')
    if (!record) throw new Error('Durable task input requires registered resource bytes.')
    const blob = resources.get(input.id)
    resource = own({ descriptor: record.descriptor, sha256: await sha256(await Blob.prototype.arrayBuffer.call(blob)) })
  }
  const request = own({ ref: { workspaceId: captured.workspace.id, taskId, executionId, definition: captured.definition, payloadHash: '' },
    workspace: captured.workspace, owner: captured.owner, input, resource })
  return own({ ...request, ref: { ...request.ref, payloadHash: await requestHash(request) } })
}

export function assertDurableTaskRequest(request: DurableTaskRequest, state: KernelState, taskId: TaskId, executionId: string, input: OwnedInput, owner: TaskOwner) {
  if (request.ref.taskId !== taskId || request.ref.executionId !== executionId || request.ref.workspaceId !== state.workspace.id
    || !request.ref.definition.id || !request.ref.definition.version || !/^sha256:[0-9a-f]{64}$/.test(request.ref.payloadHash)
    || !same(request.workspace, state.workspace) || !same(request.input, input) || !same(request.owner, owner)) throw new Error('Durable task request does not match its immutable registration.')
  if (input.kind === 'resource') {
    const record = state.resources.find(record => record.descriptor.id === input.id && record.status === 'available')
    if (!record || !request.resource || !same(record.descriptor, request.resource.descriptor) || !/^[0-9a-f]{64}$/.test(request.resource.sha256)) throw new Error('Durable task resource identity or content digest is missing.')
  } else if (request.resource !== null) throw new Error('Encoded task input cannot claim unrelated resource bytes.')
}

/** Called immediately before external I/O, against the original immutable
 * request rather than a current editor value or a re-prepared action. */
export async function verifyDurableTaskRequest(raw: DurableTaskRequest, resources: ResourceStore): Promise<Blob | null> {
  const request = own(raw)
  if (await requestHash(request) !== request.ref.payloadHash) throw new Error('Durable task request digest differs from its frozen payload.')
  if (!request.resource) return null
  const resource = resources.get(request.resource.descriptor.id)
  if (await sha256(await Blob.prototype.arrayBuffer.call(resource)) !== request.resource.sha256) throw new Error('Durable task resource content differs from its frozen digest.')
  return resource
}
