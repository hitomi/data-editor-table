import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridCloseBlocker, GridIssue } from '../controller/grid-controller.js'
import { GridConfigurationError } from '../model/grid-result.js'
import type { GridRowKey } from '../model/grid-model.js'
import { createDataGridBinding, type CreateDataGridBindingOptions, type DataGridBinding } from './data-grid-binding.js'

const managedBindings = new WeakMap<object, unknown>()

type LifecycleMessages = Readonly<{
  detachedSourceWork: string
  sourceConfigurationChanged: string
}>

export const DEFAULT_BINDING_MESSAGES: LifecycleMessages = Object.freeze({
  detachedSourceWork: 'Apply, save, or cancel the current table changes before opening another data set.',
  sourceConfigurationChanged: 'The creation settings changed. The current table still uses its original settings. Resolve its pending work before opening a new instance with the new settings.',
})

export type GridAttachmentTarget<Binding, Source> =
  | Readonly<{ kind: 'source'; dataSource: Source }>
  | Readonly<{ kind: 'binding'; binding: Binding }>

export type GridAttachment<Binding, Source> = Readonly<{
  requested: GridAttachmentTarget<Binding, Source>
}> & (
  | Readonly<{ status: 'initializing'; binding: null }>
  | Readonly<{ status: 'ready'; binding: Binding }>
  | Readonly<{ status: 'switch-blocked'; binding: Binding; blockers: readonly [GridCloseBlocker, ...GridCloseBlocker[]] }>
  | Readonly<{ status: 'error'; binding: Binding | null; issue: GridIssue; retry: (() => void) | null }>
)

function configuration<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  options: CreateDataGridBindingOptions<Row, RowKey, Schema, Effect>,
) {
  return {
    registry: options.initial?.registry,
    locale: options.initial?.locale ?? options.initial?.registry?.locale,
    maxMutations: options.initial?.limits?.maxMutations ?? 10_000,
    maxClipboardBytes: options.initial?.limits?.maxClipboardBytes ?? 2_000_000,
  }
}

type ManagedEntry<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect> = {
  kind: 'managed'
  binding: DataGridBinding<Row, RowKey, Schema, Effect>
  configuration: ReturnType<typeof configuration<Row, RowKey, Schema, Effect>>
  owner: object | null
  releaseWhenClean: (() => void) | null
}
type Entry<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect> =
  | ManagedEntry<Row, RowKey, Schema, Effect>
  | { kind: 'host'; binding: DataGridBinding<Row, RowKey, Schema, Effect> }

type BindingRequest<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect> =
  | { binding: DataGridBinding<Row, RowKey, Schema, Effect>; options?: never }
  | { binding?: never; options: CreateDataGridBindingOptions<Row, RowKey, Schema, Effect> }

function acquire<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  options: CreateDataGridBindingOptions<Row, RowKey, Schema, Effect>, owner: object,
): ManagedEntry<Row, RowKey, Schema, Effect> | { kind: 'failed'; issue: GridIssue } {
  const retained = managedBindings.get(options.dataSource) as ManagedEntry<Row, RowKey, Schema, Effect> | undefined
  if (retained) {
    if (retained.binding.controller.getCloseState().status === 'closed') {
      const result = retained.binding.destroy()
      if (result.status === 'cleanup-failed') return { kind: 'failed', issue: {
        code: 'adapter-error', domainCode: 'cleanup-failed', message: result.issues.map(issue => issue.message).join('\n'),
      } }
    }
    if (retained.owner && retained.owner !== owner)
      throw new GridConfigurationError('This data source already has a React binding owner. Use a separate data-source object for an independent grid, or render the existing binding in one viewport.')
    retained.releaseWhenClean?.()
    retained.releaseWhenClean = null
    if (retained.binding.controller.getCloseState().status !== 'closed') {
      retained.owner = owner
      return retained
    }
    managedBindings.delete(options.dataSource)
  }
  const config = configuration(options)
  const binding = createDataGridBinding<Row, RowKey, Schema, Effect>(options)
  const entry: ManagedEntry<Row, RowKey, Schema, Effect> = {
    kind: 'managed', binding, configuration: config, owner, releaseWhenClean: null,
  }
  managedBindings.set(options.dataSource, entry)
  return entry
}

function detach<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  entry: Entry<Row, RowKey, Schema, Effect>, owner: object,
) {
  // Explicit bindings outlive their views and are always disposed by their host.
  if (entry.kind === 'host' || entry.owner !== owner) return
  entry.owner = null
  let queued = false
  const release = () => {
    if (queued) return
    queued = true
    // Recheck outside the notifying command. StrictMode or another view may
    // have reattached this binding before the microtask runs.
    queueMicrotask(() => {
      queued = false
      if (entry.owner || managedBindings.get(entry.binding.dataSource) !== entry) return
      if (entry.binding.controller.getCloseState().status === 'blocked') return
      const result = entry.binding.destroy()
      if (result.status === 'blocked') return
      entry.releaseWhenClean?.()
      entry.releaseWhenClean = null
      // Keep failed disposal evidence reachable for a subsequent attachment;
      // never turn an unconfirmed release into a clean new instance.
      if (result.status === 'cleanup-failed') return
      if (managedBindings.get(entry.binding.dataSource) === entry) managedBindings.delete(entry.binding.dataSource)
    })
  }
  entry.releaseWhenClean = entry.binding.controller.subscribe(release)
  release()
}

function feedback<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  binding: DataGridBinding<Row, RowKey, Schema, Effect>, id: string, message: string | null,
) {
  const existing = binding.controller.getSnapshot().feedback.items.find(item => item.id === id)
  if (message === null) {
    if (existing) binding.controller.dispatch({ type: 'feedback/dismiss', id })
  } else if (existing?.message !== message) {
    binding.controller.dispatch({ type: 'feedback/push', item: { id, kind: 'warning', message, persistent: true } })
  }
}

function sameFields<Value extends object>(left: Value, right: Value) {
  return (Object.keys(left) as (keyof Value)[]).every(key => Object.is(left[key], right[key]))
}

function sameAttachment<Binding, Source>(left: GridAttachment<Binding, Source>, right: GridAttachment<Binding, Source>) {
  if (left.requested !== right.requested || left.status !== right.status || left.binding !== right.binding) return false
  if (left.status === 'switch-blocked' && right.status === 'switch-blocked') return left.blockers.join() === right.blockers.join()
  if (left.status === 'error' && right.status === 'error') return left.issue.code === right.issue.code
    && left.issue.message === right.issue.message && left.retry === right.retry
  return true
}

/** One transition policy for owned grids, the public hook and explicit views. */
export function useGridBindingLifecycle<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  request: BindingRequest<Row, RowKey, Schema, Effect>, messageOverrides?: Partial<LifecycleMessages>,
): GridAttachment<DataGridBinding<Row, RowKey, Schema, Effect>, CreateDataGridBindingOptions<Row, RowKey, Schema, Effect>['dataSource']> {
  type Binding = DataGridBinding<Row, RowKey, Schema, Effect>
  type Source = CreateDataGridBindingOptions<Row, RowKey, Schema, Effect>['dataSource']
  type Attachment = GridAttachment<Binding, Source>
  const [owner] = useState(() => ({}))
  const requested = useMemo<GridAttachmentTarget<Binding, Source>>(() => request.binding
    ? Object.freeze({ kind: 'binding', binding: request.binding })
    : Object.freeze({ kind: 'source', dataSource: request.options.dataSource }), [request.binding, request.options?.dataSource])
  // Explicit initial views stay synchronous; automatic creation waits for commit.
  const active = useRef<Entry<Row, RowKey, Schema, Effect> | null>(
    request.binding ? { kind: 'host', binding: request.binding } : null)
  const [attachment, setAttachment] = useState<Attachment>(() => Object.freeze(active.current
    ? { requested, status: 'ready', binding: active.current.binding }
    : { requested, status: 'initializing', binding: null }))
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  // A failed candidate is retried by a changed request or explicit retry, never
  // by the render which reports its own failure.
  const failure = useRef<{
    requested: GridAttachmentTarget<Binding, Source>
    config: ReturnType<typeof configuration<Row, RowKey, Schema, Effect>> | null
    attempt: number
    issue: GridIssue
    retryable: boolean
  } | null>(null)

  useLayoutEffect(() => {
    const previous = active.current
    const same = previous && (request.binding
      ? previous.binding === request.binding
      : previous.kind === 'managed' && previous.binding.dataSource === request.options.dataSource)
    const config = request.options ? configuration(request.options) : null
    const locale = request.binding?.locale ?? config?.locale
    const messages = { ...DEFAULT_BINDING_MESSAGES, ...locale?.dataGrid, ...messageOverrides }
    const publish = (next: Attachment) => setAttachment(current => sameAttachment(current, next) ? current : Object.freeze(next))
    const report = (issue: GridIssue, retryable: boolean) => {
      const binding = active.current?.binding ?? null
      if (binding) feedback(binding, 'grid:attachment-error', issue.message)
      publish({ requested, status: 'error', binding, issue, retry: retryable ? retry : null })
    }
    const waitForPrevious = (waiting: Entry<Row, RowKey, Schema, Effect>, blockers: readonly [GridCloseBlocker, ...GridCloseBlocker[]]) => {
      feedback(waiting.binding, 'grid:attachment-error', null)
      feedback(waiting.binding, 'grid:detached-source-work', messages.detachedSourceWork)
      publish({ requested, status: 'switch-blocked', binding: waiting.binding, blockers })
      let watching = true
      let queued = false
      const signature = blockers.join()
      const recheck = () => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          if (!watching || active.current !== waiting) return
          const close = waiting.binding.controller.getCloseState()
          if (close.status !== 'blocked' || close.blockers.join() !== signature) retry()
        })
      }
      const unsubscribe = waiting.binding.controller.subscribe(recheck)
      recheck()
      return () => { watching = false; unsubscribe() }
    }
    if (previous && !same) {
      const close = previous.binding.controller.getCloseState()
      if (close.status === 'blocked') return waitForPrevious(previous, close.blockers)
    }
    const failed = failure.current
    if (failed && failed.requested === requested && failed.attempt === attempt
      && (failed.config === config || (failed.config && config && sameFields(failed.config, config)))) {
      report(failed.issue, failed.retryable)
      return
    }
    failure.current = null
    let next: Entry<Row, RowKey, Schema, Effect>
    try {
      if (same) next = previous
      else if (request.binding) next = { kind: 'host', binding: request.binding }
      else {
        const acquired = acquire(request.options, owner)
        if (acquired.kind === 'failed') {
          failure.current = { requested, config, attempt, issue: acquired.issue, retryable: false }
          report(acquired.issue, false)
          return
        }
        next = acquired
      }
    } catch (error) {
      const issue: GridIssue = error instanceof GridConfigurationError ? error.issue
        : { code: 'adapter-error', message: error instanceof Error ? error.message : String(error) }
      const retryable = !(error instanceof GridConfigurationError)
      failure.current = { requested, config, attempt, issue, retryable }
      report(issue, retryable)
      return
    }
    if (next.binding.controller.getCloseState().status === 'closed') {
      if (active.current === next) active.current = null
      report({ code: 'closed', message: 'This binding is closed. Create a new binding to open the table.' }, false)
      return
    }
    // Candidate initialization invokes host code. It may introduce old work.
    if (previous && previous !== next) {
      const close = previous.binding.controller.getCloseState()
      if (close.status === 'blocked') {
        detach(next, owner)
        return waitForPrevious(previous, close.blockers)
      }
    }
    if (next.kind === 'managed' && request.options && config) {
      if (!sameFields(next.configuration, config)) {
        // A detached instance may contain pending input. With no previous view,
        // attach it for recovery while reporting that its old settings still apply.
        if (!previous) active.current = next
        else if (next !== previous) detach(next, owner)
        report({ code: 'invalid-configuration', message: messages.sourceConfigurationChanged }, false)
        return
      }
      const updated = next.binding.controller.updateEffects(request.options.effects)
      if (!updated.accepted) {
        if (next !== previous) detach(next, owner)
        report(updated.issue, true)
        return
      }
    }
    active.current = next
    if (previous && previous !== next) detach(previous, owner)
    feedback(next.binding, 'grid:detached-source-work', null)
    feedback(next.binding, 'grid:attachment-error', null)
    publish({ requested, status: 'ready', binding: next.binding })
  })

  useLayoutEffect(() => () => {
    const current = active.current
    active.current = null
    if (current) detach(current, owner)
  }, [owner])

  return attachment
}

/** Reports actual attachment separately from source loading. Pending input
 * remains on the old binding during a blocked switch or failed initialization. */
export function useDataGridBinding<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect = never>(
  options: CreateDataGridBindingOptions<Row, RowKey, Schema, Effect>,
): GridAttachment<DataGridBinding<Row, RowKey, Schema, Effect>, CreateDataGridBindingOptions<Row, RowKey, Schema, Effect>['dataSource']> {
  return useGridBindingLifecycle({ options })
}
