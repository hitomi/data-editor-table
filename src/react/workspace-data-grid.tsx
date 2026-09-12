import { WorkspaceDecisionRecovery, type WorkspaceDecisionRecoveryMessages } from './workspace-decision-recovery.js'
import { WorkspaceContextMenu, type WorkspaceMenuAnchor } from './workspace-context-menu.js'
import { expandWorkspaceFill, resolveWorkspaceFill, type WorkspaceFillColumn, type FillAxes } from './workspace-fill.js'
import { WorkspaceStoredFiles, type WorkspaceStoredFileMessages } from './workspace-stored-files.js'
import { scopeView } from '../kernel/view.js'
import { encodeMatrix } from '../clipboard.js'
import { WorkspaceTaskRecovery } from './workspace-task-recovery.js'
import type { WorkspaceResourceMessages, WorkspaceResourceTask } from './workspace-resource-input.js'
import { workspaceEn } from '../locales/workspace-en.js'
import type { WorkspaceLocale } from '../locales/workspace-contracts.js'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { canonicalEncodedValue, ownEncodedValue, readDocument } from '../kernel/document.js'
import { kernelId, type FieldId, type ViewId, type SessionTarget, type OwnedInput, type TaskState, type ViewPredicate } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import { WorkspaceTextEditor, type WorkspaceTextEditorMessages, type WorkspaceTextEditorProps, type WorkspaceTextCodec } from './workspace-text-editor.js'
import { WorkspaceGridViewport, type WorkspaceGridColumn, type WorkspaceGridRowHeader, type WorkspaceGridViewportMessages } from './workspace-grid-viewport.js'
import { selectWorkspaceRange, workspaceSelectionFields, type WorkspaceGridCell, type WorkspaceGridSelection } from './workspace-selection.js'
import { WorkspaceToolbar, type WorkspaceToolbarMessages } from './workspace-toolbar.js'
import { useWorkspaceSnapshot } from './workspace-react.js'
import { WorkspaceIngressRecovery, type WorkspaceIngressRecoveryMessages } from './workspace-ingress-recovery.js'
import { WorkspaceFilterEditor, type WorkspaceFilterCodec, type WorkspaceFilterEditorMessages } from './workspace-filter-editor.js'

/** One editor definition per storage field; duplicate display columns cannot
 * silently choose different parsers for the same active input session. */
export type WorkspaceGridEditor = Readonly<{ fieldId: FieldId; label: string; codec: WorkspaceTextCodec; clearInput?: string; resourceTask?: WorkspaceResourceTask }>
export type WorkspaceGridFilter = Readonly<{ columnId: string; label: string; codec: WorkspaceFilterCodec; messages?: WorkspaceFilterEditorMessages }>
export type WorkspaceGridMessages = Readonly<{ recovery: WorkspaceDecisionRecoveryMessages; files: WorkspaceStoredFileMessages; resource: WorkspaceResourceMessages; viewport: WorkspaceGridViewportMessages; editor: WorkspaceTextEditorMessages; toolbar: WorkspaceToolbarMessages; ingress: WorkspaceIngressRecoveryMessages;
    menu: Readonly<{ label: string; copy: string }>;
    fill: Readonly<{ label: string; help: string; failed: string }>;
    sort: Readonly<{ label(column: string): string; priority(position: number): string; describe(direction: 'asc' | 'desc', position: number): string; help: string; failed: string }>;
    selectCell: string; paste: string; clear: string; copyFailed: string; copying: string; copied: string; bulkLabel(count: number): string; inputUnavailable: string; retainedInput: string; targetLabel(column: string, rowNumber: number): string }>
export type WorkspaceDataGridProps = Readonly<{
  workspace: Workspace; viewId: ViewId; caption: ReactNode
  columns: readonly WorkspaceGridColumn[]; editors: readonly WorkspaceGridEditor[]
  filters?: readonly WorkspaceGridFilter[]
  messages?: WorkspaceGridMessages
  locale?: WorkspaceLocale
  serverSnapshot?: WorkspaceSnapshot
  renderActionCandidate?: (task: TaskState, input: OwnedInput) => ReactNode
  rowScope?: ViewPredicate
  rowHeader?: WorkspaceGridRowHeader
  className?: string
}>

/** Selection is transient view state, scoped to the actual owner and view.
 * The active session always determines the editor target, independently of
 * selection, visibility, row order and the presence of the original entity. */
export function WorkspaceDataGrid({ workspace, viewId, caption, columns, editors, filters = [], locale = workspaceEn, messages = locale.grid, serverSnapshot, className, renderActionCandidate, rowScope, rowHeader }: WorkspaceDataGridProps) {
  const observed = useWorkspaceSnapshot(workspace, serverSnapshot)
  const scopeKey = rowScope ? canonicalEncodedValue(ownEncodedValue(rowScope)) : ''
  const snapshot = useMemo(() => rowScope ? { ...observed, view: scopeView(observed.view, observed.projection, workspace.schema, rowScope) } : observed, [observed, workspace, rowScope, scopeKey])
  const copyAttempt = useRef(0)
  const clearing = useRef(new Set<Workspace>())
  type FillGesture = Readonly<{ token: string; workspace: Workspace; viewId: ViewId; scopeKey: string; snapshot: WorkspaceSnapshot;
    axes: FillAxes; source: FillAxes; values: readonly (readonly string[])[]; fillColumns: readonly WorkspaceFillColumn[]; columns: readonly Readonly<{ id: string; fieldId: FieldId }>[] }>
  const fillGesture = useRef<FillGesture | null>(null)
  const [fill, setFill] = useState<FillGesture | null>(null)
  const [fillFailure, setFillFailure] = useState<Workspace | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<{ workspace: Workspace; kind: 'pending' | 'copied' | 'failed' } | null>(null)
  const sorting = useRef(new Set<Workspace>())
  const [sortFeedback, setSortFeedback] = useState<{ workspace: Workspace; version: number; pending: boolean; failed: boolean } | null>(null)
  const sortingDisabled = snapshot.capabilities.close.lifecycle !== 'open' || snapshot.ingress.pending.length > 0
    || (snapshot.storage !== null && snapshot.storage.kind !== 'idle') || snapshot.recovery.running
    || (sortFeedback?.workspace === workspace && sortFeedback.pending)
  async function toggleSort(fieldId: FieldId, additive: boolean) {
    if (sorting.current.has(workspace) || sortingDisabled) return
    const view = snapshot.state.view, previous = view.sort.find(sort => sort.fieldId === fieldId)
    const direction = previous?.direction === 'asc' ? 'desc' : previous?.direction === 'desc' ? null : 'asc'
    const sort = additive ? [...view.sort] : []
    const index = sort.findIndex(entry => entry.fieldId === fieldId)
    if (index >= 0) { if (direction) sort[index] = { fieldId, direction }; else sort.splice(index, 1) }
    else if (direction) sort.push({ fieldId, direction })
    sorting.current.add(workspace)
    setSortFeedback({ workspace, version: view.version, pending: true, failed: false })
    let failed = true
    try { failed = (await workspace.dispatch({ kind: 'view-query-set', expectedVersion: view.version, filters: view.filters, sort })).kind !== 'accepted' }
    catch { /* Keep the prior query and any retained command owned by Workspace. */ }
    finally {
      sorting.current.delete(workspace)
      setSortFeedback(previous => previous?.workspace === workspace && previous.version === view.version
        ? { workspace, version: view.version, pending: false, failed } : previous)
    }
  }
  const [selection, setSelection] = useState<Readonly<{ workspace: Workspace; viewId: ViewId; scopeKey: string; range: WorkspaceGridSelection }> | null>(null)
  const [menu, setMenu] = useState<Readonly<{ workspace: Workspace; viewId: ViewId; scopeKey: string; snapshot: WorkspaceSnapshot; columns: typeof columns; editors: typeof editors; selection: typeof selection; cell: WorkspaceGridCell; anchor: WorkspaceMenuAnchor }> | null>(null)
  const definitions = useMemo(() => {
    const result = new Map<FieldId, WorkspaceGridEditor>()
    for (const editor of editors) {
      if (result.has(editor.fieldId) || !workspace.schema.fields.some(field => field.id === editor.fieldId)) throw new Error('Editors require unique fields from the Workspace schema.')
      result.set(editor.fieldId, editor)
    }
    return result
  }, [workspace, editors])
  const visibleEntities = new Set(snapshot.view.rows.map(row => row.entityId))
  const first = snapshot.view.rows[0], firstColumn = columns[0]
  const filterIds = new Set<string>()
  for (const filter of filters) {
    if (!columns.some(column => column.id === filter.columnId) || filterIds.has(filter.columnId)) throw new Error('Filters require unique display columns.')
    filterIds.add(filter.columnId)
  }
  const range = selection?.workspace === workspace && selection.viewId === viewId && selection.scopeKey === scopeKey ? selection.range : null
  const selected = range?.focus ?? (first && firstColumn ? { entityId: first.entityId, columnId: firstColumn.id } : null)
  const column = columns.find(column => column.id === selected?.columnId)
  const selectedField = selected && column && visibleEntities.has(selected.entityId)
    ? { entityId: selected.entityId, fieldId: column.fieldId } : null
  const session = snapshot.state.session
  const selectedFields = range ? workspaceSelectionFields(range, columns) : selectedField ? [selectedField] : null
  const canClear = !session && snapshot.capabilities.close.lifecycle === 'open' && !snapshot.ingress.pending.length
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && !snapshot.recovery.running
    && !!selectedFields?.length && selectedFields.every(field => definitions.get(field.fieldId)?.clearInput !== undefined)
  const candidate = selectedFields?.length && selectedFields.every(field => visibleEntities.has(field.entityId)) ? selectedFields.length === 1 ? { kind: 'cell' as const, field: selectedFields[0]! }
    : { kind: 'bulk' as const, fields: selectedFields } : null
  const target = session ? session.target.kind === 'filter' ? null : session.target : candidate
  const targets = target?.kind === 'cell' ? [target.field] : target?.fields ?? []
  const supported = targets.length > 0 && targets.every(field => definitions.has(field.fieldId))
  const codecs = useMemo(() => new Map([...definitions].map(([id, editor]) => [id, editor.codec])), [definitions])
  const resourceTask = target?.kind === 'cell' ? definitions.get(target.field.fieldId)?.resourceTask : undefined
  const editorLabel = target?.kind === 'bulk' ? messages.bulkLabel(target.fields.length) : targets[0] ? definitions.get(targets[0].fieldId)?.label : null
  const reviewBindings = new Map(workspace.schema.fields.map(binding => [binding.id, binding]))
  const reviewRows = new Map(snapshot.view.rows.map((row, index) => [row.entityId, { row, index }]))
  const reviewColumns = new Map<FieldId, WorkspaceGridColumn>()
  for (const column of columns) if (!reviewColumns.has(column.fieldId)) reviewColumns.set(column.fieldId, column)
  function review(reviewTarget: NonNullable<typeof target>): WorkspaceTextEditorProps['replacement'] {
    const fields = reviewTarget.kind === 'cell' ? [reviewTarget.field] : reviewTarget.fields
    try {
      const values = fields.map(field => {
        const binding = reviewBindings.get(field.fieldId)
        const entry = reviewRows.get(field.entityId), row = entry?.row, editor = definitions.get(field.fieldId)
        const column = reviewColumns.get(field.fieldId)
        if (!binding || binding.readonly || !row?.preview || !editor || !column) throw new Error('The complete target must be reviewable.')
        return { label: messages.targetLabel(column.label, entry!.index + 1), value: (editor.codec.display ?? editor.codec.format)(readDocument(row.preview, binding.path)) }
      })
      return { target: reviewTarget, label: reviewTarget.kind === 'cell' ? values[0]!.label : messages.bulkLabel(fields.length),
        values, revision: snapshot.state.revision }
    } catch { return undefined }
  }
  const replacement = candidate ? review(candidate) : undefined
  const currentReview = target ? review(target) : undefined
  const raw = snapshot.editorInput?.input ?? session?.rawInput
  const observation = serverSnapshot ? { serverSnapshot } : {}
  useEffect(() => {
    if (fill && (session || fill.workspace !== workspace || fill.viewId !== viewId || fill.scopeKey !== scopeKey)) { fillGesture.current = null; setFill(null) }
  }, [fill, session, workspace, viewId, scopeKey])
  const activeFill = !session && fill?.workspace === workspace && fill.viewId === viewId && fill.scopeKey === scopeKey ? fill : null
  const fillSource = activeFill ? { entityId: activeFill.source.rows.at(-1)!, columnId: activeFill.source.columns.at(-1)! } : range ? { entityId: range.rows.at(-1)!, columnId: range.columns.at(-1)! } : selected
  function cancelFill() { fillGesture.current = null; setFill(null) }
  function startFill(): string | null {
    const current = workspace.getSnapshot()
    if (session || current.state.session || current !== observed || !replacement || !supported || !fillSource
      || current.capabilities.close.lifecycle !== 'open' || current.ingress.pending.length || current.storage && current.storage.kind !== 'idle' || current.recovery.running) return null
    const source = range ?? { rows: [fillSource.entityId], columns: [fillSource.columnId] }
    const axes = { rows: snapshot.view.rows.map(row => row.entityId), columns: columns.map(column => column.id) }
    let values: readonly (readonly string[])[]
    try {
      values = Object.freeze(source.rows.map(entityId => Object.freeze(source.columns.map(columnId => {
        const column = columns.find(column => column.id === columnId)!, binding = reviewBindings.get(column.fieldId)!
        return definitions.get(column.fieldId)!.codec.format(readDocument(reviewRows.get(entityId)!.row.preview!, binding.path))
      }))))
      expandWorkspaceFill(axes, source, values, fillSource)
    } catch { setFillFailure(workspace); return null }
    const gesture: FillGesture = { token: crypto.randomUUID(), workspace, viewId, scopeKey, snapshot: current, axes, source, values,
      fillColumns: Object.freeze(columns.flatMap(column => { const codec = definitions.get(column.fieldId)?.codec
        return codec ? [Object.freeze({ id: column.id, fieldId: column.fieldId, codec, ...(column.fill ? { fill: column.fill } : {}) })] : [] })),
      columns: Object.freeze(columns.map(column => Object.freeze({ id: column.id, fieldId: column.fieldId }))) }
    fillGesture.current = gesture; setFill(gesture); setFillFailure(null)
    return gesture.token
  }
  async function finishFill(cell: WorkspaceGridCell, token: string) {
    const gesture = fillGesture.current
    if (!gesture || gesture.token !== token || gesture.workspace !== workspace || gesture.viewId !== viewId || gesture.scopeKey !== scopeKey) return
    cancelFill()
    try {
      const expanded = resolveWorkspaceFill(gesture.axes, gesture.source, gesture.values, cell, gesture.fillColumns,
        new Map(gesture.snapshot.projection.rows.flatMap(row => row.preview ? [[row.entityId, row.preview] as const] : [])))
      const fields = workspaceSelectionFields(expanded, gesture.columns)!
      const layout = { rows: expanded.rows, columns: expanded.columns.map(id => ({ columnId: id, fieldId: gesture.columns.find(column => column.id === id)!.fieldId })) }
      // Retain the literal pattern and fixed destination even if the gesture's
      // revision expired. Workspace ingress owns a rejected stale request.
      await workspace.dispatch({ kind: 'session-opened', revision: gesture.snapshot.state.revision,
        sessionId: kernelId<'session'>(crypto.randomUUID()), inputId: kernelId<'input'>(crypto.randomUUID()), viewId,
        target: fields.length === 1 ? { kind: 'cell', field: fields[0]! } : { kind: 'bulk', fields },
        reads: expanded.readEntities.map(entityId => ({ kind: 'entity', entityId })),
        input: { kind: 'encoded', value: { format: 'workspace-matrix:1', text: encodeMatrix(expanded.values), layout } } })
    } catch { setFillFailure(workspace) }
  }
  const activeMenu = menu?.workspace === workspace && menu.viewId === viewId && menu.scopeKey === scopeKey
    && menu.snapshot === observed && menu.columns === columns && menu.editors === editors && menu.selection === selection ? menu : null
  const menuAxes = activeMenu ? range && range.rows.includes(activeMenu.cell.entityId) && range.columns.includes(activeMenu.cell.columnId) ? range
    : { rows: [activeMenu.cell.entityId], columns: [activeMenu.cell.columnId] } : null
  const menuFields = menuAxes && workspaceSelectionFields(menuAxes, columns)
  const menuTarget = menuFields?.length ? menuFields.length === 1 ? { kind: 'cell' as const, field: menuFields[0]! } : { kind: 'bulk' as const, fields: menuFields } : null
  const menuCanEdit = !session && snapshot.capabilities.close.lifecycle === 'open' && !snapshot.ingress.pending.length
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && !snapshot.recovery.running && !!menuTarget && !!review(menuTarget)
  let menuEditText: string | null = null
  if (menuCanEdit && menuTarget?.kind === 'cell') {
    const field = menuTarget.field, binding = reviewBindings.get(field.fieldId)!, row = reviewRows.get(field.entityId)!.row
    try { menuEditText = definitions.get(field.fieldId)!.codec.format(readDocument(row.preview!, binding.path)) }
    catch { /* This codec cannot author the current value; do not open a lossy input. */ }
  }
  function closeMenu(restoreFocus: boolean) {
    setMenu(null)
    if (restoreFocus && activeMenu?.anchor.element.isConnected) activeMenu.anchor.element.focus()
  }
  function editFromMenu() {
    if (!activeMenu || !menuCanEdit || !menuTarget) return
    if (menuTarget.kind === 'bulk') {
      const text = copyMatrix(activeMenu.cell)
      if (text !== null) void openMatrix(text, activeMenu.cell)
    } else if (menuEditText !== null) void openInput(menuTarget, { kind: 'encoded', value: menuEditText })
  }
  function copyMatrix(cell: WorkspaceGridCell): string | null {
    copyAttempt.current++
    // Preserve captured membership/order, including filtered-out members. A
    // deleted row or removed codec rejects the whole copy, never a partial TSV.
    const axes = range && range.rows.includes(cell.entityId) && range.columns.includes(cell.columnId)
      ? range : { rows: [cell.entityId], columns: [cell.columnId] }
    try {
      const rows = new Map(snapshot.projection.rows.map(row => [row.entityId, row]))
      const text = encodeMatrix(axes.rows.map(entityId => axes.columns.map(columnId => {
        const row = rows.get(entityId), column = columns.find(column => column.id === columnId)
        const binding = column && reviewBindings.get(column.fieldId), codec = column && codecs.get(column.fieldId)
        if (!row?.preview || !binding || !codec) throw new Error('The complete selection cannot be copied.')
        return codec.format(readDocument(row.preview, binding.path))
      })))
      setCopyFeedback(null)
      return text
    } catch { setCopyFeedback({ workspace, kind: 'failed' }); return null }
  }
  async function copyShortcut(cell: WorkspaceGridCell) {
    const text = copyMatrix(cell)
    if (text === null) return
    const attempt = copyAttempt.current
    setCopyFeedback({ workspace, kind: 'pending' })
    try {
      await navigator.clipboard.writeText(text)
      if (copyAttempt.current === attempt) setCopyFeedback({ workspace, kind: 'copied' })
    } catch { if (copyAttempt.current === attempt) setCopyFeedback({ workspace, kind: 'failed' }) }
  }
  async function clearSelection(cell?: WorkspaceGridCell) {
    const current = workspace.getSnapshot()
    if (clearing.current.has(workspace) || session || current.state.session || current.capabilities.close.lifecycle !== 'open'
      || current.ingress.pending.length || current.storage && current.storage.kind !== 'idle' || current.recovery.running) return
    const origin = cell ?? selected
    const axes = range && (!cell || range.rows.includes(cell.entityId) && range.columns.includes(cell.columnId)) ? range
      : origin ? { rows: [origin.entityId], columns: [origin.columnId] } : null
    if (!axes) return
    const fields = workspaceSelectionFields(axes, columns)
    if (!fields?.length || !fields.every(field => visibleEntities.has(field.entityId) && definitions.get(field.fieldId)?.clearInput !== undefined)) return
    const clearTarget = fields.length === 1 ? { kind: 'cell' as const, field: fields[0]! } : { kind: 'bulk' as const, fields }
    if (!review(clearTarget)) return
    // Clear is an explicitly configured authoring input, not an inferred null,
    // zero or field deletion. The normal retained matrix session owns review,
    // validation, application and eventual save/undo.
    clearing.current.add(workspace)
    try {
      if (clearTarget.kind === 'cell') await openInput(clearTarget, { kind: 'encoded', value: definitions.get(clearTarget.field.fieldId)!.clearInput! })
      else {
        const text = encodeMatrix(axes.rows.map(() => axes.columns.map(id => {
          const column = columns.find(column => column.id === id)!
          return definitions.get(column.fieldId)!.clearInput!
        })))
        await openMatrix(text, cell)
      }
    } finally { clearing.current.delete(workspace) }
  }
  async function openMatrix(text: string, cell?: WorkspaceGridCell) {
    const selectedRange = range && (!cell || range.rows.includes(cell.entityId) && range.columns.includes(cell.columnId)) ? range : null
    const origin = cell ?? selected
    const axes = selectedRange ?? (origin ? { rows: [origin.entityId], columns: [origin.columnId] } : null)
    if (!axes) return
    // A removed display binding must reject the whole request while retaining
    // its text and unresolved layout, rather than dropping that matrix column.
    const fields = workspaceSelectionFields(axes, columns) ?? []
    const layout = { rows: axes.rows, columns: axes.columns.map(columnId => ({ columnId, fieldId: columns.find(column => column.id === columnId)?.fieldId ?? null })) }
    await openInput(fields.length === 1 ? { kind: 'cell', field: fields[0]! } : { kind: 'bulk', fields },
      { kind: 'encoded', value: { format: 'workspace-matrix:1', text, layout } })
  }
  async function openInput(target: Extract<SessionTarget, { kind: 'cell' | 'bulk' }>, input: OwnedInput) {
    await workspace.dispatch({ kind: 'session-opened', revision: snapshot.state.revision,
      sessionId: kernelId<'session'>(crypto.randomUUID()), inputId: kernelId<'input'>(crypto.randomUUID()),
      viewId, target, reads: [], input })
  }
  return <div className={['business-grid__workspace', className].filter(Boolean).join(' ')}>
    {activeFill ? <p role="status" className="business-grid__fill-status">{messages.fill.help}</p> : null}
    {fillFailure === workspace ? <p role="alert">{messages.fill.failed}</p> : null}
    {copyFeedback?.workspace === workspace ? <p role={copyFeedback.kind === 'failed' ? 'alert' : 'status'}>{copyFeedback.kind === 'failed' ? messages.copyFailed : copyFeedback.kind === 'pending' ? messages.copying : messages.copied}</p> : null}
    <div className="business-grid__workspace-actions">
      <WorkspaceToolbar workspace={workspace} messages={messages.toolbar} {...observation}
        renderAdditionalActions={actions => activeMenu ? <WorkspaceContextMenu anchor={activeMenu.anchor} label={messages.menu.label} close={closeMenu} isCurrent={() => workspace.getSnapshot() === activeMenu.snapshot}
          actions={[
            { id: 'edit', label: messages.editor.edit, disabled: !menuCanEdit || menuTarget?.kind === 'cell' && menuEditText === null, run: editFromMenu },
            { id: 'copy', label: messages.menu.copy, disabled: false, run: () => { void copyShortcut(activeMenu.cell) } },
            { id: 'paste', label: messages.paste, disabled: !menuCanEdit, run: () => { void openMatrix('', activeMenu.cell) } },
            { id: 'clear', label: messages.clear, disabled: !menuCanEdit || !menuFields?.every(field => definitions.get(field.fieldId)?.clearInput !== undefined), run: () => { void clearSelection(activeMenu.cell) } },
            ...actions,
          ]} /> : null} />
      {!session && candidate ? <button type="button" disabled={!supported || !replacement || snapshot.capabilities.close.lifecycle !== 'open'} onClick={() => openMatrix('')}>{messages.paste}</button> : null}
      {!session && candidate && editors.some(editor => editor.clearInput !== undefined) ? <button type="button" disabled={!canClear || !replacement || snapshot.capabilities.close.lifecycle !== 'open'} onClick={() => { void clearSelection() }}>{messages.clear}</button> : null}
      <button type="button" disabled={!!session || !replacement || !supported} aria-pressed={!!activeFill}
        onClick={event => { if (activeFill) cancelFill(); else if (startFill()) event.currentTarget.closest('.business-grid__workspace')?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus() }}>{messages.fill.label}</button>
    </div>
    <WorkspaceTaskRecovery {...(renderActionCandidate ? { renderActionCandidate } : {})} workspace={workspace} snapshot={snapshot} viewId={viewId} messages={messages.resource} {...(supported && currentReview ? { review: currentReview } : {})} />
    <WorkspaceDecisionRecovery workspace={workspace} snapshot={snapshot} viewId={viewId} {...(supported && replacement ? { target: replacement } : {})} messages={messages.recovery} resourceMessages={messages.resource} />
    <WorkspaceStoredFiles workspace={workspace} snapshot={snapshot} messages={messages.files} />
    <WorkspaceIngressRecovery workspace={workspace} messages={messages.ingress} {...observation} />
    {filters.map(filter => <WorkspaceFilterEditor key={filter.columnId} workspace={workspace} viewId={viewId} {...filter} messages={filter.messages ?? locale.filter} {...observation} />)}
    {columns.some(column => column.sortable) ? <p>{messages.sort.help}</p> : null}
    {sortFeedback?.workspace === workspace && sortFeedback.failed && sortFeedback.version === snapshot.state.view.version ? <p role="alert">{messages.sort.failed}</p> : null}
    <WorkspaceGridViewport {...(rowHeader ? { rowHeader } : {})} {...(rowScope ? { rowScope } : {})} workspace={workspace} caption={caption} columns={columns} messages={messages.viewport} {...observation}
      fill={{ source: fillSource, enabled: !session && !!replacement && supported, token: activeFill?.token ?? null,
        start: startFill, cancel: cancelFill, drop: (cell, token) => { void finishFill(cell, token) } }}
      sorting={{ sort: snapshot.state.view.sort, disabled: sortingDisabled, label: messages.sort.label, priority: messages.sort.priority,
        describe: messages.sort.describe,
        toggle: (fieldId, additive) => { void toggleSort(fieldId, additive) } }}
      interaction={{ selected, onContextMenu: (cell, anchor) => setMenu({ workspace, viewId, scopeKey, snapshot: observed, columns, editors, selection, cell, anchor }), onClear: cell => { void clearSelection(cell) }, onCopyShortcut: cell => { void copyShortcut(cell) }, onCopy: copyMatrix, onPaste: (cell, text) => { void openMatrix(text, cell) }, members: range ?? { rows: selected ? [selected.entityId] : [], columns: selected ? [selected.columnId] : [] }, onSelectExtent: (extent, cell) => {
        const rows = snapshot.view.rows.map(row => row.entityId), ids = columns.map(column => column.id)
        if (!rows.length || !ids.length) return
        const anchor = { entityId: extent === 'row' ? cell.entityId : rows[0]!, columnId: extent === 'column' ? cell.columnId : ids[0]! }
        const focus = { entityId: extent === 'row' ? cell.entityId : rows.at(-1)!, columnId: extent === 'column' ? cell.columnId : ids.at(-1)! }
        setSelection({ workspace, viewId, scopeKey, range: { ...selectWorkspaceRange(rows, ids, focus, anchor), focus: cell } })
      }, onSelect: (cell, extend) => {
        const next = selectWorkspaceRange(snapshot.view.rows.map(row => row.entityId), columns.map(column => column.id), cell, extend ? range?.anchor ?? selected ?? cell : cell)
        setSelection({ workspace, viewId, scopeKey, range: next })
      } }} />
    {target && supported && editorLabel ? <WorkspaceTextEditor workspace={workspace} viewId={viewId} target={target} label={editorLabel} codecs={codecs} messages={messages.editor} {...(resourceTask ? { resource: { task: resourceTask, messages: messages.resource } } : {})} {...observation} {...(replacement ? { replacement } : {})} {...(currentReview ? { currentReview } : {})} />
      : session?.target.kind === 'filter' && filterIds.has(session.target.columnId) ? null : session ? <section aria-label={messages.retainedInput}>
        <p role="alert">{messages.inputUnavailable}</p>
        {raw?.kind === 'encoded' ? <textarea aria-label={messages.retainedInput} readOnly value={typeof raw.value === 'string' ? raw.value : canonicalEncodedValue(raw.value)} /> : null}
      </section> : <p>{messages.selectCell}</p>}
  </div>
}
