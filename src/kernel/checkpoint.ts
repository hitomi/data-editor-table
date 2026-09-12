import { assertJournalFrontiers } from './journal-frontiers.js'
import { assertDiscardLedger } from './discard.js'
import { ingressInputs, matchesIngressEvent } from './ingress.js'
import { inputResources } from './resource-ownership.js'
import { canonicalEncodedValue, ownEncodedValue } from './document.js'
import { restoreIngressCheckpoint, type IngressCheckpoint } from './ingress-checkpoint.js'
import type { CloseTicket, RecoveryRoot, WorkspaceIdentity } from './model.js'
import { ResourceStore, type ResourceCheckpoint } from './resource-store.js'
import { recoveryRoot, sameRecoveryValue, validateRecoveryWrite, type RecoveryRecord } from './recovery-store.js'
import type { RecoveryReservation } from './recovery-scan.js'
import { assertKernelSchema, type KernelSchema } from './schema.js'
import { assertSaveSchedule } from './save-schedule.js'
import type { KernelState } from './state.js'

export type CheckpointStorage = Readonly<{ kind: 'memory' }>
  | Readonly<{ kind: 'durable'; epoch: string; root: RecoveryRoot | null; record: RecoveryRecord | null; pending: RecoveryRecord | null }>
export type CheckpointMetadata = Readonly<{
  format: 2
  state: KernelState
  ticket: CloseTicket
  ingress: IngressCheckpoint
  resources: Omit<ResourceCheckpoint, 'bundle'> & Readonly<{ manifest: ResourceCheckpoint['bundle']['manifest'] }>
  storage: CheckpointStorage
  reservation: RecoveryReservation | null
}>
/** Integrity is not authentication: import only checkpoints from a trusted
 * owner/store. Validation installs no lease and executes no events or I/O. */
export type WorkspaceCheckpoint = Readonly<{ metadata: CheckpointMetadata; sha256: string; contents: ResourceCheckpoint['bundle']['contents'] }>

async function hash(metadata: CheckpointMetadata): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalEncodedValue(ownEncodedValue(metadata)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}
function matchesEvent(active: IngressCheckpoint['snapshot']['pending'][number], record: RecoveryRecord): boolean {
  if (active.phase !== 'committing' && active.phase !== 'uncertain') return false
  return matchesIngressEvent(active.event, record.event)
}

export async function createWorkspaceCheckpoint(snapshot: Omit<CheckpointMetadata, 'format' | 'resources'>, physical: Promise<ResourceCheckpoint>, schema: KernelSchema): Promise<WorkspaceCheckpoint> {
  const owned = ownEncodedValue(snapshot) as unknown as typeof snapshot
  const resources = await physical
  const metadata = ownEncodedValue({ format: 2, ...owned, resources: { format: resources.format, retired: resources.retired, manifest: resources.bundle.manifest } }) as unknown as CheckpointMetadata
  const checkpoint = Object.freeze({ metadata, sha256: await hash(metadata), contents: resources.bundle.contents })
  await validateWorkspaceCheckpoint(checkpoint, schema)
  return checkpoint
}

export function validateWorkspaceCheckpoint(raw: WorkspaceCheckpoint, schema: KernelSchema) {
  return validateCheckpoint(raw, workspace => assertKernelSchema(workspace, schema))
}

/** Storage verifies the complete envelope against its owned workspace. The
 * executor additionally verifies the installed schema before activation. */
export function validateStoredCheckpoint(raw: WorkspaceCheckpoint, expected: WorkspaceIdentity) {
  const workspace = ownEncodedValue(expected) as unknown as WorkspaceIdentity
  return validateCheckpoint(raw, actual => {
    if (!sameRecoveryValue(actual, workspace)) throw new Error('Checkpoint belongs to another storage workspace.')
  })
}

async function validateCheckpoint(raw: WorkspaceCheckpoint, assertWorkspace: (workspace: WorkspaceIdentity) => void) {
  const metadata = ownEncodedValue(raw.metadata) as unknown as CheckpointMetadata, digest = raw.sha256
  const contents = Object.freeze(raw.contents.map(content => Object.freeze({ resourceId: content.resourceId, blob: content.blob })))
  const { state, ticket, ingress, storage } = metadata
  if (metadata.format !== 2 || !Number.isSafeInteger(state.revision) || state.revision < 0 || ticket.workspaceId !== state.workspace.id
    || ticket.semanticRevision !== state.revision || ticket.ingressGeneration !== ingress.snapshot.generation
    || !ticket.leaseEpoch || !Number.isSafeInteger(ticket.runtimeGeneration) || ticket.runtimeGeneration < 0) throw new Error('Checkpoint ticket does not bind its complete captured state.')
  assertJournalFrontiers(state)
  assertWorkspace(state.workspace); assertSaveSchedule(state.schedule); assertDiscardLedger(state)
  restoreIngressCheckpoint(ingress, state)
  const physicalIds = new Set(metadata.resources.manifest.entries.map(entry => entry.descriptor.id))
  if ([...inputResources(ingressInputs(ingress.snapshot))].some(id => !physicalIds.has(id))) throw new Error('Retained ingress input references unavailable checkpoint bytes.')
  for (const entry of ingress.snapshot.pending) if (entry.payload.kind === 'event') {
    const event = entry.payload.event
    if (event.kind === 'resource-registered' && !metadata.resources.manifest.entries.some(resource => sameRecoveryValue(resource.descriptor, event.descriptor)))
      throw new Error('Pending resource registration lacks its exact physical content.')
    if (event.kind === 'task-registered' && !event.execution && !event.definition) throw new Error('A retained memory task registration cannot restore its callback.')
  }
  for (const task of state.tasks) if (!task.execution && (task.kind === 'queued' || task.kind === 'running')) {
    const retainedOutcome = ingress.snapshot.pending.some(entry => entry.payload.kind === 'event'
      && (entry.payload.event.kind === 'task-completed' || entry.payload.event.kind === 'task-failed')
      && entry.payload.event.taskId === task.id && entry.payload.event.executionId === task.executionId)
    if (!retainedOutcome) throw new Error('The checkpoint cannot restore a live memory task callback.')
  }
  const active = ingress.snapshot.pending.find(entry => entry.phase === 'committing' || entry.phase === 'uncertain')
  const restoring = ResourceStore.restoreCheckpoint(state, { format: metadata.resources.format, retired: metadata.resources.retired,
    bundle: { manifest: metadata.resources.manifest, contents } })
  // Observe resource validation even when an independent integrity check fails.
  const [physical, actualHash] = await Promise.all([restoring, hash(metadata)])
  if (digest !== actualHash) throw new Error('Workspace checkpoint digest does not match all captured components.')
  if (storage.kind === 'durable') {
    if (!storage.epoch || storage.epoch !== ticket.leaseEpoch || Boolean(storage.root) !== Boolean(storage.record)) throw new Error('Checkpoint storage root lacks its exact published record and lease.')
    const validateRecord = async (record: RecoveryRecord) => {
      const wanted = new Set(record.manifest.entries.map(entry => entry.descriptor.id))
      await validateRecoveryWrite({ record, contents: contents.filter(content => wanted.has(content.resourceId)) }, state.workspace)
    }
    if (storage.record) {
      await validateRecord(storage.record)
      if (!sameRecoveryValue(storage.root, recoveryRoot(storage.record.commit)) || !sameRecoveryValue(state, storage.record.transition.state))
        throw new Error('Checkpoint semantic state differs from its published durable root.')
    } else if (state.revision !== 0) throw new Error('A noninitial durable state requires a published root.')
    if (storage.pending) {
      await validateRecord(storage.pending)
      if (!sameRecoveryValue(storage.pending.commit.parent, storage.root) || storage.pending.commit.token.leaseEpoch !== storage.epoch
        || !active || !matchesEvent(active, storage.pending) || (active.phase !== 'committing' && active.phase !== 'uncertain')
        || active.attempt.baseRevision !== state.revision) throw new Error('The uncertain storage candidate does not own this exact ingress attempt and parent.')
    } else if (active && (!storage.record || !matchesEvent(active, storage.record)
      || (active.phase !== 'committing' && active.phase !== 'uncertain')
      || active.attempt.baseRevision + (storage.record.transition.result.kind === 'accepted' ? 1 : 0) !== state.revision))
      throw new Error('Active ingress has no pending or published storage proof.')
  } else if (storage.kind !== 'memory' || active) throw new Error('A memory checkpoint cannot recover an unresolved commit callback.')
  const reservation = metadata.reservation
  if (reservation?.kind === 'submission') {
    const known = [state, ...(storage.kind === 'durable' && storage.pending ? [storage.pending.transition.state] : [])]
      .some(candidate => ('submission' in candidate.persistence && sameRecoveryValue(candidate.persistence.submission, reservation.submission))
        || candidate.commits.some(fact => sameRecoveryValue(fact.submission, reservation.submission)) || candidate.rejections.some(fact => sameRecoveryValue(fact.submission, reservation.submission)))
    if (!known) throw new Error('Checkpoint source reservation has no exact captured semantic evidence.')
  } else if (reservation && (reservation.kind !== 'gateway-wait' || !reservation.ticket)) throw new Error('Invalid checkpoint source reservation.')
  return Object.freeze({ metadata, resources: physical })
}
