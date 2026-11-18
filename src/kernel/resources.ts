import { applyDocumentPatches, isDocument, missingResource, readDocument } from './document.js'
import type { DataOperation, Document, EntityId, Patch, ResourceRef, ResourceValue, StoragePath } from './model.js'

export type RowOperation = Exclude<DataOperation, { kind: 'order' }>
export type RowResource = Exclude<ResourceRef, { kind: 'order' }>

export function resourceAtDocument(document: Document | null, resource: RowResource): ResourceValue {
  if (document === null) return missingResource
  return resource.kind === 'entity' ? Object.freeze({ kind: 'value', value: document }) : readDocument(document, resource.path)
}

export function resourceAtRows(rows: ReadonlyMap<EntityId, Document>, resource: ResourceRef, order: readonly EntityId[]): ResourceValue {
  return resource.kind === 'order' ? { kind: 'value', value: order } : resourceAtDocument(rows.get(resource.entityId) ?? null, resource)
}

export function pathContains(parent: readonly string[], child: readonly string[]) {
  return parent.length <= child.length && parent.every((segment, index) => segment === child[index])
}

/** Apply a declared write to a comparison domain, using the authored base for
 * that domain. In particular, a whole-row CAS must not borrow unmentioned
 * remote fields to manufacture a target that appears externally satisfied.
 */
export function patchResource(resource: RowResource, value: ResourceValue, patch: Patch): ResourceValue {
  const domain = resource.kind === 'entity' ? [] : resource.path
  if (pathContains(patch.path, domain)) {
    if (patch.kind === 'remove') return missingResource
    const remainder = domain.slice(patch.path.length)
    if (!remainder.length) return { kind: 'value', value: patch.value }
    return isDocument(patch.value) ? readDocument(patch.value, remainder as unknown as StoragePath) : missingResource
  }
  if (!pathContains(domain, patch.path)) return value
  if (value.kind !== 'value' || !isDocument(value.value)) throw new Error('The authored write domain cannot materialize its nested write.')
  const relative = patch.path.slice(domain.length) as unknown as StoragePath
  return { kind: 'value', value: applyDocumentPatches(value.value, [{ ...patch, path: relative }]) }
}

export function operationResource(resource: RowResource, value: ResourceValue, operation: RowOperation): ResourceValue {
  if (resource.entityId !== operation.entityId) return value
  if (operation.kind === 'delete') return missingResource
  if (operation.kind === 'create' || operation.kind === 'replace') return resourceAtDocument(operation.document, resource)
  let result = value
  for (const group of operation.groups) for (const patch of group.writes) result = patchResource(resource, result, patch)
  return result
}
