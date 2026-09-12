import { useState } from 'react'
import { canonicalEncodedValue } from '../kernel/document.js'
import { inputRefKey } from '../kernel/journal.js'
import { kernelId, type RecoveryId, type ViewId } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import { WorkspaceInputMaterial } from './workspace-input-material.js'
import type { WorkspaceResourceMessages } from './workspace-resource-input.js'
import type { WorkspaceTargetReview } from './workspace-text-editor.js'

export type WorkspaceDecisionRecoveryMessages = Readonly<{ label: string; source: string; blank: string; review: string; confirm: string; retained: string; failed: string; bundle(index: number): string; input(index: number): string }>
type Review = { workspace: Workspace; recoveryId: RecoveryId; target: WorkspaceTargetReview; text: string }
function Bundle({ workspace, snapshot, recoveryId, viewId, target, messages, resourceMessages }: {
  workspace: Workspace; snapshot: WorkspaceSnapshot; recoveryId: RecoveryId; viewId: ViewId; target?: WorkspaceTargetReview;
  messages: WorkspaceDecisionRecoveryMessages; resourceMessages: WorkspaceResourceMessages
}) {
  const [source, setSource] = useState(''), [review, setReview] = useState<Review | null>(null), [pending, setPending] = useState(false), [failed, setFailed] = useState<Workspace | null>(null)
  const entry = snapshot.state.recoveries.find(entry => entry.id === recoveryId)!
  const records = new Map(snapshot.state.inputs.map(input => [inputRefKey(input.ref), input]))
  const inputs = entry.inputs.map(ref => records.get(inputRefKey(ref))!)
  const text = source ? inputs.find(input => inputRefKey(input.ref) === source)?.input : undefined
  const ready = entry.state === 'available' && !snapshot.state.session && snapshot.capabilities.close.lifecycle === 'open'
    && !snapshot.ingress.pending.length && !snapshot.recovery.running && (!snapshot.storage || snapshot.storage.kind === 'idle')
  const current = review?.workspace === workspace && review.recoveryId === recoveryId ? review : null
  const valid = ready && target && current && current.target.revision === snapshot.state.revision
    && canonicalEncodedValue(current.target.target) === canonicalEncodedValue(target.target)
  async function begin() {
    if (!valid || pending) return
    setPending(true); setFailed(null)
    try {
      const result = await workspace.dispatch({ kind: 'session-opened', revision: current.target.revision, recoveryId,
        sessionId: kernelId<'session'>(crypto.randomUUID()), inputId: kernelId<'input'>(crypto.randomUUID()), viewId,
        target: current.target.target, input: { kind: 'encoded', value: current.text }, reads: [] })
      if (result.kind !== 'accepted') setFailed(workspace)
      else setReview(null)
    } catch { setFailed(workspace) }
    finally { setPending(false) }
  }
  return <div>
    {inputs.map((input, index) => <WorkspaceInputMaterial key={inputRefKey(input.ref)} workspace={workspace} input={input.input} label={messages.input(index + 1)} messages={resourceMessages} />)}
    {entry.state === 'available' ? <>
      <label>{messages.source}<select value={source} disabled={pending} onChange={event => { setSource(event.target.value); setReview(null) }}>
        <option value="">{messages.blank}</option>{inputs.map((input, index) => input.input.kind === 'encoded' && typeof input.input.value === 'string'
          ? <option key={inputRefKey(input.ref)} value={inputRefKey(input.ref)}>{messages.input(index + 1)}</option> : null)}
      </select></label>
      <button disabled={!ready || !target || pending || !!source && (text?.kind !== 'encoded' || typeof text.value !== 'string')} onClick={() => {
        if (target) setReview({ workspace, recoveryId, target, text: text?.kind === 'encoded' && typeof text.value === 'string' ? text.value : '' })
      }}>{messages.review}</button>
      {current ? <div><p>{current.target.label}</p><ul>{current.target.values.map((value, index) => <li key={index}>{value.label}: {value.value}</li>)}</ul>
        <button disabled={!valid || pending} onClick={() => { void begin() }}>{messages.confirm}</button></div> : null}
    </> : <p>{messages.retained}</p>}
    {failed === workspace ? <p role="alert">{messages.failed}</p> : null}
  </div>
}
export function WorkspaceDecisionRecovery({ workspace, snapshot, viewId, target, messages, resourceMessages }: {
  workspace: Workspace; snapshot: WorkspaceSnapshot; viewId: ViewId; target?: WorkspaceTargetReview; messages: WorkspaceDecisionRecoveryMessages; resourceMessages: WorkspaceResourceMessages
}) {
  const retained = new Set(snapshot.state.session?.retainedInputs.map(inputRefKey) ?? [])
  const entries = snapshot.state.recoveries.filter(entry => entry.state === 'available' || entry.state === 'consumed' && entry.inputs.some(ref => retained.has(inputRefKey(ref))))
  if (!entries.length) return null
  return <section aria-label={messages.label}><h3>{messages.label}</h3>{entries.map((entry, index) => <section key={entry.id} aria-label={messages.bundle(index + 1)}>
    <Bundle workspace={workspace} snapshot={snapshot} recoveryId={entry.id} viewId={viewId} {...(target ? { target } : {})} messages={messages} resourceMessages={resourceMessages} />
  </section>)}</section>
}
