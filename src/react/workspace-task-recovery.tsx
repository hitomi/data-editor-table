import { canonicalEncodedValue } from '../kernel/document.js'
import { WorkspaceInputMaterial } from './workspace-input-material.js'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { inputRefKey } from '../kernel/journal.js'
import type { OwnedInput, ViewId, TaskState } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import type { WorkspaceResourceMessages } from './workspace-resource-input.js'
import type { WorkspaceTargetReview } from './workspace-text-editor.js'

/** Recovery material belongs to Workspace, independently of editor definitions
 * or mounting. Reapplication requires an explicitly visible current edit. */
export function WorkspaceTaskRecovery({ workspace, snapshot, viewId, review, messages, renderActionCandidate }: Readonly<{
  workspace: Workspace; snapshot: WorkspaceSnapshot; viewId: ViewId; review?: WorkspaceTargetReview; messages: WorkspaceResourceMessages; renderActionCandidate?: (task: TaskState, input: OwnedInput) => ReactNode
}>) {
  const [failure, setFailure] = useState<Readonly<{ workspace: Workspace; revision: number }> | null>(null)
  const tasks = snapshot.state.tasks.filter(task => task.kind !== 'consumed')
  const session = snapshot.state.session, currentInput = snapshot.editorInput?.input ?? session?.rawInput
  const ready = !!review && review.revision === snapshot.state.revision && session?.editor?.viewId === viewId && session.composition === 'idle' && !session.issues.length
    && snapshot.editorInput?.status === 'published' && !snapshot.ingress.pending.length && (!snapshot.storage || snapshot.storage.kind === 'idle') && snapshot.capabilities.close.lifecycle === 'open'
  const canCancel = (current: WorkspaceSnapshot) => current.capabilities.close.lifecycle === 'open' && !current.ingress.pending.length
    && (!current.storage || current.storage.kind === 'idle') && !current.recovery.running
  async function cancel(task: TaskState) {
    const current = workspace.getSnapshot()
    if (!canCancel(current)) return
    const owned = current.state.tasks.find(candidate => candidate.id === task.id && candidate.executionId === task.executionId)
    if (!owned || owned.kind === 'cancelled' || owned.kind === 'consumed') return
    const result = await workspace.dispatch({ kind: 'task-cancelled', taskId: task.id, executionId: task.executionId })
    if (result.kind === 'rejected') setFailure({ workspace, revision: workspace.getState().revision })
  }
  if (!tasks.length) return null
  const inputs = new Map(snapshot.state.inputs.map(input => [inputRefKey(input.ref), input.input]))
  return <section aria-label={messages.recovery}>
    {tasks.map((task, index) => {
      const input = inputs.get(inputRefKey(task.input)), result = ('result' in task ? task.result : null) ?? (task.execution?.outcome?.kind === 'succeeded' ? task.execution.outcome.result : null)
      const status = (task.kind === 'queued' || task.kind === 'running') && (task.execution?.outcome?.kind === 'unknown' || task.execution?.outcome?.kind === 'pending') ? 'unknown' : task.kind
      const candidate = result && result.kind !== 'action' ? result.input : null
      const canReapply = result?.kind === 'session-candidate' && task.kind !== 'cancelled' && candidate?.kind === 'encoded' && typeof candidate.value === 'string'
      const cancellable = task.kind !== 'cancelled' && canCancel(snapshot)
      const escape = (event: KeyboardEvent<HTMLElement>) => {
        if (!cancellable || event.defaultPrevented || event.key !== 'Escape' || event.repeat || event.nativeEvent.isComposing
          || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
        event.preventDefault(); event.stopPropagation(); void cancel(task)
      }
      return <section key={task.id} aria-label={messages.task(index + 1)} tabIndex={0} aria-keyshortcuts={cancellable ? 'Escape' : undefined}
        onKeyDown={event => { if (event.target === event.currentTarget) escape(event) }}>
        <h3>{messages.task(index + 1)}</h3>
        <p role="status">{messages.status[status]}</p>
        {task.kind !== 'cancelled' ? <>
          <p>{messages.cancelHelp}</p>
          <button type="button" disabled={!cancellable} aria-keyshortcuts={cancellable ? 'Escape' : undefined}
            onKeyDown={escape} onClick={() => { void cancel(task) }}>{messages.cancel}</button>
        </> : null}
        {input ? <WorkspaceInputMaterial workspace={workspace} input={input} label={messages.input} messages={messages} /> : null}
        {candidate ? result?.kind === 'action-candidate' && renderActionCandidate ? renderActionCandidate(task, candidate) : <WorkspaceInputMaterial workspace={workspace} input={candidate} label={messages.result} messages={messages} /> : null}
        {result?.kind === 'action' ? <textarea aria-label={messages.result} readOnly value={canonicalEncodedValue(result.action)} /> : null}
        {canReapply && review && currentInput ? <>
          <output aria-label={messages.currentTarget} style={{ whiteSpace: 'pre-wrap' }}>{review.values.map(value => `${value.label}: ${value.value}`).join('\n')}</output>
          <WorkspaceInputMaterial workspace={workspace} input={currentInput} label={messages.reviewInput} messages={messages} />
          <button type="button" disabled={!ready} onClick={async () => {
            if (!session) return
            const result = await workspace.dispatch({ kind: 'task-reapply', taskId: task.id, executionId: task.executionId, revision: snapshot.state.revision,
              owner: { kind: 'session', sessionId: session.id, input: session.input } })
            if (result.kind === 'rejected') setFailure({ workspace, revision: workspace.getState().revision })
          }}>{messages.reapply}</button>
        </> : null}
      </section>
    })}
    {failure?.workspace === workspace && failure.revision === snapshot.state.revision ? <p role="alert">{messages.failed}</p> : null}
  </section>
}
