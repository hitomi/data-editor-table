import { observeResize } from './workspace-resize.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pathsOverlap, readDocument, resourceValuesEqual } from '../kernel/document.js'
import { type FieldRef, type ResourceValue } from '../kernel/model.js'
import { prepareWorkspaceRestore } from './workspace-restore.js'
import { policyForEntity } from '../kernel/state.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'

export type WorkspaceDirtyMessages = Readonly<{
  changed(original: string): string; original: string; restore: string; restoring: string; failed: string
}>

/** Original values remain typed authority facts. Restoring is an ordinary
 * undoable write, never deletion of history or a format/parse round trip. */
export function WorkspaceDirtyCell({ workspace, snapshot, field, original, label, messages, disabled }: Readonly<{
  workspace: Workspace; snapshot: WorkspaceSnapshot; field: FieldRef; original: ResourceValue; label: string; messages: WorkspaceDirtyMessages; disabled: boolean
}>) {
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoringFocus = useRef(false)
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const cancelClose = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null } }
  const close = (focus = false) => { cancelClose(); setOpen(false); if (focus) { restoringFocus.current = true; trigger.current?.focus(); restoringFocus.current = false } }
  const scheduleClose = () => { cancelClose(); timer.current = setTimeout(() => {
    if (!panel.current?.contains(document.activeElement) && document.activeElement !== trigger.current && !busy) setOpen(false)
  }, 180) }
  useEffect(() => () => cancelClose(), [])
  useLayoutEffect(() => {
    if (!open) return
    const node = panel.current!, button = trigger.current!
    node.showPopover()
    const place = () => {
      const anchor = button.getBoundingClientRect(), box = node.getBoundingClientRect()
      setPosition({ left: Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 6, innerHeight - box.height - 8)) })
    }
    place()
    const stopResize = observeResize([node], place)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { stopResize(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!busy && !panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, busy])
  const binding = workspace.schema.fields.find(binding => binding.id === field.fieldId)
  const policy = policyForEntity(snapshot.state.policy, field.entityId)
  const unavailable = busy || !!snapshot.state.session || snapshot.ingress.pending.length > 0
    || snapshot.capabilities.close.lifecycle !== 'open' || !!snapshot.storage && snapshot.storage.kind !== 'idle'
    || disabled || !binding || binding.readonly || !policy.write
    || policy.readonlyPaths.some(path => pathsOverlap(path, binding.path))
  async function restore() {
    if (unavailable) return
    setBusy(true); setFailed(false)
    try {
      const current = workspace.getSnapshot(), binding = workspace.schema.fields.find(binding => binding.id === field.fieldId)
      const row = current.projection.rows.find(row => row.entityId === field.entityId)
      if (current.state.session || !binding || !row?.authority || !resourceValuesEqual(readDocument(row.authority, binding.path), original)) throw new Error('Review the current original value again.')
      const prepared = prepareWorkspaceRestore(workspace, current, [field], messages.restore)
      const cell = trigger.current?.closest<HTMLElement>('[role="gridcell"]')
      const result = await workspace.dispatch({ kind: 'prepared-action', prepared })
      if (result.kind !== 'accepted') throw new Error('Restore was not confirmed.')
      setOpen(false)
      if (cell?.isConnected && (document.activeElement === document.body || panel.current?.contains(document.activeElement))) cell.focus()
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <>
    <button ref={trigger} type="button" className="business-grid__dirty-marker business-grid__dirty-marker-button"
      aria-label={messages.changed(label)} aria-haspopup="dialog" aria-expanded={open}
      onPointerDown={event => event.stopPropagation()} onClick={() => { cancelClose(); setOpen(true) }}
      onFocus={() => { if (!restoringFocus.current) { cancelClose(); setOpen(true) } }} onPointerEnter={event => { if (event.pointerType === 'mouse') { cancelClose(); setOpen(true) } }}
      onPointerLeave={scheduleClose} onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); close() }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(true) }
      }} onBlur={scheduleClose} onKeyUp={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); panel.current?.querySelector('button')?.focus() } }}><span aria-hidden="true" /></button>
    {open && trigger.current ? createPortal(<div ref={panel} popover="manual" role="dialog" aria-label={messages.original} className="business-grid-portal business-grid-dirty-popover"
      style={{ ...position, margin: 0, right: 'auto', bottom: 'auto' }} onPointerDown={event => event.stopPropagation()}
      onPointerEnter={cancelClose} onPointerLeave={scheduleClose} onBlur={scheduleClose} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(true) } }}>
      <span className="business-grid-dirty-popover__label">{messages.original}</span>
      <span className="business-grid-dirty-popover__value">{label}</span>
      <button type="button" className="business-grid__button" disabled={unavailable} onClick={() => { void restore() }}>{busy ? messages.restoring : messages.restore}</button>
      {failed ? <p role="alert">{messages.failed}</p> : null}
    </div>, trigger.current.closest('.business-grid__workspace') ?? document.body) : null}
  </>
}
