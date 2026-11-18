import { encodedValuesEqual, ownEncodedValue } from './document.js'
import { createdBindingsForReceipt, reconcileEntityRegistry } from './entities.js'
import { recordIntentSettlements } from './journal.js'
import type {
  AuthorityFrontier, CompleteAuthority, ExactReceipt, FrozenSubmission, IntentSettlement, KernelIssue, NotAppliedProof, OperationId, OperationLookup, PayloadHash, ScopeIdentity,
} from './model.js'
import { assertCommitMatchesAuthority, authorityCovers, authorityCoversFrontier, joinAuthorityFrontier, ownCompleteAuthority, sameScope, serverIdentityKey, validateExactReceipt } from './protocol.js'
import { submissionDispute, type KernelState } from './state.js'

export type SubmissionRef = Readonly<{ scope: ScopeIdentity; operationId: OperationId; payloadHash: PayloadHash }>
export type KernelEffect =
  | Readonly<{ kind: 'submit'; submission: FrozenSubmission; attempt: number }>
  | Readonly<{ kind: 'lookup'; submission: FrozenSubmission }>
  | Readonly<{ kind: 'read-at-least'; scope: ScopeIdentity; frontier: AuthorityFrontier }>
export type PersistenceStep = Readonly<{ state: KernelState; effects: readonly KernelEffect[]; ignored?: string }>

const step = (state: KernelState, effects: readonly KernelEffect[] = []): PersistenceStep => Object.freeze({ state, effects: Object.freeze(effects) })
const ignore = (state: KernelState, reason: string): PersistenceStep => Object.freeze({ state, effects: Object.freeze([]), ignored: reason })
const readEffect = (state: KernelState): KernelEffect => Object.freeze({ kind: 'read-at-least', scope: state.workspace.scope, frontier: state.authorityFrontier })
const sameFact = (a: unknown, b: unknown) => encodedValuesEqual(ownEncodedValue(a), ownEncodedValue(b))
const errorIssue = (error: unknown): KernelIssue => Object.freeze({ code: 'persistence-protocol', message: error instanceof Error ? error.message : 'Persistence evidence could not be reconciled.' })

function currentSubmission(state: KernelState) { return 'submission' in state.persistence ? state.persistence.submission : null }
function matches(submission: FrozenSubmission, ref: SubmissionRef) {
  return submission.operationId === ref.operationId && submission.payloadHash === ref.payloadHash && sameScope(submission.scope, ref.scope)
}
function protocolFault(state: KernelState, operationId: OperationId, evidence: unknown, error: unknown, disputeId?: string): PersistenceStep {
  const owned = ownEncodedValue(evidence), issue = errorIssue(error)
  if (state.protocolFaults.some(fault => encodedValuesEqual(fault.evidence, owned))) return ignore(state, 'Protocol dispute is already retained.')
  return step(Object.freeze({ ...state, protocolFaults: Object.freeze([...state.protocolFaults, Object.freeze({ operationId, ...(disputeId ? { disputeId } : {}), evidence: owned, issue })]) }))
}
export function disputeOperation(state: KernelState, ref: SubmissionRef, disputeId: string, issue: KernelIssue): PersistenceStep {
  if (!sameScope(ref.scope, state.workspace.scope)) return ignore(state, 'Protocol dispute belongs to another scope.')
  if (state.protocolFaults.some(fault => fault.disputeId === disputeId)) return ignore(state, 'Scope dispute is already retained.')
  const faults = state.protocolFaults.filter(fault => !fault.disputeId || fault.operationId !== ref.operationId)
  return protocolFault({ ...state, protocolFaults: faults }, ref.operationId, { ref, disputeId, issue }, new Error(issue.message), disputeId)
}

export function resolveOperationDispute(state: KernelState, ref: SubmissionRef, disputeId: string,
  result: Extract<OperationLookup, { kind: 'applied' | 'not-applied' }>): PersistenceStep {
  if (!sameScope(ref.scope, state.workspace.scope) || !state.protocolFaults.some(f => f.disputeId === disputeId && f.operationId === ref.operationId))
    return ignore(state, 'This dispute is no longer active.')
  const restored = Object.freeze({ ...state, protocolFaults: Object.freeze(state.protocolFaults.filter(f => f.operationId !== ref.operationId)) })
  const submission = currentSubmission(restored)
  if (!submission || !matches(submission, ref)) return step(restored)
  const fact = restored.commits.find(f => f.submission.operationId === ref.operationId)
  if (fact) {
    // The gateway admits only the original canonical outcome for a known commit.
    const resumed: KernelState = Object.freeze({ ...restored, persistence: Object.freeze({
      kind: 'committed-awaiting-authority', submission, receipt: fact.receipt, requiredFrontier: restored.authorityFrontier,
    }) })
    return reconcileCommit(resumed, submission, fact.receipt)
  }
  // The host verified the original frozen request. An earlier application report
  // alone cannot override its verified definitive rejection.
  return result.kind === 'applied' ? acceptExactReceipt(restored, result.receipt)
    : acceptNotApplied(restored, result.proof, true)
}
function blockReceipt(state: KernelState, submission: FrozenSubmission, receipt: ExactReceipt, error: unknown): KernelState {
  return Object.freeze({ ...state, persistence: Object.freeze({ kind: 'receipt-blocked', submission, receipt, issue: errorIssue(error) }) })
}

function snapshotContent(snapshot: CompleteAuthority) {
  return ownEncodedValue({ entities: [...snapshot.entities].sort((a, b) => a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0), order: snapshot.order })
}

function installAuthority(state: KernelState, snapshot: CompleteAuthority): KernelState {
  if (!authorityCoversFrontier(snapshot.version, state.authorityFrontier)) throw new Error('Complete authority does not cover the required frontier.')
  return Object.freeze({ ...state, entities: reconcileEntityRegistry(state.entities, snapshot),
    authority: Object.freeze({ content: Object.freeze({ kind: 'complete', snapshot }), read: Object.freeze({ kind: 'idle' }) }),
  })
}

function completeCommit(state: KernelState, submission: FrozenSubmission, receipt: ExactReceipt, snapshot: CompleteAuthority): KernelState {
  if (!authorityCoversFrontier(snapshot.version, state.authorityFrontier)) throw new Error('The exact commit cannot settle before the complete authority barrier.')
  assertCommitMatchesAuthority(receipt, snapshot)
  const entities = reconcileEntityRegistry(state.entities, snapshot, createdBindingsForReceipt(submission, receipt))
  const settled: IntentSettlement[] = submission.coverage.flatMap(entry => entry.intentIds.map(intentId => ({
    kind: 'committed' as const, intentId, operationId: submission.operationId, itemId: entry.itemId,
  })))
  return recordIntentSettlements(Object.freeze({ ...state, entities,
    authority: Object.freeze({ content: Object.freeze({ kind: 'complete', snapshot }), read: Object.freeze({ kind: 'idle' }) }),
    persistence: Object.freeze({ kind: 'idle' }),
  }), settled)
}

function reconcileCommit(state: KernelState, submission: FrozenSubmission, receipt: ExactReceipt): PersistenceStep {
  const content = state.authority.content
  if (content.kind === 'complete' && authorityCoversFrontier(content.snapshot.version, state.authorityFrontier)) {
    try { return step(completeCommit(state, submission, receipt, content.snapshot)) }
    catch (error) { return step(blockReceipt(state, submission, receipt, error), [readEffect(state)]) }
  }
  return step(state, [readEffect(state)])
}

/** Read facts and write facts converge here, in one atomic transition. There
 * is no fallback that treats a latest row array as the exact write result. */
export function observeAuthority(state: KernelState, raw: CompleteAuthority): PersistenceStep {
  const snapshot = ownCompleteAuthority(raw)
  if (!sameScope(snapshot.scope, state.workspace.scope)) return ignore(state, 'Authority belongs to another scope or epoch.')
  const seen = state.observations.find(entry => entry.id === snapshot.observation)
  if (seen && (!authorityCovers(seen.version, snapshot.version) || !authorityCovers(snapshot.version, seen.version))) throw new Error('An observation identity cannot acquire a different authority version.')
  if (state.authority.content.kind === 'complete') {
    const previous = state.authority.content.snapshot
    const covers = authorityCovers(snapshot.version, previous.version), covered = authorityCovers(previous.version, snapshot.version)
    if (!covers && covered) return ignore(state, 'Authority is older than the current complete snapshot.')
    if (covered && covers && !sameFact(snapshotContent(previous), snapshotContent(snapshot))) throw new Error('An immutable authority version cannot change content.')
  }
  const frontier = joinAuthorityFrontier(state.authorityFrontier, [snapshot.version])
  const observed: KernelState = Object.freeze({ ...state,
    observations: seen ? state.observations : Object.freeze([...state.observations, Object.freeze({ id: snapshot.observation, version: snapshot.version })]),
    authorityFrontier: frontier,
    persistence: state.persistence.kind === 'committed-awaiting-authority' ? Object.freeze({ ...state.persistence, requiredFrontier: frontier }) : state.persistence,
  })
  if (!authorityCoversFrontier(snapshot.version, frontier)) {
    // A repeated branch can wake a failed read. An active read only covers
    // the versions it actually requested, so a newly discovered branch wakes another.
    const read = state.authority.read
    const pending = read.kind === 'loading' && frontier.every(version => read.required.some(known => authorityCovers(known, version)))
    return step(observed, pending ? [] : [readEffect(observed)])
  }
  const submission = currentSubmission(state), fact = submission ? state.commits.find(fact => fact.submission.operationId === submission.operationId) : undefined
  // A read started before contradictory evidence arrived can update safe
  // remote rows. It cannot settle the disputed operation or bind its creation.
  if (submission && fact && !submissionDispute(state)) {
    try { return step(completeCommit(observed, submission, fact.receipt, snapshot)) }
    catch (error) { return step(blockReceipt(observed, submission, fact.receipt, error), [readEffect(observed)]) }
  }
  if (submission?.items.some(item => item.kind === 'create')) {
    const known = new Set(state.entities.flatMap(entry => entry.kind === 'local' ? [] : [serverIdentityKey(entry.identity)]))
    if (snapshot.entities.some(row => !known.has(serverIdentityKey(row.identity)))) {
      // An unknown incarnation might be our creation with an assigned key.
      // No identity/lease for that row is published until an exact receipt can
      // disambiguate it. Remember freshness, then request a covering read again.
      return step(observed, submissionDispute(state) ? [] : [{ kind: 'lookup', submission }])
    }
  }
  return step(installAuthority(observed, snapshot))
}

export function acceptExactReceipt(state: KernelState, raw: ExactReceipt): PersistenceStep {
  if (!sameScope(raw.scope, state.workspace.scope)) return ignore(state, 'Receipt belongs to another scope or epoch.')
  // Result membership is keyed by ItemId; transport array order carries no
  // meaning. canonicalOrder within an order result still carries meaning.
  const receipt = ownEncodedValue({ ...raw, results: [...raw.results].sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0) }) as unknown as ExactReceipt
  const prior = state.commits.find(fact => fact.submission.operationId === receipt.operationId)
  if (prior) {
    if (sameFact(prior.receipt, receipt)) return ignore(state, 'Exact commit fact is already retained.')
    return protocolFault(state, receipt.operationId, receipt, new Error('One operation identity produced conflicting exact receipts.'))
  }
  if (state.rejections.some(fact => fact.submission.operationId === receipt.operationId)) return protocolFault(state, receipt.operationId, receipt, new Error('An applied receipt contradicts a definitive not-applied proof.'))
  const submission = currentSubmission(state)
  if (!submission || receipt.operationId !== submission.operationId) return ignore(state, 'Receipt does not belong to the current unresolved request.')
  try { validateExactReceipt(submission, receipt) }
  catch (error) { return step(blockReceipt(state, submission, receipt, error), [{ kind: 'lookup', submission }]) }
  const required = joinAuthorityFrontier(state.authorityFrontier, [receipt.committedVersion])
  const applied: KernelState = Object.freeze({ ...state, authorityFrontier: required,
    commits: Object.freeze([...state.commits, Object.freeze({ submission, receipt })]),
    persistence: Object.freeze({ kind: 'committed-awaiting-authority', submission, receipt, requiredFrontier: required }),
  })
  return reconcileCommit(applied, submission, receipt)
}

export function acceptNotApplied(state: KernelState, raw: NotAppliedProof, verifiedByScope = false): PersistenceStep {
  if (!sameScope(raw.scope, state.workspace.scope)) return ignore(state, 'Rejection belongs to another scope or epoch.')
  const proof = ownEncodedValue(raw) as unknown as NotAppliedProof
  if (state.commits.some(fact => fact.submission.operationId === proof.operationId)) return protocolFault(state, proof.operationId, proof, new Error('Not-applied evidence contradicts an exact applied result.'))
  const previous = state.rejections.find(fact => fact.submission.operationId === proof.operationId)
  if (previous) return sameFact(previous.proof, proof) ? ignore(state, 'Definitive rejection is already retained.') : protocolFault(state, proof.operationId, proof, new Error('One operation identity produced inconsistent rejection proofs.'))
  const submission = currentSubmission(state)
  if (!submission || !matches(submission, proof)) return ignore(state, 'Rejection does not belong to the current request.')
  if (!proof.rejectionToken || !proof.reason.code) throw new Error('A definitive rejection requires a stable server fencing token and reason.')
  if (!verifiedByScope && (state.persistence.kind === 'committed-awaiting-receipt' || state.persistence.kind === 'receipt-blocked'))
    return protocolFault(state, proof.operationId, proof, new Error('Not-applied evidence contradicts already reported application evidence.'))
  const rejected: KernelState = Object.freeze({ ...state, rejections: Object.freeze([...state.rejections, Object.freeze({ submission, proof })]), persistence: Object.freeze({ kind: 'idle' }) })
  // A read held while a creation's identity was ambiguous is no longer
  // ambiguous after definitive rejection. Complete that read barrier instead
  // of leaving the workspace on old content with an unresolved frontier.
  return step(rejected, rejected.authority.content.kind === 'complete' && !authorityCoversFrontier(rejected.authority.content.snapshot.version, rejected.authorityFrontier)
    ? [readEffect(rejected)] : [])
}

export function mutationUncertain(state: KernelState, ref: SubmissionRef, attempt: number, issue: KernelIssue): PersistenceStep {
  if (state.persistence.kind !== 'sending' || state.persistence.attempt !== attempt || !matches(state.persistence.submission, ref))
    return ignore(state, 'Uncertain transport result belongs to an inactive attempt.')
  return step(Object.freeze({ ...state, persistence: Object.freeze({ kind: 'outcome-unknown', submission: state.persistence.submission, attempt,
    issue: ownEncodedValue(issue) as unknown as KernelIssue,
  }) }))
}

export function mutationAppliedWithoutReceipt(state: KernelState, ref: SubmissionRef, commitToken: string): PersistenceStep {
  const submission = currentSubmission(state)
  if (!submission || !matches(submission, ref)) return ignore(state, 'Application evidence belongs to another request.')
  if (state.commits.some(fact => fact.submission.operationId === submission.operationId)) return ignore(state, 'Exact application evidence is already available.')
  if (!commitToken) throw new Error('Application evidence requires a commit token.')
  if (state.persistence.kind === 'receipt-blocked') return ignore(state, 'Retain the original blocked receipt until exact reconciliation succeeds.')
  if (state.persistence.kind === 'committed-awaiting-receipt') return state.persistence.commitToken === commitToken
    ? ignore(state, 'Application evidence is already retained.') : protocolFault(state, ref.operationId, { ref, commitToken }, new Error('One operation identity produced conflicting commit tokens.'))
  return step(Object.freeze({ ...state, persistence: Object.freeze({ kind: 'committed-awaiting-receipt', submission, commitToken }) }), [{ kind: 'lookup', submission }])
}

export function retryPersistence(state: KernelState): PersistenceStep {
  const persistence = state.persistence
  if (persistence.kind === 'outcome-unknown') {
    const attempt = persistence.attempt + 1
    return step(Object.freeze({ ...state, persistence: Object.freeze({ kind: 'sending', submission: persistence.submission, attempt }) }), [{ kind: 'submit', submission: persistence.submission, attempt }])
  }
  const submission = currentSubmission(state)
  if (!submission) return ignore(state, 'There is no unresolved persistence operation.')
  const fact = state.commits.find(fact => fact.submission.operationId === submission.operationId)
  return step(state, fact ? [readEffect(state)] : [{ kind: 'lookup', submission }])
}
