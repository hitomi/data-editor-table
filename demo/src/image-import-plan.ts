import { encodedValuesEqual, kernelId, ownEncodedValue, prepareRowAction, readDocument, taskInputRecords,
  type Document, type EntityId, type ResourceValue, type RowCommand, type TaskId, type Workspace, type WorkspaceSnapshot } from 'data-editor-table'

type Target = Readonly<{ kind: 'existing'; entityId: EntityId; before: { name: ResourceValue; image: ResourceValue } }>
  | Readonly<{ kind: 'new'; entityId: EntityId }>
export type ImageImportPlan = Readonly<{ format: 'image-import-plan:1'; workspaceId: string; targets: readonly Target[] }>
export type ImageImportResult = Readonly<{ format: 'image-import-result:1'; plan: ImageImportPlan; images: readonly Readonly<{ fileName: string; name: string; image: string }>[] }>
const own = <T,>(value: T): T => ownEncodedValue(value) as unknown as T

export function captureImportPlan(snapshot: WorkspaceSnapshot, start: string | null, count: number): ImageImportPlan {
  if (!Number.isInteger(count) || count < 1 || count > 24) throw new Error('Choose between 1 and 24 images.')
  const rows = snapshot.view.rows, offset = start === null ? 0 : rows.findIndex(row => row.entityId === start)
  if (offset < 0) throw new Error('The selected starting row is no longer visible.')
  return own({ format: 'image-import-plan:1', workspaceId: snapshot.state.workspace.id,
    targets: Array.from({ length: count }, (_, index): Target => {
      const row = rows[offset + index]
      if (!row) return { kind: 'new', entityId: kernelId<'entity'>(crypto.randomUUID()) }
      if (!row.preview || row.existence === 'pending-delete') throw new Error('An import target is unavailable.')
      return { kind: 'existing', entityId: row.entityId, before: { name: readDocument(row.preview, ['name']), image: readDocument(row.preview, ['image']) } }
    }),
  })
}
function record(value: unknown): value is Document { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function readImportResult(value: unknown): ImageImportResult {
  value = ownEncodedValue(value)
  if (!record(value) || value.format !== 'image-import-result:1' || !record(value.plan) || value.plan.format !== 'image-import-plan:1'
    || typeof value.plan.workspaceId !== 'string' || !Array.isArray(value.plan.targets) || !Array.isArray(value.images)
    || !value.images.length || value.images.length > 24 || value.images.length !== value.plan.targets.length) throw new Error('Unsupported retained image import.')
  for (const target of value.plan.targets) {
    if (!record(target) || typeof target.entityId !== 'string' || !target.entityId || !['existing', 'new'].includes(String(target.kind))) throw new Error('Invalid import target.')
    if (target.kind === 'existing' && (!record(target.before) || !validValue(target.before.name) || !validValue(target.before.image))) throw new Error('Import target context is missing.')
  }
  if (new Set(value.plan.targets.map(target => (target as Document).entityId)).size !== value.images.length) throw new Error('Import targets must be unique.')
  for (const image of value.images) if (!record(image) || typeof image.fileName !== 'string' || typeof image.name !== 'string'
    || typeof image.image !== 'string' || !image.image.startsWith('data:image/')) throw new Error('Invalid converted image.')
  return own(value) as unknown as ImageImportResult
}
function validValue(value: unknown) { return record(value) && (value.kind === 'missing' || value.kind === 'value' && Object.hasOwn(value, 'value')) }
export function importTargetIssue(snapshot: WorkspaceSnapshot, plan: ImageImportPlan): string | null {
  if (plan.workspaceId !== snapshot.state.workspace.id) return 'This batch belongs to another workspace.'
  const rows = new Map(snapshot.projection.rows.map(row => [row.entityId, row]))
  for (const target of plan.targets) {
    if (target.kind === 'new') {
      if (snapshot.state.entities.some(entity => entity.entityId === target.entityId)) return 'An intended new row already exists. Review new targets.'
      continue
    }
    const row = rows.get(target.entityId)
    if (!row?.preview || row.existence === 'pending-delete' || row.issues.length) return 'An original target is unavailable. Review new targets.'
    if (!encodedValuesEqual(own({ name: readDocument(row.preview, ['name']), image: readDocument(row.preview, ['image']) }), own(target.before)))
      return 'An original target changed. Review new targets before replacing its values.'
  }
  return null
}
export async function applyImageImport(workspace: Workspace, taskId: TaskId, revision: number, reviewedPlan: ImageImportPlan) {
  const snapshot = workspace.getSnapshot(), state = snapshot.state
  if (state.revision !== revision) throw new Error('The workspace changed. Review the import again.')
  const task = state.tasks.find(task => task.id === taskId)
  if (!task || !('result' in task) || task.result?.kind !== 'action-candidate' || task.result.input.kind !== 'encoded') throw new Error('The batch is not ready for review.')
  const result = readImportResult(task.result.input.value)
  const plan = readImportResult({ ...result, plan: reviewedPlan }).plan
  const issue = importTargetIssue(snapshot, plan)
  if (issue) throw new Error(issue)
  const inputs = taskInputRecords(state, taskId), fresh = () => crypto.randomUUID()
  const commands = plan.targets.map((target, index): RowCommand => {
    const image = result.images[index]!, document = { name: image.name, image: image.image }
    return target.kind === 'new' ? { kind: 'create', entityId: target.entityId, document }
      : { kind: 'write', entityId: target.entityId, groups: [{ id: kernelId<'write-group'>(fresh()), comparison: 'paths', reads: [],
        writes: [{ kind: 'set', path: ['name'], value: document.name }, { kind: 'set', path: ['image'], value: document.image }] }] }
  })
  const prepared = prepareRowAction(state, { cause: 'task', inputs,
    action: { id: kernelId<'action'>(fresh()), applicationId: kernelId<'application'>(fresh()), label: `Import ${commands.length} images`, saveAtomicity: 'transaction' },
    commands: commands.map(command => ({ id: kernelId<'intent'>(fresh()), command, inputs: inputs.map(input => input.ref), dependencies: [] })),
  }, workspace.schema)
  const applied = await workspace.dispatch({ kind: 'task-reapply', taskId, executionId: task.executionId, revision, owner: task.owner, prepared })
  if (applied.kind !== 'accepted') throw new Error('The import was not confirmed. Its files and result are retained.')
}
