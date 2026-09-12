import { kernelId, prepareRowAction, taskInputRecords, type TaskId } from 'data-editor-table'
import { workspaceForReactFixture } from './durable-workspace.js'
import { captureImageBatch } from '../image-batch.js'

export async function startActionCandidate() {
  const workspace = workspaceForReactFixture()
  const input = await workspace.registerResource(captureImageBatch([new File(['original'], 'first.png', { type: 'image/png' })],
    { target: workspace.getProjection().rows[0]!.entityId }))
  const run = workspace.runDurableTask({ definition: { id: 'upload', version: 'v1' },
    owner: { kind: 'workspace', workspaceId: workspace.getState().workspace.id }, input, reads: [] })
  if ((await run.result).kind !== 'accepted') throw new Error('Registration failed')
  await workspace.waitForTask(run.taskId)
  return run.taskId
}
export async function applyActionCandidate(taskId: TaskId) {
  const workspace = workspaceForReactFixture(), state = workspace.getState()
  const task = state.tasks.find(task => task.id === taskId)!
  if (!('result' in task) || task.result?.kind !== 'action-candidate' || task.result.input.kind !== 'encoded') throw new Error('No candidate')
  const value = task.result.input.value
  if (!Array.isArray(value) || value.length !== 2 || value.some(value => typeof value !== 'number')) throw new Error('Unexpected candidate')
  const inputs = taskInputRecords(state, task.id), fresh = () => crypto.randomUUID()
  const prepared = prepareRowAction(state, { cause: 'task', inputs,
    action: { id: kernelId<'action'>(fresh()), applicationId: kernelId<'application'>(fresh()), label: 'Reviewed import', saveAtomicity: 'transaction' },
    commands: [
      { id: kernelId<'intent'>(fresh()), inputs: inputs.map(input => input.ref), dependencies: [], command: { kind: 'write', entityId: workspace.getProjection().rows[0]!.entityId,
        groups: [{ id: kernelId<'write-group'>(fresh()), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['value'], value: value[0]! }] }] } },
      { id: kernelId<'intent'>(fresh()), inputs: inputs.map(input => input.ref), dependencies: [], command: { kind: 'create', entityId: kernelId<'entity'>(fresh()), document: { value: value[1]! } } },
    ],
  }, workspace.schema)
  return workspace.dispatch({ kind: 'task-reapply', taskId, executionId: task.executionId, revision: state.revision, owner: task.owner, prepared })
}
