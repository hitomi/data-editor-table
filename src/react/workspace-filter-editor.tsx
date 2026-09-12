import { FilterIcon } from './workspace-grid-icons.js'
import { viewQuery } from '../kernel/view.js'
import { writeBrowserEditorInput } from './workspace-editor-input.js'
import { WorkspaceFilterConditions } from './workspace-filter-conditions.js'
import type { WorkspaceFilterCodec, FilterConditionMessages } from '../filter-codecs.js'
import { createPortal } from 'react-dom'
import { WorkspaceDialog } from './workspace-dialog.js'
import { useEffect, useId, useRef, useState } from 'react'
import { kernelId, type ViewId } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import type { CommandResult } from '../kernel/transition.js'
import { useWorkspaceSnapshot } from './workspace-react.js'

export type { WorkspaceFilterCodec } from '../filter-codecs.js'
export type WorkspaceFilterEditorMessages = Readonly<{
  conditions: FilterConditionMessages
  review: string; resumeReview: string
  edit: string; apply: string; discard: string; resume: string; pending: string
  changed: string; current: string; reconfirm: string; failed: string; unsupported: string; otherEditor: string
}>
export type WorkspaceFilterEditorProps = Readonly<{
  dialogTitle?: string
  workspace: Workspace; viewId: ViewId; columnId: string; label: string; codec: WorkspaceFilterCodec
  messages: WorkspaceFilterEditorMessages; serverSnapshot?: WorkspaceSnapshot
}>

/** Query editing owns an ordinary retained session input, but publishes only a
 * versioned view query. It cannot enter the data journal or trigger a save. */
export function WorkspaceFilterEditor({ workspace, viewId, columnId, label, codec, messages, serverSnapshot, dialogTitle }: WorkspaceFilterEditorProps) {
  const snapshot = useWorkspaceSnapshot(workspace, serverSnapshot), session = snapshot.state.session
  const [reviewing, setReviewing] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [intent, setIntent] = useState<{ workspace: Workspace; id: string; action: 'apply' | 'cancel' } | null>(null)
  const id = useId(), errorId = useId()
  const [failure, setFailure] = useState<Readonly<{ workspace: Workspace; session: typeof session; message: string }> | null>(null)
  const matches = session?.target.kind === 'filter' && session.target.columnId === columnId && (session.target.viewId === undefined || session.target.viewId === viewId)
  const query = viewQuery(snapshot.state, matches ? session.target.viewId : viewId)
  const owns = matches && session.editor?.viewId === viewId
  const input = owns ? snapshot.editorInput?.input ?? session.rawInput : null
  const text = input?.kind === 'encoded' && typeof input.value === 'string' ? input.value : null
  const draft = text !== null ? codec.conditions?.read(text) : null
  const open = snapshot.capabilities.close.lifecycle === 'open'
  const ready = owns && open && snapshot.editorInput?.status === 'published' && !snapshot.ingress.pending.length
    && (!snapshot.storage || snapshot.storage.kind === 'idle')
  const error = failure?.workspace === workspace && failure.session === session ? failure.message : null
  let current: string | null = null
  try { current = codec.format(query.filters.find(filter => filter.columnId === columnId)?.predicate ?? null) } catch { /* Preserve input if the current predicate cannot be represented. */ }
  const currentDraft = current === null ? null : codec.conditions?.read(current)
  const filterCount = query.filters.some(filter => filter.columnId === columnId) ? currentDraft?.conditions.length ?? 1 : 0
  const currentDisplay = codec.conditions ? !query.filters.some(filter => filter.columnId === columnId) ? messages.conditions.none
    : currentDraft ? `${currentDraft.combine === 'all' ? messages.conditions.all : messages.conditions.any}: ${currentDraft.conditions.map(condition => {
      const operator = codec.conditions!.operators.find(operator => operator.id === condition.operator)!
      const value = codec.conditions!.options?.find(option => option.text === condition.value)?.label ?? condition.value
      return operator.label + (operator.requiresValue ? ` ${value}` : '')
    }).join('; ')}` : messages.unsupported : current
  const report = (result: CommandResult) => { if (result.kind === 'rejected') setFailure({ workspace, session, message: messages.failed }) }
  async function begin() {
    if (session || current === null) return
    report(await workspace.dispatch({ kind: 'session-opened', revision: snapshot.state.revision, sessionId: kernelId<'session'>(crypto.randomUUID()),
      inputId: kernelId<'input'>(crypto.randomUUID()), viewId, target: { kind: 'filter', viewId, columnId, queryVersion: query.version },
      input: { kind: 'encoded', value: current }, reads: [] }))
  }
  async function apply() {
    if (!ready || !session?.editor || session.composition !== 'idle' || session.issues.length || text === null) return
    try {
      const parsed = codec.parse(text)
      if (parsed.kind === 'invalid') { setFailure({ workspace, session, message: parsed.message }); return }
      report(await workspace.dispatch({ kind: 'session-query-apply', lease: session.editor, inputVersion: session.input.version,
        queryVersion: query.version, predicate: parsed.predicate }))
    } catch { setFailure({ workspace, session, message: messages.failed }) }
  }
  async function cancel() {
    if (!ready || !session) return
    report(await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, inputVersion: session.input.version, lease: session.editor }))
  }
  useEffect(() => {
    if (!ready || !intent || intent.workspace !== workspace || intent.id !== session?.id) return
    setIntent(null)
    if (intent.action === 'cancel') void cancel(); else void apply()
  }, [ready, intent, session])
  const type = (value: string, composition: 'idle' | 'composing') => {
    if (owns && session.editor && writeBrowserEditorInput(workspace, session.editor, { kind: 'encoded', value }, composition)) setIntent(null)
  }
  const content = <section aria-label={label} onKeyDown={event => {
    if (!owns || !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) || event.nativeEvent.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return
    const latest = workspace.getSnapshot()
    const pending = latest.ingress.pending.filter(entry => entry.payload.kind === 'input' && entry.payload.envelope.lease.sessionId === session.id).at(-1)
    const composition = pending?.payload.kind === 'input' ? pending.payload.envelope.composition : latest.state.session?.composition
    if (composition === 'composing') return
    if (event.key === 'Enter' || event.key === 'Escape' && dialogTitle) { event.preventDefault(); setIntent({ workspace, id: session.id, action: event.key === 'Enter' ? 'apply' : 'cancel' }) }
  }}>
    {!session ? <button type="button" disabled={!open || current === null} onClick={begin}>{messages.edit}</button>
      : !owns ? <><p>{messages.otherEditor}</p>{!session.editor ? <button type="button" onClick={async () => report(await workspace.dispatch({ kind: 'session-attached', sessionId: session.id, viewId }))}>{messages.resume}</button> : null}</>
      : <>
        {dialogTitle ? <strong>{dialogTitle}</strong> : null}
        {dialogTitle ? <button type="button" onClick={() => setReviewing(reviewing === session.id ? null : session.id)}>{reviewing === session.id ? messages.resumeReview : messages.review}</button> : null}
        {!draft ? <label htmlFor={id}>{label}</label> : null}
        {draft && codec.conditions ? <WorkspaceFilterConditions draft={draft} definition={codec.conditions} messages={messages.conditions} label={label} inputId={id} disabled={!open} write={type} /> : text === null || codec.conditions && !draft ? <p role="alert">{messages.unsupported}</p> : <input id={id} value={text} readOnly={!open} aria-describedby={error ? errorId : undefined}

          onChange={event => type(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing ? 'composing' : 'idle')}
          onCompositionStart={event => type(event.currentTarget.value, 'composing')}
          onCompositionEnd={event => type(event.currentTarget.value, 'idle')} />}
        {!ready ? <p role="status">{messages.pending}</p> : null}
        {session.issues.length ? <p role="alert">{messages.changed}</p> : null}
        {session.issues.length > 0 && session.issues.every(issue => issue.code === 'session-query-changed') && !session.dependencies.length && current !== null ? <>
          <output aria-label={messages.current}>{currentDisplay}</output>
          <button type="button" disabled={!ready || session.composition !== 'idle'} onClick={async () => report(await workspace.dispatch({ kind: 'session-reconfirmed', lease: session.editor!, inputVersion: session.input.version, revision: snapshot.state.revision }))}>{messages.reconfirm}</button>
        </> : null}
        {codec.conditions ? <button type="button" disabled={!open} onClick={() => { type(JSON.stringify({ ...(draft ?? codec.conditions!.initial), conditions: [] }), 'idle'); setIntent({ workspace, id: session.id, action: 'apply' }) }}>{messages.conditions.clear}</button> : null}
        <button type="button" disabled={!ready || text === null || !!codec.conditions && !draft || session.composition !== 'idle' || !!session.issues.length} onClick={apply}>{messages.apply}</button>
        <button type="button" disabled={!ready} onClick={() => { void cancel() }}>{messages.discard}</button>
      </>}
    {error ? <p role="alert" id={errorId}>{error}</p> : null}
  </section>
  if (!dialogTitle) return session && !matches ? null : content
  const reviewHost = trigger.current?.closest('.business-grid__workspace')?.querySelector('.business-grid__workspace-filter-review')
  return <><button ref={trigger} className="business-grid__workspace-filter" data-active={filterCount > 0 || undefined} title={dialogTitle} type="button" aria-label={dialogTitle} disabled={!open || current === null || !!session} onClick={begin}><FilterIcon />{filterCount > 0 ? <span aria-hidden="true" className="business-grid__header-action-badge">{filterCount}</span> : null}</button>
    {matches && reviewing === session.id && reviewHost ? createPortal(content, reviewHost) : matches ? <WorkspaceDialog returnFocus={trigger} label={dialogTitle} cancel={() => { setIntent({ workspace, id: session.id, action: 'cancel' }) }}>{content}</WorkspaceDialog> : null}</>
}
