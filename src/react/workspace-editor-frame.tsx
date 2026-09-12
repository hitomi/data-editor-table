import { observeResize } from './workspace-resize.js'
import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import type { WorkspaceGridCell } from './workspace-selection.js'

/** Geometry belongs to the view. Moving or removing a cell never changes the
 * session's target or discards its Workspace-owned input. */
export function WorkspaceEditorFrame({ root, cell, children }: Readonly<{
  root: RefObject<HTMLElement | null>; cell: WorkspaceGridCell | null; children: ReactNode
}>) {
  const [bounds, setBounds] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const host = root.current
    if (!host || !cell) { setBounds(null); return }
    const measure = () => {
      const element = [...host.querySelectorAll<HTMLElement>('[role="gridcell"]')].find(element => element.dataset.entityId === cell.entityId && element.dataset.columnKey === cell.columnId)
      if (!element) { setBounds(null); return }
      const rect = element.getBoundingClientRect()
      setBounds(previous => previous && previous.left === rect.left && previous.top === rect.top && previous.width === rect.width && previous.height === rect.height
        ? previous : { left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }
    measure()
    const mutation = new MutationObserver(measure)
    mutation.observe(host, { childList: true, subtree: true, characterData: true })
    const table = host.querySelector('table')
    const stopResize = observeResize(table ? [host, table] : [host], measure)
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => { mutation.disconnect(); stopResize(); window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure) }
  }, [root, cell?.entityId, cell?.columnId])
  return <div className={bounds ? 'business-grid__workspace-inline-editor' : 'business-grid__workspace-editor'}
    style={bounds ? { position: 'fixed', left: bounds.left, top: bounds.top, width: bounds.width, '--workspace-cell-height': `${bounds.height}px` } as React.CSSProperties : undefined}>{children}</div>
}
