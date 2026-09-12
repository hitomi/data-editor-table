import { ownEncodedValue } from './document.js'
import { emptyFrontierTable } from './frontier-table.js'
import type { EntityRegistry } from './entities.js'
import type {
  ResourceId, CloseTicket, AuthorityFrontier, AuthorityState, AuthorityVersion, EncodedValue, EntityId, ExactReceipt, FieldRef, FrozenSubmission, InputRecord, IntentJournal, IntentSettlement, KernelIssue, NotAppliedProof, ObservationId,
  PersistenceState, PolicyVersion, RecoveryEntry, ResourceRecord, SaveSchedule, Session, SessionId, StoragePath, TaskState, ViewQuery, WorkspaceIdentity,
} from './model.js'

export type EntityPolicy = Readonly<{
  write: boolean
  replace: boolean
  delete: boolean
  readonlyPaths: readonly StoragePath[]
}>
/** Host policy evaluation becomes an owned event snapshot. Neither the
 * projector nor the reducer calls a mutable host permission callback.
 */
export type PolicySnapshot = Readonly<{
  version: PolicyVersion
  create: boolean
  order: boolean
  defaultEntity: EntityPolicy
  entities: readonly Readonly<{ entityId: EntityId; policy: EntityPolicy }>[]
}>
export type CommitFact = Readonly<{ submission: FrozenSubmission; receipt: ExactReceipt }>
export type KernelState = Readonly<{
  revision: number
  discards: readonly Readonly<{ ticket: CloseTicket; applicationCount: number; resources: readonly ResourceId[] }>[]
  workspace: WorkspaceIdentity
  sourceCapabilities: Readonly<{ restoreDeleted: boolean }>
  authority: AuthorityState
  authorityFrontier: AuthorityFrontier
  observations: readonly Readonly<{ id: ObservationId; version: AuthorityVersion }>[]
  policy: PolicySnapshot
  policies: readonly PolicySnapshot[]
  entities: EntityRegistry
  journal: IntentJournal
  inputs: readonly InputRecord[]
  resources: readonly ResourceRecord[]
  recoveries: readonly RecoveryEntry[]
  session: Session | null
  sessionIds: readonly SessionId[]
  editorGeneration: number
  view: ViewQuery
  viewHistory: readonly ViewQuery[]
  tasks: readonly TaskState[]
  fieldGenerations: readonly Readonly<{ field: FieldRef; generation: number }>[]
  settlements: readonly IntentSettlement[]
  commits: readonly CommitFact[]
  rejections: readonly Readonly<{ submission: FrozenSubmission; proof: NotAppliedProof }>[]
  protocolFaults: readonly Readonly<{ issue: KernelIssue; evidence: EncodedValue }>[]
  persistence: PersistenceState
  schedule: SaveSchedule
}>

export function ownPolicy(policy: PolicySnapshot): PolicySnapshot {
  const owned = ownEncodedValue(policy) as unknown as PolicySnapshot
  if (!owned.version || new Set(owned.entities.map(entry => entry.entityId)).size !== owned.entities.length)
    throw new Error('Policy requires a version and unique entity entries.')
  if (typeof owned.create !== 'boolean' || typeof owned.order !== 'boolean') throw new Error('Policy capabilities must be explicit booleans.')
  for (const entry of [owned.defaultEntity, ...owned.entities.map(entry => entry.policy)]) {
    if (typeof entry.write !== 'boolean' || typeof entry.replace !== 'boolean' || typeof entry.delete !== 'boolean'
      || entry.readonlyPaths.some(path => path.length === 0 || path.some(segment => typeof segment !== 'string')))
      throw new Error('Entity policy requires explicit capabilities and valid read-only paths.')
  }
  return owned
}

export function createKernelState(workspace: WorkspaceIdentity, policy: PolicySnapshot, sourceCapabilities: Readonly<{ restoreDeleted: boolean }> = { restoreDeleted: false }): KernelState {
  const owned = ownEncodedValue(workspace) as unknown as WorkspaceIdentity
  if (!owned.id || !owned.scope.sourceId || !owned.scope.id || !owned.scope.epoch || !owned.schema || !owned.codec)
    throw new Error('Workspace, scope, schema and codec identities are required.')
  const ownedPolicy = ownPolicy(policy)
  const view: ViewQuery = Object.freeze({ version: 0, filters: Object.freeze([]), sort: Object.freeze([]) })
  if (typeof sourceCapabilities.restoreDeleted !== 'boolean') throw new Error('Deletion restoration must be an explicit source guarantee.')
  return Object.freeze({
    revision: 0, discards: Object.freeze([]), workspace: owned, sourceCapabilities: Object.freeze({ restoreDeleted: sourceCapabilities.restoreDeleted }), policy: ownedPolicy, policies: Object.freeze([ownedPolicy]), observations: Object.freeze([]), authorityFrontier: Object.freeze([]),
    authority: Object.freeze({ content: Object.freeze({ kind: 'uninitialized' }), read: Object.freeze({ kind: 'idle' }) }),
    entities: Object.freeze([]), journal: Object.freeze({ intents: Object.freeze([]), actions: Object.freeze([]), frontiers: emptyFrontierTable(owned) }),
    inputs: Object.freeze([]), resources: Object.freeze([]), recoveries: Object.freeze([]), session: null, sessionIds: Object.freeze([]), editorGeneration: 0,
    view, viewHistory: Object.freeze([view]),
    tasks: Object.freeze([]), fieldGenerations: Object.freeze([]),
    settlements: Object.freeze([]), commits: Object.freeze([]), rejections: Object.freeze([]), protocolFaults: Object.freeze([]), persistence: Object.freeze({ kind: 'idle' }),
    schedule: Object.freeze({ mode: 'manual', debounceMs: 0, token: 0, pending: false }),
  })
}

export function policyForEntity(policy: PolicySnapshot, entityId: EntityId): EntityPolicy {
  return policy.entities.find(entry => entry.entityId === entityId)?.policy ?? policy.defaultEntity
}
