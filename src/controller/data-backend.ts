import { assertGridRowDeletable, prepareGridDataAction, type GridAuthoredAction } from '../data/kernel-authoring.js'
import { createGridKernelProjector } from '../data/kernel-projection.js'
import type { GridCompiledDocumentModel } from '../data/runtime-columns.js'
import { prepareHistoryCommand } from '../kernel/history-command.js'
import { rowOperationForIntent } from '../kernel/intent.js'
import { kernelId, type Document, type ExactReceipt, type PreparedAction } from '../kernel/model.js'
import { prepareResolution, type ResolutionIdentities, type ResolutionRequest } from '../kernel/resolution.js'
import { decodeRow } from '../kernel/schema.js'
import { unboundServerIdentities, type ServerAuthority } from '../kernel/source.js'
import type { KernelState } from '../kernel/state.js'
import { draftSubmission, type PreparedSubmission, type SubmissionIdentities } from '../kernel/submission.js'
import { reduceKernel, type KernelEvent } from '../kernel/transition.js'
import type { GridRowKey } from '../model/grid-model.js'
import type { GridRowCapabilities } from '../data/data-source.js'

/** Data-only events. Original controller sessions, queries and task owners
 * remain outside this boundary; there is no second writable editor draft. */
export type GridDataEvent = Extract<KernelEvent, { kind:
  | 'policy-observed' | 'read-started' | 'read-failed'
  | 'not-applied' | 'operation-disputed' | 'operation-dispute-resolved' | 'mutation-uncertain' | 'applied-without-receipt' | 'retry-persistence'
  | 'save-schedule-configured' | 'save-requested' | 'save-wait-ended'
  | 'restore-contributions'
  | 'resource-registered' | 'resource-released'
}>

/** A synchronous, stateless semantic backend. Every method takes the Runtime's
 * captured facts and returns a candidate; only GridControllerRuntime may
 * publish it together with sessions, selection, view and layout. No I/O,
 * subscriptions, timers, mutable rows setter or independently committed state. */
export function createGridDataBackend<Row, RowKey extends GridRowKey>(
  model: GridCompiledDocumentModel<Row>,
  getRowKey: (row: Row) => RowKey,
  rows: GridRowCapabilities<Row> | undefined,
) {
  const project = createGridKernelProjector(model, getRowKey)
  return Object.freeze({
    project,
    commandRows(state: KernelState) {
      const projection = project(state)
      const documents = new Map<RowKey, Document>()
      const keys: RowKey[] = []
      for (const id of projection.data.order.preview) {
        const row = projection.byId.get(id)
        if (!row || row.data.existence === 'pending-delete') continue
        keys.push(row.rowKey)
        documents.set(row.rowKey, row.data.preview!)
      }
      return Object.freeze({ keys: Object.freeze(keys), read: (key: RowKey) => decodeRow(model.codec, documents.get(key)!) })
    },
    prepare: (state: KernelState, action: GridAuthoredAction<Row>) => prepareGridDataAction(state, project(state), model, getRowKey, action, rows?.canDelete),
    apply: (state: KernelState, prepared: PreparedAction) => reduceKernel(state, { kind: 'prepared-action', prepared }, model.schema),
    event: (state: KernelState, event: GridDataEvent) => reduceKernel(state, event, model.schema),
    authority(state: KernelState, authority: ServerAuthority, allocate: () => string) {
      const candidates = unboundServerIdentities(state, authority)
        .map(identity => ({ identity, entityId: kernelId<'entity'>(allocate()) }))
      return reduceKernel(state, { kind: 'server-authority-received', snapshot: authority, candidates }, model.schema)
    },
    receipt: (state: KernelState, receipt: ExactReceipt) => reduceKernel(state, { kind: 'exact-receipt', receipt }, model.schema),
    history(state: KernelState, direction: 'undo' | 'redo', allocate: () => string) {
      const transition = reduceKernel(state, prepareHistoryCommand(state, model.schema, direction, allocate), model.schema)
      // Undoing a saved creation / redoing a deletion prepares a new physical
      // delete. Suppressing an unsaved creation does not, and needs no permission.
      for (const intent of transition.state.journal.intents.slice(state.journal.intents.length)) {
        const operation = rowOperationForIntent(transition.state, intent)
        if (operation?.kind !== 'delete') continue
        const row = project(state).data.rows.find(row => row.entityId === operation.entityId)
        if (row?.preview) assertGridRowDeletable(model, row.preview, rows?.canDelete)
      }
      return transition
    },
    resolve(state: KernelState, request: ResolutionRequest, identities: ResolutionIdentities) {
      const prepared = prepareResolution(state, request, identities, model.schema)
      return reduceKernel(state, { kind: 'prepared-resolution', prepared }, model.schema)
    },
    /** Digest computation runs as a Runtime effect, not inside synchronous
     * acceptance. A hash completion for a stale draft is rejected at freeze. */
    prepareSave: (state: KernelState, identities: Omit<SubmissionIdentities, 'payloadHash'>) => draftSubmission(state, identities, model.schema),
    freezeSave: (state: KernelState, prepared: PreparedSubmission) => reduceKernel(state, { kind: 'freeze-submission', prepared }, model.schema),
  })
}

export type GridDataBackend<Row, RowKey extends GridRowKey> = ReturnType<typeof createGridDataBackend<Row, RowKey>>
