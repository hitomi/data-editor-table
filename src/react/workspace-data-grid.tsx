import { fieldResolutionIssues } from '../kernel/field-resolution.js'
import { prepareWorkspaceRestore, workspaceRestoreWrites, prepareWorkspaceRowRestore, workspaceRestoreRows } from './workspace-restore.js'
import { WorkspaceDirtyCell, type WorkspaceDirtyMessages } from './workspace-dirty-cell.js'
import { workspaceChangeCount } from './workspace-summary.js'
import { retainsWorkspacePointerInput } from './workspace-pointer-ownership.js'
import { workspaceSelectionSummary } from './workspace-selection.js'
import { WorkspaceChoiceCell } from './workspace-choice-cell.js'
import { emptyBulkInput } from './workspace-bulk-editor.js'
import { beginChoiceBulk } from './workspace-choice-bulk.js'
import { WorkspaceSearch } from './workspace-search.js'
import { createStandardFilterCodec } from '../filter-codecs.js'
import { WorkspaceDecisionRecovery, type WorkspaceDecisionRecoveryMessages } from './workspace-decision-recovery.js'
import { WorkspaceContextMenu, type WorkspaceMenuAnchor } from './workspace-context-menu.js'
import { expandWorkspaceFill, resolveWorkspaceFill, type WorkspaceFillColumn, type FillAxes } from './workspace-fill.js'
import { WorkspaceStoredFiles, type WorkspaceStoredFileMessages } from './workspace-stored-files.js'
import { projectView, scopeView } from '../kernel/view.js'
import { clipboardFits, resolveOperationLimits, decodeMatrix, encodeMatrix, readMatrixInput } from '../clipboard.js'
import { WorkspaceTaskRecovery } from './workspace-task-recovery.js'
import { assertResourceTask, resourceFileError, type WorkspaceResourceMessages, type WorkspaceResourceTask } from './workspace-resource-input.js'
import { workspaceEn } from '../locales/workspace-en.js'
import type { WorkspaceLocale } from '../locales/workspace-contracts.js'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { canonicalEncodedValue, encodedValuesEqual, ownEncodedValue, readDocument, resourceValuesEqual } from '../kernel/document.js'
import { kernelId, type FieldId, type FieldRef, type InputRef, type ViewId, type SessionTarget, type SessionCreation, type OwnedInput, type TaskState, type ViewPredicate } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import { WorkspaceTextEditor, type WorkspaceTextEditorMessages, type WorkspaceTextEditorProps, type WorkspaceTextCodec } from './workspace-text-editor.js'
import { WorkspaceGridViewport, type WorkspaceGridColumn, type WorkspaceGridRowHeader, type WorkspaceGridViewportMessages } from './workspace-grid-viewport.js'
import { selectWorkspaceRange, updateWorkspaceSelection, workspaceSelectionContains, workspaceSelectionEnvelope, workspaceSelectionSetFields, workspaceSelectionFields, type WorkspaceSelectionSet, type WorkspaceGridCell, type WorkspaceGridSelection } from './workspace-selection.js'
import { WorkspaceToolbar, type WorkspaceToolbarMessages } from './workspace-toolbar.js'
import { useWorkspaceSnapshot } from './workspace-react.js'
import { WorkspaceIngressRecovery, type WorkspaceIngressRecoveryMessages } from './workspace-ingress-recovery.js'
import { WorkspaceFilterEditor, type WorkspaceFilterCodec, type WorkspaceFilterEditorMessages } from './workspace-filter-editor.js'

/** One editor definition per storage field; duplicate display columns cannot
 * silently choose different parsers for the same active input session. */
export type WorkspaceGridEditor = Readonly<{ fieldId: FieldId; label: string; codec: WorkspaceTextCodec; clearInput?: string; resourceTask?: WorkspaceResourceTask }>
export type WorkspaceGridFilter = Readonly<{ columnId: string; label: string; codec: WorkspaceFilterCodec; messages?: WorkspaceFilterEditorMessages }>
export type WorkspaceGridMessages = Readonly<{ dirty: WorkspaceDirtyMessages; recovery: WorkspaceDecisionRecoveryMessages; files: WorkspaceStoredFileMessages; resource: WorkspaceResourceMessages; viewport: WorkspaceGridViewportMessages; editor: WorkspaceTextEditorMessages; toolbar: WorkspaceToolbarMessages; ingress: WorkspaceIngressRecoveryMessages;
    menu: Readonly<{ label: string; copy: string; restoreCell: string; restoreSelection: string; restoreRow: string; useRemoteCell: string; keepLocalCell: string; useRemoteRow: string; keepLocalRow: string; conflictFailed: string }>;
    fill: Readonly<{ label: string; help: string; failed: string }>;
    sort: Readonly<{ label(column: string): string; priority(position: number): string; describe(direction: 'asc' | 'desc', position: number): string; help: string; failed: string }>;
    summary: Readonly<{ invalid(count: number): string; conflicts(count: number): string; blocked(count: number): string; reviewCell: string; label: string; changed(count: number): string; rows(visible: number, total: number): string; selection(rows: number, columns: number, cells: number): string }>;
    search: string; selectCell: string; paste: string; preparePasteRows: string; clear: string; copyFailed: string; limitExceeded: string; copying: string; copied: string; bulkLabel(count: number): string; inputUnavailable: string; retainedInput: string; targetLabel(column: string, rowNumber: number): string }>
export type WorkspaceDataGridProps = Readonly<{
  workspace: Workspace; viewId: ViewId; caption: ReactNode
  columns: readonly WorkspaceGridColumn[]; editors: readonly WorkspaceGridEditor[]
  filters?: readonly WorkspaceGridFilter[]
  maxClipboardBytes?: number
  maxMutations?: number
  createRow?: () => Omit<SessionCreation, 'entityId'>
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
const emptyFilters: readonly WorkspaceGridFilter[] = Object.freeze([])

export function WorkspaceDataGrid({ workspace, viewId, caption, columns, editors, filters: customFilters = emptyFilters, createRow, maxClipboardBytes, maxMutations, locale = workspaceEn, messages = locale.grid, serverSnapshot, className, renderActionCandidate, rowScope, rowHeader }: WorkspaceDataGridProps) {
  const limits = resolveOperationLimits({ maxClipboardBytes, maxMutations })
  const [limitFailure, setLimitFailure] = useState<Workspace | null>(null)
  const observed = useWorkspaceSnapshot(workspace, serverSnapshot)
  useEffect(() => {
    const protectPendingInput = (event: BeforeUnloadEvent) => {
      // Read the owner at the event boundary: React may not yet have rendered
      // the input received by the preceding paste/keyboard event. A queued
      // request is runtime-owned, not a promise that it has reached storage.
      const current = workspace.getSnapshot()
      if (!current.ingress.pending.some(entry => entry.phase === 'queued' || entry.phase === 'committing' || entry.phase === 'uncertain')) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protectPendingInput)
    return () => window.removeEventListener('beforeunload', protectPendingInput)
  }, [workspace])
  const scopeKey = rowScope ? canonicalEncodedValue(ownEncodedValue(rowScope)) : ''
  const snapshot = useMemo(() => {
    const view = projectView(observed.state, workspace.schema, observed.projection, viewId)
    return { ...observed, view: rowScope ? scopeView(view, observed.projection, workspace.schema, rowScope) : view }
  }, [observed, workspace, viewId, rowScope, scopeKey])
  const [fileFailure, setFileFailure] = useState<{ workspace: Workspace; message: string } | null>(null)
  const [editFailure, setEditFailure] = useState<Workspace | null>(null)
  const [openingEditor, setOpeningEditor] = useState<{ workspace: Workspace; viewId: ViewId; selectOnFocus: boolean; autoApply: boolean; autoApplyInput?: InputRef; fillSelection?: NonNullable<ReturnType<typeof selectWorkspaceRange>>; writer: ReturnType<Workspace['beginEditing']> } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const [editorActionContainer, setEditorActionContainer] = useState<HTMLDivElement | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const pickerOwner = useRef<{ workspace: Workspace; viewId: ViewId; scopeKey: string; cell: WorkspaceGridCell; fieldId: FieldId; task: WorkspaceResourceTask } | null>(null)
  useEffect(() => {
    const input = filePicker.current
    const cancel = () => { pickerOwner.current = null }
    input?.addEventListener('cancel', cancel)
    return () => input?.removeEventListener('cancel', cancel)
  }, [])
  const openingCell = useRef(false)
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
    const view = snapshot.view.query, previous = view.sort.find(sort => sort.fieldId === fieldId)
    const direction = previous?.direction === 'asc' ? 'desc' : previous?.direction === 'desc' ? null : 'asc'
    const sort = additive ? [...view.sort] : []
    const index = sort.findIndex(entry => entry.fieldId === fieldId)
    if (index >= 0) { if (direction) sort[index] = { fieldId, direction }; else sort.splice(index, 1) }
    else if (direction) sort.push({ fieldId, direction })
    sorting.current.add(workspace)
    setSortFeedback({ workspace, version: view.version, pending: true, failed: false })
    let failed = true
    try { failed = (await workspace.dispatch({ kind: 'view-query-set', viewId, expectedVersion: view.version, filters: view.filters, sort })).kind !== 'accepted' }
    catch { /* Keep the prior query and any retained command owned by Workspace. */ }
    finally {
      sorting.current.delete(workspace)
      setSortFeedback(previous => previous?.workspace === workspace && previous.version === view.version
        ? { workspace, version: view.version, pending: false, failed } : previous)
    }
  }
  const [selection, setSelection] = useState<Readonly<{ workspace: Workspace; viewId: ViewId; scopeKey: string; range: WorkspaceGridSelection; set: WorkspaceSelectionSet }> | null>(null)
  const [menu, setMenu] = useState<Readonly<{ workspace: Workspace; viewId: ViewId; scopeKey: string; snapshot: WorkspaceSnapshot; columns: typeof columns; editors: typeof editors; selection: typeof selection; cell: WorkspaceGridCell; anchor: WorkspaceMenuAnchor }> | null>(null)
  const definitions = useMemo(() => {
    const result = new Map<FieldId, WorkspaceGridEditor>()
    for (const editor of editors) {
      if (editor.resourceTask) assertResourceTask(editor.resourceTask)
      if (result.has(editor.fieldId) || !workspace.schema.fields.some(field => field.id === editor.fieldId)) throw new Error('Editors require unique fields from the Workspace schema.')
      result.set(editor.fieldId, editor)
    }
    return result
  }, [workspace, editors])
  const visibleEntities = new Set(snapshot.view.rows.map(row => row.entityId))
  const filters = useMemo(() => columns.flatMap(column => {
    const custom = customFilters.find(filter => filter.columnId === column.id)
    if (custom) return [custom]
    const editor = definitions.get(column.fieldId)
    const codec = editor && createStandardFilterCodec(column.fieldId, editor.codec, locale.filter.conditions, { image: !!editor.resourceTask })
    return codec ? [{ columnId: column.id, label: locale.filter.conditions.fieldLabel(column.label), codec }] : []
  }), [columns, customFilters, definitions, locale])
  const filterIds = new Set<string>()
  for (const filter of customFilters) {
    if (!columns.some(column => column.id === filter.columnId) || filterIds.has(filter.columnId)) throw new Error('Filters require unique display columns.')
    filterIds.add(filter.columnId)
  }
  for (const filter of filters) filterIds.add(filter.columnId)
  const range = selection?.workspace === workspace && selection.viewId === viewId && selection.scopeKey === scopeKey ? selection.range : null
  const rangeSet = range && selection ? selection.set : null
  const ranges = rangeSet?.ranges ?? []
  const selected = range?.focus ?? null
  const changedCount = workspaceChangeCount(snapshot.projection, workspace.schema, columns, snapshot.view, rowScope)
  const summaryRows = rowScope ? scopeView({ ...snapshot.view, rows: snapshot.projection.rows.map(row => ({ ...row, preview: row.preview ?? row.authority })) },
    snapshot.projection, workspace.schema, rowScope).rows : snapshot.projection.rows
  const invalidRows = summaryRows.filter(row => row.issues.some(issue => issue.code === 'schema-invalid' || issue.code === 'schema-validation-failed')).length
  const conflictRows = summaryRows.filter(row => row.issues.some(issue => ['write-conflict', 'target-deleted', 'create-key-collision', 'semantic-read-changed'].includes(issue.code))).length
  const blockedRows = summaryRows.filter(row => row.issues.length && !row.issues.some(issue =>
    ['schema-invalid', 'schema-validation-failed', 'write-conflict', 'target-deleted', 'create-key-collision', 'semantic-read-changed'].includes(issue.code))).length
  const selectionSummary = workspaceSelectionSummary(ranges.length ? ranges : selected ? [{ rows: [selected.entityId], columns: [selected.columnId] }] : [],
    snapshot.view.rows.map(row => row.entityId), columns.map(column => column.id))
  const column = columns.find(column => column.id === selected?.columnId)
  const selectedField = selected && column && visibleEntities.has(selected.entityId)
    ? { entityId: selected.entityId, fieldId: column.fieldId } : null
  const session = snapshot.state.session
  const selectedFields = range ? workspaceSelectionSetFields(ranges, columns) : selectedField ? [selectedField] : null
  const canClear = !session && snapshot.capabilities.close.lifecycle === 'open' && !snapshot.ingress.pending.length
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && !snapshot.recovery.running
    && !!selectedFields?.length && selectedFields.every(field => definitions.get(field.fieldId)?.clearInput !== undefined)
  const candidate = selectedFields?.length && selectedFields.every(field => visibleEntities.has(field.entityId)) ? selectedFields.length === 1 ? { kind: 'cell' as const, field: selectedFields[0]! }
    : { kind: 'bulk' as const, fields: selectedFields } : null
  const opening = openingEditor?.workspace === workspace && openingEditor.viewId === viewId ? openingEditor : null
  const pendingEditor = opening && !session && snapshot.ingress.pending.some(entry => entry.payload.kind === 'input' ? entry.payload.envelope.lease.sessionId === opening.writer.sessionId : entry.payload.kind === 'event' && entry.payload.event.kind === 'session-opened' && entry.payload.event.sessionId === opening.writer.sessionId) ? opening.writer : null
  const target: Extract<SessionTarget, { kind: 'cell' | 'bulk' }> | null = session ? session.target.kind === 'filter' ? null : session.target : pendingEditor?.target.kind === 'cell' || pendingEditor?.target.kind === 'bulk' ? pendingEditor.target : candidate
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
        const creations = reviewTarget.kind === 'bulk' ? reviewTarget.creations ?? [] : []
        const creationIndex = creations.findIndex(creation => creation.entityId === field.entityId)
        const document = row?.preview ?? creations[creationIndex]?.document
        const column = reviewColumns.get(field.fieldId)
        if (!binding || binding.readonly || !document || !editor || !column) throw new Error('The complete target must be reviewable.')
        return { label: messages.targetLabel(column.label, (entry?.index ?? snapshot.view.rows.length + creationIndex) + 1), value: (editor.codec.display ?? editor.codec.format)(readDocument(document, binding.path)) }
      })
      return { target: reviewTarget, label: reviewTarget.kind === 'cell' ? values[0]!.label : messages.bulkLabel(fields.length),
        values, revision: snapshot.state.revision }
    } catch { return undefined }
  }
  const replacement = candidate ? review(candidate) : undefined
  const currentReview = target ? review(target) : undefined
  const raw = snapshot.editorInput?.input ?? session?.rawInput ?? pendingEditor?.read()
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
    if (gesture.source.rows.includes(cell.entityId) && gesture.source.columns.includes(cell.columnId)) return
    try {
      const expanded = resolveWorkspaceFill(gesture.axes, gesture.source, gesture.values, cell, gesture.fillColumns,
        new Map(gesture.snapshot.projection.rows.flatMap(row => row.preview ? [[row.entityId, row.preview] as const] : [])))
      const fields = workspaceSelectionFields(expanded, gesture.columns)!
      const layout = { rows: expanded.rows, columns: expanded.columns.map(id => ({ columnId: id, fieldId: gesture.columns.find(column => column.id === id)!.fieldId })) }
      // Retain the literal pattern and fixed destination even if the gesture's
      // revision expired. Workspace ingress owns a rejected stale request.
      const writer = workspace.beginEditing({ kind: 'session-opened', revision: gesture.snapshot.state.revision,
        sessionId: kernelId<'session'>(crypto.randomUUID()), inputId: kernelId<'input'>(crypto.randomUUID()), viewId,
        target: fields.length === 1 ? { kind: 'cell', field: fields[0]! } : { kind: 'bulk', fields },
        reads: expanded.readEntities.map(entityId => ({ kind: 'entity', entityId })),
        input: { kind: 'encoded', value: { format: 'workspace-matrix:1', text: encodeMatrix(expanded.values), layout } } })
      const fillSelection = selectWorkspaceRange(gesture.axes.rows, gesture.axes.columns, { entityId: expanded.rows[0]!, columnId: expanded.columns[0]! }, { entityId: expanded.rows.at(-1)!, columnId: expanded.columns.at(-1)! })!
      setOpeningEditor({ workspace, viewId, writer, autoApply: true, selectOnFocus: false, fillSelection })
      const result = await writer.result
      if (result.kind !== 'accepted') setOpeningEditor(current => current?.writer === writer ? null : current)
    } catch { setFillFailure(workspace) }
  }
  const activeMenu = menu?.workspace === workspace && menu.viewId === viewId && menu.scopeKey === scopeKey
    && menu.snapshot === observed && menu.columns === columns && menu.editors === editors && menu.selection === selection ? menu : null
  const menuAxes = activeMenu ? rangeSet && workspaceSelectionContains(ranges, activeMenu.cell) ? (ranges.length === 1 ? range! : workspaceSelectionEnvelope(rangeSet))
    : { rows: [activeMenu.cell.entityId], columns: [activeMenu.cell.columnId] } : null
  const menuFields = menuAxes && (activeMenu && workspaceSelectionContains(ranges, activeMenu.cell) ? workspaceSelectionSetFields(ranges, columns) : workspaceSelectionFields(menuAxes, columns))
  const menuTarget = menuFields?.length ? menuFields.length === 1 ? { kind: 'cell' as const, field: menuFields[0]! } : { kind: 'bulk' as const, fields: menuFields } : null
  const menuCanEdit = !session && snapshot.capabilities.close.lifecycle === 'open' && !snapshot.ingress.pending.length
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && !snapshot.recovery.running && !!menuTarget && !!review(menuTarget)
  const [restoreFailure, setRestoreFailure] = useState<Workspace | null>(null)
  function canRestore(fields: readonly FieldRef[] | null | undefined) {
    if (session || snapshot.capabilities.close.lifecycle !== 'open' || snapshot.ingress.pending.length
      || snapshot.storage && snapshot.storage.kind !== 'idle' || snapshot.recovery.running || !fields?.length) return false
    try { const count = workspaceRestoreWrites(workspace, snapshot, fields).length; return count > 0 && count <= limits.maxMutations } catch { return false }
  }
  async function restoreFields(fields: readonly FieldRef[], label: string) {
    try {
      if (workspaceRestoreWrites(workspace, workspace.getSnapshot(), fields).length > limits.maxMutations) { setLimitFailure(workspace); return }
      const prepared = prepareWorkspaceRestore(workspace, workspace.getSnapshot(), fields, label)
      const result = await workspace.dispatch({ kind: 'prepared-action', prepared })
      setRestoreFailure(result.kind === 'accepted' ? null : workspace)
    } catch { setRestoreFailure(workspace) }
  }
  let canRestoreRow = false
  if (activeMenu && !session && !snapshot.ingress.pending.length && snapshot.capabilities.close.lifecycle === 'open'
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && !snapshot.recovery.running) {
    try { canRestoreRow = workspaceRestoreRows(workspace, snapshot, [activeMenu.cell.entityId]).length > 0 } catch { /* Unavailable rows require explicit recovery. */ }
  }
  async function restoreMenuRow() {
    if (!activeMenu || !canRestoreRow) return
    try {
      if (workspaceRestoreRows(workspace, workspace.getSnapshot(), [activeMenu.cell.entityId]).length > limits.maxMutations) { setLimitFailure(workspace); return }
      const prepared = prepareWorkspaceRowRestore(workspace, workspace.getSnapshot(), [activeMenu.cell.entityId], messages.menu.restoreRow)
      const result = await workspace.dispatch({ kind: 'prepared-action', prepared })
      setRestoreFailure(result.kind === 'accepted' ? null : workspace)
    } catch { setRestoreFailure(workspace) }
  }
  const menuConflictRow = activeMenu && snapshot.projection.rows.find(row => row.entityId === activeMenu.cell.entityId && row.issues.length)
  const menuCellField = activeMenu && columns.find(column => column.id === activeMenu.cell.columnId)
  const menuFieldBinding = menuCellField && reviewBindings.get(menuCellField.fieldId)
  const menuFieldIssues = menuConflictRow && menuFieldBinding ? fieldResolutionIssues(menuConflictRow.issues, menuConflictRow.entityId, menuFieldBinding.path) : []
  const canResolveRow = !!menuConflictRow && !session && !snapshot.ingress.pending.length && snapshot.capabilities.close.lifecycle === 'open'
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && !snapshot.recovery.running && snapshot.state.authority.content.kind === 'complete'
  const [conflictFailure, setConflictFailure] = useState<Workspace | null>(null)
  async function resolveMenuRow(kind: 'use-authority' | 'keep-local', field = false) {
    if (!activeMenu || !menuConflictRow || !canResolveRow) return
    const reviewed = activeMenu.snapshot.state
    if (reviewed.authority.content.kind !== 'complete') return
    const result = await workspace.resolve({ revision: reviewed.revision, observation: reviewed.authority.content.snapshot.observation,
      target: field && menuCellField ? { kind: 'field', entityId: menuConflictRow.entityId, fieldId: menuCellField.fieldId } : { kind: 'row', entityId: menuConflictRow.entityId },
      issueIds: (field ? menuFieldIssues : menuConflictRow.issues).map(issue => issue.id),
      ...(field ? {} : { intentIds: menuConflictRow.intentIds }), choice: { kind } })
    setConflictFailure(result.kind === 'accepted' ? null : workspace)
  }
  const menuCellFields = activeMenu && menuCellField ? [{ entityId: activeMenu.cell.entityId, fieldId: menuCellField.fieldId }] : []
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
      const codec = definitions.get(menuTarget.fields[0]!.fieldId)?.codec
      if (codec?.choices?.multiple && menuTarget.fields.every(field => definitions.get(field.fieldId)?.codec === codec)) {
        try {
          const values = menuTarget.fields.map(field => JSON.parse(codec.format(readDocument(reviewRows.get(field.entityId)!.row.preview!, reviewBindings.get(field.fieldId)!.path))) as string[])
          void openInput(menuTarget, { kind: 'encoded', value: beginChoiceBulk(values, codec.choices) })
        } catch { setEditFailure(workspace) }
        return
      }
      if (codec && menuTarget.fields.every(field => definitions.get(field.fieldId)?.codec === codec && !definitions.get(field.fieldId)?.resourceTask)) {
        void openInput(menuTarget, { kind: 'encoded', value: codec.inputKind === 'text' ? emptyBulkInput : '' })
        return
      }
      const text = copyMatrix(activeMenu.cell)
      if (text !== null) void openMatrix(text, activeMenu.cell)
    } else if (menuEditText !== null) void openInput(menuTarget, { kind: 'encoded', value: menuEditText })
  }
  async function editCell(cell: WorkspaceGridCell, initialText?: string) {
    const current = workspace.getSnapshot()
    // A gesture cannot replace an existing session, including detached/rejected input.
    if (openingCell.current || current.state.session || current.capabilities.close.lifecycle !== 'open') return
    const display = columns.find(column => column.id === cell.columnId)
    if (!display) return
    const target = { kind: 'cell' as const, field: { entityId: cell.entityId, fieldId: display.fieldId } }
    if (!review(target)) return
    openingCell.current = true
    try {
      const binding = reviewBindings.get(display.fieldId)!, row = reviewRows.get(cell.entityId)!.row
      const codec = definitions.get(display.fieldId)!.codec
      const original = codec.format(readDocument(row.preview!, binding.path))
      const autoApply = codec.inputKind === 'boolean'
      const text = initialText ?? (autoApply ? original === 'true' ? 'false' : 'true' : original)
      setEditFailure(null)
      const inputId = kernelId<'input'>(crypto.randomUUID())
      const writer = workspace.beginEditing({ kind: 'session-opened', revision: observed.state.revision, sessionId: kernelId<'session'>(crypto.randomUUID()), inputId, viewId, target, reads: [], input: { kind: 'encoded', value: text } })
      setOpeningEditor({ workspace, viewId, writer, autoApply, selectOnFocus: initialText === undefined })
      const result = await writer.result
      if (result.kind === 'rejected') setEditFailure(workspace)
      return { writer, result, input: { id: inputId, version: 0 } }
    } catch { setEditFailure(workspace) } finally { openingCell.current = false }
  }
  const latestActivation = useRef<(cell: WorkspaceGridCell, text?: string) => void>(() => {})
  latestActivation.current = activateEditor
  function activateEditor(cell: WorkspaceGridCell, text?: string) {
    if (workspace.getState().session || pendingEditor) {
      const active = workspace.getState().session
      if (resourceTask || active?.target.kind !== 'cell' && !pendingEditor || active?.issues.length
        || active?.editor?.viewId !== viewId && !pendingEditor || readMatrixInput(raw)
        || active?.target.kind === 'cell' && codecs.get(active.target.field.fieldId)?.choices?.multiple
        || reviewingEditor?.workspace === workspace && reviewingEditor.sessionId === active?.id) return
      transitionSelection(cell, () => {
        if (!selectCell(cell, false)) return false
        // Use the post-commit view and codecs when opening the destination.
        requestAnimationFrame(() => {
          if (currentOwner() && !workspace.getState().session) latestActivation.current(cell, text)
        })
        return true
      })
      return
    }
    const display = columns.find(column => column.id === cell.columnId), task = display && definitions.get(display.fieldId)?.resourceTask
    if (text !== undefined || !task?.pickOnEdit) { void editCell(cell, text); return }
    if (!acceptsFile(cell) || pickerOwner.current || !filePicker.current) return
    pickerOwner.current = { workspace, viewId, scopeKey, cell, fieldId: display!.fieldId, task }
    filePicker.current.accept = task.accept ?? ''
    filePicker.current.click()
  }
  function acceptsFile(cell: WorkspaceGridCell) {
    const current = workspace.getSnapshot(), display = columns.find(column => column.id === cell.columnId)
    return !openingCell.current && !current.state.session && current.capabilities.close.lifecycle === 'open'
      && !!display && !!definitions.get(display.fieldId)?.resourceTask
      && !!review({ kind: 'cell', field: { entityId: cell.entityId, fieldId: display.fieldId } })
  }
  async function dropFile(cell: WorkspaceGridCell, file: File, onOwned?: () => void) {
    if (!acceptsFile(cell)) return
    const display = columns.find(column => column.id === cell.columnId)!, task = definitions.get(display.fieldId)!.resourceTask!
    const validation = resourceFileError(file, task, messages.resource)
    setFileFailure(validation ? { workspace, message: validation } : null)
    if (validation) return
    try {
      // Receive bytes immediately, while the fixed editor opening is queued.
      // Neither a changed selection nor a late upload may choose another owner.
      const editing = editCell(cell)
      const registering = workspace.registerResource(file)
      const [opened, input] = await Promise.all([editing, registering])
      onOwned?.()
      const session = workspace.getState().session
      if (!opened || opened.result.kind !== 'accepted' || session?.id !== opened.writer.sessionId || session.editor?.viewId !== viewId
        || session.input.id !== opened.input.id || session.input.version !== opened.input.version) return
      const request = { owner: { kind: 'session' as const, sessionId: session.id, input: opened.input }, input, reads: [] }
      const run = task.kind === 'durable' ? workspace.runDurableTask({ ...request, definition: task.definition }) : workspace.runTask(request, task.execute)
      if ((await run.result).kind !== 'accepted') { setEditFailure(workspace); return }
      const finished = await workspace.waitForTask(run.taskId), current = workspace.getState().session
      if (!currentOwner() || finished?.kind !== 'consumed' || finished.destination.kind !== 'session'
        || current?.id !== session.id || current.editor?.viewId !== viewId
        || current.input.id !== finished.destination.input.id || current.input.version !== finished.destination.input.version) return
      const appliedInput = finished.destination.input
      setOpeningEditor(previous => previous?.workspace === workspace && previous.writer.sessionId === session.id ? { ...previous, autoApply: true, autoApplyInput: appliedInput } : previous)
    } catch { setEditFailure(workspace) }
  }
  function copyMatrix(cell: WorkspaceGridCell): string | null {
    copyAttempt.current++
    // Preserve captured membership/order, including filtered-out members. A
    // deleted row or removed codec rejects the whole copy, never a partial TSV.
    const axes = rangeSet && workspaceSelectionContains(ranges, cell)
      ? (ranges.length === 1 ? range! : workspaceSelectionEnvelope(rangeSet)) : { rows: [cell.entityId], columns: [cell.columnId] }
    try {
      const rows = new Map(snapshot.projection.rows.map(row => [row.entityId, row]))
      const text = encodeMatrix(axes.rows.map(entityId => axes.columns.map(columnId => {
        if ('members' in axes && !workspaceSelectionContains(ranges, { entityId, columnId })) return ''
        const row = rows.get(entityId), column = columns.find(column => column.id === columnId)
        const binding = column && reviewBindings.get(column.fieldId), codec = column && codecs.get(column.fieldId)
        if (!row?.preview || !binding || !codec) throw new Error('The complete selection cannot be copied.')
        return codec.format(readDocument(row.preview, binding.path))
      })))
      if (!clipboardFits(text, limits.maxClipboardBytes)) { setCopyFeedback(null); setLimitFailure(workspace); return null }
      setLimitFailure(null)
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
    const axes = rangeSet && (!cell || workspaceSelectionContains(ranges, cell)) ? (ranges.length === 1 ? range! : workspaceSelectionEnvelope(rangeSet))
      : origin ? { rows: [origin.entityId], columns: [origin.columnId] } : null
    if (!axes) return
    const fields = 'members' in axes ? workspaceSelectionSetFields(ranges, columns) : workspaceSelectionFields(axes, columns)
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
        const text = encodeMatrix(axes.rows.map(entityId => axes.columns.map(id => {
          if ('members' in axes && !workspaceSelectionContains(ranges, { entityId, columnId: id })) return ''
          const column = columns.find(column => column.id === id)!
          return definitions.get(column.fieldId)!.clearInput!
        })))
        await openMatrix(text, cell)
      }
    } finally { clearing.current.delete(workspace) }
  }
  async function openMatrix(text: string, cell?: WorkspaceGridCell) {
    const selectedRange = rangeSet && (!cell || workspaceSelectionContains(ranges, cell)) ? (ranges.length === 1 ? range! : workspaceSelectionEnvelope(rangeSet)) : null
    const origin = cell ?? selected
    const axes = selectedRange ?? (origin ? { rows: [origin.entityId], columns: [origin.columnId] } : null)
    if (!axes) return
    // A removed display binding must reject the whole request while retaining
    // its text and unresolved layout, rather than dropping that matrix column.
    const fields = ('members' in axes ? workspaceSelectionSetFields(ranges, columns) : workspaceSelectionFields(axes, columns)) ?? []
    const layout = { rows: axes.rows, ...('members' in axes ? { members: axes.members } : {}), columns: axes.columns.map(columnId => ({ columnId, fieldId: columns.find(column => column.id === columnId)?.fieldId ?? null })) }
    await openInput(fields.length === 1 ? { kind: 'cell', field: fields[0]! } : { kind: 'bulk', fields },
      { kind: 'encoded', value: { format: 'members' in axes ? 'workspace-matrix:2' : 'workspace-matrix:1', text, layout } })
  }
  async function openInput(target: Extract<SessionTarget, { kind: 'cell' | 'bulk' }>, input: OwnedInput, autoApply = false) {
    const writer = workspace.beginEditing({ kind: 'session-opened', revision: snapshot.state.revision,
      sessionId: kernelId<'session'>(crypto.randomUUID()), inputId: kernelId<'input'>(crypto.randomUUID()),
      viewId, target, reads: [], input })
    setOpeningEditor({ workspace, viewId, writer, selectOnFocus: false, autoApply })
    return { result: await writer.result, sessionId: writer.sessionId }
  }
  async function pasteMatrix(cell: WorkspaceGridCell, text: string) {
    const current = workspace.getSnapshot()
    if (current.capabilities.close.lifecycle !== 'open') return
    if (!clipboardFits(text, limits.maxClipboardBytes)) { setLimitFailure(workspace); return }
    let matrix: readonly (readonly string[])[]
    try { matrix = decodeMatrix(text) } catch { await openMatrix(text, cell); return }
    const rowIndex = snapshot.view.rows.findIndex(row => row.entityId === cell.entityId), columnIndex = columns.findIndex(column => column.id === cell.columnId)
    if (rowIndex < 0 || columnIndex < 0) return
    const width = matrix.reduce((width, row) => Math.max(width, row.length), 0)
    const ragged = matrix.some(row => row.length !== width)
    const layout = { rows: snapshot.view.rows.slice(rowIndex, rowIndex + matrix.length).map(row => row.entityId),
      ...(ragged ? { rowWidths: matrix.map(row => row.length) } : {}),
      columns: columns.slice(columnIndex, columnIndex + width).map(column => ({ columnId: column.id, fieldId: column.fieldId })) }
    const fields = layout.rows.flatMap((entityId, index) => [...new Set(layout.columns.slice(0, matrix[index]!.length).map(column => column.fieldId))].map(fieldId => ({ entityId, fieldId })))
    if (!fields.length) return
    const missing = Math.max(0, matrix.length - layout.rows.length)
    if (matrix.reduce((count, row) => count + row.length, missing) > limits.maxMutations) { setLimitFailure(workspace); return }
    setLimitFailure(null)
    const input: OwnedInput = { kind: 'encoded', value: { format: ragged ? 'workspace-matrix:3' : 'workspace-matrix:1', text, layout } }
    const opened = await openInput(fields.length === 1 ? { kind: 'cell', field: fields[0]! } : { kind: 'bulk', fields }, input, !missing)
    if (!missing || opened.result.kind !== 'accepted') return
    await preparePasteRows(opened.sessionId, input)
  }
  async function preparePasteRows(sessionId: string, expectedInput?: OwnedInput) {
    try {
      const observed = workspace.getSnapshot(), before = observed.state.session
      if (!currentOwner() || observed.capabilities.close.lifecycle !== 'open' || observed.ingress.pending.length || observed.storage && observed.storage.kind !== 'idle') return
      if (before?.id !== sessionId || !before.editor || before.editor.viewId !== viewId || before.issues.length || before.target.kind === 'filter'
        || before.target.kind === 'bulk' && before.target.creations?.length || expectedInput && !encodedValuesEqual(ownEncodedValue(before.rawInput), ownEncodedValue(expectedInput))) return
      const input = readMatrixInput(before.rawInput)
      if (!input || !createRow) throw new Error('The complete paste requires a supported row factory and retained layout.')
      if (!clipboardFits(input.text, limits.maxClipboardBytes)) { setLimitFailure(workspace); return }
      const matrix = decodeMatrix(input.text), layout = input.layout, missing = matrix.length - layout.rows.length
      if (missing <= 0 || matrix.some((row, index) => row.length > layout.columns.length || row.length !== (layout.rowWidths?.[index] ?? layout.columns.length))
        || layout.rowWidths && layout.rowWidths.length !== matrix.length) throw new Error('The complete paste must fit its captured columns.')
      if (matrix.reduce((count, row) => count + row.length, missing) > limits.maxMutations) { setLimitFailure(workspace); return }
      setLimitFailure(null)
      const fields = before.target.kind === 'cell' ? [before.target.field] : before.target.fields
      const creations = Array.from({ length: missing }, () => ({ ...ownEncodedValue(createRow()) as ReturnType<NonNullable<typeof createRow>>, entityId: kernelId<'entity'>(crypto.randomUUID()) }))
      const current = workspace.getState()
      if (current.session !== before) return
      const target = { kind: 'bulk' as const, fields: [...fields, ...creations.flatMap((creation, index) => [...new Set(layout.columns.slice(0, matrix[layout.rows.length + index]!.length).map(column => column.fieldId))].map(fieldId => ({ entityId: creation.entityId, fieldId })))], creations }
      const result = await workspace.dispatch({ kind: 'session-retargeted', revision: current.revision, lease: before.editor,
        inputVersion: before.input.version, target, reads: [] })
      if (result.kind === 'accepted') {
        setEditFailure(null)
        if (expectedInput) setOpeningEditor(previous => previous?.workspace === workspace && previous.writer.sessionId === sessionId ? { ...previous, autoApply: true } : previous)
      }
      else setEditFailure(workspace)
    } catch { setEditFailure(workspace) }
  }
  let needsPasteRows = false
  if (createRow && session && session.target.kind !== 'filter' && !(session.target.kind === 'bulk' && session.target.creations?.length)) {
    const matrix = readMatrixInput(raw)
    try { needsPasteRows = !!matrix && decodeMatrix(matrix.text).length > matrix.layout.rows.length } catch { /* The retained editor reports malformed text. */ }
  }
  const selectionCompletion = useRef<{ workspace: Workspace; sessionId: string; complete(): void } | null>(null)
  const [commitSelection, setCommitSelection] = useState<{
    workspace: Workspace; viewId: ViewId; scopeKey: string;
    request: NonNullable<WorkspaceTextEditorProps['commitRequest']>
  } | null>(null)
  const [reviewingEditor, setReviewingEditor] = useState<{ workspace: Workspace; sessionId: string } | null>(null)
  const owner = useRef({ workspace, viewId, scopeKey })
  owner.current = { workspace, viewId, scopeKey }
  const currentOwner = () => owner.current.workspace === workspace && owner.current.viewId === viewId && owner.current.scopeKey === scopeKey
  const ownedPointerEvents = useRef(new WeakSet<Event>())
  const outsideSelection = useRef<() => void>(() => {})
  function clearViewSelection() {
    if (!currentOwner()) return false
    setSelection(null)
    setMenu(null)
    cancelFill()
    return true
  }
  outsideSelection.current = () => { transitionSelection(null, clearViewSelection, true) }
  useEffect(() => {
    let attached = true
    const outside = (event: PointerEvent) => {
      const path = event.composedPath()
      // A microtask can run between native capture listeners, before React has
      // claimed this event. Wait until propagation completes, including portals
      // and explicit lifecycle surfaces outside the grid's DOM subtree.
      setTimeout(() => {
        if (!attached || !currentOwner() || event.defaultPrevented || ownedPointerEvents.current.has(event) || retainsWorkspacePointerInput(event, workspace)
          || root.current && path.includes(root.current)) return
        outsideSelection.current()
      }, 0)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => { attached = false; document.removeEventListener('pointerdown', outside, true) }
  }, [workspace, viewId, scopeKey])
  function selectCell(cell: WorkspaceGridCell, extend: boolean, anchor?: WorkspaceGridCell, additive?: boolean): boolean {
    const select = () => {
      if (!currentOwner()) return false
      const current = workspace.getSnapshot()
      const queryView = workspace.getView(viewId)
      const view = rowScope ? scopeView(queryView, current.projection, workspace.schema, rowScope) : queryView
      const rows = view.rows.map(row => row.entityId), ids = columns.map(column => column.id)
      if (!rows.includes(cell.entityId) || !ids.includes(cell.columnId)) return false
      const next = selectWorkspaceRange(rows, ids, cell, anchor ?? (extend ? range?.anchor ?? selected ?? cell : cell))
      setSelection(previous => ({ workspace, viewId, scopeKey, range: next, set: updateWorkspaceSelection(previous?.workspace === workspace && previous.viewId === viewId && previous.scopeKey === scopeKey ? previous.set : null, next, extend ? 'extend' : additive ? 'append' : 'replace', rows, ids) }))
      return true
    }
    return transitionSelection(cell, select)
  }
  function transitionSelection(cell: WorkspaceGridCell | null, select: () => boolean, extent = false): boolean {
    // Scalar editors finish through the same validated, durable apply command as
    // Enter. Review mode keeps retained input while inspecting other targets.
    const active = workspace.getSnapshot().state.session
    const activeTarget = active?.target ?? pendingEditor?.target
    const sessionId = active?.id ?? pendingEditor?.sessionId
    const owns = active ? active.editor?.viewId === viewId : !!pendingEditor
    if (owns && sessionId && activeTarget?.kind === 'cell' && !resourceTask && !(active?.issues.length)
      && !(reviewingEditor?.workspace === workspace && reviewingEditor.sessionId === sessionId)
      && !readMatrixInput(raw) && !codecs.get(activeTarget.field.fieldId)?.choices?.multiple) {
      if (cell && !extent && activeTarget.field.entityId === cell.entityId && columns.find(column => column.id === cell.columnId)?.fieldId === activeTarget.field.fieldId) return false
      const restoreFrom = document.activeElement
      selectionCompletion.current = { workspace, sessionId, complete: () => {
        if (!currentOwner() || workspace.getState().session || !select()) return
        setOpeningEditor(null)
        if (cell) requestAnimationFrame(() => {
          if (!currentOwner() || workspace.getState().session || openingCell.current
            || document.activeElement !== document.body && document.activeElement !== restoreFrom) return
          const element = [...(root.current?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? [])].find(element => element.dataset.entityId === cell.entityId && element.dataset.columnKey === cell.columnId)
          element?.focus({ preventScroll: true })
        })
      } }
      setCommitSelection({ workspace, viewId, scopeKey, request: { sessionId, complete: () => {
        const completion = selectionCompletion.current
        if (completion?.workspace !== workspace || completion.sessionId !== sessionId) return
        selectionCompletion.current = null
        completion.complete()
      } } })
      return false
    }
    if (!cell && (active || pendingEditor)) return false
    return select()
  }
  const editingTarget = (session?.editor?.viewId === viewId || pendingEditor) && target?.kind === 'cell' && !resourceTask && !readMatrixInput(raw)
    ? { entityId: target.field.entityId, columnId: columns.find(column => column.fieldId === target.field.fieldId)?.id ?? '' } : null
  function finishEditing(move?: 'next' | 'previous', restoreFrom?: Element | null, applied = false) {
    if (!currentOwner()) return
    selectionCompletion.current = null
    setOpeningEditor(null)
    // Apply can reorder or hide its own row. Navigation must use the published
    // query, not the render snapshot captured before the durable command.
    const current = workspace.getSnapshot(), queryView = workspace.getView(viewId)
    const view = rowScope ? scopeView(queryView, current.projection, workspace.schema, rowScope) : queryView
    const rows = view.rows.map(row => row.entityId), columnIds = columns.map(column => column.id)
    const targetColumn = target?.kind === 'cell' ? columns.find(column => column.fieldId === target.field.fieldId) : null
    let cell = editingTarget ?? selected ?? (target?.kind === 'cell' && targetColumn ? { entityId: target.field.entityId, columnId: targetColumn.id } : null)
    // Reopened input has an explicit owner even though UI selection is not
    // persisted. Return to that cell after finishing, including resource input.
    if (!selected && cell && rows.includes(cell.entityId) && columnIds.includes(cell.columnId)) {
      const range = selectWorkspaceRange(rows, columnIds, cell, cell)
      setSelection({ workspace, viewId, scopeKey, range, set: updateWorkspaceSelection(null, range, 'replace', rows, columnIds) })
    }
    if (applied && opening?.fillSelection) {
      const range = opening.fillSelection
      setSelection({ workspace, viewId, scopeKey, range, set: updateWorkspaceSelection(null, range, 'replace', snapshot.view.rows.map(row => row.entityId), columns.map(column => column.id)) })
      cell = range.focus
    }
    if (!cell) return
    if (move) {
      const rowIndex = rows.indexOf(cell.entityId), columnIndex = columnIds.indexOf(cell.columnId)
      if (rowIndex < 0 || columnIndex < 0) return
      const index = rowIndex * columns.length + columnIndex
      const next = Math.max(0, Math.min(rows.length * columns.length - 1, index + (move === 'next' ? 1 : -1)))
      cell = { entityId: rows[Math.floor(next / columns.length)]!, columnId: columnIds[next % columns.length]! }
      const range = selectWorkspaceRange(rows, columnIds, cell, cell)
      setSelection({ workspace, viewId, scopeKey, range, set: updateWorkspaceSelection(null, range, 'replace', rows, columnIds) })
    }
    const destination = cell
    requestAnimationFrame(() => {
      if (!currentOwner() || workspace.getState().session || openingCell.current || root.current?.querySelector('[data-grid-editor="true"]')
        || document.activeElement !== document.body && document.activeElement !== restoreFrom) return
      const element = [...(root.current?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? [])].find(element => element.dataset.entityId === destination.entityId && element.dataset.columnKey === destination.columnId)
      element?.focus()
    })
  }
  return <div ref={root} className={['business-grid__workspace', className].filter(Boolean).join(' ')}
    onPointerDownCapture={event => { ownedPointerEvents.current.add(event.nativeEvent) }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing
        || !(event.target instanceof Element) || !event.target.matches('[role="grid"], [role="gridcell"]')
        || workspace.getState().session || pendingEditor) return
      event.preventDefault()
      if (clearViewSelection()) root.current?.querySelector<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true })
    }}>
    <input ref={filePicker} type="file" hidden tabIndex={-1} onChange={event => {
      const file = event.currentTarget.files?.[0], owner = pickerOwner.current
      pickerOwner.current = null
      if (!file || !owner) return
      if (owner.workspace !== workspace || owner.viewId !== viewId || owner.scopeKey !== scopeKey
        || columns.find(column => column.id === owner.cell.columnId)?.fieldId !== owner.fieldId || definitions.get(owner.fieldId)?.resourceTask !== owner.task || !acceptsFile(owner.cell)) {
        setEditFailure(workspace); return
      }
      const element = event.currentTarget
      void dropFile(owner.cell, file, () => { if (element.files?.[0] === file) element.value = '' })
    }} />
    {conflictFailure === workspace ? <p role="alert">{messages.menu.conflictFailed}</p> : null}
    {restoreFailure === workspace ? <p role="alert">{messages.dirty.failed}</p> : null}
    {limitFailure === workspace ? <p role="alert">{messages.limitExceeded}</p> : null}
    {fileFailure?.workspace === workspace ? <p role="alert">{fileFailure.message}</p> : null}
    {editFailure === workspace ? <p role="alert">{messages.editor.failed}</p> : null}
    {activeFill ? <p role="status" className="business-grid__fill-status">{messages.fill.help}</p> : null}
    {fillFailure === workspace ? <p role="alert">{messages.fill.failed}</p> : null}
    {copyFeedback?.workspace === workspace ? <p role={copyFeedback.kind === 'failed' ? 'alert' : 'status'}>{copyFeedback.kind === 'failed' ? messages.copyFailed : copyFeedback.kind === 'pending' ? messages.copying : messages.copied}</p> : null}
    <div className="business-grid__workspace-actions">
      <WorkspaceSearch workspace={workspace} snapshot={snapshot} viewId={viewId} columns={columns} editors={editors} label={messages.search} locale={locale.filter.conditions.locale} />
      <WorkspaceToolbar keyboardRoot={root} workspace={workspace} messages={messages.toolbar} {...observation}
        renderAdditionalActions={actions => activeMenu ? <WorkspaceContextMenu anchor={activeMenu.anchor} label={messages.menu.label} close={closeMenu} isCurrent={() => workspace.getSnapshot() === activeMenu.snapshot}
          actions={[
            { id: 'edit', label: messages.editor.edit, disabled: !menuCanEdit || menuTarget?.kind === 'cell' && menuEditText === null, run: editFromMenu },
            { id: 'copy', label: messages.menu.copy, disabled: false, run: () => { void copyShortcut(activeMenu.cell) } },
            { id: 'paste', label: messages.paste, disabled: !menuCanEdit, run: () => { void openMatrix('', activeMenu.cell) } },
            { id: 'clear', label: messages.clear, disabled: !menuCanEdit || !menuFields?.every(field => definitions.get(field.fieldId)?.clearInput !== undefined), run: () => { void clearSelection(activeMenu.cell) } },
            { id: 'restore-cell', label: messages.menu.restoreCell, disabled: !canRestore(menuCellFields), run: () => { void restoreFields(menuCellFields, messages.menu.restoreCell) } },
            { id: 'restore-selection', label: messages.menu.restoreSelection, disabled: !canRestore(menuFields), run: () => { if (menuFields) void restoreFields(menuFields, messages.menu.restoreSelection) } },
            { id: 'restore-row', label: messages.menu.restoreRow, disabled: !canRestoreRow, run: () => { void restoreMenuRow() } },
            ...(menuFieldIssues.length ? [
              { id: 'use-remote-cell', label: messages.menu.useRemoteCell, disabled: !canResolveRow, run: () => { void resolveMenuRow('use-authority', true) } },
              { id: 'keep-local-cell', label: messages.menu.keepLocalCell, disabled: !canResolveRow || !menuConflictRow?.authority, run: () => { void resolveMenuRow('keep-local', true) } },
            ] : []),
            ...(menuConflictRow ? [
              { id: 'use-remote-row', label: messages.menu.useRemoteRow, disabled: !canResolveRow, run: () => { void resolveMenuRow('use-authority') } },
              { id: 'keep-local-row', label: messages.menu.keepLocalRow, disabled: !canResolveRow || !menuConflictRow.authority, run: () => { void resolveMenuRow('keep-local') } },
            ] : []),
            ...actions,
          ]} /> : null} />
      {!session ? <button type="button" disabled={!candidate || !supported || !replacement || snapshot.capabilities.close.lifecycle !== 'open'} onClick={() => openMatrix('')}>{messages.paste}</button> : null}
      {!session && editors.some(editor => editor.clearInput !== undefined) ? <button type="button" disabled={!canClear || !replacement || snapshot.capabilities.close.lifecycle !== 'open'} onClick={() => { void clearSelection() }}>{messages.clear}</button> : null}
      <button type="button" disabled={!!session || !replacement || !supported} aria-pressed={!!activeFill}
        onClick={event => { if (activeFill) cancelFill(); else if (startFill()) event.currentTarget.closest('.business-grid__workspace')?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus() }}>{messages.fill.label}</button>
      <div className="business-grid__workspace-editor-action" ref={setEditorActionContainer}>
        {!target && !session && !pendingEditor ? <button type="button" disabled>{messages.editor.edit}</button> : null}
      </div>
    </div>
    <WorkspaceTaskRecovery {...(renderActionCandidate ? { renderActionCandidate } : {})} workspace={workspace} snapshot={snapshot} viewId={viewId} messages={messages.resource} {...(supported && currentReview ? { review: currentReview } : {})} />
    <WorkspaceDecisionRecovery workspace={workspace} snapshot={snapshot} viewId={viewId} {...(supported && replacement ? { target: replacement } : {})} messages={messages.recovery} resourceMessages={messages.resource} />
    <WorkspaceStoredFiles workspace={workspace} snapshot={snapshot} messages={messages.files} />
    <WorkspaceIngressRecovery workspace={workspace} messages={messages.ingress} {...observation} />
    {columns.some(column => column.sortable) ? <p className="business-grid__visually-hidden">{messages.sort.help}</p> : null}
    {sortFeedback?.workspace === workspace && sortFeedback.failed && sortFeedback.version === snapshot.view.query.version ? <p role="alert">{messages.sort.failed}</p> : null}
    <div className="business-grid__workspace-filter-review" />
    <div className="business-grid__workspace-editor">
      {needsPasteRows && session ? <button type="button" disabled={!session.editor || session.editor.viewId !== viewId || session.issues.length > 0 || snapshot.ingress.pending.length > 0 || snapshot.editorInput?.status !== 'published' || !!snapshot.storage && snapshot.storage.kind !== 'idle'} onClick={() => { void preparePasteRows(session.id) }}>{messages.preparePasteRows}</button> : null}
      {target && supported && editorLabel ? <WorkspaceTextEditor idleContainer={editorActionContainer} {...limits} onReviewChange={(sessionId, reviewing) => setReviewingEditor(reviewing ? { workspace, sessionId } : null)} {...(commitSelection?.workspace === workspace && commitSelection.viewId === viewId && commitSelection.scopeKey === scopeKey ? { commitRequest: commitSelection.request } : {})} {...(editingTarget ? { inputFrame: { root, cell: editingTarget } } : {})} presentation="cell" autoApply={opening?.writer.sessionId === session?.id && opening?.autoApply && (!opening.autoApplyInput || opening.autoApplyInput.id === session?.input.id && opening.autoApplyInput.version === session?.input.version) || false} onFinished={finishEditing} selectOnFocus={opening?.selectOnFocus ?? true} {...(pendingEditor ? { opening: pendingEditor } : {})} workspace={workspace} viewId={viewId} target={target} label={editorLabel} codecs={codecs} messages={messages.editor} {...(resourceTask ? { resource: { task: resourceTask, messages: messages.resource } } : {})} {...observation} {...(replacement ? { replacement } : {})} {...(currentReview ? { currentReview } : {})} />
        : session?.target.kind === 'filter' && (session.target.viewId === undefined || session.target.viewId === viewId) && filterIds.has(session.target.columnId) ? null : session ? <section aria-label={messages.retainedInput}>
          <p role="alert">{messages.inputUnavailable}</p>
          {raw?.kind === 'encoded' ? <textarea aria-label={messages.retainedInput} readOnly value={typeof raw.value === 'string' ? raw.value : canonicalEncodedValue(raw.value)} /> : null}
        </section> : null}
    </div>
    <WorkspaceGridViewport viewId={viewId} renderHeaderControl={column => {
      const filter = filters.find(filter => filter.columnId === column.id)
      return filter ? <WorkspaceFilterEditor workspace={workspace} viewId={viewId} {...filter} dialogTitle={locale.filter.conditions.title(column.label)} messages={filter.messages ?? locale.filter} {...observation} /> : null
    }} renderAdornment={cell => {
      const column = columns.find(column => column.id === cell.columnId), binding = column && reviewBindings.get(column.fieldId)
      const row = reviewRows.get(cell.entityId)?.row, codec = column && codecs.get(column.fieldId)
      if (!binding || !row?.preview || !codec) return null
      const issues = fieldResolutionIssues(row.issues, row.entityId, binding.path)
      // Row-level validation/permission failures have no field comparison.
      // Keep their review entry visible instead of silently showing a clean row.
      const rowIssue = row.issues.length && !row.issues.some(issue => issue.comparison) && columns[0]?.id === cell.columnId
      const original = row.authority ? readDocument(row.authority, binding.path) : null
      const field = { entityId: cell.entityId, fieldId: binding.id }
      return <>
        {issues.length || rowIssue ? <button type="button" className="business-grid__issue-marker" aria-label={messages.summary.reviewCell}
          onPointerDown={event => event.stopPropagation()} onClick={event => {
            const element = event.currentTarget, rect = element.getBoundingClientRect()
            setMenu({ workspace, viewId, scopeKey, snapshot: observed, columns, editors, selection, cell, anchor: { x: rect.left, y: rect.bottom, element } })
          }}>!</button> : null}
        {original && !resourceValuesEqual(original, readDocument(row.preview, binding.path)) ? <WorkspaceDirtyCell workspace={workspace} snapshot={observed} field={field} original={original}
          label={(codec.display ?? codec.format)(original)} messages={messages.dirty} disabled={!!row.issues.length || !review({ kind: 'cell', field })} /> : null}
      </>
    }} renderControl={(cell, value) => {
      const column = columns.find(column => column.id === cell.columnId), editor = column && definitions.get(column.fieldId)
      if (editor?.codec.choices?.multiple) {
        try {
          const tokens = JSON.parse(editor.codec.format(value)) as string[], choices = editor.codec.choices
          const labels = tokens.map(token => choices.options.find(option => option.text === token)?.label ?? token)
          return <WorkspaceChoiceCell labels={labels} emptyLabel={choices.placeholder} />
        } catch { return undefined }
      }
      if (editor?.codec.inputKind !== 'boolean' || value.kind !== 'value' || typeof value.value !== 'boolean') return undefined
      return <input type="checkbox" aria-label={(editor.codec.display ?? editor.codec.format)(value)} checked={value.value}
        disabled={!!session || !!pendingEditor || !review({ kind: 'cell', field: { entityId: cell.entityId, fieldId: editor.fieldId } }) || snapshot.capabilities.close.lifecycle !== 'open'}
        onChange={() => { void editCell(cell) }} />
    }} {...(rowHeader ? { rowHeader } : {})} {...(rowScope ? { rowScope } : {})} workspace={workspace} caption={caption} columns={columns} messages={messages.viewport} {...observation}
      editing={editingTarget}
      fill={{ source: fillSource, enabled: !session && !!replacement && supported, token: activeFill?.token ?? null,
        start: startFill, cancel: cancelFill, drop: (cell, token) => { void finishFill(cell, token) } }}
      sorting={{ sort: snapshot.view.query.sort, disabled: sortingDisabled, label: messages.sort.label, priority: messages.sort.priority,
        describe: messages.sort.describe,
        toggle: (fieldId, additive) => { void toggleSort(fieldId, additive) } }}
      interaction={{ selectionPending: () => {
        const pending = selectionCompletion.current
        return pending?.workspace === workspace && pending.sessionId === (workspace.getState().session?.id ?? pendingEditor?.sessionId)
      }, acceptsFile, onFileDrop: (cell, file) => { void dropFile(cell, file) }, selected, ranges, anchor: range?.anchor ?? selected, onEdit: activateEditor, onContextMenu: (cell, anchor) => setMenu({ workspace, viewId, scopeKey, snapshot: observed, columns, editors, selection, cell, anchor }), onClear: cell => { void clearSelection(cell) }, onCopyShortcut: cell => { void copyShortcut(cell) }, onCopy: copyMatrix, onPaste: (cell, text) => { void pasteMatrix(cell, text) }, members: range ?? { rows: selected ? [selected.entityId] : [], columns: selected ? [selected.columnId] : [] }, onSelectExtent: (extent, cell, extend, additive, origin) => transitionSelection(cell, () => {
        if (!currentOwner()) return false
        const current = workspace.getSnapshot()
        const queryView = workspace.getView(viewId)
      const view = rowScope ? scopeView(queryView, current.projection, workspace.schema, rowScope) : queryView
        const rows = view.rows.map(row => row.entityId), ids = columns.map(column => column.id)
        if (!rows.includes(cell.entityId) || !ids.includes(cell.columnId)) return false
        const start = origin ?? (extend ? range?.anchor : null) ?? cell
        const anchor = { entityId: extent === 'row' ? start.entityId : rows[0]!, columnId: extent === 'column' ? start.columnId : ids[0]! }
        const focus = { entityId: extent === 'row' ? cell.entityId : rows.at(-1)!, columnId: extent === 'column' ? cell.columnId : ids.at(-1)! }
        const next = { ...selectWorkspaceRange(rows, ids, focus, anchor), focus: cell }
        setSelection(previous => ({ workspace, viewId, scopeKey, range: next, set: updateWorkspaceSelection(previous?.workspace === workspace && previous.viewId === viewId && previous.scopeKey === scopeKey ? previous.set : null, next, extent === 'all' ? 'replace' : extend ? 'extend' : additive ? 'append' : 'replace', rows, ids) }))
        return true
      }, true), onSelect: selectCell  }} />
    {snapshot.state.authority.content.kind === 'complete' ? <div className="business-grid__footer" role="group" aria-label={messages.summary.label}>
      <span>{messages.summary.rows(snapshot.view.rows.length, snapshot.view.total)}</span>
      {changedCount ? <span>{messages.summary.changed(changedCount)}</span> : null}
      {invalidRows ? <span>{messages.summary.invalid(invalidRows)}</span> : null}
      {conflictRows ? <span>{messages.summary.conflicts(conflictRows)}</span> : null}
      {blockedRows ? <span>{messages.summary.blocked(blockedRows)}</span> : null}
      {selectionSummary.cells ? <span data-grid-selection-summary="true">{messages.summary.selection(selectionSummary.rows, selectionSummary.columns, selectionSummary.cells)}</span> : null}
    </div> : null}
  </div>
}
