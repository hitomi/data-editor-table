import { useState, type ReactNode } from 'react'
import type { WorkspaceMenuAction } from './workspace-context-menu.js'
import type { CommandResult } from '../kernel/transition.js'
import type { Workspace, WorkspaceRecoveryResult, WorkspaceSaveResult, WorkspaceSnapshot } from '../kernel/workspace.js'
import { useWorkspaceSnapshot } from './workspace-react.js'

export type WorkspaceToolbarMessages = Readonly<{
  label: string; save: string; undo: string; redo: string; refresh: string; checkResults: string
  awaitingAuthority: string; awaitingReceipt: string; working: string; failed: string; notApplied: string; unresolved: string; partialSave: string; recoveryIncomplete: string
}>
export type WorkspaceToolbarProps = Readonly<{
  workspace: Workspace; messages: WorkspaceToolbarMessages; serverSnapshot?: WorkspaceSnapshot
  renderAdditionalActions?: (actions: readonly WorkspaceMenuAction[]) => ReactNode
}>
type Operation = 'save' | 'undo' | 'redo' | 'refresh' | 'recovery'
type FeedbackMessage = 'failed' | 'notApplied' | 'unresolved' | 'partialSave' | 'recoveryIncomplete'
type Feedback = Readonly<{ attempt: Readonly<{ workspace: Workspace; operation: Operation }>; pending: boolean;
  state: WorkspaceSnapshot['state'] | null; message: FeedbackMessage | null }>

/** Buttons consume advisory capabilities, while every operation still passes
 * Workspace admission. Checking outcomes performs the finite lookup scan;
 * it never resends a mutation or discards recoverable input. */
export function WorkspaceToolbar({ workspace, messages, serverSnapshot, renderAdditionalActions }: WorkspaceToolbarProps) {
  const snapshot = useWorkspaceSnapshot(workspace, serverSnapshot)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const current = feedback?.attempt.workspace === workspace ? feedback : null
  const inactive = snapshot.capabilities.close.lifecycle !== 'open'
  const busy = inactive || current?.pending === true || snapshot.recovery.running
  const storageMoving = snapshot.storage?.kind === 'preparing' || snapshot.storage?.kind === 'writing' || snapshot.storage?.kind === 'fenced'
  const candidates = snapshot.recovery.plan.candidates.length > 0
  const persistence = snapshot.state.persistence
  const confirmedWrite = persistence.kind === 'committed-awaiting-authority' ? messages.awaitingAuthority
    : persistence.kind === 'committed-awaiting-receipt' ? messages.awaitingReceipt : null
  const feedbackMessage = current?.state === snapshot.state && current.message && (current.message !== 'unresolved' || candidates)
    ? messages[current.message] : null
  async function run(operation: Operation) {
    const attempt = { workspace, operation }
    setFeedback({ attempt, pending: true, state: null, message: null })
    let message: FeedbackMessage | null = null
    try {
      if (operation === 'recovery') {
        const result: WorkspaceRecoveryResult = await workspace.recoverPendingWork()
        if (result.kind !== 'completed') message = 'recoveryIncomplete'
      } else if (operation === 'save') {
        const result: WorkspaceSaveResult = await workspace.save()
        switch (result.kind) {
          case 'committed': message = result.remaining.length ? 'partialSave' : null; break
          case 'not-applied': message = 'notApplied'; break
          case 'unresolved': message = 'unresolved'; break
          case 'blocked': message = 'failed'; break
          case 'no-changes': case 'not-started': break
        }
      } else {
        const result: CommandResult = await workspace[operation]()
        if (result.kind === 'unresolved') message = 'unresolved'
        else if (result.kind !== 'accepted') message = 'failed'
      }
    } catch { message = 'failed' }
    // A late completion from a previous owner/operation cannot replace the
    // current operation's feedback. This state holds no business input.
    const state = workspace.getState()
    setFeedback(previous => previous?.attempt === attempt ? { attempt, pending: false, state, message } : previous)
  }
  const actions: readonly WorkspaceMenuAction[] = [
    ...(['undo', 'redo', 'save'] as const).map(operation => ({ id: operation, label: messages[operation], disabled: busy || snapshot.capabilities[operation].kind !== 'available', run: () => { void run(operation) } })),
    { id: 'refresh', label: messages.refresh, disabled: busy || candidates || snapshot.ingress.pending.length > 0 || (snapshot.storage !== null && snapshot.storage.kind !== 'idle') || snapshot.state.authority.read.kind === 'loading', run: () => { void run('refresh') } },
    ...(candidates ? [{ id: 'recovery', label: messages.checkResults, disabled: busy || storageMoving || (snapshot.capabilities.save.kind === 'blocked' && snapshot.capabilities.save.reason === 'source-busy'), run: () => { void run('recovery') } }] : []),
  ]
  return <div role="toolbar" aria-label={messages.label}>
    {actions.map(action => <button key={action.id} type="button" disabled={action.disabled} onClick={action.run}>{action.label}</button>)}
    {current?.pending ? <span role="status">{messages.working}</span> : confirmedWrite ? <p role="status">{confirmedWrite}</p> : null}
    {!current?.pending && feedbackMessage && !(confirmedWrite && current?.message === 'unresolved') ? <p role="alert">{feedbackMessage}</p> : null}
    {renderAdditionalActions?.(actions)}
  </div>
}
