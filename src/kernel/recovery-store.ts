import { assertJournalFrontiers } from './journal-frontiers.js'
import { assertDiscardLedger } from './discard.js'
import { assertDispositionShape } from './ingress-disposition.js'
import { assertSaveSchedule } from './save-schedule.js'
import { assertCheckpointCommit, type CheckpointToken } from './checkpoint-store.js'
import { IngressQueue } from './ingress.js'
import { restoreIngressCheckpoint, type IngressCheckpoint } from './ingress-checkpoint.js'
import { canonicalEncodedValue, encodedValuesEqual, ownEncodedValue } from './document.js'
import type { PreparedStorageCommit, RecoveryCommitResult, RecoveryRoot, ResourceId, WorkspaceIdentity } from './model.js'
import { ResourceStore, type ResourceBundle, type ResourceManifest } from './resource-store.js'
import type { KernelState } from './state.js'
import type { KernelEvent, KernelTransition } from './transition.js'

export type RecoveryLease = Readonly<{ workspace: WorkspaceIdentity; epoch: string }>
export type RecoveryRecord = Readonly<{
  format: 10
  commit: PreparedStorageCommit
  event: KernelEvent
  transition: KernelTransition
  manifest: ResourceManifest
  retiredResources: readonly ResourceId[]
  /** null explicitly denotes a bare semantic barrier, not a Workspace root. */
  ingress: IngressCheckpoint | null
  checkpointParent: CheckpointToken | null
}>
export type RecoveryWrite = Readonly<{ record: RecoveryRecord; contents: ResourceBundle['contents'] }>

/** A session is acquired by a storage adapter with an exclusive fenced epoch.
 * Every method must atomically verify that epoch. commit stores the complete
 * record, bytes and root CAS together; lookup never interprets a missing token
 * as not-committed unless it also permanently prevents a late commit of it.
 * A definitive result is immutable for the entire workspace lifetime.
 *
 * Loss of the lease must fence the runtime as well as future storage/effects.
 * This interface is a required adapter contract, not a realm-local lock. */
export type RecoveryStoreSession = Readonly<{
  lease: RecoveryLease
  onFence(listener: (reason: string) => void): () => void
  commit(write: RecoveryWrite): Promise<RecoveryCommitResult>
  lookup(commit: PreparedStorageCommit): Promise<RecoveryCommitResult>
  load(): Promise<RecoveryWrite | null>
  /** Fence this runtime before relinquishing exclusivity. Resolve only once
   * the lease is released; repeated calls must safely finish the same release. */
  release(): Promise<void>
}>

export const sameRecoveryValue = (left: unknown, right: unknown) => encodedValuesEqual(ownEncodedValue(left), ownEncodedValue(right))
export function recoveryRoot(commit: PreparedStorageCommit): RecoveryRoot {
  return Object.freeze({ token: commit.token, revision: commit.semanticRevision })
}

async function hashCandidate(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalEncodedValue(ownEncodedValue(value)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}
function candidateBody(record: RecoveryRecord) {
  const { candidateHash: _hash, ...token } = record.commit.token
  return { ...record, commit: { ...record.commit, token } }
}

function assertDurableTransition(transition: KernelTransition, parent: RecoveryRoot | null, ingress: IngressCheckpoint | null) {
  const result = transition.result
  if (!['accepted', 'rejected', 'ignored'].includes(result.kind)
    || (result.kind === 'accepted' ? result.revision !== transition.state.revision : !ingress || transition.effects.length !== 0))
    throw new Error('A durable candidate requires a terminal transition and complete ingress for declined work.')
  if (transition.state.revision !== (parent?.revision ?? 0) + (result.kind === 'accepted' ? 1 : 0))
    throw new Error('A durable candidate must extend its exact parent revision.')
}

export async function prepareRecoveryWrite(lease: RecoveryLease, sequence: number, parent: RecoveryRoot | null,
  event: KernelEvent, transition: KernelTransition, resources: ResourceStore, ingress: IngressCheckpoint | null = null, checkpointParent: CheckpointToken | null = null): Promise<RecoveryWrite> {
  lease = ownEncodedValue(lease) as unknown as RecoveryLease
  parent = ownEncodedValue(parent) as unknown as RecoveryRoot | null
  event = ownEncodedValue(event) as unknown as KernelEvent
  transition = ownEncodedValue(transition) as unknown as KernelTransition
  checkpointParent = ownEncodedValue(checkpointParent) as unknown as CheckpointToken | null
  if (!sameRecoveryValue(lease.workspace, transition.state.workspace) || !lease.epoch || !Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error('A durable candidate requires a complete fenced identity.')
  assertDurableTransition(transition, parent, ingress)
  assertJournalFrontiers(transition.state)
  assertSaveSchedule(transition.state.schedule); assertDiscardLedger(transition.state)
  const publishedIngress = ingress ? IngressQueue.committedCheckpoint(ingress, event, transition) : null
  const physical = await resources.exportRecovery(transition.state), bundle = physical.bundle
  const record = ownEncodedValue({ format: 10, commit: { token: { workspaceId: lease.workspace.id, leaseEpoch: lease.epoch, sequence, candidateHash: '' },
    workspace: lease.workspace, parent, semanticRevision: transition.state.revision }, event, transition, manifest: bundle.manifest, retiredResources: physical.retired, ingress: publishedIngress, checkpointParent }) as unknown as RecoveryRecord
  assertRecordIngress(record)
  const candidateHash = await hashCandidate(candidateBody(record))
  const complete = ownEncodedValue({ ...record, commit: { ...record.commit, token: { ...record.commit.token, candidateHash } } }) as unknown as RecoveryRecord
  return Object.freeze({ record: complete, contents: bundle.contents })
}

/** Validate durable bytes before exposing a restored state. Hashes establish
 * record integrity, not trust in an arbitrary host-supplied semantic snapshot;
 * records must come from the workspace's trusted transactional store. */
export async function validateRecoveryWrite(raw: RecoveryWrite, workspace: WorkspaceIdentity): Promise<Readonly<{ write: RecoveryWrite; resources: ResourceStore }>> {
  const record = ownEncodedValue(raw.record) as unknown as RecoveryRecord, { commit, transition } = record
  const contents = Object.freeze(raw.contents.map(entry => Object.freeze({ resourceId: entry.resourceId, blob: entry.blob })))
  if (record.format !== 10 || !sameRecoveryValue(commit.workspace, workspace) || !sameRecoveryValue(transition.state.workspace, workspace)
    || commit.token.workspaceId !== workspace.id || !commit.token.leaseEpoch || !Number.isSafeInteger(commit.token.sequence) || commit.token.sequence < 1
    || !Number.isSafeInteger(commit.semanticRevision) || commit.semanticRevision < 0 || commit.semanticRevision !== transition.state.revision)
    throw new Error('The recovery record has an invalid workspace, token, parent or transition.')
  assertDurableTransition(transition, commit.parent, record.ingress)
  if (commit.parent && (commit.parent.token.workspaceId !== workspace.id || !commit.parent.token.leaseEpoch
    || !Number.isSafeInteger(commit.parent.token.sequence) || commit.parent.token.sequence < 1
    || !/^sha256:[0-9a-f]{64}$/.test(commit.parent.token.candidateHash))) throw new Error('The recovery parent is not a complete root identity.')
  assertJournalFrontiers(transition.state)
  assertSaveSchedule(transition.state.schedule); assertDiscardLedger(transition.state)
  assertRecordIngress(record)
  const released = new Set(transition.state.resources.filter(resource => resource.status === 'released').map(resource => resource.descriptor.id))
  if (record.manifest.entries.some(entry => released.has(entry.descriptor.id))) throw new Error('A recovery root must retire released resource bytes.')
  // Capture physical contents before awaiting any digest. ResourceStore owns
  // Blob brands/metadata and never invokes caller-overridden byte methods.
  const restoring = ResourceStore.restoreCheckpoint(transition.state, { format: 1, retired: record.retiredResources, bundle: { manifest: record.manifest, contents } })
  const [resources, actualHash] = await Promise.all([restoring, hashCandidate(candidateBody(record))])
  if (actualHash !== commit.token.candidateHash) throw new Error('The recovery candidate digest does not match its complete record.')
  return Object.freeze({ write: Object.freeze({ record, contents: (await resources.exportRecovery(transition.state)).bundle.contents }), resources })
}

function assertRecordIngress(record: RecoveryRecord): void {
  if (record.event.kind === 'ingress-disposed' && record.transition.result.kind === 'accepted') {
    const event = record.event
    assertDispositionShape(event)
    if (!record.ingress || event.revision + 1 !== record.transition.state.revision
      || record.ingress.snapshot.generation !== event.generation + 1
      || event.ids.some(id => !record.ingress!.snapshot.receipts.some(receipt => receipt.id === id && receipt.disposition === event.disposition)))
      throw new Error('A disposition record requires its complete published ingress receipts.')
  }
  if (record.checkpointParent !== null) {
    assertCheckpointCommit({ workspace: record.commit.workspace, token: record.checkpointParent, parent: null }, record.commit.workspace)
    if (!record.ingress) throw new Error('Checkpoint consumption requires complete ingress ownership.')
  }
  if (record.ingress === null) return
  const { snapshot } = restoreIngressCheckpoint(record.ingress, record.transition.state)
  if (snapshot.pending.some(entry => entry.phase === 'uncertain' || entry.phase === 'committing')) throw new Error('Published ingress cannot retain an active storage attempt.')
  // Raw rejected input may reference a resource the producer never supplied.
  // Preserve that failure material without fabricating bytes or preventing an
  // independent authoritative result from committing. The physical inventory
  // remains exact; full transferable checkpoint validation is stricter.
}

export function assertRecoveryResult(expected: PreparedStorageCommit, result: RecoveryCommitResult): void {
  if (!sameRecoveryValue(expected, result.commit)) throw new Error('Storage completion belongs to another candidate, parent or lease epoch.')
  if (result.kind === 'committed') {
    if (!sameRecoveryValue(result.root, recoveryRoot(expected))) throw new Error('Storage completion does not name the exact committed root.')
  } else if (result.kind !== 'not-committed' && result.kind !== 'unknown') throw new Error('Unknown storage outcome.')
}

export function assertInitialDurableState(state: KernelState, lease: RecoveryLease) {
  if (state.revision !== 0 || !sameRecoveryValue(state.workspace, lease.workspace) || !lease.epoch)
    throw new Error('A new durable barrier requires an initial workspace at revision zero and an exclusive storage lease.')
}
