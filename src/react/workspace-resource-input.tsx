import { useId, useState } from 'react'
import type { TaskDefinitionRef, TaskState } from '../kernel/model.js'
import type { TaskExecutor, Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'

export type WorkspaceResourceTask = Readonly<{ kind: 'durable'; definition: TaskDefinitionRef }> | Readonly<{ kind: 'memory'; execute: TaskExecutor }>
export type WorkspaceResourceMessages = Readonly<{ choose: string; pending: string; failed: string; result: string; reapply: string; reviewInput: string; recovery: string; input: string; currentTarget: string; unavailable: string; preparingDownload: string; task(index: number): string; download(name: string): string; cancel: string; cancelHelp: string; status: Readonly<Record<TaskState['kind'] | 'unknown', string>> }>

/** Choosing bytes transfers them to Workspace before task registration. The
 * task owner is captured before awaiting storage, never rebound to a later edit.
 * Unmount does not cancel execution or release retained bytes. */
export function WorkspaceResourceInput({ workspace, snapshot, task, messages }: Readonly<{
  workspace: Workspace; snapshot: WorkspaceSnapshot; task: WorkspaceResourceTask; messages: WorkspaceResourceMessages
}>) {
  const id = useId(), session = snapshot.state.session
  const [attempt, setAttempt] = useState<Readonly<{ workspace: Workspace; sessionId: string; pending: boolean; failed: boolean }> | null>(null)
  const current = attempt?.workspace === workspace && attempt.sessionId === session?.id ? attempt : null
  const tasks = snapshot.state.tasks.filter(task => task.owner.kind === 'session' && task.owner.sessionId === session?.id)
  const pending = tasks.some(task => task.kind === 'queued' || task.kind === 'running')
  const failed = tasks.some(task => task.kind === 'failed' || task.kind === 'blocked' || task.kind === 'superseded')
  const ready = session?.editor && session.composition === 'idle' && !session.issues.length && snapshot.editorInput?.status === 'published'
    && !snapshot.ingress.pending.length && (!snapshot.storage || snapshot.storage.kind === 'idle') && snapshot.capabilities.close.lifecycle === 'open'
  async function choose(element: HTMLInputElement) {
    const file = element.files?.[0]
    if (!file || !ready || !session) return
    const owner = { kind: 'session' as const, sessionId: session.id, input: session.input }
    const started = { workspace, sessionId: session.id, pending: true, failed: false }
    setAttempt(started)
    let failed = false
    try {
      const input = await workspace.registerResource(file)
      const request = { owner, input, reads: [] }
      const run = task.kind === 'durable' ? workspace.runDurableTask({ ...request, definition: task.definition }) : workspace.runTask(request, task.execute)
      const result = await run.result
      if (result.kind !== 'accepted') failed = true
      else if (element.files?.[0] === file) element.value = ''
    } catch { failed = true }
    setAttempt(previous => previous === started ? { ...started, pending: false, failed } : previous)
  }
  return <div>
    <label htmlFor={id}>{messages.choose}</label>
    <input id={id} type="file" disabled={!ready || current?.pending || pending} onChange={event => { void choose(event.currentTarget) }} />
    {current?.pending || pending ? <p role="status">{messages.pending}</p> : null}

    {current?.failed || failed ? <p role="alert">{messages.failed}</p> : null}
  </div>
}
