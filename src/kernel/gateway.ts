import { encodedValuesEqual, ownEncodedValue } from './document.js'
import type { AuthorityFrontier, FrozenSubmission, KernelIssue, NotAppliedProof, OperationLookup, ScopeIdentity, WorkspaceId } from './model.js'
import { authorityCoversFrontier, joinAuthorityFrontier, sameScope, validateReceiptContents, validateFrozenSubmission } from './protocol.js'
import { hashSubmission, type PersistenceSource, type ServerAuthority, type SourceMutationResult } from './source.js'
import type { KernelState } from './state.js'
import { ScopeDisputes, type DefinitiveResult, type ScopeDisputeEvent } from './scope-disputes.js'
export type { DefinitiveResult, ScopeDispute, ScopeDisputeEvent } from './scope-disputes.js'
import { VersionContentConflict } from './version-content.js'
import { ScopeAuthority, type ValidateAuthorityRows } from './scope-authority.js'

type RecoveryReservation = Readonly<{ kind: 'submission'; submission: FrozenSubmission }> | Readonly<{ kind: 'gateway-wait'; ticket: string }>

export type GatewayPermit = Readonly<{ sourceId: string; scope: ScopeIdentity; workspaceId: WorkspaceId; ticket: string }>
export type GatewayFence = Readonly<{ epoch: string; isActive(): boolean }>
type Applied = Extract<OperationLookup, { kind: 'applied' }>
export type GatewayMutationResult = SourceMutationResult | Readonly<{ kind: 'disputed'; issue: KernelIssue }>
type ReceiveReceipt = (result: GatewayMutationResult) => void
type Job = {
  submission: FrozenSubmission
  validators: readonly ValidateAuthorityRows[]
  reportedToken?: string
  inFlight: Promise<GatewayMutationResult> | null
  terminal: Extract<OperationLookup, { kind: 'applied' | 'not-applied' }> | null
  applicationEvidence: Extract<SourceMutationResult, { kind: 'applied' | 'applied-without-receipt' }> | null
}
type Holder = { permit: GatewayPermit; gateway: PersistenceGateway; job: Job | null; fence: GatewayFence | null }
type Waiter = { gateway: PersistenceGateway; permit: GatewayPermit; fence: GatewayFence | null; promise: Promise<GatewayPermit>; resolve(value: GatewayPermit): void; reject(error: Error): void }
type ScopeSlot = { holder: Holder | null; queue: Waiter[]; authority: ScopeAuthority; disputes: ScopeDisputes<Job>; pending: Map<Job, { reported: Applied; receive?: ReceiveReceipt }> }
type SourceRegistry = { slots: Map<string, ScopeSlot>; ordering: 'ordered' | 'causal'; identity: PersistenceSource['capabilities']['identity']; restoreDeleted: boolean }

// Registry keys identify physical sources, not individual React instances or
// adapter wrapper objects. Only the active permit holder may issue a mutation.
const registries = new Map<string, SourceRegistry>()
const gateways = new WeakMap<PersistenceSource, PersistenceGateway>()
const scopeKey = (scope: ScopeIdentity) => JSON.stringify([scope.id, scope.epoch])
const same = (a: unknown, b: unknown) => encodedValuesEqual(ownEncodedValue(a), ownEncodedValue(b))
const unknown = (error: unknown): OperationLookup => Object.freeze({ kind: 'unknown', issue: Object.freeze({ code: 'source-unavailable', message: error instanceof Error ? error.message : 'The operation outcome is unavailable.' }) })

function sameReceipt(left: Applied, right: Applied) {
  return sameCommitVersion(left, right) && same(left.receipt.results, right.receipt.results)
}

function sameCommitVersion(left: Applied, right: Applied) {
  const a = left.receipt.committedVersion, b = right.receipt.committedVersion
  return a.token === b.token && (a.kind === 'ordered' && b.kind === 'ordered' && a.position === b.position
    || a.kind === 'causal' && b.kind === 'causal' && a.stamp === b.stamp)
}

const disputed = (fault: { issue: KernelIssue }): GatewayMutationResult => ({ kind: 'disputed', issue: fault.issue })

function validRejection(proof: NotAppliedProof) {
  return typeof proof.rejectionToken === 'string' && !!proof.rejectionToken && typeof proof.reason?.code === 'string'
    && !!proof.reason.code && typeof proof.reason.message === 'string'
}

function canonicalResult(result: SourceMutationResult): SourceMutationResult {
  return ownEncodedValue(result.kind === 'applied' && Array.isArray(result.receipt.results) && result.receipt.results.every(r => typeof r?.itemId === 'string') ? { ...result, receipt: { ...result.receipt,
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
    if (!slot) {
      const authority = new ScopeAuthority(Object.freeze({ ...scope }), this.capabilities, () => {
        const current = slot!
        for (const [job, pending] of current.pending) {
          const admitted = this.#admitReceipt(current, job, pending.reported, pending.receive)
          if (admitted.kind === 'applied' || admitted.kind === 'disputed') pending.receive?.(admitted)
        }
      })
      slot = { holder: null, queue: [], authority, disputes: new ScopeDisputes<Job>(), pending: new Map() }
      this.#registry.slots.set(key, slot)
    }
    return slot
  }

  authority(scope: ScopeIdentity) { return this.#slot(scope).authority }
  frontier(scope: ScopeIdentity): AuthorityFrontier { return this.authority(scope).frontier }

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
    if (slot.disputes.first) return Promise.reject(new Error(slot.disputes.first.issue.message))
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
    if (slot.disputes.first) throw new Error(slot.disputes.first.issue.message)
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

  readAtLeast(scope: ScopeIdentity, required: AuthorityFrontier, validate?: (rows: ServerAuthority['rows']) => void) {
    return this.authority(scope).read(required, this.#source.readAtLeast, validate)
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
    const validators = this.authority(submission.scope).captureRowValidators()
    const job: Job = { submission, validators, inFlight: null, terminal: null, applicationEvidence: null }
    holder.job = job
    return job
  }

  getDispute(scope: ScopeIdentity, id?: string) {
    const ledger = this.#slot(scope).disputes
    return id === undefined ? ledger.first : ledger.find(id)?.report ?? null
  }

  subscribeDisputes(scope: ScopeIdentity, listener: (event: ScopeDisputeEvent) => void) {
    return this.#slot(scope).disputes.subscribe(listener)
  }

  #fault(slot: ScopeSlot, job: Job, message: string, result: SourceMutationResult) {
    for (const waiter of slot.queue.splice(0)) waiter.reject(new Error(message))
    const token = job.reportedToken ? { kind: 'applied-without-receipt' as const, commitToken: job.reportedToken } : null
    const evidence = [token, slot.pending.get(job)?.reported, job.terminal, result]
    slot.pending.delete(job)
    return disputed(slot.disputes.raise(job, message, evidence.filter(fact => fact != null)))
  }

  /** The host supplies its verified definitive result for the reviewed evidence.
   * A settled fact may already be the base of local intents. Reversing it needs
   * a new authoritative epoch, not an in-place rewrite of workspace history. */
  resolveDispute(scope: ScopeIdentity, id: string, raw: DefinitiveResult, validate?: (rows: ServerAuthority['rows']) => void) {
    const slot = this.#slot(scope), job = slot.disputes.find(id)?.job
    if (!job) throw new Error('This dispute is no longer current. Review the latest evidence.')
    if (raw?.kind !== 'applied' && raw?.kind !== 'not-applied') throw new Error('A resolution requires definitive source evidence.')
    const captured = canonicalResult(raw) as DefinitiveResult
    const ref = captured.kind === 'applied' ? captured.receipt : captured.proof
    if (!ref?.scope || !sameScope(scope, ref.scope) || ref.operationId !== job.submission.operationId || ref.payloadHash !== job.submission.payloadHash)
      throw new Error('Resolution evidence must match the disputed submission.')
    if (job.terminal && !(captured.kind === 'applied' && job.terminal.kind === 'applied'
      ? sameReceipt(job.terminal, captured) : same(job.terminal, captured)))
      throw new Error('This resolution reverses a retained terminal fact. Use a verified new authority epoch to rebuild its dependent history.')
    let terminal: DefinitiveResult, admission
    if (captured.kind === 'applied') {
      validateReceiptContents(job.submission, captured.receipt)
      admission = slot.authority.prepareReceipt(job.submission, captured.receipt, validate ? [...job.validators, validate] : job.validators)
      if (!admission) throw new Error('Resolution evidence must cover the original write base.')
      terminal = job.terminal ?? Object.freeze({ kind: 'applied', receipt: admission.receipt })
    } else {
      if (!validRejection(captured.proof)) throw new Error('Resolution requires a definitive rejection proof.')
      terminal = captured
    }
    if (slot.disputes.forJob(job)?.id !== id) throw new Error('New evidence arrived while validating the resolution.')
    job.terminal = terminal
    job.applicationEvidence = terminal.kind === 'applied' ? terminal : null
    slot.pending.delete(job)
    delete job.reportedToken
    admission?.commit()
    slot.disputes.resolve(job, id, terminal)
  }

  #admitReceipt(slot: ScopeSlot, job: Job, reported: Applied, receive?: ReceiveReceipt): GatewayMutationResult {
    const prior = slot.pending.get(job)
    const original = job.terminal?.kind === 'applied' ? job.terminal : prior?.reported
    const existing = slot.disputes.forJob(job)
    // Repeated lookups can contribute different edges for the same immutable
    // result before any of them connects the commit to the frozen base.
    const version = reported.receipt.committedVersion, previous = prior?.reported.receipt.committedVersion
    if (version.kind === 'causal' && previous?.kind === 'causal' && version.stamp === previous.stamp && version.token === previous.token) {
      const [joined] = joinAuthorityFrontier([previous], [version])
      reported = Object.freeze({ ...reported, receipt: Object.freeze({ ...reported.receipt, committedVersion: joined! }) })
    }
    const receipt = reported.receipt
    const incomplete = job.applicationEvidence?.kind === 'applied-without-receipt' ? job.applicationEvidence
      : { kind: 'applied-without-receipt' as const, commitToken: receipt.committedVersion.token }
    const retained = existing ? disputed(existing) : job.terminal
    let admission: ReturnType<ScopeAuthority['prepareReceipt']>
    try { admission = slot.authority.prepareReceipt(job.submission, receipt, job.validators) }
    catch (error) {
      // Different canonical outputs for a previously admitted identical
      // commit are themselves the conflicting facts. A bad row, stale base
      // or unrelated version cannot supply such evidence.
      if (error instanceof VersionContentConflict && job.terminal?.kind === 'applied' && sameCommitVersion(job.terminal, reported)
        && !sameReceipt(job.terminal, reported))
        return this.#fault(slot, job, 'Source supplied contradictory terminal operation evidence.', reported)
      if (prior && sameReceipt(prior.reported, reported)) slot.pending.delete(job)
      if (retained) return retained
      job.applicationEvidence = incomplete
      return incomplete
    }
    if (!admission) {
      if (!retained && original && !sameReceipt(original, reported))
        return this.#fault(slot, job, 'Source supplied contradictory candidate receipts.', reported)
      const notify = receive ?? prior?.receive
      slot.pending.set(job, { reported, ...(notify ? { receive: notify } : {}) })
      if (retained) return retained
      job.applicationEvidence = incomplete
      return incomplete
    }
    if (existing) return this.#fault(slot, job, existing.issue.message, reported)
    if (job.terminal?.kind === 'not-applied') return this.#fault(slot, job, 'Source application contradicts a definitive rejection.', reported)
    if (original && !sameReceipt(original, reported)) return this.#fault(slot, job, 'Source supplied contradictory terminal operation evidence.', reported)
    // Local ancestry can grow between repeated lookups. The kernel and permit
    // keep the first admitted receipt for this exact immutable item outcome.
    job.terminal ??= Object.freeze({ kind: 'applied', receipt: admission.receipt })
    slot.pending.delete(job)
    admission.commit()
    return job.terminal
  }

  #record(permit: GatewayPermit, job: Job, raw: SourceMutationResult, receive?: ReceiveReceipt): GatewayMutationResult {
    const slot = this.#slot(permit.scope)
    // Requests capture their original job. A lookup may finish after release
    // and must compare with that operation's evidence, even under a new permit.
    if (raw.kind === 'applied' || raw.kind === 'not-applied') {
      const ref = raw.kind === 'applied' ? raw.receipt : raw.proof
      if (!ref?.scope || !sameScope(ref.scope, job.submission.scope) || ref.operationId !== job.submission.operationId
        || ref.payloadHash !== job.submission.payloadHash) return job.terminal ?? unknown(new Error('Source result belongs to another submission.'))
    }
    const result = canonicalResult(raw)
    const existing = slot.disputes.forJob(job)
    if (result.kind === 'applied') {
      try { validateReceiptContents(job.submission, result.receipt) }
      catch {
        if (existing) return disputed(existing)
        if (job.terminal) return job.terminal
        job.applicationEvidence ??= result
        return result // The kernel retains malformed item evidence for explicit review.
      }
      return this.#admitReceipt(slot, job, result, receive)
    } else if (result.kind === 'not-applied') {
      const proof = result.proof
      if (!validRejection(proof)) return existing ? disputed(existing) : job.terminal ?? unknown(new Error('Source rejection lacks a definitive proof.'))
      if (existing) return this.#fault(slot, job, existing.issue.message, result)
      if (job.reportedToken || (job.terminal && !same(job.terminal, result))) return this.#fault(slot, job, 'Source rejected an operation for which application evidence already exists.', result)
      else job.terminal = result
    } else if (result.kind === 'applied-without-receipt') {
      if (typeof result.commitToken !== 'string' || !result.commitToken)
        return existing ? disputed(existing) : job.terminal ?? unknown(new Error('Reported application requires a stable commit token.'))
      if (existing) return this.#fault(slot, job, existing.issue.message, result)
      if (job.terminal?.kind === 'not-applied') return this.#fault(slot, job, 'Source application contradicts a definitive rejection.', result)
      if (job.reportedToken && job.reportedToken !== result.commitToken)
        return this.#fault(slot, job, 'Source supplied conflicting operation commit tokens.', result)
      job.reportedToken = result.commitToken
      job.applicationEvidence ??= result
      return job.terminal ?? job.applicationEvidence
    } else if (result.kind !== 'pending' && result.kind !== 'unknown') throw new Error('Unknown source operation result.')
    if (existing) return disputed(existing)
    if ((result.kind === 'unknown' || result.kind === 'pending') && job.terminal) return job.terminal
    return result
  }

  async submit(permit: GatewayPermit, submission: FrozenSubmission, receive?: ReceiveReceipt): Promise<GatewayMutationResult> {
    const job = await this.#reserve(permit, submission), slot = this.#slot(permit.scope)
    this.#holder(permit)
    const fault = slot.disputes.forJob(job)
    if (fault) return disputed(fault)
    if (job.terminal) return job.terminal
    if (job.inFlight) return job.inFlight
    if (job.applicationEvidence) return job.applicationEvidence
    job.inFlight = Promise.resolve().then(async () => {
      // A different completed operation can acquire a dispute after this job
      // reserved its bytes. Keep the new job intact until writes are allowed.
      while (slot.disputes.first) await slot.disputes.waitUntilClear()
      this.#holder(permit)
      if (job.terminal || job.applicationEvidence) return job.terminal ?? job.applicationEvidence!
      return this.#record(permit, job, await this.#source.submit(job.submission), receive)
    }).catch(error => unknown(error)).finally(() => { job.inFlight = null })
    return job.inFlight
  }

  /** Recovery reserves the original bytes and queries first. It does not
   * manufacture a new mutation or infer not-applied from a missing record. */
  async lookup(permit: GatewayPermit, submission: FrozenSubmission, receive?: ReceiveReceipt): Promise<GatewayMutationResult> {
    const job = await this.#reserve(permit, submission)
    this.#holder(permit)
    const fault = this.#slot(permit.scope).disputes.forJob(job)
    if (fault) return disputed(fault)
    try {
      return this.#record(permit, job, await this.#source.lookupOperation({ scope: submission.scope, operationId: submission.operationId, payloadHash: submission.payloadHash }), receive)
    } catch (error) { return job.terminal ?? unknown(error) }
  }

  /** Call only after the complete kernel transition has been published (and,
   * in durable mode, committed). A network success alone cannot release it. */
  releaseSettled(permit: GatewayPermit, state: KernelState) {
    const holder = this.#holder(permit), slot = this.#slot(permit.scope), job = holder.job
    if (state.workspace.id !== permit.workspaceId || !sameScope(state.workspace.scope, permit.scope)) throw new Error('Only the owning workspace can settle its permit.')
    if (job && (slot.disputes.forJob(job) || state.protocolFaults.some(f => f.operationId === job.submission.operationId))) throw new Error('Protocol disputes prevent releasing this operation.')
    if (!job?.terminal) throw new Error('The operation result is still unresolved.')
    if ('submission' in state.persistence && state.persistence.submission.operationId === job.submission.operationId) throw new Error('The kernel still reserves the submission contribution.')
    const result = job.terminal
    if (result.kind === 'not-applied') {
      if (!state.rejections.some(fact => same(fact.submission, job.submission) && same(fact.proof, result.proof))) throw new Error('The definitive rejection is not committed in workspace state.')
    } else {
      if (!state.commits.some(fact => same(fact.submission, job.submission) && same(fact.receipt, result.receipt))) throw new Error('The exact commit is not retained in workspace state.')
      // Another workspace's read may advance slot.frontier after this read was
      // validated but before its Runtime publishes settlement. That later
      // evidence belongs to the next acquisition/read, not this operation's
      // completion barrier. Requiring it here strands an already-settled job.
      const required = joinAuthorityFrontier(state.authorityFrontier,
        [job.submission.baseAuthority, result.receipt.committedVersion])
      if (state.authority.content.kind !== 'complete' || !authorityCoversFrontier(state.authority.content.snapshot.version, required))
        throw new Error('Workspace authority has not crossed the settled operation barrier.')
      for (const coverage of job.submission.coverage) for (const intentId of coverage.intentIds) {
        if (!state.settlements.some(proof => proof.kind === 'committed' && proof.intentId === intentId && proof.operationId === job.submission.operationId && proof.itemId === coverage.itemId))
          throw new Error('The exact submission coverage has not settled in workspace state.')
      }
    }
    this.#advance(slot)
  }
}
