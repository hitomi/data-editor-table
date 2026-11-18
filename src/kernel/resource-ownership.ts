import { ownEncodedValue } from './document.js'
import type { OwnedInput, ResourceDescriptor, ResourceId } from './model.js'
import type { KernelState } from './state.js'

export type ResourceEvent =
  | Readonly<{ kind: 'resource-registered'; descriptor: ResourceDescriptor }>
  | Readonly<{ kind: 'resource-released'; resourceId: ResourceId }>

export function inputResources(inputs: readonly OwnedInput[]): ReadonlySet<ResourceId> {
  return new Set(inputs.flatMap(input => input.kind === 'resource' ? [input.id] : []))
}

/** Terminal input still has historical references. No resource is reclaimed
 * merely because its editor closed, task cancelled, or row was committed. */
export function referencedResources(state: KernelState): ReadonlySet<ResourceId> {
  const inputs = state.inputs.map(record => record.input)
  if (state.session) inputs.push(state.session.rawInput)
  for (const task of state.tasks) if ('result' in task && task.result) {
    if (task.result.kind !== 'action') inputs.push(task.result.input)
    else inputs.push(...task.result.action.inputs.map(record => record.input))
  }
  for (const task of state.tasks) if (task.execution?.outcome?.kind === 'succeeded') {
    const result = task.execution.outcome.result
    if (result.kind !== 'action') inputs.push(result.input)
    else inputs.push(...result.action.inputs.map(record => record.input))
  }
  return inputResources(inputs)
}

export function ownResourceDescriptor(raw: ResourceDescriptor): ResourceDescriptor {
  const descriptor = ownEncodedValue(raw) as unknown as ResourceDescriptor
  if (!descriptor.id || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || typeof descriptor.mediaType !== 'string') throw new Error('Resource metadata requires an identity, byte size and media type.')
  if (descriptor.kind !== 'blob' && descriptor.kind !== 'file') throw new Error('Only owned File and Blob resources are supported.')
  if (descriptor.kind === 'file' && (typeof descriptor.name !== 'string' || !Number.isSafeInteger(descriptor.lastModified))) throw new Error('File metadata requires its name and last-modified time.')
  return descriptor
}

export function assertRegisteredResources(state: KernelState) {
  const available = new Set(state.resources.filter(record => record.status === 'available').map(record => record.descriptor.id))
  for (const id of referencedResources(state)) if (!available.has(id)) throw new Error('An input or task result references an unavailable resource. Register its bytes before accepting it.')
}

export function reduceResource(state: KernelState, event: ResourceEvent): KernelState {
  if (event.kind === 'resource-registered') {
    const descriptor = ownResourceDescriptor(event.descriptor)
    if (state.resources.some(record => record.descriptor.id === descriptor.id)) throw new Error('Resource identities cannot be reused, including after release.')
    return Object.freeze({ ...state, resources: Object.freeze([...state.resources, Object.freeze({ descriptor, status: 'available' as const })]) })
  }
  const record = state.resources.find(record => record.descriptor.id === event.resourceId)
  if (!record || record.status !== 'available') throw new Error('Resource is not available for release.')
  if (referencedResources(state).has(event.resourceId)) throw new Error('Current or historical input still references this resource.')
  return Object.freeze({ ...state, resources: Object.freeze(state.resources.map(record => record.descriptor.id === event.resourceId
    ? Object.freeze({ ...record, status: 'released' as const }) : record)) })
}
