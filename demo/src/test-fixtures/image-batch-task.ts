import { Workspace, defineKernelSchema, kernelId, openIndexedDbRecovery, type TaskId } from 'data-editor-table'
import { openDemoSource } from '../demo-source.js'
import { captureImageBatch } from '../image-batch.js'
import { openImageBatchTask } from '../image-batch-task.js'

let workspace: Workspace
export async function openBatchWorkspace(name: string, restore: boolean, loseResponse = false) {
  const scope = { sourceId: name, id: kernelId<'scope'>('images'), epoch: kernelId<'scope-epoch'>('v1') }
  const schema = defineKernelSchema({ version: kernelId<'schema-version'>('v1'), codec: kernelId<'codec-version'>('json-v1'),
    fields: ['name', 'image'].map(name => ({ id: kernelId<'field'>(name), path: [name], readonly: false })), validate: () => [] })
  const source = await openDemoSource(scope, [{ name: 'Original', image: null }], () => {}, true)
  const service = await openImageBatchTask(`${name}:conversions`)
  const session = await openIndexedDbRecovery({ databaseName: name, workspace: { id: kernelId<'workspace'>(name), scope, schema: schema.version, codec: schema.codec } })
  workspace = await Workspace.openDurable({ scope, schema, source, session, restore,
    policy: { version: kernelId<'policy-version'>('v1'), create: true, order: true,
      defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [] },
    tasks: [{ ...service, start: async (request, context) => {
      const outcome = await service.start(request, context)
      if (loseResponse) { loseResponse = false; throw new Error('Response lost after conversion') }
      return outcome
    } }],
  })
  await workspace.refresh()
}
export async function startBatchConversion() {
  const plan = { target: workspace.getProjection().rows[0]!.entityId, before: { name: 'Original', image: null } }
  const files = [new File(['<svg/>'], '一.first.svg', { type: 'image/svg+xml', lastModified: 12 }),
    new File([new Uint8Array([0, 255, 10])], 'second.png', { type: 'image/png', lastModified: 34 })]
  const input = await workspace.registerResource(captureImageBatch(files, plan))
  const run = workspace.runDurableTask({ definition: { id: 'image-batch-data-url', version: 'v1' },
    owner: { kind: 'workspace', workspaceId: workspace.getState().workspace.id }, input, reads: [] })
  if ((await run.result).kind !== 'accepted') throw new Error('Batch registration was rejected')
  await workspace.waitForTask(run.taskId)
  return { id: run.taskId, plan, ...inspectBatch(run.taskId) }
}
export function inspectBatch(id: TaskId) {
  return { task: workspace.getState().tasks.find(task => task.id === id), rows: workspace.getProjection().rows.map(row => row.preview), actions: workspace.getState().journal.actions.length }
}
export async function recoverBatch(id: TaskId) { await workspace.recoverTask(id); return inspectBatch(id) }
