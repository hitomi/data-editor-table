import { useMemo } from 'react'
import type { ViewId, ViewSearchField } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import type { WorkspaceGridColumn } from './workspace-grid-viewport.js'
import type { WorkspaceGridEditor } from './workspace-data-grid.js'

/** Search is a scoped query patch. Its raw text enters ingress synchronously;
 * queued typing cannot overwrite a later column filter or sort. */
export function WorkspaceSearch({ workspace, snapshot, viewId, columns, editors, label, locale }: Readonly<{
  workspace: Workspace; snapshot: WorkspaceSnapshot; viewId: ViewId; columns: readonly WorkspaceGridColumn[]
  editors: readonly WorkspaceGridEditor[]; label: string; locale: string
}>) {
  const fields = useMemo<readonly ViewSearchField[]>(() => [...new Set(columns.map(column => column.fieldId))].map(fieldId => {
    const codec = editors.find(editor => editor.fieldId === fieldId)?.codec
    const labels = codec?.choices ? codec.choices.options.flatMap(option => {
      // Multi-choice tokens use the same scalar catalog as single-choice tokens.
      const parsed = codec.parse(codec.choices!.multiple ? JSON.stringify([option.text]) : option.text)
      if (parsed.kind !== 'valid' || parsed.value.kind !== 'value') return []
      const value = codec.choices!.multiple && Array.isArray(parsed.value.value) ? parsed.value.value[0]! : parsed.value.value
      return [{ value, text: option.label }]
    }) : codec?.inputKind === 'boolean' ? [true, false].map(value => ({ value, text: (codec.display ?? codec.format)({ kind: 'value', value }) })) : undefined
    return { fieldId, ...(labels ? { labels } : {}) }
  }), [columns, editors])
  const pending = snapshot.ingress.pending.findLast(entry => entry.payload.kind === 'event' && entry.payload.event.kind === 'view-search-set' && entry.payload.event.viewId === viewId)
  const text = pending?.payload.kind === 'event' && pending.payload.event.kind === 'view-search-set' ? pending.payload.event.search.text : snapshot.view.query.search?.text ?? ''
  const disabled = snapshot.capabilities.close.lifecycle !== 'open' || pending?.phase === 'blocked' || pending?.phase === 'rejected'
  return <label className="business-grid__workspace-search"><span className="business-grid__visually-hidden">{label}</span>
    <input type="search" aria-label={label} placeholder={`${label}…`} value={text} readOnly={disabled}
      onChange={event => { if (!disabled && event.currentTarget.value !== text) void workspace.dispatch({ kind: 'view-search-set', viewId, search: { text: event.currentTarget.value, locale, fields } }) }} />
  </label>
}
