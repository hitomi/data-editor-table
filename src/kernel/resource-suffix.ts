import { type Patch, type ResourceValue } from './model.js'
import { operationResource, patchResource, pathContains, type RowOperation, type RowResource } from './resources.js'

type Program = null | Readonly<{ kind: 'constant'; value: ResourceValue }> | Readonly<{ kind: 'failure'; error: unknown }>
  | Readonly<{ kind: 'patch'; patch: Patch; next: Program }>

function evaluate(resource: RowResource, program: Program, base: ResourceValue): ResourceValue {
  let value = base
  while (program) {
    if (program.kind === 'constant') return program.value
    if (program.kind === 'failure') throw program.error
    value = patchResource(resource, value, program.patch)
    program = program.next
  }
  return value
}

/** A projection-local suffix plan. Unconditional domain replacements can be
 * evaluated once; preceding nested patches must still execute and may fail.
 * It never substitutes a latest preview for the authored comparison base. */
export function createResourceSuffix(operations: readonly RowOperation[]) {
  const plans = new Map<string, readonly Program[]>()
  const entities = new Map<string, { position: number; operation: RowOperation }[]>()
  operations.forEach((operation, position) => {
    const entries = entities.get(operation.entityId) ?? []
    entries.push({ position, operation }); entities.set(operation.entityId, entries)
  })
  return (resource: RowResource, start: number, base: ResourceValue): ResourceValue => {
    const entries = entities.get(resource.entityId)
    if (!entries) return base
    const key = JSON.stringify([resource.entityId, resource.kind === 'entity' ? [] : resource.path])
    let plan = plans.get(key)
    if (!plan) {
      const domain = resource.kind === 'entity' ? [] : resource.path
      const suffix: Program[] = Array.from({ length: entries.length + 1 }, () => null)
      const constant = (value: ResourceValue, next: Program): Program => {
        try { return { kind: 'constant', value: evaluate(resource, next, value) } }
        catch (error) { return { kind: 'failure', error } }
      }
      for (let index = entries.length - 1; index >= 0; index--) {
        const operation = entries[index]!.operation
        let next: Program = suffix[index + 1] ?? null
        if (operation.entityId === resource.entityId) {
          if (operation.kind !== 'write') next = constant(operationResource(resource, { kind: 'missing' }, operation), next)
          else {
            for (let group = operation.groups.length - 1; group >= 0; group--) {
              const patches = operation.groups[group]!.writes
              for (let index = patches.length - 1; index >= 0; index--) {
                const patch = patches[index]!
                if (pathContains(patch.path, domain)) next = constant(patchResource(resource, { kind: 'missing' }, patch), next)
                else if (pathContains(domain, patch.path)) next = { kind: 'patch', patch, next }
              }
            }
          }
        }
        suffix[index] = next
      }
      plans.set(key, plan = suffix)
    }
    let low = 0, high = entries.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (entries[middle]!.position < start) low = middle + 1
      else high = middle
    }
    return evaluate(resource, plan[low] ?? null, base)
  }
}
