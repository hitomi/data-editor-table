import { useId, useState } from 'react'
import { kernelId, type ViewId, type ViewPredicate } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import type { CommandResult } from '../kernel/transition.js'
import { useWorkspaceSnapshot } from './workspace-react.js'

export type WorkspaceFilterCodec = Readonly<{
  format(predicate: ViewPredicate | null): string
  parse(text: string): Readonly<{ kind: 'valid'; predicate: ViewPredicate | null }> | Readonly<{ kind: 'invalid'; message: string }>
}>
export type WorkspaceFilterEditorMessages = Readonly<{
  edit: string; apply: string; discard: string; resume: string; pending: string
  changed: string; current: string; reconfirm: string; failed: string; unsupported: string; otherEditor: string
}>
export type WorkspaceFilterEditorProps = Readonly<{
  workspace: Workspace; viewId: ViewId; columnId: string; label: string; codec: WorkspaceFilterCodec
  messages: WorkspaceFilterEditorMessages; serverSnapshot?: WorkspaceSnapshot
}>

/** Query editing owns an ordinary retained session input, but publishes only a
 * versioned view query. It cannot enter the data journal or trigger a save. */
export function WorkspaceFilterEditor({ workspace, viewId, columnId, label, codec, messages, serverSnapshot }: WorkspaceFilterEditorProps) {
  const snapshot = useWorkspaceSnapshot(workspace, serverSnapshot), session = snapshot.state.session
  const id = useId(), errorId = useId()
  const [failure, setFailure] = useState<Readonly<{ workspace: Workspace; session: typeof session; message: string }> | null>(null)
  const matches = session?.target.kind === 'filter' && session.target.columnId === columnId
  const owns = matches && session.editor?.viewId === viewId
  const input = owns ? snapshot.editorInput?.input ?? session.rawInput : null
  const text = input?.kind === 'encoded' && typeof input.value === 'string' ? input.value : null
  const open = snapshot.capabilities.close.lifecycle === 'open'
  const ready = owns && open && snapshot.editorInput?.status === 'published' && !snapshot.ingress.pending.length
    && (!snapshot.storage || snapshot.storage.kind === 'idle')
  const error = failure?.workspace === workspace && failure.session === session ? failure.message : null
  let current: string | null = null
  try { current = codec.format(snapshot.state.view.filters.find(filter => filter.columnId === columnId)?.predicate ?? null) } catch { /* Preserve input if the current predicate cannot be represented. */ }
  const report = (result: CommandResult) => { if (result.kind === 'rejected') setFailure({ workspace, session, message: messages.failed }) }
  async function begin() {
    if (session || current === null) return
    report(await workspace.dispatch({ kind: 'session-opened', revision: snapshot.state.revision, sessionId: kernelId<'session'>(crypto.randomUUID()),
      inputId: kernelId<'input'>(crypto.randomUUID()), viewId, target: { kind: 'filter', columnId, queryVersion: snapshot.state.view.version },
      input: { kind: 'encoded', value: current }, reads: [] }))
  }
  async function apply() {
    if (!ready || !session?.editor || session.composition !== 'idle' || session.issues.length || text === null) return
    try {
      const parsed = codec.parse(text)
      if (parsed.kind === 'invalid') { setFailure({ workspace, session, message: parsed.message }); return }
      report(await workspace.dispatch({ kind: 'session-query-apply', lease: session.editor, inputVersion: session.input.version,
        queryVersion: snapshot.state.view.version, predicate: parsed.predicate }))
    } catch { setFailure({ workspace, session, message: messages.failed }) }
  }
  const type = (value: string, composition: 'idle' | 'composing') => {
    if (owns && session.editor) workspace.typeInput(session.editor, { kind: 'encoded', value }, composition)
  }
  if (session && !matches) return null
  return <section aria-label={label}>
    {!session ? <button type="button" disabled={!open || current === null} onClick={begin}>{messages.edit}</button>
      : !owns ? <><p>{messages.otherEditor}</p>{!session.editor ? <button type="button" onClick={async () => report(await workspace.dispatch({ kind: 'session-attached', sessionId: session.id, viewId }))}>{messages.resume}</button> : null}</>
      : <>
        <label htmlFor={id}>{label}</label>
        {text === null ? <p role="alert">{messages.unsupported}</p> : <input id={id} value={text} readOnly={!open} aria-describedby={error ? errorId : undefined}
          onChange={event => type(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing ? 'composing' : 'idle')}
          onCompositionStart={event => type(event.currentTarget.value, 'composing')}
          onCompositionEnd={event => type(event.currentTarget.value, 'idle')} />}
        {!ready ? <p role="status">{messages.pending}</p> : null}
        {session.issues.length ? <p role="alert">{messages.changed}</p> : null}
        {session.issues.length > 0 && session.issues.every(issue => issue.code === 'session-query-changed') && !session.dependencies.length && current !== null ? <>
          <output aria-label={messages.current}>{current}</output>
          <button type="button" disabled={!ready || session.composition !== 'idle'} onClick={async () => report(await workspace.dispatch({ kind: 'session-reconfirmed', lease: session.editor!, inputVersion: session.input.version, revision: snapshot.state.revision }))}>{messages.reconfirm}</button>
        </> : null}
        <button type="button" disabled={!ready || text === null || session.composition !== 'idle' || !!session.issues.length} onClick={apply}>{messages.apply}</button>
        <button type="button" disabled={!ready} onClick={async () => report(await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, inputVersion: session.input.version, lease: session.editor }))}>{messages.discard}</button>
      </>}
    {error ? <p role="alert" id={errorId}>{error}</p> : null}
  </section>
}
