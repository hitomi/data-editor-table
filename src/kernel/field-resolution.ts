import { pathsOverlap, resourceValuesEqual } from './document.js'
import type { DataOperation, EntityId, StoragePath } from './model.js'
import type { ProjectedIssue } from './projection.js'
import { pathContains } from './resources.js'

type WriteOperation = Extract<DataOperation, { kind: 'write' }>

export function fieldResolutionIssues(issues: readonly ProjectedIssue[], entityId: EntityId, path: StoragePath): readonly ProjectedIssue[] {
  return issues.filter(issue => issue.comparison?.resources.some((resource, index) => {
    if (resource.kind !== 'path' || resource.entityId !== entityId || !pathsOverlap(resource.path, path)) return false
    const comparison = issue.comparison!, remote = comparison.remote[index], base = comparison.base[index], local = comparison.local[index]
    return remote && base && local && !resourceValuesEqual(remote, base) && !resourceValuesEqual(remote, local)
  }))
}

/** A field review changes only that field's write bases. Unreviewed write
 * bases and business reads keep their captured values and causal anchors. */
export function preserveUnreviewedFieldBases(original: WriteOperation, prepared: WriteOperation, path: StoragePath): WriteOperation {
  if (original.groups.length !== prepared.groups.length) throw new Error('A field replay must retain its complete group correspondence.')
  return { ...prepared, groups: prepared.groups.map((group, index) => {
    const previous = original.groups[index]!
    const expectations = previous.expectations.filter(expected => expected.role !== 'write-base' || expected.resource.kind !== 'path'
      || group.writes.some(write => expected.resource.kind === 'path' && pathsOverlap(write.path, expected.resource.path)))
    return { ...group, expectations: expectations.map(expected => {
      if (expected.role !== 'write-base') return expected
      if (expected.resource.kind !== 'path') throw new Error('A whole-row comparison requires a whole-row conflict review.')
      if (!pathsOverlap(path, expected.resource.path)) return expected
      if (!pathContains(path, expected.resource.path)) throw new Error('A parent-domain comparison requires its complete conflict review.')
      const replacement = group.expectations.find(candidate => candidate.role === 'write-base' && candidate.resource.kind === 'path'
        && expected.resource.kind === 'path' && candidate.resource.path.length === expected.resource.path.length
        && candidate.resource.path.every((segment, index) => segment === (expected.resource.kind === 'path' ? expected.resource.path[index] : undefined)))
      if (!replacement) throw new Error('The reviewed write base must have an exact compiled replacement.')
      return replacement
    }) }
  }) }
}
