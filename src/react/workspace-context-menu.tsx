import { observeResize } from './workspace-resize.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type WorkspaceMenuAction = Readonly<{ id: string; label: string; disabled: boolean; run(): void }>
export type WorkspaceMenuAnchor = Readonly<{ x: number; y: number; element: HTMLElement }>

/** A transient command chooser. The native top layer preserves inherited grid
 * theme tokens without clipping the menu inside a scrolling/transformed grid. */
export function WorkspaceContextMenu({ anchor, actions, label, close, isCurrent }: Readonly<{
  anchor: WorkspaceMenuAnchor; actions: readonly WorkspaceMenuAction[]; label: string; close(restoreFocus: boolean): void; isCurrent(): boolean
}>) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y })
  useLayoutEffect(() => {
    const node = menu.current!
    node.showPopover()
    const place = () => {
      const rect = node.getBoundingClientRect()
      setPosition({ left: Math.max(8, Math.min(anchor.x, innerWidth - rect.width - 8)), top: Math.max(8, Math.min(anchor.y, innerHeight - rect.height - 8)) })
    }
    place()
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const stopResize = observeResize([node], place)
    window.addEventListener('resize', place)
    return () => {
      stopResize(); window.removeEventListener('resize', place)
      if (node.contains(document.activeElement) && anchor.element.isConnected) anchor.element.focus()
    }
  }, [anchor])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [close])
  return <div ref={menu} popover="manual" role="menu" aria-label={label} className="business-grid-portal business-grid-menu"
    style={{ ...position, margin: 0, insetInlineEnd: 'auto', insetBlockEnd: 'auto' }}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (event.key === 'Tab') { close(true); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }}>
    {actions.map(action => <button key={action.id} type="button" role="menuitem" tabIndex={-1} disabled={action.disabled}
      onClick={() => { const current = isCurrent(); close(true); if (current) action.run() }}>{action.label}</button>)}
  </div>
}
