import { createPortal } from 'react-dom'
import { beginChoiceBulk, readChoiceBulkInput, transformChoiceBulk, WorkspaceChoiceBulk, type ChoiceBulkMessages } from './workspace-choice-bulk.js'
import { writeBrowserEditorInput } from './workspace-editor-input.js'
import { WorkspaceDialog } from './workspace-dialog.js'
import { emptyBulkInput, readBulkInput, transformBulkText, WorkspaceBulkEditor, type WorkspaceBulkMessages } from './workspace-bulk-editor.js'
import { WorkspaceEditorFrame } from './workspace-editor-frame.js'
import type { WorkspaceGridCell } from './workspace-selection.js'
import { WorkspaceResourceInput, type WorkspaceResourceMessages, type WorkspaceResourceTask } from './workspace-resource-input.js'
import { clipboardFits, decodeMatrix, resolveOperationLimits, parseMatrixValues, readMatrixInput } from '../clipboard.js'
import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent, type RefObject, type ReactNode } from 'react'
import { encodedValuesEqual, ownEncodedValue, readDocument } from '../kernel/document.js'
import { inputRefKey } from '../kernel/journal.js'
import { reduceSession } from '../kernel/session.js'
import { kernelId, type EntityId, type FieldRef, type InputRef, type Patch, type ResourceValue, type SessionTarget, type ViewId } from '../kernel/model.js'
import { prepareRowAction, type RowCommand } from '../kernel/prepare.js'
import type { CommandResult } from '../kernel/transition.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import { useWorkspaceSnapshot } from './workspace-react.js'

import type { WorkspaceTextCodec } from '../value-codecs.js'
export type { WorkspaceTextCodec } from '../value-codecs.js'

export type WorkspaceTextEditorMessages = Readonly<{
  bulkTitle(count: number): string
  choiceBulk: ChoiceBulkMessages
  bulk: WorkspaceBulkMessages
  editSelection: string; review: string; chooseValue: string; chooseValues: string; applyChoice: string; cancel: string; applyCells(count: number): string
  edit: string; apply: string; discard: string; resume: string
  limitExceeded: string; unavailable: string; otherEditor: string; pending: string; unsupported: string; failed: string
  currentValue: string; reconfirm: string; retarget(label: string): string
}>
export type WorkspaceTargetReview = Readonly<{
  target: Extract<SessionTarget, { kind: 'cell' | 'bulk' }>; label: string
  values: readonly Readonly<{ label: string; value: string }>[]; revision: number
}>
export type WorkspaceTextEditorProps = Readonly<{
  idleContainer?: HTMLElement | null
  inputFrame?: Readonly<{ root: RefObject<HTMLElement | null>; cell: WorkspaceGridCell }>
  presentation?: 'cell'
  maxClipboardBytes?: number
  maxMutations?: number
  autoApply?: boolean
  commitRequest?: Readonly<{ sessionId: string; complete(): void }>
  onReviewChange?(sessionId: string, reviewing: boolean): void
  selectOnFocus?: boolean
  onFinished?(move?: 'next' | 'previous', restoreFrom?: Element | null, applied?: boolean): void
  opening?: ReturnType<Workspace['beginEditing']>
  workspace: Workspace; viewId: ViewId; target: Extract<SessionTarget, { kind: 'cell' | 'bulk' }>; label: string
  codecs: ReadonlyMap<FieldRef['fieldId'], WorkspaceTextCodec>; messages: WorkspaceTextEditorMessages; serverSnapshot?: WorkspaceSnapshot
  replacement?: WorkspaceTargetReview
  currentReview?: WorkspaceTargetReview
  resource?: Readonly<{ task: WorkspaceResourceTask; messages: WorkspaceResourceMessages }>
}>

/** The text is always the Workspace-owned ingress/session input. Applying
 * prepares the fixed cell or bulk target set; it does not promise a source save. Blur and
 * React cleanup never dispose input. Escape is explicit cancellation for scalar
 * editors; resource tasks keep their separate cancellation scope. */
export function WorkspaceTextEditor({ idleContainer, workspace, viewId, target, label, codecs, messages, serverSnapshot, replacement, currentReview, resource, opening, selectOnFocus = true, onFinished, presentation, autoApply, inputFrame, commitRequest, onReviewChange, maxClipboardBytes, maxMutations }: WorkspaceTextEditorProps) {
  const limits = resolveOperationLimits({ maxClipboardBytes, maxMutations })
  const snapshot = useWorkspaceSnapshot(workspace, serverSnapshot), session = snapshot.state.session
  const [reviewing, setReviewing] = useState<string | null>(null)
  const inputId = useId(), errorId = useId()
  const [failure, setFailure] = useState<Readonly<{ workspace: Workspace; sessionId: string | null; text: string | null; message: string }> | null>(null)
  const fields = target.kind === 'cell' ? [target.field] : target.fields
  const bindings = new Map(workspace.schema.fields.map(binding => [binding.id, binding]))
  const availableRows = new Set(snapshot.projection.rows.filter(row => row.preview && row.existence !== 'pending-delete').map(row => row.entityId))
  const field = target.kind === 'cell' ? target.field : null
  const binding = field && workspace.schema.fields.find(binding => binding.id === field.fieldId)
  const codec = field && codecs.get(field.fieldId)
  const row = snapshot.projection.rows.find(row => row.entityId === field?.entityId && row.existence !== 'pending-delete')
  const matches = session && encodedValuesEqual(ownEncodedValue(session.target), ownEncodedValue(target))
  const owns = matches && session.editor?.viewId === viewId
  const focusedInput = useRef<{ id: string; node: HTMLElement } | null>(null)
  useLayoutEffect(() => {
    const id = owns ? session?.id : opening?.sessionId
    const node = document.getElementById(inputId)
    if (!id || !node || focusedInput.current?.id === id && focusedInput.current.node === node) return
    const firstActivation = focusedInput.current?.id !== id
    node.focus({ preventScroll: true })
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      if (firstActivation && selectOnFocus) node.select()
      else if (node.type !== 'date') node.setSelectionRange(node.value.length, node.value.length)
    }
    focusedInput.current = { id, node }
  })
  const input = owns ? snapshot.editorInput?.input ?? session.rawInput : opening?.read() ?? null
  const bulk = readBulkInput(input), choiceBulk = readChoiceBulkInput(input)
  const matrix = readMatrixInput(input)
  const text = choiceBulk ? JSON.stringify(choiceBulk) : bulk ? JSON.stringify(bulk) : matrix ? matrix.text : input?.kind === 'encoded' && typeof input.value === 'string' ? input.value : null
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
  const error = failure?.workspace === workspace && failure.sessionId === (session?.id ?? null) && failure.text === text ? failure.message : null
  const report = (result: CommandResult) => {
    if (result.kind === 'rejected') setFailure({ workspace, sessionId: session?.id ?? null, text, message: messages.failed })
  }
  async function apply(move?: 'next' | 'previous', complete?: () => void) {
    const restoreFrom = document.activeElement
    if (!ready || !session?.editor || text === null || session.composition !== 'idle' || choiceBulk && (choiceBulk.operation === 'keep' || choiceBulk.operation !== 'replace' && !choiceBulk.tokens.length)) return
    try {
      const createdCount = session.target.kind === 'bulk' ? session.target.creations?.length ?? 0 : 0
      if (fields.length + createdCount > limits.maxMutations || matrix && (!clipboardFits(text, limits.maxClipboardBytes)
        || decodeMatrix(text).reduce((count, row) => count + row.length, createdCount) > limits.maxMutations)) {
        setFailure({ workspace, sessionId: session.id, text, message: messages.limitExceeded }); return
      }
      const key = (field: FieldRef) => JSON.stringify([field.entityId, field.fieldId])
      const values = new Map<string, ResourceValue>()
      if (choiceBulk) {
        if (!choices?.multiple) throw new Error('The bulk catalog is unavailable.')
        for (const field of fields) {
          const binding = bindings.get(field.fieldId), codec = codecs.get(field.fieldId)
          const row = snapshot.projection.rows.find(row => row.entityId === field.entityId)
          if (!binding || !codec || !row?.preview) throw new Error('The bulk target is no longer available.')
          let next: readonly string[]
          try { next = transformChoiceBulk(choiceBulk, JSON.parse(codec.format(readDocument(row.preview, binding.path))), choices, messages.choiceBulk.unavailable) }
          catch (error) { setFailure({ workspace, sessionId: session.id, text, message: error instanceof Error ? error.message : messages.failed }); return }
          const parsed = codec.parse(JSON.stringify(next))
          if (parsed.kind === 'invalid') { setFailure({ workspace, sessionId: session.id, text, message: parsed.message }); return }
          values.set(key(field), parsed.value)
        }
      } else if (bulk) {
        for (const field of fields) {
          const binding = bindings.get(field.fieldId), codec = codecs.get(field.fieldId)
          const row = snapshot.projection.rows.find(row => row.entityId === field.entityId)
          if (!binding || !codec || codec.inputKind !== 'text' || !row?.preview) throw new Error('The bulk target is no longer available.')
          let transformed: string
          try { transformed = transformBulkText(bulk, codec.format(readDocument(row.preview, binding.path)), messages.bulk) }
          catch (error) { setFailure({ workspace, sessionId: session.id, text, message: error instanceof Error ? error.message : messages.failed }); return }
          const parsed = codec.parse(transformed)
          if (parsed.kind === 'invalid') { setFailure({ workspace, sessionId: session.id, text, message: parsed.message }); return }
          values.set(key(field), parsed.value)
        }
      } else if (matrix) {
        const creations = session.target.kind === 'bulk' ? session.target.creations ?? [] : []
        const parsed = parseMatrixValues(text, { ...matrix.layout, rows: [...matrix.layout.rows, ...creations.map(creation => creation.entityId)] }, codecs)
        if (parsed.kind === 'invalid') { setFailure({ workspace, sessionId: session?.id ?? null, text, message: parsed.message }); return }
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
            if (parsed.kind === 'invalid') { setFailure({ workspace, sessionId: session?.id ?? null, text, message: parsed.message }); return }
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
        action: { id: kernelId<'action'>(fresh()), applicationId: kernelId<'application'>(fresh()), label, saveAtomicity: session.target.kind === 'bulk' && session.target.creations?.length ? 'transaction' : 'row' }, cause: 'user', inputs,
        commands: [...(session.target.kind === 'bulk' ? session.target.creations ?? [] : []).map(creation => ({ id: kernelId<'intent'>(fresh()), inputs: refs, dependencies: [], command: { kind: 'create', ...creation } satisfies RowCommand })),
          ...[...writes].map(([entityId, patches]) => ({ id: kernelId<'intent'>(fresh()), inputs: refs, dependencies: [],
          command: { kind: 'write', entityId, groups: [{ id: kernelId<'write-group'>(fresh()), comparison: 'paths',
            reads: session.dependencies.filter(dependency => dependency.resource.kind === 'entity' && dependency.resource.entityId === entityId)
              .map(dependency => ({ ...dependency, role: 'semantic-read' as const })),
            writes: patches }] } satisfies RowCommand,
          }))],
      }, workspace.schema)
      const command = { kind: 'session-apply' as const, lease: session.editor, inputVersion: session.input.version, prepared }
      // Validate a complete creation candidate while its original input is
      // still editable. Storage admission revalidates the same lease and data.
      if (session.target.kind === 'bulk' && session.target.creations?.length) reduceSession(snapshot.state, command, workspace.schema)
      const result = await workspace.dispatch(command)
      report(result)
      if (result.kind === 'accepted') { if (complete) complete(); else onFinished?.(move, restoreFrom, true) }
    } catch { setFailure({ workspace, sessionId: session?.id ?? null, text, message: messages.failed }) }
  }
  async function open() {
    if (session) return
    try {
      const raw = target.kind === 'bulk' ? choices?.multiple ? '[]' : '' : codec && binding && row?.preview ? codec.format(readDocument(row.preview, binding.path)) : null
      if (raw === null) return
      report(await workspace.dispatch({ kind: 'session-opened', revision: snapshot.state.revision,
        sessionId: kernelId<'session'>(crypto.randomUUID()), inputId: kernelId<'input'>(crypto.randomUUID()), viewId,
        target, input: { kind: 'encoded', value: target.kind === 'bulk' && choices?.multiple ? beginChoiceBulk(fields.map(field => {
          const binding = bindings.get(field.fieldId)!, row = snapshot.projection.rows.find(row => row.entityId === field.entityId)!
          return JSON.parse(codecs.get(field.fieldId)!.format(readDocument(row.preview!, binding.path))) as string[]
        }), choices) : target.kind === 'bulk' && fields.every(field => codecs.get(field.fieldId)?.inputKind === 'text') ? emptyBulkInput : raw }, reads: [] }))
    } catch { setFailure({ workspace, sessionId: null, text, message: messages.failed }) }
  }
  const type = (value: string, composition: 'idle' | 'composing') => {
    if (!session && opening) { setIntent(null); opening.type({ kind: 'encoded', value: matrix ? { ...matrix, text: value } : value }, composition); return }
    if (owns && session.editor && writeBrowserEditorInput(workspace, session.editor, { kind: 'encoded', value: matrix ? { ...matrix, text: value } : value }, composition)) setIntent(null)
  }
  const automaticSession = useRef<string | null>(null)
  const [intent, setIntent] = useState<{ workspace: Workspace; expectedInput?: InputRef; id: string; action: 'apply' | 'cancel'; move?: 'next' | 'previous'; complete?: () => void } | null>(null)
  useEffect(() => {
    if (autoApply && ready && session && automaticSession.current !== session.id) {
      automaticSession.current = session.id; setIntent({ workspace, id: session.id, expectedInput: session.input, action: 'apply' })
    }
  }, [autoApply, ready, session])
  const handledCommit = useRef<typeof commitRequest>(undefined)
  useEffect(() => {
    if (!commitRequest || handledCommit.current === commitRequest) return
    handledCommit.current = commitRequest
    setIntent({ workspace, id: commitRequest.sessionId, action: 'apply', complete: commitRequest.complete })
  }, [commitRequest])
  async function cancel() {
    const restoreFrom = document.activeElement
    if (!ready || !session?.editor) return
    const result = await workspace.dispatch({ kind: 'session-cancelled', sessionId: session.id, inputVersion: session.input.version, lease: session.editor })
    report(result)
    if (result.kind === 'accepted') onFinished?.(undefined, restoreFrom)
  }
  useEffect(() => {
    if (!intent) return
    if (intent.workspace !== workspace) { setIntent(null); return }
    if (!ready || session?.id !== intent.id) return
    setIntent(null)
    if (intent.expectedInput && (intent.expectedInput.id !== session.input.id || intent.expectedInput.version !== session.input.version)) return
    if (intent.action === 'cancel') void cancel()
    else void apply(intent.move, intent.complete)
  }, [intent, ready, session])
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    const latest = workspace.getSnapshot()
    const pending = latest.ingress.pending.filter(entry => entry.payload.kind === 'input' && entry.payload.envelope.lease.sessionId === (session?.id ?? opening?.sessionId)).at(-1)
    const composition = pending?.payload.kind === 'input' ? pending.payload.envelope.composition : latest.state.session?.composition
    if (resource && event.key === 'Escape') return
    if (event.nativeEvent.isComposing || composition === 'composing' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox' && event.key !== 'Escape') return
    if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)) return
    if (target.kind === 'bulk' && event.key === 'Tab') return
    if (event.key !== 'Escape' && event.key !== 'Tab' && (event.key !== 'Enter' || matrix)) return
    const id = owns ? session?.id : opening?.sessionId
    if (!id) return
    event.preventDefault(); event.stopPropagation()
    setIntent({ workspace, id, action: event.key === 'Escape' ? 'cancel' : 'apply', ...(event.key === 'Tab' ? { move: event.shiftKey ? 'previous' : 'next' } : {}) })
  }
  const control: ReactNode = choiceBulk && choices?.multiple ? <WorkspaceChoiceBulk input={choiceBulk} catalog={choices} messages={messages.choiceBulk} inputId={inputId} disabled={snapshot.capabilities.close.lifecycle !== 'open'} write={input => {
    if (session?.editor && writeBrowserEditorInput(workspace, session.editor, { kind: 'encoded', value: input }, 'idle')) setIntent(null)
  }} /> : bulk ? <WorkspaceBulkEditor messages={messages.bulk} input={bulk} inputId={inputId} disabled={snapshot.capabilities.close.lifecycle !== 'open'} write={(input, composition = 'idle') => {
    if (owns && session.editor && writeBrowserEditorInput(workspace, session.editor, { kind: 'encoded', value: input }, composition)) setIntent(null)
  }} /> : text === null ? <p role="alert">{messages.unsupported}</p> : matrix ? <textarea id={inputId} value={text} readOnly={snapshot.capabilities.close.lifecycle !== 'open'} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          onChange={event => type(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing ? 'composing' : 'idle')}
          onCompositionStart={event => type(event.currentTarget.value, 'composing')}
          onCompositionEnd={event => type(event.currentTarget.value, 'idle')} /> : representedChoice && presentation === 'cell' ? choices.multiple ? <fieldset id={inputId} aria-label={messages.chooseValues}>
          {choices.options.map(option => <label key={option.text}><input type="checkbox" checked={selectedTokens!.includes(option.text)} disabled={option.disabled || snapshot.capabilities.close.lifecycle !== 'open'}
            onChange={event => type(JSON.stringify(event.currentTarget.checked ? [...selectedTokens!, option.text] : selectedTokens!.filter(token => token !== option.text)), 'idle')} />{option.label}</label>)}
        </fieldset> : <div id={inputId} tabIndex={0} role="listbox" aria-label={messages.chooseValue} onKeyDown={event => {
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
          const index = options.indexOf(document.activeElement as HTMLButtonElement)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault(); options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
          } else if (event.key === 'Escape') { event.preventDefault(); setIntent({ workspace, id: session?.id ?? opening!.sessionId, action: 'cancel' }) }
        }}>
          {choices.options.map(option => <button key={option.text} type="button" role="option" aria-selected={text === option.text} disabled={option.disabled || snapshot.capabilities.close.lifecycle !== 'open'}
            onClick={() => { type(option.text, 'idle'); setIntent({ workspace, id: session?.id ?? opening!.sessionId, action: 'apply' }) }}>{option.label}</button>)}
        </div>: representedChoice ? <select id={inputId} multiple={choices.multiple ?? false} value={choices.multiple ? selectedTokens! : text}
          disabled={snapshot.capabilities.close.lifecycle !== 'open'} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          onChange={event => {
            if (!choices.multiple) { type(event.currentTarget.value, 'idle'); return }
            const next = [...event.currentTarget.selectedOptions].map(option => option.value), membership = new Set(next)
            const retained = (selectedTokens ?? []).filter(token => membership.has(token)), previous = new Set(retained)
            type(JSON.stringify([...retained, ...next.filter(token => !previous.has(token))]), 'idle')
          }}>
          {!choices.multiple ? <option value="">{choices.placeholder}</option> : null}
          {choices.options.map(option => <option key={option.text} value={option.text} disabled={option.disabled}>{option.label}</option>)}
        </select> : <input type={presentation === 'cell' && codec?.inputKind === 'date' ? 'date' : 'text'} id={inputId} value={text} readOnly={snapshot.capabilities.close.lifecycle !== 'open'} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          onChange={event => type(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing ? 'composing' : 'idle')}
          onCompositionStart={event => type(event.currentTarget.value, 'composing')}
          onCompositionEnd={event => type(event.currentTarget.value, 'idle')} />
  const framedControl = inputFrame ? <WorkspaceEditorFrame {...inputFrame}>{control}</WorkspaceEditorFrame> : control
  const bulkTitle = messages.bulkTitle(fields.length)
  const bulkDialog = presentation === 'cell' && owns && target.kind === 'bulk' && !matrix
  const content = <section aria-label={label} data-inline-editor={!!inputFrame || undefined} data-grid-editor={owns || !!opening ? true : undefined} onKeyDown={keyboard}>
    {!session && !opening ? <button type="button" onClick={open} disabled={!fields.length || fields.some(field => !codecs.has(field.fieldId) || !bindings.has(field.fieldId) || bindings.get(field.fieldId)!.readonly || !availableRows.has(field.entityId)) || snapshot.capabilities.close.lifecycle !== 'open'}>{presentation === 'cell' && target.kind === 'bulk' ? messages.editSelection : messages.edit}</button>
      : !owns && !opening ? <>
        <p>{messages.otherEditor}</p>
        {matches && !session!.editor ? <button type="button" onClick={async () => report(await workspace.dispatch({ kind: 'session-attached', sessionId: session!.id, viewId }))}>{messages.resume}</button> : null}
      </> : <>
        {bulkDialog ? <h2 className="business-grid__workspace-bulk-title">{bulkTitle}</h2> : null}
        {owns && resource && field && !matrix ? <WorkspaceResourceInput workspace={workspace} snapshot={snapshot} {...resource} onResultApplied={(id, expectedInput) => setIntent({ workspace, id, expectedInput, action: 'apply' })} /> : null}
        {!bulk && !choiceBulk ? <label htmlFor={inputId}>{label}</label> : null}
        {framedControl}
        {owns && !matrix ? <button type="button" onClick={() => { const next = reviewing !== session!.id; setReviewing(next ? session!.id : null); onReviewChange?.(session!.id, next) }}>{reviewing === session!.id ? messages.resume : messages.review}</button> : null}
        {!ready ? <p role="status">{messages.pending}</p> : null}
        {session?.issues.length ? <p role="alert">{messages.unavailable}</p> : null}
        {(session?.issues.length ?? 0) > 0 && session!.issues.every(issue => issue.code === 'session-context-changed') && currentReview && sameTarget(currentReview) ? <>
          <output style={{ whiteSpace: 'pre-wrap' }} aria-label={messages.currentValue}>{reviewedValue(currentReview)}</output>
          <button type="button" disabled={!canReview || currentReview.revision !== snapshot.state.revision} onClick={async () => report(await workspace.dispatch({ kind: 'session-reconfirmed', lease: session!.editor!, inputVersion: session!.input.version, revision: currentReview.revision }))}>{messages.reconfirm}</button>
        </> : null}
        {!matrix && replacement && !sameTarget(replacement) ? <>
          <output style={{ whiteSpace: 'pre-wrap' }} aria-label={replacement.label}>{reviewedValue(replacement)}</output>
          <button type="button" disabled={!canReview || replacement.revision !== snapshot.state.revision} onClick={async () => report(await workspace.dispatch({ kind: 'session-retargeted', lease: session!.editor!, inputVersion: session!.input.version,
            revision: replacement.revision, target: replacement.target, reads: [] }))}>{messages.retarget(replacement.label)}</button>
        </> : null}
        <button type="button" disabled={!ready || !!choiceBulk && (choiceBulk.operation === 'keep' || choiceBulk.operation !== 'replace' && !choiceBulk.tokens.length) || text === null || session?.composition !== 'idle' || (session?.issues.length ?? 0) > 0} onClick={() => { void apply() }}>{presentation === 'cell' && target.kind === 'bulk' && !matrix ? messages.applyCells(fields.length) : presentation === 'cell' && choices ? messages.applyChoice : messages.apply}</button>
        <button type="button" disabled={!ready} onClick={() => { void cancel() }}>{presentation === 'cell' && (choices || target.kind === 'bulk' && !matrix) ? messages.cancel : messages.discard}</button>
      </>}
    {error ? <p role="alert" id={errorId}>{error}</p> : null}
  </section>
  if (!session && !opening && idleContainer) return createPortal(content, idleContainer)
  return bulkDialog && reviewing !== session!.id
    ? <WorkspaceDialog label={bulkTitle} cancel={() => setIntent({ workspace, id: session!.id, action: 'cancel' })}>{content}</WorkspaceDialog> : content
}
