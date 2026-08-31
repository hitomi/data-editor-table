import type { ReactNode } from 'react'

import type { GridPersistenceMode, GridPersistenceStatus } from '../model/grid-model.js'
import { GridDialog } from './grid-layers.js'

export type GridToolbarState = Readonly<{
  globalFilter: string
  dirtyCount: number
  selectedRowCount: number
  selectedCellCount: number
  canAddRows: boolean
  canDuplicateRows: boolean
  canDeleteRows: boolean
  deleteRowsDisabledReason: string | null
  showAddRows: boolean
  showDuplicateRows: boolean
  showDeleteRows: boolean
  canUndo: boolean
  canRedo: boolean
  canBulkEdit: boolean
  canSave: boolean
  showBulkEdit: boolean
  persistenceMode: GridPersistenceMode
  persistenceStatus: GridPersistenceStatus
}>

export type GridToolbarMessages = Readonly<{
  actionsLabel: string
  filterRowsLabel: string
  filterRowsPlaceholder: string
  undo: string
  redo: string
  editSelection: string
  addRow: string
  duplicateRows: (count: number) => string
  deleteRows: (count: number) => string
  deleteRowsBlocked: (blockedCount: number, selectedCount: number) => string
  saving: string
  saveChanges: string
}>

export type GridToolbarProps = Readonly<{
  actionSlot?: ReactNode
  messages: GridToolbarMessages
  onAddRows: () => void
  onBulkEdit: () => void
  onDeleteRows: () => void
  onDuplicateRows: () => void
  onGlobalFilterChange: (value: string) => void
  onRedo: () => void
  onSave: () => void
  onUndo: () => void
  state: GridToolbarState
}>

export function GridToolbar({
  actionSlot,
  onAddRows,
  onBulkEdit,
  onDeleteRows,
  onDuplicateRows,
  onGlobalFilterChange,
  onRedo,
  onSave,
  onUndo,
  state,
  messages,
}: GridToolbarProps) {
  return <div aria-label={messages.actionsLabel} className="business-grid__toolbar" role="toolbar">
    <label>
      <span className="business-grid__visually-hidden">{messages.filterRowsLabel}</span>
      <input
        aria-label={messages.filterRowsLabel}
        className="business-grid__search"
        placeholder={messages.filterRowsPlaceholder}
        type="search"
        value={state.globalFilter}
        onChange={(event) => onGlobalFilterChange(event.currentTarget.value)}
      />
    </label>
    <button className="business-grid__button" disabled={!state.canUndo} type="button" onClick={onUndo}>{messages.undo}</button>
    <button className="business-grid__button" disabled={!state.canRedo} type="button" onClick={onRedo}>{messages.redo}</button>
    {actionSlot}
    <span className="business-grid__toolbar-spacer" />
    {state.showBulkEdit ? <button className="business-grid__button" disabled={!state.canBulkEdit} type="button" onClick={onBulkEdit}>{messages.editSelection}</button> : null}
    {state.showAddRows ? <button className="business-grid__button" disabled={!state.canAddRows} type="button" onClick={onAddRows}>{messages.addRow}</button> : null}
    {state.showDuplicateRows ? <button className="business-grid__button" disabled={!state.canDuplicateRows} type="button" onClick={onDuplicateRows}>
      {messages.duplicateRows(state.selectedRowCount)}
    </button> : null}
    {state.showDeleteRows ? <button
      className="business-grid__button business-grid__button--destructive"
      disabled={!state.canDeleteRows}
      title={state.deleteRowsDisabledReason ?? undefined}
      type="button"
      onClick={onDeleteRows}
    >
      {messages.deleteRows(state.selectedRowCount)}
    </button> : null}
    {state.persistenceMode === 'manual-save' ? <button
      className="business-grid__button business-grid__button--primary"
      disabled={!state.canSave || state.persistenceStatus === 'saving'}
      type="button"
      onClick={onSave}
    >{state.persistenceStatus === 'saving' ? messages.saving : messages.saveChanges}</button> : null}
  </div>
}

export type GridFooterMessages = Readonly<{
  rows: (visible: number, total: number) => string
  selection: (rows: number, columns: number, cells: number) => string
  changed: (count: number) => string
  invalid: (count: number) => string
  conflicted: (count: number) => string
  saveScheduled: string
  saving: string
}>

export type GridFooterProps = Readonly<{
  conflictCount: number
  dirtyCount: number
  feedback: ReactNode
  invalidCount: number
  messages: GridFooterMessages
  persistenceStatus: GridPersistenceStatus
  selectedCellCount: number
  selectedColumnCount: number
  selectedRowCount: number
  totalRowCount: number
  visibleRowCount: number
}>

export function GridFooter({
  conflictCount,
  dirtyCount,
  feedback,
  invalidCount,
  persistenceStatus,
  selectedCellCount,
  selectedColumnCount,
  selectedRowCount,
  totalRowCount,
  visibleRowCount,
  messages,
}: GridFooterProps) {
  return <div className="business-grid__footer">
    <span>{messages.rows(visibleRowCount, totalRowCount)}</span>
    {selectedCellCount > 0 ? <span data-grid-selection-summary="true">{messages.selection(selectedRowCount, selectedColumnCount, selectedCellCount)}</span> : null}
    {dirtyCount > 0 ? <span>{messages.changed(dirtyCount)}</span> : null}
    {invalidCount > 0 ? <span>{messages.invalid(invalidCount)}</span> : null}
    {conflictCount > 0 ? <span>{messages.conflicted(conflictCount)}</span> : null}
    {persistenceStatus === 'scheduled' ? <span>{messages.saveScheduled}</span> : persistenceStatus === 'saving' ? <span>{messages.saving}</span> : null}
    <span className="business-grid__toolbar-spacer" />
    {feedback ? <span aria-live="polite" role="status">{feedback}</span> : null}
  </div>
}

export type GridFilterDraft = Readonly<{
  columnLabel: string
  operators: readonly Readonly<{
    id: string
    label: string
    requiresValue: boolean
    inputMode?: 'text' | 'numeric' | 'decimal' | 'date'
  }>[]
  conditions: readonly Readonly<{ operator: string; value: string }>[]
  combine: 'all' | 'any'
  error: string | null
}>

export type GridFilterDialogProps = Readonly<{
  draft: GridFilterDraft
  messages: Readonly<{
    dialogLabel: (column: string) => string
    title: (column: string) => string
    match: string
    allConditions: string
    anyCondition: string
    condition: (index: number) => string
    value: (column: string, index: number, multiple: boolean) => string
    removeCondition: (index: number) => string
    clearFilter: string
    addCondition: string
    cancel: string
    applyFilter: string
  }>
  onAddCondition: () => void
  onApply: () => void
  onCancel: () => void
  onCombineChange: (combine: 'all' | 'any') => void
  onClear: () => void
  onOperatorChange: (index: number, operator: string) => void
  onRemoveCondition: (index: number) => void
  onValueChange: (index: number, value: string) => void
}>

export function GridFilterDialog({
  draft,
  onAddCondition,
  onApply,
  onCancel,
  onCombineChange,
  onClear,
  onOperatorChange,
  onRemoveCondition,
  onValueChange,
  messages,
}: GridFilterDialogProps) {
  return <GridDialog ariaLabel={messages.dialogLabel(draft.columnLabel)}>
    <strong>{messages.title(draft.columnLabel)}</strong>
    {draft.conditions.length > 1 ? <label>{messages.match}<select value={draft.combine} onChange={(event) => onCombineChange(event.currentTarget.value as 'all' | 'any')}>
      <option value="all">{messages.allConditions}</option>
      <option value="any">{messages.anyCondition}</option>
    </select></label> : null}
    <div className="business-grid-filter__conditions">{draft.conditions.map((condition, index) => {
      const operator = draft.operators.find((candidate) => candidate.id === condition.operator)
      return <div className="business-grid-filter__condition" key={index}>
        <label><span className="business-grid__visually-hidden">{messages.condition(index + 1)}</span><select aria-label={messages.condition(index + 1)} value={condition.operator} onChange={(event) => onOperatorChange(index, event.currentTarget.value)}>
          {draft.operators.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
        </select></label>
        {operator?.requiresValue ? <label><span className="business-grid__visually-hidden">{messages.value(draft.columnLabel, index + 1, draft.conditions.length > 1)}</span><input
          aria-label={messages.value(draft.columnLabel, index + 1, draft.conditions.length > 1)}
          inputMode={operator.inputMode === 'date' ? undefined : operator.inputMode}
          type={operator.inputMode === 'date' ? 'date' : 'text'}
          value={condition.value}
          onChange={(event) => onValueChange(index, event.currentTarget.value)}
        /></label> : <span />}
        {draft.conditions.length > 1 ? <button aria-label={messages.removeCondition(index + 1)} className="business-grid__icon-button" type="button" onClick={() => onRemoveCondition(index)}>×</button> : null}
      </div>
    })}</div>
    {draft.error ? <p role="alert">{draft.error}</p> : null}
    <div className="business-grid-dialog__actions">
      <button className="business-grid__button" type="button" onClick={onClear}>{messages.clearFilter}</button>
      <button className="business-grid__button" type="button" onClick={onAddCondition}>{messages.addCondition}</button>
      <span className="business-grid__toolbar-spacer" />
      <button className="business-grid__button" type="button" onClick={onCancel}>{messages.cancel}</button>
      <button className="business-grid__button business-grid__button--primary" disabled={Boolean(draft.error)} type="button" onClick={onApply}>{messages.applyFilter}</button>
    </div>
  </GridDialog>
}
