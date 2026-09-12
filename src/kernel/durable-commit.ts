import { validateWorkspaceCheckpoint, type WorkspaceCheckpoint } from './checkpoint.js'
import { assertCheckpointResult, checkpointMatchesRoot, checkpointStore, validateCheckpointWrite, type CheckpointResult, type CheckpointToken, type CheckpointWrite } from './checkpoint-store.js'
import { ownEncodedValue } from './document.js'
import type { IngressCheckpoint } from './ingress-checkpoint.js'
import type { KernelIssue, RecoveryCommitResult, RecoveryRoot } from './model.js'
import { assertInitialDurableState, assertRecoveryResult, prepareRecoveryWrite, recoveryRoot, sameRecoveryValue,
  validateRecoveryWrite, type RecoveryRecord, type RecoveryStoreSession, type RecoveryWrite } from './recovery-store.js'
import { ResourceStore } from './resource-store.js'
import { assertKernelSchema, defineKernelSchema, type KernelSchema } from './schema.js'
import type { KernelState } from './state.js'
import { reduceKernel, type KernelEvent, type KernelTransition } from './transition.js'

export type DurableStatus = Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'preparing' }>
  | Readonly<{ kind: 'writing' | 'unknown'; record: RecoveryRecord; issue?: KernelIssue }>
  | Readonly<{ kind: 'fenced'; issue: KernelIssue }>
const issue = (error: unknown): KernelIssue => Object.freeze({ code: 'durable-commit', message: error instanceof Error ? error.message : 'Durable commit could not be established.' })

/** The ingress sink. It is the sole publisher of its state; accepted results
 * and outbox effects leave this barrier only after an exact storage receipt.
 * It does not execute effects: their fenced recovery policy belongs to the
 * Workspace executor. A recovered record is evidence, never a running Promise. */
export class DurableCommitBarrier {
  readonly #schema: KernelSchema
  readonly #session: RecoveryStoreSession
  readonly resources: ResourceStore
  #state: KernelState
  #root: RecoveryRoot | null = null
  #sequence = 0
  #status: DurableStatus = Object.freeze({ kind: 'idle' })
  #pending: RecoveryWrite | null = null
  #recovering = false
  #restored: RecoveryRecord | null = null
  #record: RecoveryRecord | null = null
  #checkpointParent: CheckpointToken | null = null

  constructor(options: Readonly<{ state: KernelState; schema: KernelSchema; resources: ResourceStore; session: RecoveryStoreSession }>) {
    this.#schema = defineKernelSchema(options.schema)
    this.#session = Object.freeze({ lease: ownEncodedValue(options.session.lease) as unknown as RecoveryStoreSession['lease'],
      onFence: options.session.onFence.bind(options.session), commit: options.session.commit.bind(options.session), lookup: options.session.lookup.bind(options.session), load: options.session.load.bind(options.session), release: options.session.release.bind(options.session) })
    assertInitialDurableState(options.state, this.#session.lease)
    assertKernelSchema(options.state.workspace, this.#schema)
    this.#state = ownEncodedValue(options.state) as unknown as KernelState
    this.resources = options.resources
    this.resources.assertState(this.#state)
    this.#session.onFence(reason => this.fence(reason))
  }

  getState() { return this.#state }
  getRoot() { return this.#root }
  getStatus() { return this.#status }
  getRestoredRecord() { return this.#restored }
  /** The coordinator has verified that this exact stored receipt is still the
   * current head. Subsequent candidates must consume it atomically, including
   * when new input made the original close ticket stale. */
  adoptCheckpointHead(write: CheckpointWrite, receipt: CheckpointResult): void {
    assertCheckpointResult(write.commit, receipt)
    if (receipt.kind !== 'stored' || this.#status.kind === 'fenced' || write.commit.token.leaseEpoch !== this.#session.lease.epoch
      || !sameRecoveryValue(write.commit.workspace, this.#state.workspace) || !checkpointMatchesRoot(write, this.#root))
      throw new Error('This runtime cannot adopt the checkpoint head.')
    this.#checkpointParent = ownEncodedValue(receipt.head) as unknown as CheckpointToken
  }
  getCheckpointEvidence() {
    if (this.#status.kind !== 'idle' && this.#status.kind !== 'unknown') throw new Error('Wait for storage preparation/publication or reconcile its outcome before exporting a checkpoint.')
    return Object.freeze({ kind: 'durable' as const, epoch: this.#session.lease.epoch, root: this.#root, record: this.#record, pending: this.#pending?.record ?? null })
  }
  fence(reason: string) { this.#status = Object.freeze({ kind: 'fenced', issue: issue(new Error(reason)) }) }

  static async restore(options: Readonly<{ initialState: KernelState; schema: KernelSchema; session: RecoveryStoreSession }>): Promise<DurableCommitBarrier> {
    if (await checkpointStore(options.session)?.load()) throw new Error('Restore the outstanding checkpoint head before exposing the semantic root.')
    const raw = await options.session.load()
    if (!raw) throw new Error('There is no durable root to restore.')
    const { write, resources } = await validateRecoveryWrite(raw, options.initialState.workspace)
    if (write.record.commit.token.leaseEpoch === options.session.lease.epoch) throw new Error('Restoring a runtime requires a newly acquired lease epoch.')
    const barrier = new DurableCommitBarrier({ state: options.initialState, schema: options.schema, session: options.session, resources })
    assertKernelSchema(write.record.transition.state.workspace, barrier.#schema)
    barrier.#state = write.record.transition.state
    barrier.#root = recoveryRoot(write.record.commit)
    // Rejected attempts may have advanced the old epoch beyond the root's
    // sequence; only a new epoch may safely restart this counter.
    barrier.#sequence = 0
    barrier.#restored = write.record; barrier.#record = write.record
    return barrier
  }

  /** Import into a new fenced barrier only when storage is still at the
   * captured root (or that root's exact uncertain successor). This never
   * replaces a newer durable root with an archived checkpoint. */
  static async restoreCheckpoint(options: Readonly<{ initialState: KernelState; schema: KernelSchema; session: RecoveryStoreSession; checkpoint: WorkspaceCheckpoint }>) {
    const checkpointHash = options.checkpoint.sha256
    const { metadata, resources } = await validateWorkspaceCheckpoint(options.checkpoint, options.schema)
    const storage = metadata.storage
    if (storage.kind !== 'durable') throw new Error('Memory checkpoints require an explicit durable installation protocol.')
    if (!sameRecoveryValue(metadata.state.workspace, options.initialState.workspace)
      || !sameRecoveryValue(metadata.state.sourceCapabilities, options.initialState.sourceCapabilities)
      || storage.epoch === options.session.lease.epoch) throw new Error('Checkpoint activation requires the same definition and a newly acquired lease.')
    const barrier = new DurableCommitBarrier({ state: options.initialState, schema: options.schema, session: options.session, resources })
    const current = await barrier.#session.load()
    if (barrier.getStatus().kind === 'fenced') throw new Error('Checkpoint lease was lost during storage verification.')
    const rawHead = await checkpointStore(options.session)?.load()
    const stored = rawHead ? await validateCheckpointWrite(rawHead, metadata.state.workspace) : null
    if (stored && stored.checkpoint.sha256 !== checkpointHash) throw new Error('Restore the current checkpoint head rather than another archived snapshot.')
    const verifiedCurrent = current ? (await validateRecoveryWrite(current, metadata.state.workspace)).write : null
    if (barrier.getStatus().kind === 'fenced') throw new Error('Checkpoint lease was lost during storage verification.')
    const currentRoot = verifiedCurrent ? recoveryRoot(verifiedCurrent.record.commit) : null
    if (!sameRecoveryValue(currentRoot, storage.root) && (!storage.pending || !sameRecoveryValue(currentRoot, recoveryRoot(storage.pending.commit))))
      throw new Error('Checkpoint is not the current storage root or its exact pending successor.')
    barrier.#state = metadata.state; barrier.#root = storage.root; barrier.#record = storage.record; barrier.#restored = storage.record
    barrier.#checkpointParent = stored?.commit.token ?? null
    if (storage.pending) {
      const contents = Object.freeze(storage.pending.manifest.entries.map(entry => Object.freeze({ resourceId: entry.descriptor.id, blob: resources.get(entry.descriptor.id) })))
      barrier.#pending = Object.freeze({ record: storage.pending, contents })
      barrier.#status = Object.freeze({ kind: 'unknown', record: storage.pending })
    }
    const active = metadata.ingress.snapshot.pending.find(entry => entry.phase === 'committing' || entry.phase === 'uncertain')
    // A state already published before the old queue recorded its receipt can
    // complete that receipt from the exact root proof, without replaying I/O.
    const publishedTransition: KernelTransition | null = active && !storage.pending && storage.record
      ? Object.freeze({ state: barrier.#state, result: storage.record.transition.result, effects: Object.freeze([]) }) : null
    return Object.freeze({ barrier, metadata, publishedTransition })
  }

  #failed(error: unknown): KernelTransition {
    return Object.freeze({ state: this.#state, result: Object.freeze({ kind: 'rejected', issue: issue(error) }), effects: Object.freeze([]) })
  }
  #unresolved(error: unknown): KernelTransition {
    const failure = issue(error)
    if (this.#status.kind !== 'fenced' && this.#pending) this.#status = Object.freeze({ kind: 'unknown', record: this.#pending.record, issue: failure })
    return Object.freeze({ state: this.#state, result: Object.freeze({ kind: 'unresolved', issue: failure }), effects: Object.freeze([]) })
  }
  #complete(raw: RecoveryCommitResult): KernelTransition {
    if (!this.#pending) throw new Error('Storage result has no pending candidate.')
    const result = ownEncodedValue(raw) as unknown as RecoveryCommitResult
    assertRecoveryResult(this.#pending.record.commit, result)
    if (this.#status.kind === 'fenced') return this.#unresolved(new Error(this.#status.issue.message))
    if (result.kind === 'unknown') return this.#unresolved(new Error(result.issue.message))
    if (!sameRecoveryValue(this.#root, this.#pending.record.commit.parent)) throw new Error('Published durable root changed while a commit was unresolved.')
    if (result.kind === 'not-committed') {
      this.#pending = null; this.#status = Object.freeze({ kind: 'idle' })
      return this.#failed(new Error(result.issue.message))
    }
    const stored = this.#pending.record.transition
    // A durable ownership receipt can advance the storage root without
    // changing semantic state. Preserve reducer identity for a declined event.
    const transition = stored.result.kind === 'accepted' ? stored : Object.freeze({ ...stored, state: this.#state })
    if (this.#pending.record.checkpointParent && sameRecoveryValue(this.#pending.record.checkpointParent, this.#checkpointParent)) this.#checkpointParent = null
    this.#state = transition.state; this.#root = result.root; this.#record = this.#pending.record
    this.#pending = null; this.#status = Object.freeze({ kind: 'idle' })
    return transition
  }

  async commit(raw: KernelEvent, ingress: IngressCheckpoint | null = null, declined?: KernelIssue): Promise<KernelTransition> {
    if (this.#status.kind !== 'idle') throw new Error('Durable state is busy or fenced; serialize commands through ingress.')
    this.#status = Object.freeze({ kind: 'preparing' })
    let event: KernelEvent, transition: KernelTransition
    try {
      event = ownEncodedValue(raw) as unknown as KernelEvent
      transition = declined ? { state: this.#state, result: { kind: 'rejected', issue: ownEncodedValue(declined) as unknown as KernelIssue }, effects: [] }
        : reduceKernel(this.#state, event, this.#schema)
      if (this.getStatus().kind === 'fenced') return this.#unresolved(new Error('Workspace lease was lost during preparation.'))
      if (transition.result.kind !== 'accepted' && !ingress) { this.#status = Object.freeze({ kind: 'idle' }); return transition }
      if (!Number.isSafeInteger(this.#sequence + 1)) throw new Error('Durable attempt sequence exhausted.')
      const write = await prepareRecoveryWrite(this.#session.lease, ++this.#sequence, this.#root, event, transition, this.resources, ingress, this.#checkpointParent)
      if (this.getStatus().kind === 'fenced') return this.#unresolved(new Error('Workspace lease was lost while preparing storage.'))
      this.#pending = write
    } catch (error) {
      if (this.getStatus().kind === 'fenced') return this.#unresolved(error)
      this.#status = Object.freeze({ kind: 'idle' }); return this.#failed(error)
    }
    this.#status = Object.freeze({ kind: 'writing', record: this.#pending.record })
    try { return this.#complete(await this.#session.commit(this.#pending)) }
    catch (error) { return this.#unresolved(error) }
  }

  /** A lookup is for the original token only. Exceptions, missing records and
   * mismatched receipts keep the candidate frozen; they never authorize a
   * retry. The caller resolves the matching ingress attempt with this result. */
  async reconcile(): Promise<KernelTransition> {
    if (this.#status.kind !== 'unknown' || !this.#pending || this.#recovering) throw new Error('Only one unresolved durable candidate may be queried.')
    this.#recovering = true
    try { return this.#complete(await this.#session.lookup(this.#pending.record.commit)) }
    catch (error) { return this.#unresolved(error) }
    finally { this.#recovering = false }
  }
}
