import { WorkspaceResourceInput, type WorkspaceResourceMessages, type WorkspaceResourceTask } from './workspace-resource-input.js'
import { parseMatrixValues, readMatrixInput } from '../clipboard.js'
import { useEffect, useId, useState } from 'react'
import { encodedValuesEqual, ownEncodedValue, readDocument } from '../kernel/document.js'
import { inputRefKey } from '../kernel/journal.js'
import { kernelId, type EntityId, type FieldRef, type Patch, type ResourceValue, type SessionTarget, type ViewId } from '../kernel/model.js'
import { prepareRowAction } from '../kernel/prepare.js'
import type { CommandResult } from '../kernel/transition.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import { useWorkspaceSnapshot } from './workspace-react.js'

import type { WorkspaceTextCodec } from '../value-codecs.js'
export type { WorkspaceTextCodec } from '../value-codecs.js'

export type WorkspaceTextEditorMessages = Readonly<{
  edit: string; apply: string; discard: string; resume: string
  unavailable: string; otherEditor: string; pending: string; unsupported: string; failed: string
  currentValue: string; reconfirm: string; retarget(label: string): string
}>
export type WorkspaceTargetReview = Readonly<{
  target: Extract<SessionTarget, { kind: 'cell' | 'bulk' }>; label: string
  values: readonly Readonly<{ label: string; value: string }>[]; revision: number
}>
export type WorkspaceTextEditorProps = Readonly<{
  workspace: Workspace; viewId: ViewId; target: Extract<SessionTarget, { kind: 'cell' | 'bulk' }>; label: string
  codecs: ReadonlyMap<FieldRef['fieldId'], WorkspaceTextCodec>; messages: WorkspaceTextEditorMessages; serverSnapshot?: WorkspaceSnapshot
  replacement?: WorkspaceTargetReview
  currentReview?: WorkspaceTargetReview
  resource?: Readonly<{ task: WorkspaceResourceTask; messages: WorkspaceResourceMessages }>
}>

/** The text is always the Workspace-owned ingress/session input. Applying
 * prepares the fixed cell or bulk target set; it does not promise a source save. Blur and
 * Escape never dispose input, and React cleanup never closes the owner. */
export function WorkspaceTextEditor({ workspace, viewId, target, label, codecs, messages, serverSnapshot, replacement, currentReview, resource }: WorkspaceTextEditorProps) {
  const snapshot = useWorkspaceSnapshot(workspace, serverSnapshot), session = snapshot.state.session
  const inputId = useId(), errorId = useId()
  const [failure, setFailure] = useState<Readonly<{ workspace: Workspace; session: typeof session; message: string }> | null>(null)
  const fields = target.kind === 'cell' ? [target.field] : target.fields
  const bindings = new Map(workspace.schema.fields.map(binding => [binding.id, binding]))
  const availableRows = new Set(snapshot.projection.rows.filter(row => row.preview && row.existence !== 'pending-delete').map(row => row.entityId))
  const field = target.kind === 'cell' ? target.field : null
  const binding = field && workspace.schema.fields.find(binding => binding.id === field.fieldId)
  const codec = field && codecs.get(field.fieldId)
  const row = snapshot.projection.rows.find(row => row.entityId === field?.entityId && row.existence !== 'pending-delete')
  const matches = session && encodedValuesEqual(ownEncodedValue(session.target), ownEncodedValue(target))
  const owns = matches && session.editor?.viewId === viewId
  useEffect(() => { if (owns) document.getElementById(inputId)?.focus() }, [workspace, owns, session?.id, inputId])
  const input = owns ? snapshot.editorInput?.input ?? session.rawInput : null
  const matrix = readMatrixInput(input)
  const text = matrix ? matrix.text : input?.kind === 'encoded' && typeof input.value === 'string' ? input.value : null
  const ready = owns && snapshot.editorInput?.status === 'published' && snapshot.ingress.pending.length === 0
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && snapshot.capabilities.close.lifecycle === 'open'
  const knownContext = session?.dependencies.every(dependency => dependency.resource.kind === 'path'
    && fields.some(field => {
      const binding = bindings.get(field.fieldId), resource = dependency.resource
      return resource.kind === 'path' && binding && resource.entityId === field.entityId
        && resource.path.length === binding.path.length && resource.path.every((segment, index) => segment === binding.path[index])
    }))
  const canReview = ready && knownContext && session?.composition === 'idle'
  const sameTarget = (other: WorkspaceTargetReview) => encodedValuesEqual(ownEncodedValue(other.target), ownEncodedValue(target))
  const reviewedValue = (review: WorkspaceTargetReview) => review.target.kind === 'cell' ? review.values[0]?.value
    : review.values.map(value => `${value.label}: ${value.value}`).join('\n')
  const firstCodec = fields[0] && codecs.get(fields[0].fieldId)
  const choices = firstCodec && fields.every(field => codecs.get(field.fieldId) === firstCodec) ? firstCodec.choices : undefined
  let selectedTokens: readonly string[] | null = null
  if (choices?.multiple && text !== null) {
    try {
      const tokens: unknown = JSON.parse(text)
      if (Array.isArray(tokens) && new Set(tokens).size === tokens.length && tokens.every(token => typeof token === 'string' && choices.options.some(option => option.text === token))) selectedTokens = tokens
    } catch { /* Invalid retained text stays editable instead of becoming an empty selection. */ }
  }
  const representedChoice = choices && text !== null && (choices.multiple ? selectedTokens !== null : text === '' || choices.options.some(option => option.text === text))
  const error = failure?.workspace === workspace && failure.session === session ? failure.message : null
  const report = (result: CommandResult) => {
    if (result.kind === 'rejected') setFailure({ workspace, session, message: messages.failed })
  }
  async function apply() {
    if (!ready || !session?.editor || text === null || session.composition !== 'idle') return
    try {
      const key = (field: FieldRef) => JSON.stringify([field.entityId, field.fieldId])
      const values = new Map<string, ResourceValue>()
      if (matrix) {
        const parsed = parseMatrixValues(text, matrix.layout, codecs)
        if (parsed.kind === 'invalid') { setFailure({ workspace, session, message: parsed.message }); return }
        const targets = new Set(fields.map(key))
        if (parsed.values.length !== targets.size || parsed.values.some(value => !targets.has(key(value.field)))) throw new Error('The matrix layout no longer matches the session target.')
        for (const value of parsed.values) values.set(key(value.field), value.value)
      } else {
        const parsedFields = new Map<FieldRef['fieldId'], ResourceValue>()
        for (const field of fields) {
          if (!parsedFields.has(field.fieldId)) {
            const codec = codecs.get(field.fieldId)
            if (!codec) throw new Error('Missing target codec.')
            const parsed = codec.parse(text)
            if (parsed.kind === 'invalid') { setFailure({ workspace, session, message: parsed.message }); return }
            parsedFields.set(field.fieldId, parsed.value)
          }
          values.set(key(field), parsedFields.get(field.fieldId)!)
        }
      }
      const refs = [session.input, ...session.retainedInputs]
      const inputs = refs.map(ref => {
        const record = snapshot.state.inputs.find(record => inputRefKey(record.ref) === inputRefKey(ref))
        if (!record) throw new Error('Missing session input evidence.')
        return { ref, input: record.input }
      })
      const fresh = () => crypto.randomUUID()
      const writes = new Map<EntityId, Patch[]>()
      for (const field of fields) {
        const binding = bindings.get(field.fieldId), value = values.get(key(field))
        if (!binding || !value) throw new Error('Missing target binding.')
        const patches = writes.get(field.entityId) ?? []
        patches.push(value.kind === 'missing' ? { kind: 'remove', path: binding.path } : { kind: 'set', path: binding.path, value: value.value })
        writes.set(field.entityId, patches)
      }
      const prepared = prepareRowAction(snapshot.state, {
        action: { id: kernelId<'action'>(fresh()), applicationId: kernelId<'application'>(fresh()), label, saveAtomicity: 'row' }, cause: 'user', inputs,
        commands: [...writes].map(([entityId, patches]) => ({ id: kernelId<'intent'>(fresh()), inputs: refs, dependencies: [],
          command: { kind: 'write', entityId, groups: [{ id: kernelId<'write-group'>(fresh()), comparison: 'paths',
            reads: session.dependencies.filter(dependency => dependency.resource.kind === 'entity' && dependency.resource.entityId === entityId)
              .map(dependency => ({ ...dependency, role: 'semantic-read' as const })),
            writes: patches }] },
        })),
      }, workspace.schema)
      report(await workspace.dispatch({ kind: 'session-apply', lease: session.editor, inputVersion: session.input.version, prepared }))
    } catch { setFailure({ workspace, session, message: messages.failed }) }
  }
  async function open() {
    if (session) return
    try {
      const raw = target.kind === 'bulk' ? choices?.multiple ? '[]' : '' : codec && binding && row?.preview ? codec.format(readDocument(row.preview, binding.path)) : null
      if (raw === null) return
      report(await workspace.dispatch({ kind: 'session-opened', revision: snapshot.state.revision,
        sessionId: kernelId<'session'>(crypto.randomUUID()), inputId: kernelId<'input'>(crypto.randomUUID()), viewId,
        target, input: { kind: 'encoded', value: raw }, reads: [] }))
    } catch { setFailure({ workspace, session, message: messages.failed }) }
  }
  const type = (value: string, composition: 'idle' | 'composing') => {
    if (owns && session.editor) workspace.typeInput(session.editor, { kind: 'encoded', value: matrix ? { ...matrix, text: value } : value }, composition)
  }
  return <section aria-label={label}>
    {!session ? <button type="button" onClick={open} disabled={!fields.length || fields.some(field => !codecs.has(field.fieldId) || !bindings.has(field.fieldId) || bindings.get(field.fieldId)!.readonly || !availableRows.has(field.entityId)) || snapshot.capabilities.close.lifecycle !== 'open'}>{messages.edit}</button>
      : !owns ? <>
        <p>{messages.otherEditor}</p>
        {matches && !session.editor ? <button type="button" onClick={async () => report(await workspace.dispatch({ kind: 'session-attached', sessionId: session.id, viewId }))}>{messages.resume}</button> : null}
      </> : <>
        {resource && field && !matrix ? <WorkspaceResourceInput workspace={workspace} snapshot={snapshot} {...resource} /> : null}
        <label htmlFor={inputId}>{label}</label>
        {text === null ? <p role="alert">{messages.unsupported}</p> : matrix ? <textarea id={inputId} value={text} readOnly={snapshot.capabilities.close.lifecycle !== 'open'} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          onChange={event => type(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing ? 'composing' : 'idle')}
          onCompositionStart={event => type(event.currentTarget.value, 'composing')}
          onCompositionEnd={event => type(event.currentTarget.value, 'idle')} /> : representedChoice ? <select id={inputId} multiple={choices.multiple ?? false} value={choices.multiple ? selectedTokens! : text}
          disabled={snapshot.capabilities.close.lifecycle !== 'open'} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          onChange={event => {
            if (!choices.multiple) { type(event.currentTarget.value, 'idle'); return }
            const next = [...event.currentTarget.selectedOptions].map(option => option.value), membership = new Set(next)
            const retained = (selectedTokens ?? []).filter(token => membership.has(token)), previous = new Set(retained)
            type(JSON.stringify([...retained, ...next.filter(token => !previous.has(token))]), 'idle')
          }}>
          {!choices.multiple ? <option value="">{choices.placeholder}</option> : null}
          {choices.options.map(option => <option key={option.text} value={option.text} disabled={option.disabled}>{option.label}</option>)}
        </select> : <input id={inputId} value={text} readOnly={snapshot.capabilities.close.lifecycle !== 'open'} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          onChange={event => type(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing ? 'composing' : 'idle')}
          onCompositionStart={event => type(event.currentTarget.value, 'composing')}
          onCompositionEnd={event => type(event.currentTarget.value, 'idle')} />}
        {!ready ? <p role="status">{messages.pending}</p> : null}
        {session.issues.length ? <p role="alert">{messages.unavailable}</p> : null}
        {session.issues.length > 0 && session.issues.every(issue => issue.code === 'session-context-changed') && currentReview && sameTarget(currentReview) ? <>
          <output style={{ whiteSpace: 'pre-wrap' }} aria-label={messages.currentValue}>{reviewedValue(currentReview)}</output>
          <button type="button" disabled={!canReview || currentReview.revision !== snapshot.state.revision} onClick={async () => report(await workspace.dispatch({ kind: 'session-reconfirmed', lease: session.editor!, inputVersion: session.input.version, revision: currentReview.revision }))}>{messages.reconfirm}</button>
        </> : null}
        {!matrix && replacement && !sameTarget(replacement) ? <>
          <output style={{ whiteSpace: 'pre-wrap' }} aria-label={replacement.label}>{reviewedValue(replacement)}</output>
          <button type="button" disabled={!canReview || replacement.revision !== snapshot.state.revision} onClick={async () => report(await workspace.dispatch({ kind: 'session-retargeted', lease: session.editor!, inputVersion: session.input.version,
            revision: replacement.revision, target: replacement.target, reads: [] }))}>{messages.retarget(replacement.label)}</button>
        </> : null}
        <button type="button" disabled={!ready || text === null || session.composition !== 'idle' || session.issues.length > 0} onClick={apply}>{messages.apply}</button>
        <button type="button" disabled={!ready} onClick={async () => report(await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, inputVersion: session.input.version, lease: session.editor }))}>{messages.discard}</button>
      </>}
    {error ? <p role="alert" id={errorId}>{error}</p> : null}
  </section>
}
