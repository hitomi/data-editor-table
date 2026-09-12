import { encodedValuesEqual, pathsOverlap, readDocument, resourceValuesEqual } from '../kernel/document.js'
import { kernelId, type EntityId, type FieldRef, type Patch } from '../kernel/model.js'
import { prepareRowAction, type RowCommand } from '../kernel/prepare.js'
import { policyForEntity } from '../kernel/state.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'

/** Missing authority means a newly created row, not an original empty row.
 * Resolve all selected fields before creating one atomic, undoable action. */
export function workspaceRestoreWrites(workspace: Workspace, snapshot: WorkspaceSnapshot, fields: readonly FieldRef[]) {
  const rows = new Map(snapshot.projection.rows.map(row => [row.entityId, row]))
  const bindings = new Map(workspace.schema.fields.map(binding => [binding.id, binding]))
  const seen = new Set<string>()
  return fields.flatMap(field => {
    const key = JSON.stringify([field.entityId, field.fieldId])
    if (seen.has(key)) return []
    seen.add(key)
    const row = rows.get(field.entityId), binding = bindings.get(field.fieldId)
    if (!binding || !row?.preview) throw new Error('The selected field is unavailable.')
    if (!row.authority) return []
    const original = readDocument(row.authority, binding.path)
    if (resourceValuesEqual(original, readDocument(row.preview, binding.path))) return []
    const policy = policyForEntity(snapshot.state.policy, field.entityId)
    if (binding.readonly || !policy.write || policy.readonlyPaths.some(path => pathsOverlap(path, binding.path)) || row.issues.length)
      throw new Error('Resolve permissions and conflicts before restoring the complete selection.')
    const patch: Patch = original.kind === 'missing' ? { kind: 'remove', path: binding.path } : { kind: 'set', path: binding.path, value: original.value }
    return [{ field, patch }]
  })
}

export function prepareWorkspaceRestore(workspace: Workspace, snapshot: WorkspaceSnapshot, fields: readonly FieldRef[], label: string) {
  if (snapshot.state.session || snapshot.ingress.pending.length || snapshot.capabilities.close.lifecycle !== 'open'
    || snapshot.storage && snapshot.storage.kind !== 'idle') throw new Error('Finish the pending work before restoring values.')
  const writes = workspaceRestoreWrites(workspace, snapshot, fields)
  if (!writes.length) throw new Error('The selected fields have no changed original values.')
  const groups = new Map<FieldRef['entityId'], Patch[]>()
  for (const { field, patch } of writes) { const patches = groups.get(field.entityId) ?? []; patches.push(patch); groups.set(field.entityId, patches) }
  return prepareRestoreAction(workspace, snapshot, [...groups].map(([entityId, patches]) => ({
    kind: 'write', entityId, groups: [{ id: kernelId<'write-group'>(crypto.randomUUID()), comparison: 'paths', reads: [], writes: patches }],
  })), label)
}

export function workspaceRestoreRows(workspace: Workspace, snapshot: WorkspaceSnapshot, ids: readonly EntityId[]): readonly RowCommand[] {
  const selected = new Set(ids), rows = new Map(snapshot.projection.rows.map(row => [row.entityId, row]))
  const commands: RowCommand[] = [], removed = new Set<EntityId>()
  for (const entityId of selected) {
    const row = rows.get(entityId), policy = policyForEntity(snapshot.state.policy, entityId)
    if (!row?.preview || row.issues.length) throw new Error('Resolve the original row before restoring it.')
    if (!row.authority) {
      if (!policy.delete) throw new Error('The new row cannot currently be removed.')
      commands.push({ kind: 'delete', entityId }); removed.add(entityId)
    } else if (!encodedValuesEqual(row.preview, row.authority)) {
      if (!policy.replace) throw new Error('The original row cannot currently be restored.')
      commands.push({ kind: 'replace', entityId, document: row.authority })
    }
  }
  const desired = snapshot.projection.order.preview.filter(id => !selected.has(id))
  snapshot.projection.order.authority.forEach((id, index) => {
    if (selected.has(id)) desired.splice(Math.min(index, desired.length), 0, id)
  })
  const remaining = snapshot.projection.order.preview.filter(id => !removed.has(id))
  if (desired.length !== remaining.length || desired.some((id, index) => id !== remaining[index])) {
    if (!snapshot.state.policy.order || snapshot.projection.order.issues.length) throw new Error('The original row order cannot currently be restored.')
    commands.push({ kind: 'order', desired })
  }
  return commands
}

export function prepareWorkspaceRowRestore(workspace: Workspace, snapshot: WorkspaceSnapshot, ids: readonly EntityId[], label: string) {
  if (snapshot.state.session || snapshot.ingress.pending.length || snapshot.capabilities.close.lifecycle !== 'open'
    || snapshot.storage && snapshot.storage.kind !== 'idle') throw new Error('Finish the pending work before restoring rows.')
  const commands = workspaceRestoreRows(workspace, snapshot, ids)
  if (!commands.length) throw new Error('These rows have no original changes to restore.')
  return prepareRestoreAction(workspace, snapshot, commands, label)
}

function prepareRestoreAction(workspace: Workspace, snapshot: WorkspaceSnapshot, commands: readonly RowCommand[], label: string) {
  return prepareRowAction(snapshot.state, { cause: 'user', inputs: [],
    action: { id: kernelId<'action'>(crypto.randomUUID()), applicationId: kernelId<'application'>(crypto.randomUUID()), label, saveAtomicity: 'transaction' },
    commands: commands.map(command => ({ id: kernelId<'intent'>(crypto.randomUUID()), inputs: [], dependencies: [], command })),
  }, workspace.schema)
}
