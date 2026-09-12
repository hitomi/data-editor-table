import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'

/** The host owns Workspace creation, recovery and close. React subscription
 * cleanup only detaches the view; it never discards input or releases a lease.
 * SSR requires the host's matching serialized initial observation explicitly. */
export function useWorkspaceSnapshot(workspace: Workspace, serverSnapshot?: WorkspaceSnapshot): WorkspaceSnapshot {
  const subscribe = useCallback((listener: () => void) => workspace.subscribe(listener), [workspace])
  const getSnapshot = useCallback(() => workspace.getSnapshot(), [workspace])
  const getServerSnapshot = useCallback(() => serverSnapshot!, [serverSnapshot])
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot ? getServerSnapshot : undefined)
}

function selectedReader<Selected>(read: () => WorkspaceSnapshot, selector: (snapshot: WorkspaceSnapshot) => Selected,
  isEqual: (left: Selected, right: Selected) => boolean): () => Selected {
  let cached: { snapshot: WorkspaceSnapshot; selected: Selected } | null = null
  return () => {
    const snapshot = read()
    if (cached?.snapshot === snapshot) return cached.selected
    const next = selector(snapshot)
    const selected = cached && isEqual(cached.selected, next) ? cached.selected : next
    cached = { snapshot, selected }
    return selected
  }
}

/** Selectors are read-only views of the owner's observation. Each render's
 * reader is scoped to its Workspace/selector/equality, so an interrupted or
 * replaced render cannot change another render's selection through a ref. */
export function useWorkspaceSelector<Selected>(workspace: Workspace, selector: (snapshot: WorkspaceSnapshot) => Selected,
  options: Readonly<{ isEqual?: (left: Selected, right: Selected) => boolean; serverSnapshot?: WorkspaceSnapshot }> = {}): Selected {
  const { isEqual = Object.is, serverSnapshot } = options
  const subscribe = useCallback((listener: () => void) => workspace.subscribe(listener), [workspace])
  const getSnapshot = useMemo(() => selectedReader(() => workspace.getSnapshot(), selector, isEqual), [workspace, selector, isEqual])
  const getServerSnapshot = useMemo(() => serverSnapshot ? selectedReader(() => serverSnapshot, selector, isEqual) : undefined,
    [serverSnapshot, selector, isEqual])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
