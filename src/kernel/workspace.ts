import type { ViewId } from './model.js'
import { createWorkspaceCheckpoint, validateWorkspaceCheckpoint, type WorkspaceCheckpoint } from './checkpoint.js'
import type { IngressCheckpoint } from './ingress-checkpoint.js'
import { assertReviewedDisposition, type IngressDispositionEvent } from './ingress-disposition.js'
import { assertCheckpointResult, checkpointStore, prepareCheckpointWrite, type CheckpointStore, type CheckpointToken, type CheckpointWrite } from './checkpoint-store.js'
import { planRecovery, type RecoveryCandidate, type RecoveryPlan, type RecoveryReservation } from './recovery-scan.js'
import type { SaveScheduleEvent, SaveScheduleOptions } from './save-schedule.js'
import { canonicalEncodedValue, ownEncodedValue } from './document.js'
import { persistenceGateway, type GatewayFence, type GatewayPermit, type PersistenceGateway } from './gateway.js'
import { kernelId, type CloseTicket, type DurableTaskOutcome, type EditorLease, type FrozenSubmission, type IngressId, type InputEnvelope, type IntentId, type KernelIssue, type NotAppliedProof, type OwnedInput, type PreparedAction, type ResourceId, type ResourceRef, type ScopeIdentity, type TaskDefinitionRef, type TaskId, type TaskOwner, type TaskResult, type WorkspaceId } from './model.js'
import type { KernelEffect } from './persistence.js'
import { projectKernel } from './projection.js'
import { assertKernelSchema, defineKernelSchema, type KernelSchema } from './schema.js'
import { hashSubmission, type PersistenceSource, type SourceMutationResult } from './source.js'
import { createKernelState, type KernelState, type PolicySnapshot } from './state.js'
import { draftSubmission } from './submission.js'
import { projectHistory } from './history.js'
import { prepareHistoryCommand } from './history-command.js'
import { projectCapabilities, type BlockedCapability, type SemanticCapabilities } from './capabilities.js'
import { reduceKernel, type CommandResult, type KernelEvent, type KernelTransition, type TransitionEffect } from './transition.js'
import { prepareResolution, type ResolutionRequest } from './resolution.js'
import { captureSessionOpeningContext, type SessionEvent } from './session.js'
import { projectView, type ViewEvent } from './view.js'
import type { TaskCommand, TaskEffect } from './task.js'
import { ResourceStore } from './resource-store.js'
import { assessClose, type CloseAssessment, type CloseResult, type WorkspaceLifecycle } from './lifecycle.js'
import { inputResources } from './resource-ownership.js'
import { IngressQueue, ingressPayloadInputs } from './ingress.js'
import { DurableCommitBarrier } from './durable-commit.js'
import { sameRecoveryValue, type RecoveryStoreSession } from './recovery-store.js'
import { DurableTaskDefinitions, prepareDurableTaskRequest, verifyDurableTaskRequest, type DurableTaskDefinition } from './durable-task.js'

export type WorkspaceCommand = SaveScheduleEvent | SessionEvent | ViewEvent | TaskCommand | Extract<KernelEvent, { kind: 'prepared-action' | 'prepared-undo' | 'prepared-redo' | 'prepared-resolution' | 'policy-observed' }>
export type TaskExecutor = (context: Readonly<{ taskId: TaskId; executionId: string; input: OwnedInput; signal: AbortSignal }>) => TaskResult | Promise<TaskResult>
type TaskWorker = { executionId: string; execute: TaskExecutor; controller: AbortController; completion: Promise<void> | null; registration: Promise<CommandResult> | null }
export type WorkspaceOptions = Readonly<{ scope: ScopeIdentity; schema: KernelSchema; policy: PolicySnapshot; source: PersistenceSource; workspaceId?: WorkspaceId; tasks?: readonly DurableTaskDefinition[] }>
export type RejectedAction = Readonly<{ id: IngressId; prepared: PreparedAction; issue: KernelIssue }>
export type RejectedResolution = Readonly<{ id: IngressId; request: ResolutionRequest; issue: KernelIssue }>
export type WorkspaceSaveResult =
  | Readonly<{ kind: 'committed'; submission: FrozenSubmission; remaining: readonly IntentId[]; neutral: readonly IntentId[] }>
  | Readonly<{ kind: 'not-applied'; proof: NotAppliedProof }>
  | Readonly<{ kind: 'unresolved'; submission: FrozenSubmission; issue: KernelIssue | null }>
  | Readonly<{ kind: 'blocked'; issue: KernelIssue }>
  | Readonly<{ kind: 'no-changes' | 'not-started' }>

export type RecoveryOutcome = Readonly<{ candidate: RecoveryCandidate; result: CommandResult | WorkspaceSaveResult }>
export type WorkspaceRecoveryResult = Readonly<{ kind: 'completed' | 'blocked'; outcomes: readonly RecoveryOutcome[]; remaining: RecoveryPlan; issue?: KernelIssue }>
export type WorkspaceSnapshot = Readonly<{
  state: KernelState
  projection: ReturnType<typeof projectKernel>
  view: ReturnType<typeof projectView>
  ingress: ReturnType<IngressQueue['getSnapshot']>
  editorInput: ReturnType<IngressQueue['inputProjection']>
  storage: ReturnType<DurableCommitBarrier['getStatus']> | null
  runtimeIssue: KernelIssue | null
  capabilities: ReturnType<Workspace['getCapabilities']>
  checkpoint: ReturnType<Workspace['getCheckpointStatus']>
  scheduledSave: ReturnType<Workspace['getScheduledSaveResult']>
  recovery: Readonly<{ plan: RecoveryPlan; running: boolean }>
}>

const issue = (error: unknown): KernelIssue => Object.freeze({ code: 'workspace-runtime', message: error instanceof Error ? error.message : 'Workspace execution could not complete.' })
const id = () => crypto.randomUUID()

/** Shared asynchronous executor for memory and durable semantic commits.
 * Views own neither the state nor I/O. Every command uses the ingress queue;
 * durable state and effects pass the storage barrier before publication.
 * Memory transfer requires the live owner; durable transfer uses a stored
 * checkpoint and an exclusive lease. Explicit discard records input terminals
 * and a history boundary before closing.
 */
export class Workspace {
  readonly #schema: KernelSchema
  readonly #gateway: PersistenceGateway
  #state: KernelState
  #snapshot: WorkspaceSnapshot | null = null
  #projection: Readonly<{ state: KernelState; value: ReturnType<typeof projectKernel> }> | null = null
  #view: Readonly<{ state: KernelState; value: ReturnType<typeof projectView> }> | null = null
  #capabilities: Readonly<{ state: KernelState; value: SemanticCapabilities }> | null = null
  #permit: GatewayPermit | null = null
  #submission: FrozenSubmission | null = null
  #lane: Promise<unknown> = Promise.resolve()
  #saving: Promise<WorkspaceSaveResult> | null = null
  #listeners = new Set<() => void>()
  #notificationQueued = false
  #runtimeIssue: KernelIssue | null = null
  #taskWorkers = new Map<TaskId, TaskWorker>()
  readonly #taskDefinitions: DurableTaskDefinitions
  #taskRegistrations = new Map<TaskId, Promise<CommandResult>>()
  #taskExecutions = new Map<string, { taskId: TaskId; controller: AbortController; completion: Promise<CommandResult> }>()
  #resources = new ResourceStore()
  #ingress: IngressQueue
  #durable: DurableCommitBarrier | null = null
  #fenced: KernelIssue | null = null
  #fence: GatewayFence | null = null
  #restored = false
  #lifecycle: WorkspaceLifecycle = 'open'
  #runtimeEpoch: string = id()
  #runtimeGeneration = 0
  #activities = new Set<string>()
  #releaseStorage: (() => Promise<void>) | null = null
  #closeTicket: CloseTicket | null = null
  #closing: Promise<CloseResult> | null = null
  #closePreparation: Readonly<{ ticket: CloseTicket; result: Promise<CloseResult> }> | null = null
  #checkpointStore: CheckpointStore | null = null
  #checkpointAttempt: CheckpointWrite | null = null
  #checkpointClosing: Readonly<{ ticket: CloseTicket; result: Promise<CloseResult> }> | null = null
  #memoryTransfers = 0
  #discardClosing: Readonly<{ ticket: CloseTicket; result: Promise<CloseResult> }> | null = null
  #closedCheckpoint: CheckpointToken | null = null
  #saveTimer: { token: number; handle: ReturnType<typeof setTimeout> } | null = null
  #scheduledSaveResult: Readonly<{ token: number; result: WorkspaceSaveResult }> | null = null
  #attemptedScheduleToken: number | null = null
  #recoveryRun: Promise<WorkspaceRecoveryResult> | null = null
  #recoveryOutcomes: readonly RecoveryOutcome[] = Object.freeze([])

  constructor(options: WorkspaceOptions) {
    this.#schema = defineKernelSchema(options.schema)
    this.#taskDefinitions = new DurableTaskDefinitions(options.tasks)
    this.#gateway = persistenceGateway(options.source)
    if (options.scope.sourceId !== this.#gateway.sourceId) throw new Error('Workspace scope belongs to another physical source.')
    this.#state = createKernelState({ id: options.workspaceId ?? kernelId<'workspace'>(id()), scope: options.scope, schema: this.#schema.version, codec: this.#schema.codec }, options.policy,
      { restoreDeleted: this.#gateway.capabilities.restoreDeleted })
    assertKernelSchema(this.#state.workspace, this.#schema)
    this.#ingress = new IngressQueue(() => this.#state, event => this.#publish(event), () => this.#notify(), () => this.#admissionIssue())
  }

  /** In-process memory ownership transfer. An arbitrary archived snapshot is
   * insufficient authority: the live owner must yield its current ticket.
   * Source operations and callbacks must finish before this transfer. */
  static async transferMemory(options: WorkspaceOptions & Readonly<{ from: Workspace; ticket: CloseTicket }>): Promise<Workspace> {
    const previous = options.from
    const ticket = ownEncodedValue(options.ticket) as unknown as CloseTicket
    const assertTransferable = () => {
      if (previous.#durable || previous.#admissionIssue()) throw new Error('Memory transfer requires an open memory Workspace.')
      if (!sameRecoveryValue(ticket, previous.requestClose().ticket)) throw new Error('The memory transfer ticket is stale.')
      if (previous.#activities.size || previous.#saving || previous.#taskWorkers.size || previous.#taskExecutions.size
        || previous.#recoveryRun || previous.#ingress.busy || previous.#recoveryReservation())
        throw new Error('Memory transfer must retain the current owner until running work and source reservations finish.')
    }
    assertTransferable()
    const workspace = new Workspace({ ...options, workspaceId: previous.#state.workspace.id })
    if (workspace.#gateway !== previous.#gateway || !sameRecoveryValue(workspace.#state.workspace, previous.#state.workspace)
      || !sameRecoveryValue(workspace.#state.sourceCapabilities, previous.#state.sourceCapabilities))
      throw new Error('Memory transfer requires the same complete Workspace and physical source.')
    previous.#memoryTransfers++
    try {
      const checkpoint = await previous.exportCheckpoint()
      const restored = await validateWorkspaceCheckpoint(checkpoint, workspace.#schema)
      workspace.#state = restored.metadata.state
      workspace.#resources = restored.resources
      workspace.#ingress = IngressQueue.restore(restored.metadata.ingress, () => workspace.#state,
        event => workspace.#publish(event), () => workspace.#notify(), () => workspace.#admissionIssue())
      workspace.#ingress.retainQueuedAfterRestore()
      // Detach only the old view binding, before revoking its owner. Validation
      // or preparation failure must leave that owner completely usable.
      const editor = workspace.#state.session
      if (editor?.editor) {
        const detached = reduceKernel(workspace.#state, { kind: 'session-detached', lease: editor.editor, inputVersion: editor.input.version }, workspace.#schema)
        if (detached.result.kind !== 'accepted') throw new Error('Memory transfer could not detach the previous editor.')
        workspace.#state = detached.state
      }
      assertTransferable()
      // No await between the final ownership check and admission revocation.
      previous.#cancelSaveTimer()
      previous.#closeTicket = ticket
      previous.#lifecycle = 'closed'
      workspace.#attemptedScheduleToken = previous.#attemptedScheduleToken
      workspace.#scheduledSaveResult = previous.#scheduledSaveResult
      workspace.#runtimeIssue = previous.#runtimeIssue
      workspace.#ingress.resume()
      previous.#notify(); workspace.#notify()
      return workspace
    } finally { previous.#memoryTransfers-- }
  }

  static async openDurable(options: WorkspaceOptions & Readonly<{ session: RecoveryStoreSession; restore: boolean; recovery?: 'manual' | 'lookup' }>): Promise<Workspace> {
    const workspace = new Workspace({ ...options, workspaceId: options.session.lease.workspace.id })
    if (!sameRecoveryValue(workspace.#state.workspace, options.session.lease.workspace)) throw new Error('The storage lease must match the complete Workspace definition.')
    const stored = await checkpointStore(options.session)?.load()
    if (stored) {
      if (!options.restore) throw new Error('This durable Workspace has a checkpoint head; reopen it through explicit restoration.')
      return Workspace.openCheckpoint({ ...options, checkpoint: stored.checkpoint })
    }
    if (!options.restore && await options.session.load()) throw new Error('This durable Workspace already has a root; reopen it through explicit restoration.')
    const barrier = options.restore
      ? await DurableCommitBarrier.restore({ initialState: workspace.#state, schema: workspace.#schema, session: options.session })
      : new DurableCommitBarrier({ state: workspace.#state, schema: workspace.#schema, resources: workspace.#resources, session: options.session })
    const ingress = options.restore ? barrier.getRestoredRecord()?.ingress : null
    if (options.restore && !ingress) throw new Error('A durable Workspace root requires its complete ingress checkpoint.')
    return Workspace.#activateDurable(workspace, barrier, options.session, ingress ?? null, options.restore, false, options.recovery)
  }

  /** The supplied session must be a new exclusive lease. Resolve the original
   * storage token before exposing an executor; an inconclusive lookup leaves
   * the caller's checkpoint intact and starts no source/task work. */
  static async openCheckpoint(options: WorkspaceOptions & Readonly<{ session: RecoveryStoreSession; checkpoint: WorkspaceCheckpoint; recovery?: 'manual' | 'lookup' }>): Promise<Workspace> {
    const workspace = new Workspace({ ...options, workspaceId: options.session.lease.workspace.id })
    const restored = await DurableCommitBarrier.restoreCheckpoint({ initialState: workspace.#state, schema: workspace.#schema, session: options.session, checkpoint: options.checkpoint })
    const { barrier, metadata } = restored
    const queue = IngressQueue.restore(metadata.ingress, () => barrier.getState(), () => { throw new Error('Checkpoint validation cannot execute queued work.') })
    const active = queue.getSnapshot().pending.find(entry => entry.phase === 'uncertain')
    let rejectedFreeze = false
    if (active?.phase === 'uncertain') {
      const transition = restored.publishedTransition ?? await barrier.reconcile()
      if (transition.result.kind === 'unresolved') throw new Error(`Checkpoint activation is waiting for the original storage outcome: ${transition.result.issue.message}`)
      rejectedFreeze = transition.result.kind === 'rejected' && active.event.kind === 'freeze-submission'
      queue.resolveUncertain(active.attempt, transition)
    }
    // A completed source receipt can coexist with an old runtime reservation.
    // Keep its exact request until the shared gateway's recovery protocol has
    // proved the old holder can be released or inherited.
    workspace.#submission = !rejectedFreeze && metadata.reservation?.kind === 'submission' ? metadata.reservation.submission : null
    return Workspace.#activateDurable(workspace, barrier, options.session, queue.exportCheckpoint(), true, true, options.recovery)
  }

  static async #activateDurable(workspace: Workspace, barrier: DurableCommitBarrier, session: RecoveryStoreSession,
    ingress: IngressCheckpoint | null, restoring: boolean, installCheckpoint: boolean, recovery: 'manual' | 'lookup' | undefined): Promise<Workspace> {
    if (!sameRecoveryValue(barrier.getState().sourceCapabilities, workspace.#state.sourceCapabilities)) throw new Error('Restored source capabilities differ from the fixed Workspace definition.')
    workspace.#durable = barrier; workspace.#resources = barrier.resources; workspace.#state = barrier.getState(); workspace.#restored = restoring
    if (ingress) {
      workspace.#ingress = IngressQueue.restore(ingress, () => workspace.#state, event => workspace.#publish(event), () => workspace.#notify(), () => workspace.#admissionIssue())
      workspace.#ingress.retainQueuedAfterRestore()
    }
    workspace.#submission = 'submission' in workspace.#state.persistence ? workspace.#state.persistence.submission : workspace.#submission
    workspace.#runtimeEpoch = session.lease.epoch
    workspace.#releaseStorage = session.release.bind(session)
    const checkpoints = checkpointStore(session)
    workspace.#checkpointStore = checkpoints ? Object.freeze({ commit: checkpoints.commit.bind(checkpoints), lookup: checkpoints.lookup.bind(checkpoints), load: checkpoints.load.bind(checkpoints) }) : null
    workspace.#fence = Object.freeze({ epoch: session.lease.epoch, isActive: () => workspace.#lifecycle === 'open' && workspace.#fenced === null && barrier.getStatus().kind !== 'fenced' })
    session.onFence(reason => {
      if (workspace.#lifecycle === 'closing' || workspace.#lifecycle === 'closed') return
      workspace.#cancelSaveTimer()
      workspace.#lifecycle = 'fenced'
      workspace.#fenced = issue(new Error(reason)); workspace.#runtimeIssue = workspace.#fenced
      for (const worker of workspace.#taskWorkers.values()) worker.controller.abort()
      for (const execution of workspace.#taskExecutions.values()) execution.controller.abort()
      workspace.#notify()
    })
    if (ingress) workspace.#ingress.resume()
    const editor = workspace.#state.session
    if (restoring && editor?.editor) {
      const detached = await workspace.#commit({ kind: 'session-detached', lease: editor.editor, inputVersion: editor.input.version })
      if (detached.result.kind !== 'accepted') workspace.#runtimeIssue = workspace.#transitionIssue(detached)
    } else if (installCheckpoint) {
      // Persist the imported ingress and physical inventory even when there is
      // no editor to detach. A subsequent ordinary reload uses this new root.
      const installed = await workspace.#commit({ kind: 'ingress-checkpointed', revision: workspace.#state.revision })
      if (installed.result.kind !== 'accepted') workspace.#runtimeIssue = workspace.#transitionIssue(installed)
    }
    if (restoring && recovery === 'lookup') void workspace.recoverPendingWork().catch(error => { workspace.#runtimeIssue = issue(error); workspace.#notify() })
    workspace.#notify()
    return workspace
  }

  #admissionIssue(): KernelIssue | null {
    return this.#fenced ?? (this.#lifecycle === 'open' ? null : { code: 'workspace-closed', message: 'This Workspace no longer accepts work. The producer retains its input.' })
  }

  requestClose(): CloseAssessment {
    return assessClose(this.#state, this.getProjection(), this.#ingress.getSnapshot(), {
      lifecycle: this.#lifecycle, leaseEpoch: this.#runtimeEpoch, generation: this.#runtimeGeneration,
      activities: [...this.#activities, ...[...this.#taskWorkers.keys()].map(id => `callback:${id}`),
        ...[...this.#taskExecutions.keys()].map(id => `execution:${id}`),
        ...(this.#lifecycle === 'open' && (this.#checkpointAttempt || this.#checkpointClosing) ? ['checkpoint-close'] : [])],
      storage: this.getStorageStatus(), reservation: this.#submission?.operationId ?? this.#gateway.workspaceReservation(this.#state.workspace.scope, this.#state.workspace.id),
    })
  }

  /** The check and admission fence are synchronous, with no await between
   * them. Lease release can then wait without accepting a new producer. */
  close(ticket: CloseTicket, disposition: 'clean-close' | 'checkpoint-close' | 'discard' | 'retain'): Promise<CloseResult> {
    if (disposition === 'discard' && this.#discardClosing && sameRecoveryValue(ticket, this.#discardClosing.ticket)) return this.#discardClosing.result
    if (disposition === 'checkpoint-close' && this.#checkpointClosing && sameRecoveryValue(ticket, this.#checkpointClosing.ticket)) return this.#checkpointClosing.result
    if (disposition === 'clean-close' && this.#closePreparation && sameRecoveryValue(ticket, this.#closePreparation.ticket)) return this.#closePreparation.result
    const assessment = this.requestClose()
    if (!sameRecoveryValue(ticket, assessment.ticket)) return Promise.resolve({ kind: 'blocked', reason: 'stale', assessment })
    if (this.#lifecycle === 'closing' && disposition !== 'retain' && sameRecoveryValue(ticket, this.#closeTicket)) return this.#finishClose()
    if (this.#lifecycle === 'closed' && disposition !== 'retain' && sameRecoveryValue(ticket, this.#closeTicket)) return Promise.resolve(this.#closedResult())
    if (this.#lifecycle !== 'open') return Promise.resolve({ kind: 'blocked', reason: 'inactive', assessment })
    if (disposition === 'retain') {
      if (this.#checkpointClosing || this.#closePreparation || this.#memoryTransfers || this.#discardClosing) this.#runtimeGeneration++
      return Promise.resolve({ kind: 'retained', assessment: this.requestClose() })
    }
    if (disposition === 'checkpoint-close') return this.#closeWithCheckpoint(assessment.ticket)
    if (disposition === 'discard') return this.#closeWithDiscard(assessment.ticket)
    if (disposition !== 'clean-close' || assessment.blockers.length) return Promise.resolve({ kind: 'blocked', reason: 'work', assessment })
    if (this.#durable && !sameRecoveryValue(this.#durable.getCheckpointEvidence().record?.ingress ?? null, this.#ingress.exportCheckpoint())) {
      // An ignored receipt can change ingress without a semantic
      // transition. Persist it before releasing the lease; never reopen an
      // older root that still claims to own explicitly disposed input.
      const reviewed = assessment.ticket
      const result = Promise.resolve().then(async (): Promise<CloseResult> => {
        const transition = await this.#commit({ kind: 'ingress-checkpointed', revision: reviewed.semanticRevision })
        if (transition.result.kind !== 'accepted') return { kind: 'blocked', reason: 'checkpoint-failed', assessment: this.requestClose(), issue: this.#transitionIssue(transition) }
        const expected = { ...reviewed, semanticRevision: reviewed.semanticRevision + 1, ingressGeneration: reviewed.ingressGeneration + 1 }
        return this.close(expected, 'clean-close')
      }).finally(() => { this.#closePreparation = null })
      this.#closePreparation = { ticket: assessment.ticket, result }
      return result
    }
    return this.#beginClose(assessment.ticket)
  }

  #closeWithDiscard(ticket: CloseTicket): Promise<CloseResult> {
    const assessment = this.requestClose()
    if (this.#discardClosing || this.#checkpointClosing || this.#checkpointAttempt || this.#closePreparation
      || this.#activities.size || this.#saving || this.#taskWorkers.size || this.#taskExecutions.size || this.#recoveryRun
      || this.#recoveryReservation() || this.#ingress.busy || (this.#durable && this.#durable.getStatus().kind !== 'idle'))
      return Promise.resolve({ kind: 'blocked', reason: 'work', assessment })
    const result = Promise.resolve().then(async (): Promise<CloseResult> => {
      // This preparation may have yielded to new input, retain or another
      // close. Check again before recording any irreversible disposition.
      if (this.#admissionIssue() || !sameRecoveryValue(ticket, this.requestClose().ticket))
        return { kind: 'blocked', reason: 'stale', assessment: this.requestClose() }
      const transition = await this.#commit({ kind: 'workspace-discarded', ticket })
      if (transition.result.kind !== 'accepted') return { kind: 'blocked', reason: 'checkpoint-failed', assessment: this.requestClose(), issue: this.#transitionIssue(transition) }
      // Only the reviewed ingress precedes the discard event. Later producers
      // remain owned, and make this expected ticket stale instead of closing.
      return this.close({ ...ticket, semanticRevision: ticket.semanticRevision + 1, ingressGeneration: ticket.ingressGeneration + 1 }, 'clean-close')
    }).finally(() => { this.#discardClosing = null; this.#notify() })
    this.#discardClosing = { ticket, result }
    return result
  }

  getCheckpointStatus() {
    return this.#checkpointClosing ? { kind: 'writing' as const, commit: this.#checkpointAttempt?.commit ?? null }
      : this.#checkpointAttempt ? { kind: 'unknown' as const, commit: this.#checkpointAttempt.commit } : { kind: 'idle' as const }
  }

  #closeWithCheckpoint(ticket: CloseTicket): Promise<CloseResult> {
    if (this.#checkpointClosing) return Promise.resolve({ kind: 'blocked', reason: 'work', assessment: this.requestClose() })
    const store = this.#checkpointStore, barrier = this.#durable
    if (!store || !barrier) return Promise.resolve({ kind: 'blocked', reason: 'checkpoint-failed', assessment: this.requestClose(),
      issue: { code: 'checkpoint-unavailable', message: 'Checkpoint-close requires a durable checkpoint storage session.' } })
    const result = Promise.resolve().then(async (): Promise<CloseResult> => {
      try {
        let receipt
        if (this.#checkpointAttempt) receipt = await store.lookup(this.#checkpointAttempt.commit)
        else {
          const previous = await store.load(), checkpoint = await this.exportCheckpoint()
          const write = await prepareCheckpointWrite(checkpoint, previous?.commit.token ?? null, id(), this.#schema)
          if (!sameRecoveryValue(ticket, checkpoint.metadata.ticket) || !sameRecoveryValue(ticket, this.requestClose().ticket))
            return { kind: 'blocked', reason: 'stale', assessment: this.requestClose() }
          this.#checkpointAttempt = write
          receipt = await store.commit(write)
        }
        const write = this.#checkpointAttempt
        if (!write) throw new Error('Checkpoint result has no owning attempt.')
        assertCheckpointResult(write.commit, receipt)
        if (receipt.kind === 'unknown') throw new Error(receipt.issue.message)
        if (receipt.kind === 'not-stored') {
          this.#checkpointAttempt = null
          throw new Error(receipt.issue.message)
        }
        const current = await store.load()
        if (!current || !sameRecoveryValue(current.commit, write.commit)) throw new Error('The stored checkpoint is no longer the current head.')
        barrier.adoptCheckpointHead(write, receipt)
        this.#checkpointAttempt = null; this.#runtimeIssue = null
        const assessment = this.requestClose()
        if (!sameRecoveryValue(write.checkpoint.metadata.ticket, ticket) || !sameRecoveryValue(ticket, assessment.ticket))
          return { kind: 'blocked', reason: 'stale', assessment }
        if (this.#admissionIssue()) return { kind: 'blocked', reason: 'inactive', assessment }
        this.#closedCheckpoint = write.commit.token
        return this.#beginClose(ticket)
      } catch (error) {
        this.#runtimeIssue = issue(error); this.#notify()
        return { kind: 'blocked', reason: 'checkpoint-failed', assessment: this.requestClose(), issue: this.#runtimeIssue }
      }
    }).finally(() => { this.#checkpointClosing = null; this.#notify() })
    this.#checkpointClosing = { ticket, result }; this.#notify()
    return result
  }

  #beginClose(ticket: CloseTicket): Promise<CloseResult> {
    this.#closeTicket = ticket
    this.#lifecycle = 'closing'
    this.#cancelSaveTimer()
    for (const worker of this.#taskWorkers.values()) worker.controller.abort()
    for (const execution of this.#taskExecutions.values()) execution.controller.abort()
    this.#notify()
    return this.#finishClose()
  }

  #closedResult(): CloseResult {
    return { kind: 'closed', assessment: this.requestClose(), ...(this.#closedCheckpoint ? { checkpoint: this.#closedCheckpoint } : {}) }
  }

  #finishClose(): Promise<CloseResult> {
    if (this.#closing) return this.#closing
    this.#closing = Promise.resolve().then(async (): Promise<CloseResult> => {
      try {
        await this.#releaseStorage?.()
        this.#lifecycle = 'closed'; this.#runtimeIssue = null; this.#notify()
        return this.#closedResult()
      } catch (error) {
        this.#runtimeIssue = issue(error); this.#notify()
        return { kind: 'blocked', reason: 'release-failed', assessment: this.requestClose(), issue: this.#runtimeIssue }
      }
    }).finally(() => { this.#closing = null })
    return this.#closing
  }

  setSaveSchedule(options: SaveScheduleOptions, expectedToken = this.#state.schedule.token): Promise<CommandResult> {
    return this.dispatch({ kind: 'save-schedule-configured', expectedToken, options })
  }
  getScheduledSaveResult() { return this.#scheduledSaveResult }

  #cancelSaveTimer() {
    if (this.#saveTimer) clearTimeout(this.#saveTimer.handle)
    this.#saveTimer = null
  }

  #canSchedule() {
    return !this.#admissionIssue() && !this.#saving && !this.#activities.size && !this.#submission && !this.#checkpointClosing && !this.#checkpointAttempt && !this.#discardClosing
      && this.#state.persistence.kind === 'idle' && !this.#ingress.busy && !this.#ingress.getSnapshot().pending.length
      && (!this.#durable || this.#durable.getStatus().kind === 'idle')
  }

  #syncSaveTimer() {
    const schedule = this.#state.schedule
    if (!schedule.pending || schedule.mode === 'manual' || schedule.token === this.#attemptedScheduleToken || !this.#canSchedule()) { this.#cancelSaveTimer(); return }
    if (this.#saveTimer?.token === schedule.token) return
    this.#cancelSaveTimer()
    const token = schedule.token
    this.#saveTimer = { token, handle: setTimeout(() => {
      if (this.#saveTimer?.token !== token) return
      this.#saveTimer = null
      // Timers have no authority to bypass newer input, an unknown operation
      // or a closing lease. The reducer checks the token again at publication.
      if (!this.#canSchedule() || this.#state.schedule.token !== token) { this.#notify(); return }
      this.#attemptedScheduleToken = token
      void this.#save(token).then(result => {
        this.#scheduledSaveResult = Object.freeze({ token, result })
        if (result.kind === 'blocked' || result.kind === 'unresolved') this.#runtimeIssue = result.issue
        this.#notify()
      }).catch(error => { this.#runtimeIssue = issue(error); this.#notify() })
    }, schedule.mode === 'debounced' ? schedule.debounceMs : 0) }
  }

  get schema() { return this.#schema }
  getState() { return this.#state }
  /** Stable external-store observation. Runtime input and failures belong to
   * the same owner as semantic state; subscribers need no second draft store. */
  getSnapshot(): WorkspaceSnapshot {
    const ingress = this.#ingress.getSnapshot(), storage = this.getStorageStatus(), checkpoint = this.getCheckpointStatus(), cached = this.#snapshot
    if (cached && cached.state === this.#state && cached.ingress === ingress && cached.storage === storage
      && cached.runtimeIssue === this.#runtimeIssue && cached.scheduledSave === this.#scheduledSaveResult && cached.recovery.running === (this.#recoveryRun !== null)
      && cached.checkpoint.kind === checkpoint.kind && ('commit' in cached.checkpoint ? cached.checkpoint.commit : null) === ('commit' in checkpoint ? checkpoint.commit : null)) return cached
    return this.#snapshot = Object.freeze({ state: this.#state, projection: this.getProjection(), view: this.getView(), ingress, storage, runtimeIssue: this.#runtimeIssue,
      editorInput: this.#state.session?.editor ? this.#ingress.inputProjection(this.#state.session.editor) : null,
      capabilities: this.getCapabilities(), checkpoint: Object.freeze(checkpoint), scheduledSave: this.#scheduledSaveResult,
      recovery: Object.freeze({ plan: this.getRecoveryPlan(), running: this.#recoveryRun !== null }) })
  }
  get durability() { return this.#durable ? 'durable' as const : 'memory' as const }
  getStorageStatus() { return this.#durable?.getStatus() ?? null }
  getRejectedResolutions(): readonly RejectedResolution[] {
    return this.#ingress.getSnapshot().pending.flatMap(entry => {
      if (entry.phase !== 'rejected' && entry.phase !== 'blocked') return []
      const request = entry.payload.kind === 'resolution-rejected' ? entry.payload.request
        : entry.payload.kind === 'event' && entry.payload.event.kind === 'prepared-resolution' ? entry.payload.event.prepared.request : null
      return request ? [Object.freeze({ id: entry.id, request, issue: entry.issue })] : []
    })
  }
  getRecoveryEntries() { return this.#state.recoveries }
  getProjection() {
    if (this.#projection?.state !== this.#state) this.#projection = { state: this.#state, value: projectKernel(this.#state, this.#schema) }
    return this.#projection.value
  }
  #namedViews = new Map<ViewId, Readonly<{ state: KernelState; value: ReturnType<typeof projectView> }>>()
  getView(viewId?: ViewId) {
    if (viewId !== undefined) {
      if (this.#namedViews.size && this.#namedViews.values().next().value!.state !== this.#state) this.#namedViews.clear()
      let cached = this.#namedViews.get(viewId)
      if (!cached) {
        cached = { state: this.#state, value: projectView(this.#state, this.#schema, this.getProjection(), viewId) }
        this.#namedViews.set(viewId, cached)
      }
      return cached.value
    }
    if (this.#view?.state !== this.#state) this.#view = { state: this.#state, value: projectView(this.#state, this.#schema, this.getProjection()) }
    return this.#view.value
  }
  getHistory() { return projectHistory(this.#state) }
  /** Runtime overlays are read afresh even when the semantic state is unchanged.
   * The returned ticket is evidence of the observation, not command authority. */
  getCapabilities() {
    if (this.#capabilities?.state !== this.#state) this.#capabilities = { state: this.#state, value: projectCapabilities(this.#state, this.#schema) }
    const semantic = this.#capabilities.value, assessment = this.requestClose()
    const blocked = (reason: BlockedCapability['reason'], message: string): BlockedCapability => Object.freeze({ kind: 'blocked', reason, issue: Object.freeze({ code: reason, message }) })
    const admission = this.#admissionIssue(), storage = this.getStorageStatus()
    const common = admission ? blocked('inactive', admission.message)
      : this.#ingress.busy || this.#checkpointAttempt || (storage && storage.kind !== 'idle') ? blocked('storage-pending', 'Wait for the current input or checkpoint commit, or resolve its exact outcome.') : null
    const save = common ?? (this.#saving || this.#activities.size ? blocked('source-busy', 'Wait for the current source operation.')
      : this.#recoveryReservation() ? blocked('source-reserved', 'Resolve the original source operation before saving again.') : semantic.save)
    return Object.freeze({ ticket: assessment.ticket, save, undo: common ?? semantic.undo, redo: common ?? semantic.redo, close: assessment })
  }

  getRejectedActions(): readonly RejectedAction[] {
    return this.#ingress.getSnapshot().pending.flatMap(entry => (entry.phase === 'rejected' || entry.phase === 'blocked') && entry.payload.kind === 'event' && entry.payload.event.kind === 'prepared-action'
      ? [Object.freeze({ id: entry.id, prepared: entry.payload.event.prepared, issue: entry.issue })] : [])
  }
  getIngress() { return this.#ingress.getSnapshot() }
  getReturnedIngress(ingressId: IngressId) {
    return this.#ingress.getSnapshot().receipts.find(receipt => receipt.id === ingressId && receipt.disposition === 'returned')?.returned ?? null
  }
  getInputProjection(lease: EditorLease) { return this.#ingress.inputProjection(lease) }
  enqueueInput(envelope: InputEnvelope) { return this.#ingress.input(envelope) }
  /** Retain keystrokes while durable session admission is still awaiting its
   * receipt. The producer never needs to predict a lease or buffer business input. */
  beginEditing(raw: Extract<SessionEvent, { kind: 'session-opened' }>) {
    const command = ownEncodedValue(raw) as unknown as typeof raw
    const lease: EditorLease = Object.freeze({ sessionId: command.sessionId, viewId: command.viewId, generation: this.#state.editorGeneration + 1 })
    const result = this.dispatch(command)
    let sequence = 0, previous: IngressId | null = null
    return Object.freeze({
      sessionId: command.sessionId, target: command.target, lease, result,
      read: (): OwnedInput => {
        const projected = this.getInputProjection(lease)
        if (projected) return projected.input
        const pending = this.getIngress().pending.filter(entry => entry.payload.kind === 'input' && entry.payload.envelope.lease.sessionId === command.sessionId).at(-1)
        return pending?.payload.kind === 'input' ? pending.payload.envelope.input : command.input
      },
      type: (input: OwnedInput, composition: InputEnvelope['composition'] = 'idle') => {
        if (this.#state.session?.editor?.sessionId === lease.sessionId) return this.typeInput(lease, input, composition)
        const ingressId = kernelId<'ingress'>(id())
        const envelope: InputEnvelope = { ingressId, lease, inputSequence: ++sequence,
          predecessor: previous ? { kind: 'ingress', id: previous } : { kind: 'published', inputVersion: 0 }, input, composition }
        previous = ingressId
        return this.enqueueInput(envelope)
      },
    })
  }
  typeInput(lease: EditorLease, input: OwnedInput, composition: InputEnvelope['composition'] = 'idle') {
    return this.enqueueInput(this.#ingress.envelope(kernelId<'ingress'>(id()), lease, input, composition))
  }
  async disposeIngress(ids: readonly IngressId[], generation: number, disposition: 'discarded' | 'returned') {
    const snapshot = this.#ingress.getSnapshot()
    const event: IngressDispositionEvent = { kind: 'ingress-disposed', revision: this.#state.revision, generation, ids, disposition }
    if (this.#admissionIssue() || this.#ingress.busy) throw new Error('Wait for the current commit before disposing retained requests.')
    assertReviewedDisposition(snapshot, event)
    const payloads = ids.map(id => snapshot.pending.find(entry => entry.id === id)!.payload)
    const transition = await this.#commit(event)
    if (transition.result.kind !== 'accepted') throw new Error(this.#transitionIssue(transition).message)
    return Object.freeze(payloads)
  }
  retryIngress(id: IngressId, generation: number) { return this.#ingress.retry(id, generation) }
  getRuntimeIssue() { return this.#runtimeIssue }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    // Detaching a view never cancels a request, clears inputs or disposes this
    // workspace. The host must keep an accessible reference in memory mode.
    return () => { this.#listeners.delete(listener) }
  }

  #notify() {
    this.#snapshot = null
    if (this.#notificationQueued) return
    this.#notificationQueued = true
    queueMicrotask(() => {
      this.#notificationQueued = false
      this.#syncSaveTimer()
      // Listener changes during a callback apply to the next notification.
      // Iterating the live Set could visit a resubscribed callback forever.
      const listeners = [...this.#listeners]
      for (const listener of listeners) {
        try { listener() } catch (error) { this.#runtimeIssue = issue(error) }
      }
    })
  }

  async #commit(event: KernelEvent): Promise<KernelTransition> {
    const handle = this.#ingress.event(kernelId<'ingress'>(id()), event)
    const result = await handle.completion
    if (result.kind === 'completed') return result.transition
    this.#runtimeIssue = result.issue
    return { state: this.#state, result: { kind: 'unresolved', issue: result.issue }, effects: [] }
  }

  #publish(event: KernelEvent): KernelTransition | Promise<KernelTransition> {
    if (this.#admissionIssue()) return { state: this.#state, result: { kind: 'rejected', issue: this.#admissionIssue()! }, effects: [] }
    if (event.kind === 'workspace-discarded' && !sameRecoveryValue({ ...event.ticket, ingressGeneration: event.ticket.ingressGeneration + 1 }, this.requestClose().ticket))
      return this.#publishDeclined(event, { code: 'stale-discard', message: 'Discard must be reviewed again after ownership or runtime activity changes.' })
    if (event.kind === 'task-registered' && event.definition && !event.execution) {
      // The entire raw registration already belongs to ingress. Hashing must
      // not hide pending File input in a Promise outside recovery/close state.
      return (async (): Promise<KernelTransition> => {
        try {
          if (!this.#durable) throw new Error('Recoverable tasks require a durable Workspace.')
          const definition = this.#taskDefinitions.get(event.definition!)
          const execution = await prepareDurableTaskRequest(this.#state, event.taskId, event.executionId, definition.ref, event.owner, event.input, this.#resources)
          return this.#publish({ ...event, execution })
        } catch (error) { return this.#publishDeclined(event, issue(error)) }
      })()
    }
    if (this.#durable) return this.#durable.commit(event, this.#ingress.exportCheckpoint()).then(transition => this.#published(transition))
    const transition = reduceKernel(this.#state, event, this.#schema)
    if (transition.result.kind === 'accepted') {
      try { this.#resources.assertState(transition.state) }
      catch (error) { return { state: this.#state, result: { kind: 'rejected', issue: issue(error) }, effects: [] } }
    }
    return this.#published(transition)
  }

  #publishDeclined(event: KernelEvent, failure: KernelIssue): KernelTransition | Promise<KernelTransition> {
    if (this.#durable) return this.#durable.commit(event, this.#ingress.exportCheckpoint(), failure).then(transition => this.#published(transition))
    return { state: this.#state, result: { kind: 'rejected', issue: failure }, effects: [] }
  }

  #published(transition: KernelTransition, recovering = false): KernelTransition {
    if (transition.result.kind === 'accepted') {
      if (this.#admissionIssue()) return { state: this.#state, result: { kind: 'unresolved', issue: this.#admissionIssue()! }, effects: [] }
      this.#state = transition.state
      this.#notify()
      for (const effect of transition.effects) if ((!recovering && effect.kind === 'run-task') || effect.kind === 'abort-task') this.#taskEffect(effect)
    }
    return transition
  }

  reconcileStorage(): Promise<CommandResult> { return this.#reconcileStorage() }

  async #reconcileStorage(recovering = false): Promise<CommandResult> {
    if (!this.#durable) return { kind: 'rejected', issue: issue(new Error('This Workspace has no durable storage barrier.')) }
    const pending = this.#ingress.getSnapshot().pending.find(entry => entry.phase === 'uncertain')
    if (!pending || pending.phase !== 'uncertain') return { kind: 'rejected', issue: issue(new Error('There is no uncertain storage attempt.')) }
    const transition = this.#published(await this.#durable.reconcile(), recovering)
    this.#ingress.resolveUncertain(pending.attempt, transition)
    if (transition.result.kind === 'rejected' && pending.payload.kind === 'event' && pending.payload.event.kind === 'freeze-submission') {
      this.#submission = null
      if (this.#permit) { this.#gateway.abandonUnused(this.#permit); this.#permit = null }
    }
    this.#runtimeIssue = transition.result.kind === 'rejected' || transition.result.kind === 'unresolved' ? transition.result.issue : null
    // Network recovery is explicit. A recovered freeze is first queried with
    // its original OperationId; no lost save callback can create a new write.
    return transition.result
  }

  async registerResource(blob: Blob): Promise<Extract<OwnedInput, { kind: 'resource' }>> {
    const admission = this.#admissionIssue()
    if (admission) throw new Error(admission.message)
    const resourceId = kernelId<'resource'>(id()), descriptor = this.#resources.register(resourceId, blob)
    const result = (await this.#commit({ kind: 'resource-registered', descriptor })).result
    if (result.kind !== 'accepted') {
      // The rejected/unknown registration remains in ingress and must retain
      // its physical bytes for an explicit retry or complete checkpoint.
      throw new Error(result.kind === 'ignored' ? result.reason : result.issue.message)
    }
    return Object.freeze({ kind: 'resource', id: resourceId })
  }

  getResource(resourceId: ResourceId): Blob {
    if (!this.#state.resources.some(record => record.descriptor.id === resourceId && record.status === 'available')) throw new Error('Resource is no longer available in this workspace.')
    return this.#resources.get(resourceId)
  }

  /** Recovery export is authorized by a pending request or returned archive, including a
   * registration that never published. It does not grant semantic resource
   * availability to tasks or later commands. Discarded request IDs cannot read. */
  getIngressResource(ingressId: IngressId, resourceId: ResourceId): Blob {
    const snapshot = this.#ingress.getSnapshot(), entry = snapshot.pending.find(entry => entry.id === ingressId)
    const payload = entry?.payload ?? this.getReturnedIngress(ingressId)
    if (!payload) throw new Error('The request no longer owns retained resources.')
    const references = new Set(inputResources(ingressPayloadInputs(payload)))
    if (!references.has(resourceId)) throw new Error('The retained request does not reference this resource.')
    return this.#resources.get(resourceId)
  }

  async releaseResource(resourceId: ResourceId): Promise<CommandResult> {
    if (this.#retainedResourceIds().has(resourceId)) return { kind: 'rejected', issue: { code: 'resource-retained', message: 'Retained request material still references this resource.' } }
    const result = (await this.#commit({ kind: 'resource-released', resourceId })).result
    if (result.kind === 'accepted') this.#resources.release(resourceId)
    return result
  }

  #retainedResourceIds() {
    const snapshot = this.#ingress.getSnapshot()
    const payloads = [...snapshot.pending.map(entry => entry.payload), ...snapshot.receipts.flatMap(receipt => receipt.returned ? [receipt.returned] : [])]
    const resources = new Set(inputResources(payloads.flatMap(ingressPayloadInputs)))
    return resources
  }

  async exportCheckpoint() {
    const admission = this.#admissionIssue()
    if (admission) return Promise.reject(new Error(admission.message))
    if (this.#taskWorkers.size) return Promise.reject(new Error('A memory task callback must finish before a complete checkpoint can be exported.'))
    const state = this.#state, ticket = this.requestClose().ticket, ingress = this.#ingress.exportCheckpoint()
    const storage = this.#durable?.getCheckpointEvidence() ?? { kind: 'memory' as const }
    const reservation = this.#recoveryReservation()
    return createWorkspaceCheckpoint({ state, ticket, ingress, storage, reservation }, this.#resources.exportCheckpoint(state), this.#schema)
  }

  async exportResources() {
    for (const id of this.#retainedResourceIds()) if (!this.#state.resources.some(record => record.descriptor.id === id && record.status === 'available'))
      throw new Error('Rejected input references unavailable resource bytes; recovery export is incomplete.')
    return this.#resources.export(this.#state)
  }

  async dispatch(command: WorkspaceCommand): Promise<CommandResult> {
    try {
      const owned = ownEncodedValue(command) as unknown as WorkspaceCommand
      if (owned.kind !== 'save-schedule-configured' && owned.kind !== 'prepared-action' && owned.kind !== 'prepared-undo' && owned.kind !== 'prepared-redo' && owned.kind !== 'prepared-resolution' && owned.kind !== 'policy-observed'
        && owned.kind !== 'session-opened' && owned.kind !== 'session-attached' && owned.kind !== 'session-detached' && owned.kind !== 'session-input'
        && owned.kind !== 'session-reconfirmed' && owned.kind !== 'session-retargeted' && owned.kind !== 'session-apply' && owned.kind !== 'session-query-apply'
        && owned.kind !== 'session-cancelled' && owned.kind !== 'view-query-set' && owned.kind !== 'view-search-set'
        && owned.kind !== 'task-cancelled' && owned.kind !== 'task-consume' && owned.kind !== 'task-reapply') throw new Error('Transport facts may only enter through the Workspace executor.')
      // Capture once at admission for every opening producer, before any queued
      // write can advance the revision. Never refresh a stale caller's reads.
      const admitted = owned.kind === 'session-opened' && owned.context === undefined && owned.revision === this.#state.revision
        ? { ...owned, context: captureSessionOpeningContext(this.#state, owned.target, owned.reads, this.#schema) } : owned
      return (await this.#commit(admitted)).result
    } catch (error) { return { kind: 'rejected', issue: issue(error) } }
  }

  runTask(raw: Readonly<{ owner: TaskOwner; input: OwnedInput; reads: readonly ResourceRef[] }>, execute: TaskExecutor): Readonly<{ taskId: TaskId; result: Promise<CommandResult> }> {
    const taskId = kernelId<'task'>(id()), executionId = id()
    try {
      const request = ownEncodedValue(raw) as unknown as typeof raw
      if (this.#admissionIssue()) throw new Error(this.#admissionIssue()!.message)
      if (this.#durable) throw new Error('Durable tasks require a recoverable execution definition; memory callbacks cannot be started in durable mode.')
      if (typeof execute !== 'function') throw new Error('A task requires an executor.')
      const worker: TaskWorker = { executionId, execute, controller: new AbortController(), completion: null, registration: null }
      this.#taskWorkers.set(taskId, worker)
      const result = this.#commit({ kind: 'task-registered', revision: this.#state.revision, taskId, executionId, inputId: kernelId<'input'>(id()),
        owner: request.owner, input: request.input, reads: request.reads }).then(transition => {
        if (transition.result.kind !== 'accepted' && transition.result.kind !== 'unresolved') this.#taskWorkers.delete(taskId)
        return transition.result
      })
      worker.registration = result
      return { taskId, result }
    } catch (error) {
      this.#taskWorkers.delete(taskId)
      return { taskId, result: Promise.resolve({ kind: 'rejected', issue: issue(error) }) }
    }
  }

  async waitForTask(taskId: TaskId) {
    await this.#taskRegistrations.get(taskId)
    await Promise.all([...this.#taskExecutions.values()].filter(execution => execution.taskId === taskId).map(execution => execution.completion))
    const worker = this.#taskWorkers.get(taskId)
    await worker?.registration
    await worker?.completion
    return this.#state.tasks.find(task => task.id === taskId) ?? null
  }

  #taskEffect(effect: TaskEffect) {
    const task = this.#state.tasks.find(task => task.id === effect.taskId)
    if (task?.execution) {
      if (effect.kind === 'abort-task') { for (const execution of this.#taskExecutions.values()) if (execution.taskId === effect.taskId) execution.controller.abort() }
      else void this.#executeDurableTask(effect.taskId, 'start')
      return
    }
    const worker = this.#taskWorkers.get(effect.taskId)
    if (!worker || worker.executionId !== effect.executionId) return
    if (effect.kind === 'abort-task') { worker.controller.abort(); return }
    if (worker.completion) return
    worker.completion = Promise.resolve().then(async () => {
      const started = await this.#commit({ kind: 'task-started', taskId: effect.taskId, executionId: effect.executionId })
      if (started.result.kind !== 'accepted') return
      const task = this.#state.tasks.find(task => task.id === effect.taskId)!
      if (task.kind !== 'running' || worker.controller.signal.aborted || this.#fenced) return
      const input = this.#state.inputs.find(input => input.ref.id === task.input.id && input.ref.version === task.input.version)!.input
      try {
        const result = await worker.execute(Object.freeze({ taskId: task.id, executionId: task.executionId, input, signal: worker.controller.signal }))
        // A rejected result remains owned by ingress. Do not replace an actual
        // success with task-failed and thereby prevent later result delivery.
        await this.#commit({ kind: 'task-completed', taskId: task.id, executionId: task.executionId, result })
      } catch (error) {
        await this.#commit({ kind: 'task-failed', taskId: task.id, executionId: task.executionId, issue: issue(error) })
      }
    }).catch(error => { this.#runtimeIssue = issue(error); this.#notify() }).finally(() => {
      if (this.#taskWorkers.get(effect.taskId) === worker) this.#taskWorkers.delete(effect.taskId)
      this.#notify()
    })
  }

  runDurableTask(raw: Readonly<{ definition: TaskDefinitionRef; owner: TaskOwner; input: OwnedInput; reads: readonly ResourceRef[] }>): Readonly<{ taskId: TaskId; result: Promise<CommandResult> }> {
    const taskId = kernelId<'task'>(id()), executionId = id()
    const result = (async (): Promise<CommandResult> => {
      try {
        const request = ownEncodedValue(raw) as unknown as typeof raw
        return (await this.#commit({ kind: 'task-registered', taskId, executionId, revision: this.#state.revision, inputId: kernelId<'input'>(id()),
          owner: request.owner, input: request.input, reads: request.reads, definition: request.definition })).result
      } catch (error) { return { kind: 'rejected', issue: issue(error) } }
    })()
    this.#taskRegistrations.set(taskId, result)
    void result.finally(() => this.#taskRegistrations.delete(taskId))
    return { taskId, result }
  }

  /** Restoring a runtime never reruns a callback. Explicit recovery queries
   * the persisted execution; retry uses the exact original idempotent request. */
  recoverTask(taskId: TaskId, mode: 'lookup' | 'retry' = 'lookup'): Promise<CommandResult> {
    return this.#executeDurableTask(taskId, mode === 'retry' ? 'start' : 'lookup')
  }

  #executeDurableTask(taskId: TaskId, mode: 'start' | 'lookup'): Promise<CommandResult> {
    if (this.#admissionIssue()) return Promise.resolve({ kind: 'rejected', issue: this.#admissionIssue()! })
    this.#runtimeGeneration++
    const key = JSON.stringify([taskId, mode]), existing = this.#taskExecutions.get(key)
    if (existing) return existing.completion
    const controller = new AbortController()
    const completion = Promise.resolve().then(async (): Promise<CommandResult> => {
      try {
        let task = this.#state.tasks.find(task => task.id === taskId)
        if (!task?.execution || !this.#durable) throw new Error('No durable execution is registered for this task.')
        if (this.#fenced) throw new Error(this.#fenced.message)
        if (this.#durable.getStatus().kind === 'unknown') throw new Error('Reconcile storage before querying or retrying the task execution.')
        if (task.execution.outcome?.kind === 'succeeded' || task.execution.outcome?.kind === 'failed') return { kind: 'ignored', reason: 'The exact terminal task outcome is already retained.' }
        if (mode === 'start' && (task.kind === 'cancelled' || task.kind === 'superseded')) throw new Error('A cancelled or superseded task may be queried, but cannot start or retry an external action.')
        const request = task.execution.request, definition = this.#taskDefinitions.get(request.ref.definition)
        if (task.kind === 'queued') {
          const started = await this.#commit({ kind: 'task-started', taskId, executionId: task.executionId })
          if (started.result.kind !== 'accepted') return started.result
        }
        const resource = await verifyDurableTaskRequest(request, this.#resources)
        task = this.#state.tasks.find(task => task.id === taskId)!
        if (this.#fenced || this.#durable.getStatus().kind === 'fenced') throw new Error('Task executor lease was fenced before I/O.')
        if (controller.signal.aborted || (mode === 'start' && task.kind !== 'running')) return { kind: 'ignored', reason: 'The original task no longer permits this execution.' }
        let outcome: DurableTaskOutcome
        try { outcome = await definition[mode](request, Object.freeze({ signal: controller.signal, resource })) }
        catch (error) { outcome = { kind: 'unknown', ref: request.ref, issue: issue(error) } }
        // Preserve actual success even if the owner was cancelled during I/O.
        // Definition/ref mismatches enter ingress as retained protocol evidence.
        return (await this.#commit({ kind: 'task-execution-observed', taskId, executionId: task.executionId, outcome })).result
      } catch (error) {
        this.#runtimeIssue = issue(error); this.#notify()
        return { kind: 'rejected', issue: this.#runtimeIssue }
      }
    }).finally(() => { if (this.#taskExecutions.get(key)?.completion === completion) this.#taskExecutions.delete(key); this.#notify() })
    this.#taskExecutions.set(key, { taskId, controller, completion })
    return completion
  }

  async #retainResolution(request: ResolutionRequest, issue: KernelIssue): Promise<CommandResult> {
    const result = await this.#ingress.retainResolution(kernelId<'ingress'>(id()), request, issue).completion
    return result.kind === 'completed' ? result.transition.result : { kind: 'unresolved', issue: result.issue }
  }

  resolve(raw: ResolutionRequest): Promise<CommandResult> {
    let request: ResolutionRequest | undefined
    try {
      request = ownEncodedValue(raw) as unknown as ResolutionRequest
      return this.dispatch({ kind: 'prepared-resolution', prepared: prepareResolution(this.#state, request, {
        actionId: kernelId<'action'>(id()), applicationId: kernelId<'application'>(id()), controlId: kernelId<'intent'>(id()),
      }, this.#schema) })
    } catch (error) {
      const failure = issue(error)
      if (request) return this.#retainResolution(request, failure)
      return Promise.resolve({ kind: 'rejected', issue: failure })
    }
  }

  undo(): Promise<CommandResult> { return this.#historyCommand('undo') }
  redo(): Promise<CommandResult> { return this.#historyCommand('redo') }
  #historyCommand(kind: 'undo' | 'redo'): Promise<CommandResult> {
    try { return this.dispatch(prepareHistoryCommand(this.#state, this.#schema, kind, id)) }
    catch (error) { return Promise.resolve({ kind: 'rejected', issue: issue(error) }) }
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.#admissionIssue()) return run()
    const activity = `source:${id()}`
    this.#activities.add(activity); this.#runtimeGeneration++; this.#notify()
    const result = this.#lane.then(run).finally(() => { this.#activities.delete(activity); this.#notify() })
    this.#lane = result.catch(() => undefined)
    return result
  }

  #readEffect(): KernelEffect { return { kind: 'read-at-least', scope: this.#state.workspace.scope, frontier: this.#state.authorityFrontier } }

  async #read(effect: Extract<KernelEffect, { kind: 'read-at-least' }>): Promise<KernelTransition> {
    const ticket = id()
    const started = await this.#commit({ kind: 'read-started', ticket })
    if (started.result.kind !== 'accepted') return started
    try {
      if (this.#fenced) throw new Error(this.#fenced.message)
      const snapshot = await this.#gateway.readAtLeast(effect.scope, effect.frontier)
      // Bind against the state at completion, including any edits or exact
      // identities published since this read began. Never capture a rows array.
      const candidates = snapshot.rows.map(row => ({ identity: row.identity, entityId: kernelId<'entity'>(id()) }))
      const result = await this.#commit({ kind: 'server-authority-received', snapshot, candidates })
      if (result.result.kind === 'rejected') await this.#commit({ kind: 'read-failed', ticket, issue: result.result.issue })
      return result
    } catch (error) {
      const failure = issue(error)
      await this.#commit({ kind: 'read-failed', ticket, issue: failure })
      return { state: this.#state, result: { kind: 'rejected', issue: failure }, effects: [] }
    }
  }

  #resultEvent(effect: Extract<KernelEffect, { kind: 'submit' | 'lookup' }>, result: SourceMutationResult): KernelEvent {
    if (result.kind === 'applied') return { kind: 'exact-receipt', receipt: result.receipt }
    if (result.kind === 'not-applied') return { kind: 'not-applied', proof: result.proof }
    if (result.kind === 'applied-without-receipt') return { kind: 'applied-without-receipt', ref: effect.submission, commitToken: result.commitToken }
    const persistence = this.#state.persistence
    return { kind: 'mutation-uncertain', ref: effect.submission,
      attempt: effect.kind === 'submit' ? effect.attempt : persistence.kind === 'sending' || persistence.kind === 'outcome-unknown' ? persistence.attempt : 0,
      issue: result.kind === 'unknown' ? result.issue : { code: 'operation-pending', message: 'The source operation is still pending.' },
    }
  }

  async #drive(initial: readonly TransitionEffect[]): Promise<KernelIssue | null> {
    const queue = [...initial], attempted = new Set<string>()
    while (queue.length) {
      if (this.#fenced) return this.#fenced
      const effect = queue.shift()!
      // Task effects already ran after their publishing commit, independently
      // of the persistence lane. Never execute them twice through this queue.
      if ('taskId' in effect) continue
      const key = canonicalEncodedValue(ownEncodedValue(effect))
      // An unchanged bad receipt/read may propose the same effect forever.
      // Keep its reservation and evidence, and require a new explicit recovery
      // cycle instead of turning protocol disagreement into a tight I/O loop.
      if (attempted.has(key)) return issue(new Error('Reconciliation requires new source evidence; retry after the source can provide it.'))
      attempted.add(key)
      let transition: KernelTransition
      if (effect.kind === 'read-at-least') transition = await this.#read(effect)
      else {
        if (!this.#permit || this.#submission?.operationId !== effect.submission.operationId) return issue(new Error('The effect has no owning scope reservation.'))
        try {
          const result = effect.kind === 'submit' ? await this.#gateway.submit(this.#permit, effect.submission) : await this.#gateway.lookup(this.#permit, effect.submission)
          transition = await this.#commit(this.#resultEvent(effect, result))
        } catch (error) { return issue(error) }
      }
      if (transition.result.kind === 'rejected' || transition.result.kind === 'unresolved') return transition.result.issue
      queue.push(...transition.effects)
    }
    return null
  }

  #release(): KernelIssue | null {
    if (!this.#permit || !this.#submission || this.#state.persistence.kind !== 'idle') return null
    try { this.#gateway.releaseSettled(this.#permit, this.#state); this.#permit = null; this.#submission = null; return null }
    catch (error) { return issue(error) }
  }

  #outcome(submission: FrozenSubmission, failure: KernelIssue | null): WorkspaceSaveResult {
    this.#runtimeIssue = failure
    if (this.#submission) return Object.freeze({ kind: 'unresolved', submission, issue: failure })
    const rejected = this.#state.rejections.find(fact => fact.submission.operationId === submission.operationId)
    if (rejected) return Object.freeze({ kind: 'not-applied', proof: rejected.proof })
    const settled = new Set(this.#state.settlements.map(proof => proof.intentId))
    const neutral = this.getProjection().neutralIntentIds, neutralSet = new Set(neutral)
    return Object.freeze({ kind: 'committed', submission, neutral,
      remaining: Object.freeze(this.#state.journal.intents.filter(intent => !settled.has(intent.id) && !neutralSet.has(intent.id)).map(intent => intent.id)),
    })
  }

  refresh(): Promise<CommandResult> {
    return this.#enqueue(async () => {
      if (this.#admissionIssue()) return { kind: 'rejected', issue: this.#admissionIssue()! }
      const failure = await this.#drive([this.#readEffect()]) ?? this.#release()
      this.#runtimeIssue = failure
      return failure ? { kind: this.#durable?.getStatus().kind === 'unknown' ? 'unresolved' : 'rejected', issue: failure } : { kind: 'accepted', revision: this.#state.revision }
    })
  }

  save(): Promise<WorkspaceSaveResult> { return this.#save() }

  #save(scheduleToken?: number): Promise<WorkspaceSaveResult> {
    if (this.#saving) return this.#saving
    this.#saving = this.#enqueue<WorkspaceSaveResult>(async () => {
      if (this.#admissionIssue()) return { kind: 'blocked', issue: this.#admissionIssue()! }
      if (this.#restored) {
        const recovered = await this.#restorePermit()
        if (recovered) return { kind: 'blocked', issue: recovered }
      }
      if (this.#submission || this.#state.persistence.kind !== 'idle') return { kind: 'blocked', issue: issue(new Error('Resolve the reserved operation before requesting another save.')) }
      const ticket = id()
      const requested = await this.#commit({ kind: 'save-requested', ticket, ...(scheduleToken !== undefined ? { scheduleToken } : {}) })
      if (requested.result.kind !== 'accepted') return { kind: 'blocked', issue: this.#transitionIssue(requested) }
      if (requested.state.persistence.kind === 'idle') return { kind: 'no-changes' }
      try {
        this.#permit = await this.#gateway.acquire(this.#state.workspace.scope, this.#state.workspace.id, ticket, this.#fence)
        const waiting = await this.#commit({ kind: 'save-wait-ended', ticket })
        if (waiting.result.kind !== 'accepted') return { kind: 'blocked', issue: this.#transitionIssue(waiting) }
        const failure = await this.#drive([this.#readEffect()])
        if (failure) return { kind: 'blocked', issue: failure }
        const draft = draftSubmission(this.#state, { operationId: kernelId<'operation'>(id()),
          items: this.getProjection().changes.map(change => ({ entityId: change.entityId, itemId: kernelId<'item'>(id()) })),
          ...(this.getProjection().orderChange ? { orderItemId: kernelId<'item'>(id()) } : {}),
        }, this.#schema)
        const submission = { ...draft.payload, payloadHash: await hashSubmission(draft.payload) }
        this.#submission = submission
        const transition = await this.#commit({ kind: 'freeze-submission', prepared: { revision: draft.revision, submission } })
        if (transition.result.kind !== 'accepted' && transition.result.kind !== 'unresolved') this.#submission = null
        if (transition.result.kind !== 'accepted') return { kind: 'blocked', issue: transition.result.kind === 'ignored' ? issue(new Error(transition.result.reason)) : transition.result.issue }
        this.#submission = 'submission' in transition.state.persistence ? transition.state.persistence.submission : null
        const executionFailure = await this.#drive(transition.effects)
        return this.#outcome(submission, executionFailure ?? this.#release())
      } catch (error) { return { kind: 'blocked', issue: issue(error) } }
      finally {
        const current = this.getState().persistence
        if (!this.#fenced && current.kind === 'waiting-for-gateway' && current.ticket === ticket
          && (!this.#durable || this.#durable.getStatus().kind === 'idle')) await this.#commit({ kind: 'save-wait-ended', ticket })
        if (this.#permit && !this.#submission && !this.#fenced) { this.#gateway.abandonUnused(this.#permit); this.#permit = null }
      }
    }).finally(() => { this.#saving = null; this.#notify() })
    return this.#saving
  }

  /** Lookup never manufactures a new mutation. Only explicit retry may resend
   * an unknown operation, with the exact frozen bytes and identity. */
  recover(mode: 'lookup' | 'retry' = 'lookup'): Promise<WorkspaceSaveResult> { return this.#recover(mode) }

  #recover(mode: 'lookup' | 'retry', expected?: RecoveryReservation): Promise<WorkspaceSaveResult> {
    return this.#enqueue(async () => {
      if (this.#admissionIssue()) return { kind: 'blocked', issue: this.#admissionIssue()! }
      if (this.#durable?.getStatus().kind === 'unknown') return { kind: 'blocked', issue: issue(new Error('Reconcile storage before executing the reserved operation.')) }
      if (expected && !sameRecoveryValue(expected, this.#recoveryReservation())) return { kind: 'blocked', issue: issue(new Error('The reviewed recovery reservation is no longer current.')) }
      const interruptedWait = this.#recoveryReservation()?.kind === 'gateway-wait'
      if (this.#restored || (this.#submission && !this.#permit)) {
        const restored = await this.#restorePermit()
        if (restored) return { kind: 'blocked', issue: restored }
      }
      const submission = this.#submission
      if (!submission && interruptedWait) {
        // Storage may have accepted SaveRequested after its caller lost the
        // acknowledgement. No frozen operation exists: retire the exact wait,
        // without inventing a lookup ID or claiming that input was saved.
        const pending = this.#state.persistence
        if (pending.kind === 'waiting-for-gateway') {
          const ended = await this.#commit({ kind: 'save-wait-ended', ticket: pending.ticket })
          if (ended.result.kind !== 'accepted') return { kind: 'blocked', issue: this.#transitionIssue(ended) }
        }
        if (this.#permit) { this.#gateway.abandonUnused(this.#permit); this.#permit = null }
        this.#runtimeIssue = null
        return { kind: 'not-started' }
      }
      if (!submission) return { kind: 'blocked', issue: issue(new Error('There is no reserved operation to recover.')) }
      let effects: readonly TransitionEffect[]
      if (this.#state.persistence.kind === 'idle') effects = [this.#readEffect()]
      else if (mode === 'retry') {
        const transition = await this.#commit({ kind: 'retry-persistence' })
        if (transition.result.kind !== 'accepted') return { kind: 'blocked', issue: this.#transitionIssue(transition) }
        effects = transition.effects
      } else effects = this.#state.commits.some(fact => fact.submission.operationId === submission.operationId) ? [this.#readEffect()] : [{ kind: 'lookup' as const, submission }]
      const failure = await this.#drive(effects)
      return this.#outcome(submission, failure ?? this.#release())
    })
  }

  #recoveryReservation(): RecoveryReservation | null {
    if ('submission' in this.#state.persistence) return { kind: 'submission', submission: this.#state.persistence.submission }
    if (this.#submission) return { kind: 'submission', submission: this.#submission }
    return this.#gateway.recoveryReservation(this.#state.workspace.scope, this.#state.workspace.id)
      ?? (this.#state.persistence.kind === 'waiting-for-gateway' ? { kind: 'gateway-wait', ticket: this.#state.persistence.ticket } : null)
  }

  getRecoveryPlan(): RecoveryPlan {
    return planRecovery(this.#state, this.requestClose(), this.getStorageStatus(), this.#recoveryReservation(), ref => this.#taskDefinitions.has(ref))
  }
  getRecoveryProgress() { return Object.freeze({ running: this.#recoveryRun !== null, outcomes: this.#recoveryOutcomes }) }

  /** One finite pass, coalesced per runtime. No polling, idempotent start or
   * destructive disposition is inferred from an unknown result. */
  recoverPendingWork(): Promise<WorkspaceRecoveryResult> {
    if (this.#recoveryRun) return this.#recoveryRun
    if (this.#admissionIssue()) return Promise.resolve({ kind: 'blocked', outcomes: [], remaining: this.getRecoveryPlan() })
    const activity = `recovery:${id()}`
    this.#activities.add(activity); this.#runtimeGeneration++; this.#recoveryOutcomes = Object.freeze([])
    const record = (candidate: RecoveryCandidate, result: RecoveryOutcome['result']) => {
      this.#recoveryOutcomes = Object.freeze([...this.#recoveryOutcomes, Object.freeze({ candidate, result })]); this.#notify()
    }
    let failure: KernelIssue | null = null
    this.#recoveryRun = Promise.resolve().then(async () => {
      try {
        const storage = this.getRecoveryPlan().candidates.find(candidate => candidate.kind === 'storage')
        if (storage) record(storage, await this.#reconcileStorage(true))
        if (this.#admissionIssue() || this.#ingress.busy || (this.getStorageStatus() && this.getStorageStatus()!.kind !== 'idle')) return
        const candidates = this.getRecoveryPlan().candidates
        // Physical queries start independently. Each result still enters the
        // single ingress/storage barrier and rechecks its semantic owner.
        await Promise.all(candidates.map(async candidate => {
          try {
            if (candidate.kind === 'storage') return
            if (candidate.kind === 'task') {
              if (!candidate.definitionAvailable) record(candidate, { kind: 'rejected', issue: { code: 'recovery-definition-missing', message: 'The original task definition version is required for recovery.' } })
              else record(candidate, await this.#executeDurableTask(candidate.ref.taskId, 'lookup'))
            } else record(candidate, await this.#recover('lookup', candidate))
          } catch (error) { record(candidate, { kind: 'rejected', issue: issue(error) }) }
        }))
      } catch (error) { failure = issue(error); this.#runtimeIssue = failure }
    }).then((): WorkspaceRecoveryResult => {
      this.#activities.delete(activity)
      const remaining = this.getRecoveryPlan()
      const blocked = failure !== null || remaining.assessment.lifecycle !== 'open' || remaining.candidates.length > 0
        || remaining.assessment.blockers.some(blocker => blocker.kind === 'storage' || blocker.kind === 'ingress')
      return Object.freeze({ kind: blocked ? 'blocked' : 'completed', outcomes: this.#recoveryOutcomes, remaining, ...(failure ? { issue: failure } : {}) })
    }).finally(() => { this.#activities.delete(activity); this.#recoveryRun = null; this.#notify() })
    this.#notify()
    return this.#recoveryRun
  }

  #transitionIssue(transition: KernelTransition): KernelIssue {
    return transition.result.kind === 'rejected' || transition.result.kind === 'unresolved' ? transition.result.issue
      : issue(new Error(transition.result.kind === 'ignored' ? transition.result.reason : 'The operation was not accepted.'))
  }

  async #restorePermit(): Promise<KernelIssue | null> {
    if (!this.#fence) return issue(new Error('Restoring an executor requires a durable lease.'))
    try {
      const inherited = await this.#gateway.acquireRecovery(this.#state, id(), this.#fence)
      this.#permit = inherited.permit; this.#submission = inherited.submission; this.#restored = false
      if (!this.#submission) { this.#gateway.abandonUnused(this.#permit); this.#permit = null }
      // A process may have stopped while waiting for permission, before any
      // request was frozen. Retire that old ticket through a durable event.
      if (this.#state.persistence.kind === 'waiting-for-gateway') {
        const ended = await this.#commit({ kind: 'save-wait-ended', ticket: this.#state.persistence.ticket })
        if (ended.result.kind !== 'accepted') return this.#transitionIssue(ended)
      }
      return null
    } catch (error) { return issue(error) }
  }
}
