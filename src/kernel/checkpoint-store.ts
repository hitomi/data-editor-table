import { validateStoredCheckpoint, validateWorkspaceCheckpoint, type WorkspaceCheckpoint } from './checkpoint.js'
import { ownEncodedValue } from './document.js'
import type { KernelIssue, RecoveryRoot, WorkspaceIdentity } from './model.js'
import { recoveryRoot, sameRecoveryValue, type RecoveryRecord, type RecoveryStoreSession } from './recovery-store.js'
import { ingressInputs } from './ingress.js'
import { inputResources } from './resource-ownership.js'
import type { KernelSchema } from './schema.js'
import type { KernelState } from './state.js'

export type CheckpointToken = Readonly<{ workspaceId: string; leaseEpoch: string; id: string; sha256: string }>
export type CheckpointCommit = Readonly<{ workspace: WorkspaceIdentity; token: CheckpointToken; parent: CheckpointToken | null }>
export type CheckpointWrite = Readonly<{ commit: CheckpointCommit; checkpoint: WorkspaceCheckpoint }>
export type CheckpointResult = Readonly<{ kind: 'stored'; commit: CheckpointCommit; head: CheckpointToken }>
  | Readonly<{ kind: 'not-stored' | 'unknown'; commit: CheckpointCommit; issue: KernelIssue }>

/** Shares the semantic store's exclusive lease and transaction domain. A
 * missing lookup permanently rejects that token, including delayed writers.
 * The head CAS, complete bytes and immutable result must commit together.
 * Loading a head does not prove it still matches the semantic root or that a
 * close ticket is current; the Workspace coordinator must establish both. */
export type CheckpointStore = Readonly<{
  commit(write: CheckpointWrite): Promise<CheckpointResult>
  lookup(commit: CheckpointCommit): Promise<CheckpointResult>
  load(): Promise<CheckpointWrite | null>
}>
export type CheckpointRecoverySession = RecoveryStoreSession & Readonly<{ checkpoints: CheckpointStore }>
export function checkpointStore(session: RecoveryStoreSession): CheckpointStore | null {
  return (session as Partial<CheckpointRecoverySession>).checkpoints ?? null
}

/** A semantic commit may consume the head only while preserving every owned
 * ingress identity and byte inventory (or an explicit terminal disposition).
 * The store performs this check and both root updates in one transaction. */
export function assertCheckpointConsumption(record: Pick<RecoveryRecord, 'checkpointParent' | 'ingress' | 'manifest' | 'retiredResources'> & Readonly<{ transition: Readonly<{ state: KernelState }> }>, stored: CheckpointWrite): void {
  if (!sameRecoveryValue(record.checkpointParent, stored.commit.token) || !record.ingress) throw new Error('Semantic commit does not consume this exact checkpoint head.')
  const before = stored.checkpoint.metadata.ingress.snapshot, after = record.ingress.snapshot
  const pending = new Map(after.pending.map(entry => [entry.id, entry])), receipts = new Map(after.receipts.map(entry => [entry.id, entry]))
  if (after.generation < before.generation) throw new Error('Checkpoint consumption regresses ingress generation.')
  for (const receipt of before.receipts) if (!sameRecoveryValue(receipts.get(receipt.id) ?? null, receipt)) throw new Error('Checkpoint consumption drops an existing ingress receipt.')
  for (const entry of before.pending) {
    const retained = pending.get(entry.id), receipt = receipts.get(entry.id)
    if (receipt?.disposition === 'returned' && !sameRecoveryValue(receipt.returned, entry.payload)) throw new Error('Checkpoint return rewrites the original request material.')
    if (retained ? retained.sequence !== entry.sequence || retained.scheduledAt < entry.scheduledAt || !sameRecoveryValue(retained.payload, entry.payload)
      : !receipt || receipt.sequence !== entry.sequence || receipt.scheduledAt < entry.scheduledAt)
      throw new Error('Checkpoint consumption drops or rewrites retained input.')
    if (receipt?.disposition === 'accepted' && entry.payload.kind === 'input') {
      const input = record.transition.state.inputs.find(input => sameRecoveryValue(input.ref, receipt.input?.ref ?? null))
      if (!input || !sameRecoveryValue(input.input, entry.payload.envelope.input) || !sameRecoveryValue(receipt.input?.lease ?? null, entry.payload.envelope.lease)
        || receipt.input?.inputSequence !== entry.payload.envelope.inputSequence) throw new Error('Checkpoint input lacks its exact accepted ownership proof.')
    }
  }
  const physical = new Map(record.manifest.entries.map(entry => [entry.descriptor.id, entry])), retired = new Set(record.retiredResources)
  const referenced = new Set(inputResources(ingressInputs(after)))
  for (const entry of stored.checkpoint.metadata.resources.manifest.entries) {
    const current = physical.get(entry.descriptor.id)
    if (current ? !sameRecoveryValue(current, entry) : !retired.has(entry.descriptor.id) || referenced.has(entry.descriptor.id))
      throw new Error('Checkpoint consumption drops or changes owned resource bytes.')
  }
  for (const id of stored.checkpoint.metadata.resources.retired) if (!retired.has(id)) throw new Error('Checkpoint consumption loses a retired resource identity.')
}

/** Reading the latest parent is not permission to replace its ownership with
 * an older archive. Replacement obeys the same conservation rules as consume. */
export function assertCheckpointReplacement(write: CheckpointWrite, previous: CheckpointWrite): void {
  const { metadata } = write.checkpoint
  assertCheckpointConsumption({ checkpointParent: write.commit.parent, ingress: metadata.ingress, transition: { state: metadata.state },
    manifest: metadata.resources.manifest, retiredResources: metadata.resources.retired }, previous)
}

export function assertCheckpointCommit(commit: CheckpointCommit, workspace: WorkspaceIdentity): void {
  const valid = (token: CheckpointToken) => token !== null && typeof token === 'object' && token.workspaceId === workspace.id
    && typeof token.leaseEpoch === 'string' && token.leaseEpoch.length > 0 && typeof token.id === 'string' && token.id.length > 0
    && typeof token.sha256 === 'string' && /^sha256:[0-9a-f]{64}$/.test(token.sha256)
  if (!sameRecoveryValue(commit.workspace, workspace) || !valid(commit.token) || (commit.parent !== null && !valid(commit.parent)))
    throw new Error('Checkpoint commit requires a complete workspace, token and parent identity.')
}
export function assertCheckpointResult(expected: CheckpointCommit, result: CheckpointResult): void {
  if (!sameRecoveryValue(expected, result.commit)) throw new Error('Checkpoint receipt belongs to another attempt or parent.')
  if (result.kind === 'stored') {
    if (!sameRecoveryValue(result.head, expected.token)) throw new Error('Checkpoint receipt does not name its exact head.')
  } else if (result.kind !== 'not-stored' && result.kind !== 'unknown') throw new Error('Unknown checkpoint storage result.')
}

export async function prepareCheckpointWrite(checkpoint: WorkspaceCheckpoint, parent: CheckpointToken | null, id: string, schema: KernelSchema): Promise<CheckpointWrite> {
  const sha256 = checkpoint.sha256, ownedParent = ownEncodedValue(parent) as unknown as CheckpointToken | null
  const validated = await validateWorkspaceCheckpoint(checkpoint, schema), { metadata } = validated
  const commit = ownEncodedValue({ workspace: metadata.state.workspace, parent: ownedParent,
    token: { workspaceId: metadata.state.workspace.id, leaseEpoch: metadata.ticket.leaseEpoch, id, sha256 } }) as unknown as CheckpointCommit
  assertCheckpointCommit(commit, metadata.state.workspace)
  return ownedCheckpointWrite(commit, sha256, validated)
}

export async function validateCheckpointWrite(raw: CheckpointWrite, workspace: WorkspaceIdentity): Promise<CheckpointWrite> {
  const commit = ownEncodedValue(raw.commit) as unknown as CheckpointCommit, sha256 = raw.checkpoint.sha256
  assertCheckpointCommit(commit, workspace)
  return ownedCheckpointWrite(commit, sha256, await validateStoredCheckpoint(raw.checkpoint, workspace))
}

function ownedCheckpointWrite(commit: CheckpointCommit, sha256: string, { metadata, resources }: Awaited<ReturnType<typeof validateStoredCheckpoint>>): CheckpointWrite {
  if (metadata.storage.kind !== 'durable' || metadata.storage.epoch !== commit.token.leaseEpoch || sha256 !== commit.token.sha256)
    throw new Error('Checkpoint attempt does not bind the durable snapshot and lease.')
  const contents = Object.freeze(metadata.resources.manifest.entries.map(entry => Object.freeze({ resourceId: entry.descriptor.id, blob: resources.get(entry.descriptor.id) })))
  return Object.freeze({ commit, checkpoint: Object.freeze({ metadata, sha256, contents }) })
}

export function checkpointMatchesRoot(write: CheckpointWrite, root: RecoveryRoot | null): boolean {
  const storage = write.checkpoint.metadata.storage
  return storage.kind === 'durable' && (sameRecoveryValue(storage.root, root) || Boolean(storage.pending && sameRecoveryValue(recoveryRoot(storage.pending.commit), root)))
}
