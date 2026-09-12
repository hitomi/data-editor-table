import { useLayoutEffect, useRef, type RefObject, type ReactNode } from 'react'

/** Native modal focus containment; only explicit cancellation closes authoring. */
export function WorkspaceDialog({ label, cancel, children, returnFocus }: Readonly<{ label: string; returnFocus?: RefObject<HTMLElement | null>; cancel(): void; children: ReactNode }>) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current!, previous = returnFocus?.current ?? document.activeElement
    element.showModal()
    return () => { element.close(); queueMicrotask(() => { if (previous instanceof HTMLElement && previous.isConnected && !document.querySelector('dialog[open]')) previous.focus({ preventScroll: true }) }) }
  }, [])
  return <dialog ref={dialog} className="business-grid__workspace-dialog" aria-label={label} onCancel={event => { event.preventDefault(); cancel() }}>{children}</dialog>
}
