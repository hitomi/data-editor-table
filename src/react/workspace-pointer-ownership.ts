import type { Workspace } from '../kernel/workspace.js'

// Lifecycle controls may be composed outside DataGrid's React subtree. Their
// explicit input disposition must not race an implicit outside-pointer apply.
const owners = new WeakMap<Event, Workspace>()
export function retainWorkspacePointerInput(event: Event, workspace: Workspace) {
  owners.set(event, workspace)
}
export function retainsWorkspacePointerInput(event: Event, workspace: Workspace) {
  return owners.get(event) === workspace
}
