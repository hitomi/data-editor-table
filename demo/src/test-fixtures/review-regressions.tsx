import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DataGrid, createStringCodec, kernelId, prepareRowAction, useWorkspaceSnapshot, type ResolutionRequest, type RowCommand, type WorkspaceGridColumn } from 'data-editor-table'
import { workspaceForReactFixture } from './durable-workspace.js'
const fresh = () => crypto.randomUUID()
const fieldId = kernelId<'field'>('value')
const columns: readonly WorkspaceGridColumn[] = [{ id: 'name', fieldId, header: 'Name', label: 'Name', render: ({ document }) => String(document.value) }]
const editors = [{ fieldId, label: 'Name', codec: createStringCodec({ invalid: 'Enter a name.' }) }]
export function reviewRegressionDiagnostics() {
  const workspace = workspaceForReactFixture()
  return { state: workspace.getState(), projection: workspace.getProjection() }
}
export async function changeReviewPermission(write: boolean) {
  const workspace = workspaceForReactFixture(), state = workspace.getState()
  return workspace.dispatch({ kind: 'policy-observed', policy: { ...state.policy, version: kernelId<'policy-version'>(fresh()), defaultEntity: { ...state.policy.defaultEntity, write } } })
}
async function action(command: RowCommand) {
  const workspace = workspaceForReactFixture(), input = { ref: { id: kernelId<'input'>(fresh()), version: 0 }, input: { kind: 'encoded' as const, value: command.kind } }
  return workspace.dispatch({ kind: 'prepared-action', prepared: prepareRowAction(workspace.getState(), {
    cause: 'user', inputs: [input], action: { id: kernelId<'action'>(fresh()), applicationId: kernelId<'application'>(fresh()), label: command.kind, saveAtomicity: 'transaction' },
    commands: [{ id: kernelId<'intent'>(fresh()), inputs: [input.ref], dependencies: [], command }],
  }, workspace.schema) })
}
export function mountReviewRegressionFixture(container: HTMLElement) {
  const workspace = workspaceForReactFixture()
  function Fixture() {
    const snapshot = useWorkspaceSnapshot(workspace), [review, setReview] = useState<ResolutionRequest | null>(null), [error, setError] = useState(false)
    const [deletion, setDeletion] = useState<number | null>(null)
    const local = snapshot.projection.rows.find(row => row.issues.some(issue => issue.code === 'create-key-collision'))
    const existing = snapshot.state.entities.find(entity => entity.kind === 'bound' && entity.identity.key === 'new')
    async function run(work: () => Promise<{ kind: string }>) { try { setError((await work()).kind !== 'accepted') } catch { setError(true) } }
    return <main>
      <button onClick={() => { void run(() => action({ kind: 'create', entityId: kernelId<'entity'>(fresh()), proposedKey: 'new', document: { value: 'New row', note: 'local input', locked: false } })) }}>Add row</button>
      <button disabled={!local || !existing} onClick={() => {
        const state = workspace.getState()
        if (!local?.preview || !existing || state.authority.content.kind !== 'complete') return
        setReview({ revision: state.revision, observation: state.authority.content.snapshot.observation, issueIds: local.issues.map(issue => issue.id),
          target: { kind: 'row', entityId: local.entityId }, choice: { kind: 'adopt-existing', entityId: existing.entityId, document: local.preview } })
      }}>Review existing row replacement</button>
      {review ? <section aria-label="Review row replacement"><pre>{JSON.stringify(review.choice)}</pre>
        <button disabled={review.revision !== snapshot.state.revision} onClick={() => { void run(async () => { const result = await workspace.resolve(review); if (result.kind === 'accepted') setReview(null); return result }) }}>Replace existing row with reviewed data</button></section> : null}
      <label><input type="checkbox" checked={deletion === snapshot.state.revision} onChange={event => setDeletion(event.target.checked ? snapshot.state.revision : null)} />Confirm deletion of the adopted row</label>
      <button disabled={!existing || deletion !== snapshot.state.revision} onClick={() => { if (existing) void run(() => action({ kind: 'delete', entityId: existing.entityId })) }}>Delete adopted row</button>
      {error ? <p role="alert">The reviewed action was rejected.</p> : null}
      <DataGrid workspace={workspace} viewId={kernelId<'view'>('regressions')} columns={columns} editors={editors} caption="Review regressions" />
    </main>
  }
  createRoot(container).render(<Fixture />)
}
