import type { RecoveryReservation } from './recovery-scan.js'
import { encodedValuesEqual, ownEncodedValue } from './document.js'
import type { AuthorityFrontier, FrozenSubmission, OperationLookup, ScopeIdentity, WorkspaceId } from './model.js'
import { authorityCovers, authorityCoversFrontier, joinAuthorityFrontier, sameScope, serverIdentityKey, validateExactReceipt, validateFrozenSubmission } from './protocol.js'
import { hashSubmission, ownServerAuthority, type PersistenceSource, type ServerAuthority, type SourceMutationResult } from './source.js'
import type { KernelState } from './state.js'

export type GatewayPermit = Readonly<{ sourceId: string; scope: ScopeIdentity; workspaceId: WorkspaceId; ticket: string }>
export type GatewayFence = Readonly<{ epoch: string; isActive(): boolean }>
type Job = {
  submission: FrozenSubmission
  inFlight: Promise<SourceMutationResult> | null
  terminal: Extract<OperationLookup, { kind: 'applied' | 'not-applied' }> | null
  applicationEvidence: Extract<SourceMutationResult, { kind: 'applied' | 'applied-without-receipt' }> | null
}
type Holder = { permit: GatewayPermit; gateway: PersistenceGateway; job: Job | null; fence: GatewayFence | null }
type Waiter = { gateway: PersistenceGateway; permit: GatewayPermit; fence: GatewayFence | null; promise: Promise<GatewayPermit>; resolve(value: GatewayPermit): void; reject(error: Error): void }
type ScopeSlot = { holder: Holder | null; queue: Waiter[]; frontier: AuthorityFrontier; latest: ServerAuthority | null; fault: Error | null }
type SourceRegistry = { slots: Map<string, ScopeSlot>; ordering: 'ordered' | 'causal'; identity: PersistenceSource['capabilities']['identity']; restoreDeleted: boolean }

// Registry keys identify physical sources, not individual React instances or
// adapter wrapper objects. Only the active permit holder may issue a mutation.
const registries = new Map<string, SourceRegistry>()
const gateways = new WeakMap<PersistenceSource, PersistenceGateway>()
const scopeKey = (scope: ScopeIdentity) => JSON.stringify([scope.id, scope.epoch])
const same = (a: unknown, b: unknown) => encodedValuesEqual(ownEncodedValue(a), ownEncodedValue(b))
const unknown = (error: unknown): OperationLookup => Object.freeze({ kind: 'unknown', issue: Object.freeze({ code: 'source-unavailable', message: error instanceof Error ? error.message : 'The operation outcome is unavailable.' }) })

function canonicalResult(result: SourceMutationResult): SourceMutationResult {
  return ownEncodedValue(result.kind === 'applied' ? { ...result, receipt: { ...result.receipt,
    results: [...result.receipt.results].sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
  } } : result) as unknown as SourceMutationResult
}

export function persistenceGateway(source: PersistenceSource): PersistenceGateway {
  const existing = gateways.get(source)
  if (existing) return existing
  const gateway = new PersistenceGateway(source)
  gateways.set(source, gateway)
  return gateway
}

/** Process-local scope exclusion. Durable Workspace additionally fences its
 * own executor through RecoveryStore's single-writer lease. This gateway never
 * treats unmount, timeout, HTTP 404 or receipt expiry as proof of non-application.
 */
export class PersistenceGateway {
  readonly #source: PersistenceSource
  readonly #registry: SourceRegistry

  constructor(source: PersistenceSource) {
    const capabilities = ownEncodedValue(source.capabilities) as unknown as PersistenceSource['capabilities']
    if (!source.id || capabilities.atomicScopeWrites !== true || capabilities.durableOperationLookup !== true || capabilities.operationIdFence !== 'scope-epoch'
      || !['ordered', 'causal'].includes(capabilities.authorityOrder) || !['incarnation', 'no-key-reuse-in-epoch'].includes(capabilities.identity)
      || !Number.isFinite(capabilities.operationRetentionMs) || capabilities.operationRetentionMs <= 0 || typeof capabilities.restoreDeleted !== 'boolean')
      throw new Error('Writable sources require atomic writes, fenced operation identities, recoverable results and explicit authority/identity guarantees.')
    this.#source = Object.freeze({ id: source.id, capabilities,
      readAtLeast: source.readAtLeast.bind(source), submit: source.submit.bind(source), lookupOperation: source.lookupOperation.bind(source),
    })
    const registry = registries.get(source.id)
    if (registry && (registry.ordering !== capabilities.authorityOrder || registry.identity !== capabilities.identity || registry.restoreDeleted !== capabilities.restoreDeleted))
      throw new Error('One physical source cannot declare conflicting authority, identity or restoration protocols.')
    this.#registry = registry ?? { slots: new Map(), ordering: capabilities.authorityOrder, identity: capabilities.identity, restoreDeleted: capabilities.restoreDeleted }
    registries.set(source.id, this.#registry)
  }

  get sourceId() { return this.#source.id }
  get capabilities() { return this.#source.capabilities }

  #slot(scope: ScopeIdentity): ScopeSlot {
    if (scope.sourceId !== this.sourceId) throw new Error('A gateway cannot access another physical source.')
    if (!scope.id || !scope.epoch) throw new Error('A gateway scope requires stable id and epoch.')
    const key = scopeKey(scope)
    let slot = this.#registry.slots.get(key)
    if (!slot) { slot = { holder: null, queue: [], frontier: Object.freeze([]), latest: null, fault: null }; this.#registry.slots.set(key, slot) }
    return slot
  }

  frontier(scope: ScopeIdentity): AuthorityFrontier { return this.#slot(scope).frontier }

  /** Read-only lifecycle evidence, including a previous fenced runtime's job.
   * An idle restored semantic root does not itself release a shared permit. */
  workspaceReservation(scope: ScopeIdentity, workspaceId: WorkspaceId): string | null {
    const reservation = this.recoveryReservation(scope, workspaceId)
    return reservation?.kind === 'submission' ? reservation.submission.operationId : reservation?.ticket ?? null
  }

  recoveryReservation(scope: ScopeIdentity, workspaceId: WorkspaceId): RecoveryReservation | null {
    const slot = this.#slot(scope), holder = slot.holder
    if (holder?.permit.workspaceId === workspaceId) return holder.job
      ? Object.freeze({ kind: 'submission', submission: holder.job.submission }) : Object.freeze({ kind: 'gateway-wait', ticket: holder.permit.ticket })
    const waiting = slot.queue.find(waiter => waiter.permit.workspaceId === workspaceId)
    return waiting ? Object.freeze({ kind: 'gateway-wait', ticket: waiting.permit.ticket }) : null
  }

  acquire(scope: ScopeIdentity, workspaceId: WorkspaceId, ticket: string, fence: GatewayFence | null = null): Promise<GatewayPermit> {
    const slot = this.#slot(scope)
    if (!workspaceId || !ticket) return Promise.reject(new Error('A gateway request requires workspace and ticket identities.'))
    if (fence && (!fence.epoch || !fence.isActive())) return Promise.reject(new Error('Gateway acquisition requires an active workspace lease.'))
    if (slot.fault) return Promise.reject(slot.fault)
    if (slot.holder?.gateway === this && slot.holder.permit.workspaceId === workspaceId && slot.holder.permit.ticket === ticket) return Promise.resolve(slot.holder.permit)
    const existing = slot.queue.find(waiter => waiter.gateway === this && waiter.permit.workspaceId === workspaceId && waiter.permit.ticket === ticket)
    if (existing) return existing.promise
    const permit: GatewayPermit = Object.freeze({ sourceId: this.sourceId, scope: Object.freeze({ ...scope }), workspaceId, ticket })
    if (!slot.holder) { slot.holder = { permit, gateway: this, job: null, fence }; return Promise.resolve(permit) }
    let resolve!: (permit: GatewayPermit) => void, reject!: (error: Error) => void
    const promise = new Promise<GatewayPermit>((yes, no) => { resolve = yes; reject = no })
    slot.queue.push({ gateway: this, permit, fence, promise, resolve, reject })
    return promise
  }

  cancelWaiting(scope: ScopeIdentity, workspaceId: WorkspaceId, ticket: string): boolean {
    const slot = this.#slot(scope), index = slot.queue.findIndex(waiter => waiter.gateway === this && waiter.permit.workspaceId === workspaceId && waiter.permit.ticket === ticket)
    if (index < 0) return false
    const [waiter] = slot.queue.splice(index, 1)
    waiter!.reject(new Error('Gateway wait was explicitly cancelled.'))
    return true
  }

  #holder(permit: GatewayPermit): Holder {
    const holder = this.#slot(permit.scope).holder
    if (!holder || holder.permit !== permit || holder.gateway !== this) throw new Error('The gateway permit is no longer owned by this executor.')
    if (holder.fence && !holder.fence.isActive()) throw new Error('The gateway executor lease is fenced.')
    return holder
  }

  #advance(slot: ScopeSlot) {
    slot.holder = null
    const waiter = slot.queue.shift()
    if (!waiter) return
    if (slot.fault) { waiter.reject(slot.fault); this.#advance(slot); return }
    if (waiter.fence && !waiter.fence.isActive()) { waiter.reject(new Error('Waiting workspace lease was fenced.')); this.#advance(slot); return }
    slot.holder = { permit: waiter.permit, gateway: waiter.gateway, job: null, fence: waiter.fence }
    waiter.resolve(waiter.permit)
  }

  abandonUnused(permit: GatewayPermit) {
    const holder = this.#holder(permit)
    if (holder.job) throw new Error('A reserved operation cannot be abandoned as an unused permit.')
    this.#advance(this.#slot(permit.scope))
  }

  /** A new fenced runtime may inherit only its own exact persisted operation.
   * Keep the shared job, in-flight request and authority frontier intact; do
   * not release the scope merely because the previous view/runtime stopped. */
  async acquireRecovery(state: KernelState, ticket: string, fence: GatewayFence): Promise<Readonly<{ permit: GatewayPermit; submission: FrozenSubmission | null }>> {
    const slot = this.#slot(state.workspace.scope), previous = slot.holder
    if (slot.fault) throw slot.fault
    let submission = 'submission' in state.persistence ? state.persistence.submission : null
    let permit: GatewayPermit
    if (previous?.permit.workspaceId === state.workspace.id && previous.fence && !previous.fence.isActive()) {
      if (!fence.epoch || !fence.isActive() || fence.epoch === previous.fence.epoch) throw new Error('Recovery requires a new active lease epoch.')
      if (previous.job) {
        const original = previous.job.submission
        const known = same(submission, original) || state.commits.some(fact => same(fact.submission, original)) || state.rejections.some(fact => same(fact.submission, original))
        if (!known) throw new Error('The restored root lacks evidence for the retained gateway operation.')
        submission = original
      }
      permit = Object.freeze({ sourceId: this.sourceId, scope: state.workspace.scope, workspaceId: state.workspace.id, ticket })
      slot.holder = { permit, gateway: this, job: previous.job, fence }
    } else permit = await this.acquire(state.workspace.scope, state.workspace.id, ticket, fence)
    // A fresh process has no gateway job, even when the durable root already
    // owns an exact receipt. Reconstruct that evidence before the read barrier:
    // recovery may correctly skip lookup, and release still requires both the
    // terminal job and complete kernel settlement. Validate through the same
    // reservation/result path used by live responses, without sending a write.
    if (submission) {
      const committed = state.commits.find(fact => same(fact.submission, submission))
      const rejected = state.rejections.find(fact => same(fact.submission, submission))
      if (committed || rejected) {
        const job = await this.#reserve(permit, submission)
        this.#record(permit, job, committed ? { kind: 'applied', receipt: committed.receipt } : { kind: 'not-applied', proof: rejected!.proof })
      }
    }
    return Object.freeze({ permit, submission })
  }

  async readAtLeast(scope: ScopeIdentity, required: AuthorityFrontier): Promise<ServerAuthority> {
    const ownedScope = Object.freeze({ ...scope })
    const slot = this.#slot(ownedScope), requested = joinAuthorityFrontier(slot.frontier, required)
    const snapshot = ownServerAuthority(await this.#source.readAtLeast(ownedScope, requested))
    if (!sameScope(snapshot.scope, ownedScope) || snapshot.version.kind !== this.#source.capabilities.authorityOrder) throw new Error('The source returned a snapshot from another scope or authority protocol.')
    if (slot.latest && authorityCovers(snapshot.version, slot.latest.version) && authorityCovers(slot.latest.version, snapshot.version)) {
      const content = (value: ServerAuthority) => ({ rows: [...value.rows].sort((a, b) => {
        const left = serverIdentityKey(a.identity), right = serverIdentityKey(b.identity)
        return left < right ? -1 : left > right ? 1 : 0
      }), order: value.order })
      if (!same(content(snapshot), content(slot.latest))) throw new Error('One authority version returned inconsistent complete content.')
    }
    slot.frontier = joinAuthorityFrontier(slot.frontier, requested, [snapshot.version])
    if (!authorityCoversFrontier(snapshot.version, slot.frontier)) throw new Error('The returned read does not cover the gateway frontier.')
    slot.latest = snapshot
    return snapshot
  }

  async #reserve(permit: GatewayPermit, raw: FrozenSubmission): Promise<Job> {
    this.#holder(permit)
    const submission = ownEncodedValue(raw) as unknown as FrozenSubmission
    validateFrozenSubmission(submission)
    if (!this.capabilities.restoreDeleted && submission.items.some(item => item.kind === 'create' && item.restores)) throw new Error('The physical source does not support deletion restoration.')
    if (!sameScope(submission.scope, permit.scope)) throw new Error('A permit cannot authorize another scope.')
    if (submission.workspaceId !== permit.workspaceId) throw new Error('A permit cannot authorize another workspace mutation.')
    if (await hashSubmission(submission) !== submission.payloadHash) throw new Error('The frozen payload does not match its SHA-256 digest.')
    // A cancellation may have run during digest calculation. Check ownership
    // again before recording a job or allowing any source mutation to start.
    const holder = this.#holder(permit)
    if (holder.job) {
      if (!same(holder.job.submission, submission)) throw new Error('The permit already reserves a different immutable operation.')
      return holder.job
    }
    const job: Job = { submission, inFlight: null, terminal: null, applicationEvidence: null }
    holder.job = job
    return job
  }

  #fault(slot: ScopeSlot, error: Error) {
    slot.fault = error
    for (const waiter of slot.queue.splice(0)) waiter.reject(error)
  }

  #record(permit: GatewayPermit, job: Job, raw: SourceMutationResult): SourceMutationResult {
    const result = canonicalResult(raw), slot = this.#slot(permit.scope)
    if (result.kind === 'applied') {
      job.applicationEvidence = result
      try { validateExactReceipt(job.submission, result.receipt) }
      catch { return result } // Preserve malformed application evidence for the kernel's receipt-blocked state.
      if (job.terminal && !same(job.terminal, result)) this.#fault(slot, new Error('Source supplied contradictory terminal operation evidence.'))
      else job.terminal = result
      slot.frontier = joinAuthorityFrontier(slot.frontier, [result.receipt.committedVersion])
    } else if (result.kind === 'not-applied') {
      const proof = result.proof, submission = job.submission
      if (proof.operationId !== submission.operationId || proof.payloadHash !== submission.payloadHash || !sameScope(proof.scope, submission.scope)
        || !proof.rejectionToken || !proof.reason.code) throw new Error('Source rejection is not a definitive proof for this operation.')
      if (job.applicationEvidence || (job.terminal && !same(job.terminal, result))) this.#fault(slot, new Error('Source rejected an operation for which application evidence already exists.'))
      else job.terminal = result
    } else if (result.kind === 'applied-without-receipt') {
      if (!result.commitToken) throw new Error('Reported application requires a stable commit token.')
      if (job.terminal?.kind === 'not-applied') this.#fault(slot, new Error('Source application contradicts a definitive rejection.'))
      job.applicationEvidence ??= result
    } else if (result.kind !== 'pending' && result.kind !== 'unknown') throw new Error('Unknown source operation result.')
    if ((result.kind === 'unknown' || result.kind === 'pending' || result.kind === 'applied-without-receipt') && job.terminal) return job.terminal
    return result
  }

  async submit(permit: GatewayPermit, submission: FrozenSubmission): Promise<SourceMutationResult> {
    const job = await this.#reserve(permit, submission), slot = this.#slot(permit.scope)
    this.#holder(permit)
    if (slot.fault) throw slot.fault
    if (job.terminal) return job.terminal
    if (job.inFlight) return job.inFlight
    if (job.applicationEvidence) return job.applicationEvidence
    job.inFlight = Promise.resolve().then(() => { this.#holder(permit); return this.#source.submit(job.submission) })
      .then(result => this.#record(permit, job, result), error => unknown(error))
      .catch(error => unknown(error)).finally(() => { job.inFlight = null })
    return job.inFlight
  }

  /** Recovery reserves the original bytes and queries first. It does not
   * manufacture a new mutation or infer not-applied from a missing record. */
  async lookup(permit: GatewayPermit, submission: FrozenSubmission): Promise<SourceMutationResult> {
    const job = await this.#reserve(permit, submission)
    this.#holder(permit)
    try {
      return this.#record(permit, job, await this.#source.lookupOperation({ scope: submission.scope, operationId: submission.operationId, payloadHash: submission.payloadHash }))
    } catch (error) { return job.terminal ?? unknown(error) }
  }

  /** Call only after the complete kernel transition has been published (and,
   * in durable mode, committed). A network success alone cannot release it. */
  releaseSettled(permit: GatewayPermit, state: KernelState) {
    const holder = this.#holder(permit), slot = this.#slot(permit.scope), job = holder.job
    if (state.workspace.id !== permit.workspaceId || !sameScope(state.workspace.scope, permit.scope)) throw new Error('Only the owning workspace can settle its permit.')
    if (slot.fault || state.protocolFaults.length) throw slot.fault ?? new Error('Protocol disputes prevent releasing this scope reservation.')
    if (!job?.terminal) throw new Error('The operation result is still unresolved.')
    if ('submission' in state.persistence && state.persistence.submission.operationId === job.submission.operationId) throw new Error('The kernel still reserves the submission contribution.')
    const result = job.terminal
    if (result.kind === 'not-applied') {
      if (!state.rejections.some(fact => same(fact.submission, job.submission) && same(fact.proof, result.proof))) throw new Error('The definitive rejection is not committed in workspace state.')
    } else {
      if (!state.commits.some(fact => same(fact.submission, job.submission) && same(fact.receipt, result.receipt))) throw new Error('The exact commit is not retained in workspace state.')
      if (state.authority.content.kind !== 'complete' || !authorityCoversFrontier(state.authority.content.snapshot.version, joinAuthorityFrontier(slot.frontier, [result.receipt.committedVersion])))
        throw new Error('Workspace authority has not crossed the complete shared-scope barrier.')
      for (const coverage of job.submission.coverage) for (const intentId of coverage.intentIds) {
        if (!state.settlements.some(proof => proof.kind === 'committed' && proof.intentId === intentId && proof.operationId === job.submission.operationId && proof.itemId === coverage.itemId))
          throw new Error('The exact submission coverage has not settled in workspace state.')
      }
    }
    this.#advance(slot)
  }
}
