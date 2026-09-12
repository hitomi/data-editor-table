import { memo, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useWorkspaceSelector, useWorkspaceSnapshot } from '../../../src/react/workspace-react.js'
import { workspaceForReactFixture } from './durable-workspace.js'
import type { Workspace, WorkspaceSnapshot } from '../../../src/kernel/workspace.js'

let root: Root | null = null
const owners = new Map<string, Workspace>()
const rendered = new Map<Workspace, number>()
const subscriptions = new Map<Workspace, number>()
const publishedInput = (snapshot: WorkspaceSnapshot) => ({ raw: snapshot.state.session?.rawInput })
const equalPublished = (left: ReturnType<typeof publishedInput>, right: ReturnType<typeof publishedInput>) => left.raw === right.raw
const PublishedInput = memo(function PublishedInput({ workspace }: { workspace: Workspace }) {
  const { raw } = useWorkspaceSelector(workspace, publishedInput, { isEqual: equalPublished })
  rendered.set(workspace, (rendered.get(workspace) ?? 0) + 1)
  return <output aria-label="Published input">{raw?.kind === 'encoded' ? String(raw.value) : ''}</output>
})
function Editor({ workspace }: { workspace: Workspace }) {
  const snapshot = useWorkspaceSnapshot(workspace)
  const session = snapshot.state.session, input = snapshot.editorInput?.input ?? session?.rawInput
  const displayed = input?.kind === 'encoded' ? String(input.value) : ''
  return <section>
    <label>Workspace input<input value={displayed} onChange={event => {
      if (session?.editor) workspace.typeInput(session.editor, { kind: 'encoded', value: event.currentTarget.value })
    }} /></label>
    <PublishedInput workspace={workspace} />
    <output aria-label="Storage state">{snapshot.storage?.kind ?? 'memory'}</output>
    <output aria-label="Workspace lifecycle">{snapshot.capabilities.close.lifecycle}</output>
  </section>
}
export function mountWorkspaceView(container: HTMLElement) {
  if (root) throw new Error('Unmount the previous fixture view first')
  root = createRoot(container)
  root.render(<StrictMode><Editor workspace={workspaceForReactFixture()} /></StrictMode>)
}
export function unmountWorkspaceView() { root?.unmount(); root = null }

export function captureWorkspaceViewOwner(name: string) {
  const workspace = workspaceForReactFixture()
  if (!subscriptions.has(workspace)) {
    subscriptions.set(workspace, 0)
    const subscribe = workspace.subscribe.bind(workspace)
    // Fixture-only instrumentation of real subscription cleanup.
    workspace.subscribe = listener => {
      const detach = subscribe(listener)
      subscriptions.set(workspace, subscriptions.get(workspace)! + 1)
      return () => { detach(); subscriptions.set(workspace, subscriptions.get(workspace)! - 1) }
    }
  }
  owners.set(name, workspace)
}
export function selectWorkspaceViewOwner(name: string) {
  const workspace = owners.get(name)
  if (!root || !workspace) throw new Error('Expected a mounted view and captured owner')
  root.render(<StrictMode><Editor workspace={workspace} /></StrictMode>)
}
export async function typeIntoWorkspaceViewOwner(name: string, value: string) {
  const workspace = owners.get(name)
  if (!workspace?.getState().session?.editor) throw new Error('Expected a live editor')
  return workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value }).completion
}
export function workspaceViewOwner(name: string) {
  const workspace = owners.get(name)
  if (!workspace) throw new Error('Expected a captured owner')
  return { raw: workspace.getSnapshot().editorInput?.input, lifecycle: workspace.requestClose().lifecycle, renders: rendered.get(workspace) ?? 0, subscriptions: subscriptions.get(workspace) ?? 0 }
}
