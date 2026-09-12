import { useRef, useState } from 'react'
import type { CloseAssessment, CloseResult } from '../kernel/lifecycle.js'
import type { CloseBlocker } from '../kernel/model.js'
import { sameRecoveryValue } from '../kernel/recovery-store.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import { useWorkspaceSnapshot } from './workspace-react.js'

export type WorkspaceCloseMessages = Readonly<{
  review: string; label: string; clean: string; checkpoint: string; checkpointHelp: string
  discard: string; discardConsent: string; keepEditing: string; changed: string; failed: string
  pending: string; closed: string; blockers: Readonly<Record<CloseBlocker['kind'], string>>
}>
export type WorkspaceClosedResult = Extract<CloseResult, { kind: 'closed' | 'retained' }> & { kind: 'closed' }
export type WorkspaceCloseControlsProps = Readonly<{
  workspace: Workspace; messages: WorkspaceCloseMessages; serverSnapshot?: WorkspaceSnapshot
  /** Only offer this when the host can reopen this owner's checkpoint. */
  checkpoint: boolean
  /** The host must match the owner before navigating a possibly replaced view. */
  onClosed: (workspace: Workspace, result: WorkspaceClosedResult) => void
}>
type Review = Readonly<{ workspace: Workspace; assessment: CloseAssessment; discard: boolean }>

/** Explicit host composition, never an unmount cleanup. A reviewed ticket is
 * not silently renewed by a render or a late result. Only a confirmed close
 * grants the host permission to leave; retaining keeps the owner alive. */
export function WorkspaceCloseControls({ workspace, messages, checkpoint, onClosed, serverSnapshot }: WorkspaceCloseControlsProps) {
  const snapshot = useWorkspaceSnapshot(workspace, serverSnapshot)
  const [review, setReview] = useState<Review | null>(null)
  const [feedback, setFeedback] = useState<{ workspace: Workspace; pending: boolean; failed: boolean } | null>(null)
  const running = useRef(false)
  const notified = useRef<Workspace | null>(null)
  const current = review?.workspace === workspace ? review : null
  const observation = snapshot.capabilities.close
  const pending = feedback?.workspace === workspace && feedback.pending
  const stale = current !== null && !sameRecoveryValue(current.assessment.ticket, observation.ticket)
  const inactive = observation.lifecycle !== 'open'
  const failed = feedback?.workspace === workspace && feedback.failed
  function inspect() {
    setReview({ workspace, assessment: workspace.requestClose(), discard: false })
    setFeedback(null)
  }
  async function close(disposition: 'clean-close' | 'checkpoint-close' | 'discard' | 'retain') {
    if (!current || running.current || notified.current === workspace) return
    running.current = true
    setFeedback({ workspace, pending: true, failed: false })
    let result: CloseResult | null = null
    try { result = await workspace.close(current.assessment.ticket, disposition) }
    catch { /* The owner retains responsibility; the host has no close proof. */ }
    running.current = false
    setFeedback({ workspace, pending: false, failed: result === null || result.kind === 'blocked' })
    if (result?.kind === 'retained') setReview(previous => previous === current ? null : previous)
    // Keep callback errors outside the close failure path. They cannot undo
    // an already confirmed lease release or turn it into a retryable close.
    if (result?.kind === 'closed') {
      notified.current = workspace
      onClosed(workspace, { ...result, kind: 'closed' })
    }
  }
  if (observation.lifecycle === 'closed') return <p role="status">{messages.closed}</p>
  const categories = current ? [...new Set(current.assessment.blockers.map(blocker => blocker.kind))] : []
  return <section aria-label={messages.label}>
    <button type="button" disabled={pending || observation.lifecycle === 'fenced'} onClick={inspect}>{messages.review}</button>
    {current ? <fieldset disabled={pending}>
      <legend>{messages.label}</legend>
      {categories.length ? <ul>{categories.map(kind => <li key={kind}>{messages.blockers[kind]}</li>)}</ul> : null}
      {stale ? <p role="alert">{messages.changed}</p> : null}
      <button type="button" disabled={stale || (observation.lifecycle !== 'closing' && (inactive || categories.length > 0))}
        onClick={() => close('clean-close')}>{messages.clean}</button>
      {checkpoint ? <><p>{messages.checkpointHelp}</p><button type="button" disabled={stale || inactive}
        onClick={() => close('checkpoint-close')}>{messages.checkpoint}</button></> : null}
      {!inactive && categories.length > 0 ? <>
        <label><input type="checkbox" checked={current.discard} disabled={stale}
          onChange={event => setReview({ ...current, discard: event.target.checked })} />{messages.discardConsent}</label>
        <button type="button" disabled={stale || !current.discard} onClick={() => close('discard')}>{messages.discard}</button>
      </> : null}
      <button type="button" disabled={stale || inactive} onClick={() => close('retain')}>{messages.keepEditing}</button>
    </fieldset> : null}
    {pending ? <p role="status">{messages.pending}</p> : failed ? <p role="alert">{messages.failed}</p> : null}
  </section>
}
