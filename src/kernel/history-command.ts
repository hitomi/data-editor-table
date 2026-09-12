import { prepareRedo, prepareUndo, projectHistory } from './history.js'
import { declaredOrderOperation, rowOperationForIntent } from './intent.js'
import { kernelId } from './model.js'
import type { KernelSchema } from './schema.js'
import type { KernelState } from './state.js'
import type { KernelEvent } from './transition.js'

/** Shared preparation for execution and advisory capabilities. The allocator
 * belongs to the caller; this function never reserves identities or runs I/O. */
export function prepareHistoryCommand(state: KernelState, schema: KernelSchema, kind: 'undo' | 'redo', allocate: () => string): Extract<KernelEvent, { kind: 'prepared-undo' | 'prepared-redo' }> {
  const target = projectHistory(state)[kind].at(-1)
  if (!target) throw new Error(`There is no action to ${kind}.`)
  const records = target.intentIds.map(intentId => state.journal.intents.find(intent => intent.id === intentId)!)
  if (kind === 'undo') {
    const entities = new Set(records.flatMap(record => { const operation = rowOperationForIntent(state, record); return operation ? [operation.entityId] : [] }))
    return { kind: 'prepared-undo', prepared: prepareUndo(state, {
      actionId: kernelId<'action'>(allocate()), applicationId: kernelId<'application'>(allocate()),
      controls: [...entities].map(entityId => ({ entityId, intentId: kernelId<'intent'>(allocate()) })),
      ...(records.some(declaredOrderOperation) ? { orderIntentId: kernelId<'intent'>(allocate()) } : {}),
    }) }
  }
  return { kind: 'prepared-redo', prepared: prepareRedo(state, { applicationId: kernelId<'application'>(allocate()),
    controls: records.map(record => ({ sourceIntentId: record.id, intentId: kernelId<'intent'>(allocate()) })),
    creations: records.flatMap(record => { const operation = rowOperationForIntent(state, record)
      return operation?.kind === 'create' ? [{ sourceEntityId: operation.entityId, entityId: kernelId<'entity'>(allocate()) }] : []
    }),
  }, schema) }
}
