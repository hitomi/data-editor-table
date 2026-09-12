import { useId, useRef, useState } from 'react'
import type { InputRef, SessionId, TaskDefinitionRef, TaskState } from '../kernel/model.js'
import type { TaskExecutor, Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'

export type WorkspaceResourceTask = (Readonly<{ kind: 'durable'; definition: TaskDefinitionRef }> | Readonly<{ kind: 'memory'; execute: TaskExecutor }>)
  & Readonly<{ accept?: string; maxBytes?: number; pickOnEdit?: boolean; applyOnUpload?: boolean }>
export type WorkspaceResourceMessages = Readonly<{ unsupportedType: string; tooLarge(bytes: number): string; drop: string; choose: string; pending: string; failed: string; result: string; reapply: string; reviewInput: string; recovery: string; input: string; currentTarget: string; unavailable: string; preparingDownload: string; task(index: number): string; download(name: string): string; cancel: string; cancelHelp: string; status: Readonly<Record<TaskState['kind'] | 'unknown', string>> }>

/** The native accept attribute only filters the picker. Drops and replacements
 * use the same preflight before opening a session or cancelling existing tasks. */
export function assertResourceTask(task: WorkspaceResourceTask): void {
  if (task.maxBytes !== undefined && (!Number.isSafeInteger(task.maxBytes) || task.maxBytes <= 0)) throw new Error('maxBytes must be a positive safe integer.')
}
export function resourceFileError(file: File, task: WorkspaceResourceTask, messages: WorkspaceResourceMessages): string | null {
  if (task.maxBytes !== undefined && file.size > task.maxBytes) return messages.tooLarge(task.maxBytes)
  if (task.accept?.trim() && !task.accept.split(',').some(part => {
    const rule = part.trim().toLowerCase()
    return rule.startsWith('.') ? file.name.toLowerCase().endsWith(rule)
      : rule.endsWith('/*') ? file.type.toLowerCase().startsWith(rule.slice(0, -1))
      : !!rule && file.type.toLowerCase() === rule
  })) return messages.unsupportedType
  return null
}

/** Choosing bytes transfers them to Workspace before task registration. The
 * task owner is captured before awaiting storage, never rebound to a later edit.
 * Unmount does not cancel execution or release retained bytes. */
export function WorkspaceResourceInput({ workspace, snapshot, task, messages, onResultApplied }: Readonly<{
  workspace: Workspace; snapshot: WorkspaceSnapshot; task: WorkspaceResourceTask; messages: WorkspaceResourceMessages
  onResultApplied?(sessionId: SessionId, input: InputRef): void
}>) {
  assertResourceTask(task)
  const id = useId(), session = snapshot.state.session
  const [attempt, setAttempt] = useState<Readonly<{ workspace: Workspace; sessionId: string; pending: boolean; failed: boolean; validation?: string }> | null>(null)
  const activeAttempt = useRef<typeof attempt>(null)
  const current = attempt?.workspace === workspace && attempt.sessionId === session?.id ? attempt : null
  const tasks = snapshot.state.tasks.filter(task => task.owner.kind === 'session' && task.owner.sessionId === session?.id)
  const pending = tasks.some(task => task.kind === 'queued' || task.kind === 'running')
  const failed = tasks.some(task => task.kind === 'failed' || task.kind === 'blocked' || task.kind === 'superseded')
  const ready = session?.editor && session.composition === 'idle' && !session.issues.length && snapshot.editorInput?.status === 'published'
    && !snapshot.ingress.pending.length && (!snapshot.storage || snapshot.storage.kind === 'idle') && snapshot.capabilities.close.lifecycle === 'open'
  async function choose(file: File, element?: HTMLInputElement) {
    if (!ready || !session || activeAttempt.current?.workspace === workspace && activeAttempt.current.sessionId === session.id) return
    const validation = resourceFileError(file, task, messages)
    if (validation) { setAttempt({ workspace, sessionId: session.id, pending: false, failed: false, validation }); return }
    const owner = { kind: 'session' as const, sessionId: session.id, input: session.input }
    const started = { workspace, sessionId: session.id, pending: true, failed: false }
    activeAttempt.current = started
    setAttempt(started)
    let failed = false
    try {
      // Replacing a file ends the old tasks' authority to publish before the
      // new registration awaits storage. Their bytes/results remain retained.
      const cancellations = tasks.filter(task => task.kind !== 'consumed' && task.kind !== 'cancelled')
        .map(task => workspace.dispatch({ kind: 'task-cancelled', taskId: task.id, executionId: task.executionId }))
      const [input, cancelled] = await Promise.all([workspace.registerResource(file), Promise.all(cancellations)])
      if (cancelled.some(result => result.kind !== 'accepted' && result.kind !== 'ignored')) throw new Error('Previous file tasks could not be cancelled.')
      const request = { owner, input, reads: [] }
      const run = task.kind === 'durable' ? workspace.runDurableTask({ ...request, definition: task.definition }) : workspace.runTask(request, task.execute)
      const result = await run.result
      if (result.kind !== 'accepted') failed = true
      else {
        if (element?.files?.[0] === file) element.value = ''
        if (task.applyOnUpload && onResultApplied) void workspace.waitForTask(run.taskId).then(finished => {
          if (finished?.kind === 'consumed' && finished.destination.kind === 'session') onResultApplied(finished.destination.sessionId, finished.destination.input)
        }).catch(() => { setAttempt(previous => previous === started ? { ...started, pending: false, failed: true } : previous) })
      }
    } catch { failed = true }
    if (activeAttempt.current === started) activeAttempt.current = null
    setAttempt(previous => previous === started ? { ...started, pending: false, failed } : previous)
  }
  return <div role="group" aria-label={messages.drop}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault(); event.stopPropagation()
      event.dataTransfer.dropEffect = ready && !current?.pending ? 'copy' : 'none'
    }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault(); event.stopPropagation()
      const file = event.dataTransfer.files[0]
      if (file) void choose(file)
    }}>
    <label htmlFor={id}>{messages.choose}</label>
    <input id={id} type="file" accept={task.accept} disabled={!ready || current?.pending} onChange={event => {
      const file = event.currentTarget.files?.[0]
      if (file) void choose(file, event.currentTarget)
    }} />
    {current?.pending || pending ? <p role="status">{messages.pending}</p> : null}

    {current?.validation ? <p role="alert">{current.validation}</p> : null}
    {current?.failed || failed ? <p role="alert">{messages.failed}</p> : null}
  </div>
}
