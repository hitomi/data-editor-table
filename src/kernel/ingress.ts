import { restoreIngressCheckpoint, type IngressCheckpoint } from './ingress-checkpoint.js'
import { assertReviewedDisposition } from './ingress-disposition.js'
import { encodedValuesEqual, ownEncodedValue } from './document.js'
import type { EditorLease, IngressId, InputEnvelope, InputRef, KernelIssue, OwnedInput, TaskOwner } from './model.js'
import type { ResolutionRequest } from './resolution.js'
import type { KernelState } from './state.js'
import type { KernelEvent, KernelTransition } from './transition.js'

export type IngressPayload = Readonly<{ kind: 'input'; envelope: InputEnvelope }>
  | Readonly<{ kind: 'event'; event: KernelEvent }>
  | Readonly<{ kind: 'resolution-rejected'; request: ResolutionRequest }>
export type IngressAttempt = Readonly<{ ingressId: IngressId; sequence: number; generation: number; baseRevision: number }>
export type PendingIngress = Readonly<{ id: IngressId; sequence: number; scheduledAt: number; payload: IngressPayload; rejection?: KernelIssue }> & (
  | Readonly<{ phase: 'queued' }>
  | Readonly<{ phase: 'committing'; attempt: IngressAttempt; event: KernelEvent }>
  | Readonly<{ phase: 'uncertain'; attempt: IngressAttempt; event: KernelEvent; issue: KernelIssue }>
  | Readonly<{ phase: 'rejected' | 'blocked'; issue: KernelIssue }>
)
export type IngressReceipt = Readonly<{
  id: IngressId; sequence: number; scheduledAt: number; disposition: 'accepted' | 'ignored' | 'discarded' | 'returned'
  input?: Readonly<{ lease: EditorLease; inputSequence: number; ref?: InputRef }>
  returned?: IngressPayload
}>
export type IngressResult = Readonly<{ kind: 'completed'; transition: KernelTransition }>
  | Readonly<{ kind: 'unresolved'; attempt: IngressAttempt; issue: KernelIssue }>
export type IngressHandle = Readonly<{ id: IngressId; immediate: IngressResult | null; completion: Promise<IngressResult> }>
export type IngressSnapshot = Readonly<{ generation: number; pending: readonly PendingIngress[]; receipts: readonly IngressReceipt[] }>

const owned = <const T>(value: T): T => ownEncodedValue(value) as unknown as T
const same = (a: unknown, b: unknown) => encodedValuesEqual(ownEncodedValue(a), ownEncodedValue(b))
const leaseKey = (lease: EditorLease) => JSON.stringify([lease.sessionId, lease.viewId, lease.generation])
const issue = (message: string): KernelIssue => Object.freeze({ code: 'ingress-blocked', message })
const errorIssue = (error: unknown) => issue(error instanceof Error ? error.message : 'Ingress processing could not complete.')

/** Durable task registration adds a verified frozen execution request after
 * ingress has already taken ownership of the original registration. */
export function matchesIngressEvent(original: KernelEvent, committed: KernelEvent): boolean {
  if (original.kind === 'task-registered' && committed.kind === 'task-registered' && !original.execution) {
    const { execution: _execution, ...registration } = committed
    return same(original, registration)
  }
  return same(original, committed)
}

/** Runtime ownership before semantic publication. The sink owns the atomic
 * commit barrier; a Promise may remain pending across durable I/O. Exceptions
 * mean an unknown commit outcome, never permission to retry an operation. */
export class IngressQueue {
  #generation = 0
  #pending = new Map<IngressId, PendingIngress>()
  #receipts = new Map<IngressId, IngressReceipt>()
  #heads = new Map<string, Readonly<{ id: IngressId; inputSequence: number }>>()
  #queue: IngressId[] = []
  #resolvers = new Map<IngressId, (result: IngressResult) => void>()
  #active: IngressId | null = null
  #draining = false
  #paused = false
  #synchronous = new Map<IngressId, IngressResult>()
  #collecting = new Set<IngressId>()
  #snapshot: IngressSnapshot = Object.freeze({ generation: 0, pending: Object.freeze([]), receipts: Object.freeze([]) })

  constructor(readonly getState: () => KernelState, readonly commit: (event: KernelEvent) => KernelTransition | Promise<KernelTransition>, readonly notify: () => void = () => {}, readonly admission: () => KernelIssue | null = () => null) {}

  exportCheckpoint(): IngressCheckpoint {
    const state = this.getState()
    return owned({ format: 1, workspace: state.workspace, revision: state.revision, snapshot: this.#snapshot })
  }

  /** Install ownership without executing commands. The outer checkpoint
   * coordinator must establish the lease and resolve any uncertain attempt. */
  static restore(checkpoint: IngressCheckpoint, getState: () => KernelState,
    commit: (event: KernelEvent) => KernelTransition | Promise<KernelTransition>, notify: () => void = () => {}, admission: () => KernelIssue | null = () => null): IngressQueue {
    const restored = restoreIngressCheckpoint(checkpoint, getState())
    const queue = new IngressQueue(getState, commit, notify, admission)
    queue.#generation = restored.snapshot.generation
    queue.#pending = new Map(restored.snapshot.pending.map(entry => [entry.id, entry]))
    queue.#receipts = new Map(restored.snapshot.receipts.map(entry => [entry.id, entry]))
    queue.#heads = restored.heads; queue.#queue = restored.queue; queue.#active = restored.active; queue.#paused = true; queue.#snapshot = restored.snapshot
    return queue
  }

  /** Derive the receipt and cancellation dispositions in the same candidate
   * as semantic publication. Work on an isolated paused queue: no callback,
   * Promise or effect from the live queue is completed before the store does. */
  static committedCheckpoint(before: IngressCheckpoint, event: KernelEvent, transition: KernelTransition): IngressCheckpoint {
    if (event.kind === 'ingress-disposed') assertReviewedDisposition(before.snapshot, event, true)
    if (transition.result.kind === 'unresolved' || before.revision + (transition.result.kind === 'accepted' ? 1 : 0) !== transition.state.revision)
      throw new Error('Ingress publication requires its exact terminal semantic revision.')
    const queue = IngressQueue.restore({ ...before, revision: transition.state.revision }, () => transition.state,
      () => { throw new Error('Checkpoint projection cannot execute queued work.') })
    const active = queue.#active ? queue.#pending.get(queue.#active) : null
    if (!active || active.phase !== 'uncertain' || active.attempt.baseRevision !== before.revision || !matchesIngressEvent(active.event, event))
      throw new Error('The durable event does not own the captured ingress attempt.')
    queue.resolveUncertain(active.attempt, transition)
    return queue.exportCheckpoint()
  }

  /** A published root proves these entries had not started at its capture.
   * Keep their original identity/input, but require explicit review in the
   * new runtime rather than replaying commands during restoration. */
  retainQueuedAfterRestore() {
    if (!this.#paused || this.#active) throw new Error('Only a paused queue without an unresolved attempt can retain recovered work.')
    for (const id of this.#queue) {
      const entry = this.#pending.get(id)
      if (entry?.phase === 'queued') this.#pending.set(id, Object.freeze({ ...entry, phase: 'blocked', issue: issue('Review recovered work before explicitly retrying it.') }))
    }
    this.#queue = []; this.#changed()
  }

  resume() {
    const admission = this.admission()
    if (admission) throw new Error(admission.message)
    this.#paused = false
    this.#drain()
  }

  #declined(id: IngressId): IngressHandle | null {
    const failure = this.admission()
    if (!failure) return null
    // Closed runtimes never take ownership. The producer retains its input;
    // no ingress receipt, sequence or semantic state is advanced.
    const result: IngressResult = Object.freeze({ kind: 'completed', transition: Object.freeze({ state: this.getState(),
      result: Object.freeze({ kind: 'rejected', issue: owned(failure) }), effects: Object.freeze([]) }) })
    return Object.freeze({ id, immediate: result, completion: Promise.resolve(result) })
  }

  get busy() { return this.#paused || this.#active !== null || this.#draining }
  getSnapshot(): IngressSnapshot { return this.#snapshot }
  #changed() {
    this.#snapshot = Object.freeze({ generation: this.#generation, pending: Object.freeze([...this.#pending.values()]), receipts: Object.freeze([...this.#receipts.values()]) })
    this.notify()
  }
  #allocate(id: IngressId) {
    if (!id || this.#pending.has(id) || this.#receipts.has(id)) throw new Error('Ingress identities cannot be reused.')
    if (!Number.isSafeInteger(this.#generation + 1)) throw new Error('Ingress sequence exhausted.')
    return ++this.#generation
  }
  #reject(entry: PendingIngress, failure: KernelIssue, phase: 'rejected' | 'blocked' = 'rejected'): IngressResult {
    this.#pending.set(entry.id, Object.freeze({ id: entry.id, sequence: entry.sequence, scheduledAt: entry.scheduledAt, payload: entry.payload, phase, issue: failure,
      ...(entry.rejection ? { rejection: entry.rejection } : {}) }))
    const result: IngressResult = Object.freeze({ kind: 'completed', transition: Object.freeze({ state: this.getState(), result: Object.freeze({ kind: 'rejected', issue: failure }), effects: Object.freeze([]) }) })
    this.#deliver(entry.id, result); this.#changed()
    return result
  }
  #deliver(id: IngressId, result: IngressResult) {
    if (this.#collecting.has(id)) this.#synchronous.set(id, result)
    this.#resolvers.get(id)?.(result); this.#resolvers.delete(id)
  }
  #submit(id: IngressId, payload: IngressPayload, failure?: KernelIssue): IngressHandle {
    const declined = this.#declined(id)
    if (declined) return declined
    const sequence = this.#allocate(id)
    const completion = new Promise<IngressResult>(resolve => this.#resolvers.set(id, resolve))
    const entry: PendingIngress = Object.freeze({ id, sequence, scheduledAt: sequence, payload, phase: 'queued', ...(failure ? { rejection: failure } : {}) })
    this.#pending.set(id, entry)
    this.#collecting.add(id)
    this.#queue.push(id); this.#changed(); this.#drain()
    const immediate = this.#synchronous.get(id) ?? null
    this.#synchronous.delete(id); this.#collecting.delete(id)
    return Object.freeze({ id, immediate, completion })
  }

  event(id: IngressId, raw: KernelEvent): IngressHandle {
    if (raw.kind === 'session-input') {
      const head = this.#heads.get(leaseKey(raw.lease))
      return this.input({ ingressId: id, lease: raw.lease, inputSequence: (head?.inputSequence ?? 0) + 1,
        predecessor: { kind: 'published', inputVersion: raw.inputVersion }, input: raw.input, composition: raw.composition })
    }
    return this.#submit(id, owned({ kind: 'event', event: raw }))
  }
  retainResolution(id: IngressId, raw: ResolutionRequest, failure: KernelIssue): IngressHandle {
    return this.#submit(id, owned({ kind: 'resolution-rejected', request: raw }), owned(failure))
  }

  input(raw: InputEnvelope): IngressHandle {
    const declined = this.#declined(raw.ingressId)
    if (declined) return declined
    const envelope = owned(raw), lease = envelope.lease, head = this.#heads.get(leaseKey(lease))
    if (!lease.sessionId || !lease.viewId || !Number.isSafeInteger(lease.generation) || lease.generation < 1) throw new Error('Ingress input requires a complete editor lease.')
    if (!Number.isSafeInteger(envelope.inputSequence) || envelope.inputSequence !== (head?.inputSequence ?? 0) + 1) throw new Error('Input sequences must be strictly consecutive within an editor lease.')
    if ((envelope.input.kind !== 'encoded' && envelope.input.kind !== 'resource') || (envelope.input.kind === 'encoded' && !('value' in envelope.input))
      || (envelope.input.kind === 'resource' && !envelope.input.id) || !['idle', 'composing'].includes(envelope.composition)) throw new Error('Ingress requires owned input and composition state.')
    let failure: KernelIssue | undefined
    if (envelope.predecessor.kind === 'ingress') {
      if (!head || head.id !== envelope.predecessor.id) failure = issue('Input predecessor must be the immediately preceding input in this lease.')
    } else if (envelope.predecessor.kind === 'published') {
      if (!Number.isSafeInteger(envelope.predecessor.inputVersion) || envelope.predecessor.inputVersion < 0) failure = issue('Published input version must be a nonnegative safe integer.')
      else if (head && this.#pending.has(head.id)) failure = issue('Unresolved input cannot be skipped by rebinding to a published version.')
    } else failure = issue('Unknown input predecessor.')
    // Install the head before synchronous processing can notify a new producer.
    if (this.#pending.has(envelope.ingressId) || this.#receipts.has(envelope.ingressId)) throw new Error('Ingress identities cannot be reused.')
    this.#heads.set(leaseKey(lease), Object.freeze({ id: envelope.ingressId, inputSequence: envelope.inputSequence }))
    return this.#submit(envelope.ingressId, Object.freeze({ kind: 'input', envelope }), failure)
  }

  /** UI producers get a predecessor without maintaining a second draft or
   * guessing the input version that a pending durable commit will publish. */
  envelope(id: IngressId, lease: EditorLease, input: OwnedInput, composition: InputEnvelope['composition']): InputEnvelope {
    const session = this.getState().session
    if (!session || !session.editor || !same(session.editor, lease)) throw new Error('The input producer no longer owns this editor lease.')
    const head = this.#heads.get(leaseKey(lease)), receipt = head ? this.#receipts.get(head.id) : undefined
    const predecessor: InputEnvelope['predecessor'] = head && (this.#pending.has(head.id) || (receipt?.disposition === 'accepted' && receipt.input?.ref?.version === session.input.version))
      ? { kind: 'ingress', id: head.id } : { kind: 'published', inputVersion: session.input.version }
    return owned({ ingressId: id, lease, inputSequence: (head?.inputSequence ?? 0) + 1, predecessor, input, composition })
  }

  #event(entry: PendingIngress): KernelEvent {
    if (entry.rejection) return { kind: 'ingress-declined', ingressId: entry.id, phase: 'rejected', issue: entry.rejection }
    if (entry.payload.kind === 'resolution-rejected') throw new Error('A rejected decision requires new explicit preparation.')
    if (entry.payload.kind === 'event') {
      const event = entry.payload.event
      if (event.kind === 'ingress-disposed') assertReviewedDisposition(this.#snapshot, event, true)
      if (event.kind === 'session-apply' || event.kind === 'session-query-apply' || event.kind === 'session-retargeted' || event.kind === 'session-reconfirmed'
        || event.kind === 'task-registered' || event.kind === 'task-completed' || event.kind === 'task-execution-observed' || event.kind === 'task-consume' || event.kind === 'task-reapply') {
        const sessionId = this.#sessionOf(entry.payload)
        const lease = 'lease' in event ? event.lease : this.getState().session?.id === sessionId ? this.getState().session?.editor : null
        if (lease && [...this.#pending.values()].some(previous => previous.scheduledAt < entry.scheduledAt && previous.payload.kind === 'input' && same(previous.payload.envelope.lease, lease)))
          throw new Error('Resolve the earlier retained input chain before ending or changing its editor context.')
      }
      return event
    }
    const { envelope } = entry.payload
    let inputVersion: number
    if (envelope.predecessor.kind === 'published') inputVersion = envelope.predecessor.inputVersion
    else {
      const predecessor = this.#receipts.get(envelope.predecessor.id)
      if (predecessor?.disposition !== 'accepted' || !predecessor.input?.ref || !same(predecessor.input.lease, envelope.lease))
        throw new Error('The input predecessor has not been accepted. Retain this input until the chain is explicitly recovered.')
      inputVersion = predecessor.input.ref.version
    }
    return owned({ kind: 'session-input', lease: envelope.lease, inputVersion, input: envelope.input, composition: envelope.composition })
  }
  #drain() {
    if (this.#paused || this.#draining || this.#active !== null) return
    this.#draining = true
    try {
      while (this.#queue.length && this.#active === null) {
        const id = this.#queue.shift()!, entry = this.#pending.get(id)
        if (!entry || entry.phase !== 'queued') continue
        let event: KernelEvent
        try { event = this.#event(entry) }
        catch (error) { event = { kind: 'ingress-declined', ingressId: entry.id, phase: 'blocked', issue: errorIssue(error) } }
        const attempt = Object.freeze({ ingressId: id, sequence: entry.sequence, generation: this.#generation, baseRevision: this.getState().revision })
        this.#active = id
        this.#pending.set(id, Object.freeze({ ...entry, phase: 'committing', attempt, event })); this.#changed()
        try {
          const result = this.commit(event)
          if ('then' in result) {
            void result.then(transition => {
              try { this.#finish(id, transition); this.#drain() }
              catch (error) { this.#uncertain(id, error) }
            }, error => this.#uncertain(id, error))
          } else this.#finish(id, result)
        } catch (error) { this.#uncertain(id, error) }
      }
    } finally { this.#draining = false }
  }
  #uncertain(id: IngressId, error: unknown) {
    const entry = this.#pending.get(id)
    if (!entry || entry.phase !== 'committing') return
    const failure = errorIssue(error)
    this.#pending.set(id, Object.freeze({ ...entry, phase: 'uncertain', issue: failure }))
    this.#deliver(id, Object.freeze({ kind: 'unresolved', attempt: entry.attempt, issue: failure })); this.#changed()
    // Keep the active head. Neither later commands nor retries can pass it.
  }
  #finish(id: IngressId, transition: KernelTransition) {
    const entry = this.#pending.get(id)
    if (!entry || (entry.phase !== 'committing' && entry.phase !== 'uncertain')) throw new Error('Ingress completion has no owning attempt.')
    if (transition.result.kind === 'unresolved') { this.#uncertain(id, new Error(transition.result.issue.message)); return }
    if (transition.state !== this.getState()) throw new Error('Ingress completion must refer to the exact currently published state.')
    if (entry.payload.kind === 'input' && transition.result.kind === 'accepted') {
      const session = transition.state.session
      if (entry.event.kind !== 'session-input' || !session || !same(session.editor, entry.payload.envelope.lease)
        || session.input.version !== entry.event.inputVersion + 1 || !same(session.rawInput, entry.payload.envelope.input))
        throw new Error('Accepted ingress lacks the exact published input version and ownership.')
    }
    if (transition.result.kind === 'rejected') this.#reject(entry, transition.result.issue, entry.event.kind === 'ingress-declined' ? entry.event.phase : 'rejected')
    else {
      const input = entry.payload.kind === 'input' ? { lease: entry.payload.envelope.lease, inputSequence: entry.payload.envelope.inputSequence,
        ...(transition.result.kind === 'accepted' && transition.state.session ? { ref: transition.state.session.input } : {}),
      } : undefined
      this.#receipts.set(id, owned({ id, sequence: entry.sequence, scheduledAt: entry.scheduledAt, disposition: transition.result.kind, ...(input ? { input } : {}) }))
      this.#pending.delete(id)
      this.#deliver(id, Object.freeze({ kind: 'completed', transition }))
      if (transition.result.kind === 'accepted' && entry.event.kind === 'ingress-disposed') {
        for (const disposedId of entry.event.ids) {
          const retained = this.#pending.get(disposedId)
          if (!retained) throw new Error('Published disposition lost its retained request.')
          this.#dispose(retained, entry.event.disposition)
        }
      }
      if (transition.result.kind === 'accepted' && entry.event.kind === 'workspace-discarded') {
        for (const previous of this.#pending.values()) if (previous.scheduledAt < entry.scheduledAt) this.#dispose(previous, 'discarded')
      }
      if (transition.result.kind === 'accepted' && entry.event.kind === 'session-cancelled') {
        for (const previous of this.#pending.values()) if (previous.scheduledAt < entry.scheduledAt && this.#sessionOf(previous.payload) === entry.event.sessionId)
          this.#dispose(previous, 'discarded')
      }
      if (transition.result.kind === 'accepted' && entry.event.kind === 'task-cancelled') {
        for (const previous of this.#pending.values()) if (previous.scheduledAt < entry.scheduledAt && previous.payload.kind === 'event'
          && 'taskId' in previous.payload.event && previous.payload.event.taskId === entry.event.taskId) this.#dispose(previous, 'discarded')
      }
      this.#changed()
    }
    this.#active = null
  }

  #sessionOf(payload: IngressPayload) {
    if (payload.kind === 'input') return payload.envelope.lease.sessionId
    if (payload.kind !== 'event') return null
    const event = payload.event
    if ('lease' in event && event.lease) return event.lease.sessionId
    if (event.kind === 'session-opened' || event.kind === 'session-attached' || event.kind === 'session-cancelled') return event.sessionId
    const session = this.getState().session
    const ownerSession = (owner: TaskOwner | undefined) => {
      if (owner?.kind === 'session') return owner.sessionId
      if (owner?.kind !== 'field' || !session) return null
      const fields = session.target.kind === 'cell' ? [session.target.field] : session.target.kind === 'bulk' ? session.target.fields : []
      return fields.some(field => same(field, owner.field)) ? session.id : null
    }
    if (event.kind === 'task-registered' || event.kind === 'task-reapply') return ownerSession(event.owner)
    if ('taskId' in event) {
      const owner = this.getState().tasks.find(task => task.id === event.taskId)?.owner
      return ownerSession(owner)
    }
    return null
  }

  /** Only an external commit coordinator can resolve an uncertain attempt.
   * The token must match and its complete outcome must already be published. */
  resolveUncertain(attempt: IngressAttempt, transition: KernelTransition) {
    const entry = this.#pending.get(attempt.ingressId)
    if (entry?.phase !== 'uncertain' || !same(entry.attempt, attempt)) throw new Error('Recovery result belongs to another ingress attempt.')
    this.#finish(entry.id, transition); this.#drain()
  }

  #dispose(entry: PendingIngress, disposition: 'discarded' | 'returned') {
    if (entry.phase === 'committing' || entry.phase === 'uncertain') throw new Error('An unresolved commit cannot be discarded or returned.')
    const input = entry.payload.kind === 'input' ? { lease: entry.payload.envelope.lease, inputSequence: entry.payload.envelope.inputSequence } : undefined
    this.#pending.delete(entry.id)
    this.#receipts.set(entry.id, owned({ id: entry.id, sequence: entry.sequence, scheduledAt: entry.scheduledAt, disposition,
      ...(disposition === 'returned' ? { returned: entry.payload } : {}), ...(input ? { input } : {}) }))
    const failure = issue('The retained input was explicitly disposed before semantic acceptance.')
    this.#deliver(entry.id, Object.freeze({ kind: 'completed', transition: { state: this.getState(), result: { kind: 'rejected' as const, issue: failure }, effects: [] } }))
  }
  dispose(ids: readonly IngressId[], generation: number, disposition: 'discarded' | 'returned'): readonly IngressPayload[] {
    const admission = this.admission()
    if (admission) throw new Error(admission.message)
    if (generation !== this.#generation || this.busy || !ids.length || new Set(ids).size !== ids.length || !['discarded', 'returned'].includes(disposition)) throw new Error('Ingress disposition requires the current reviewed generation and no unresolved commit.')
    const entries = ids.map(id => this.#pending.get(id))
    if (entries.some(entry => !entry || (entry.phase !== 'rejected' && entry.phase !== 'blocked'))) throw new Error('Only retained rejected or blocked work may be explicitly disposed.')
    const selected = new Set(ids)
    for (const entry of this.#pending.values()) if (entry.payload.kind === 'input' && entry.payload.envelope.predecessor.kind === 'ingress'
      && selected.has(entry.payload.envelope.predecessor.id) && !selected.has(entry.id)) throw new Error('Dispose the complete dependent input chain together.')
    if (!Number.isSafeInteger(this.#generation + 1)) throw new Error('Ingress generation exhausted.')
    for (const entry of entries) this.#dispose(entry!, disposition)
    this.#generation++; this.#changed()
    return Object.freeze(entries.map(entry => entry!.payload))
  }

  retry(id: IngressId, generation: number): IngressHandle {
    const declined = this.#declined(id)
    if (declined) return declined
    const first = this.#pending.get(id)
    if (generation !== this.#generation || this.busy || !first || (first.phase !== 'rejected' && first.phase !== 'blocked') || first.payload.kind === 'resolution-rejected')
      throw new Error('Only a reviewed, definitively rejected attempt can be retried; an unknown commit must be reconciled.')
    const ids = new Set([id])
    for (const entry of this.#pending.values()) if (entry.payload.kind === 'input' && entry.payload.envelope.predecessor.kind === 'ingress' && ids.has(entry.payload.envelope.predecessor.id)) ids.add(entry.id)
    const entries = [...ids].map(id => this.#pending.get(id)!).sort((a, b) => a.sequence - b.sequence)
    if (entries.some(entry => entry.phase !== 'rejected' && entry.phase !== 'blocked')) throw new Error('A dependent attempt is still unresolved.')
    if (!Number.isSafeInteger(this.#generation + entries.length)) throw new Error('Ingress generation exhausted.')
    const completion = new Promise<IngressResult>(resolve => this.#resolvers.set(id, resolve))
    for (const entry of entries) { this.#pending.set(entry.id, Object.freeze({ id: entry.id, sequence: entry.sequence, scheduledAt: ++this.#generation, payload: entry.payload, phase: 'queued',
      ...(entry.rejection ? { rejection: entry.rejection } : {}) })); this.#queue.push(entry.id) }
    this.#collecting.add(id); this.#changed(); this.#drain()
    const immediate = this.#synchronous.get(id) ?? null
    this.#collecting.delete(id); this.#synchronous.delete(id)
    return Object.freeze({ id, immediate, completion })
  }

  inputProjection(lease: EditorLease) {
    const session = this.getState().session
    if (!session || !session.editor || !same(session.editor, lease)) return null
    const pending = [...this.#pending.values()].filter(entry => entry.payload.kind === 'input' && same(entry.payload.envelope.lease, lease)).at(-1)
    return Object.freeze({ session, input: pending?.payload.kind === 'input' ? pending.payload.envelope.input : session.rawInput,
      status: pending?.phase ?? 'published', ingressId: pending?.id ?? null })
  }
}

export function ingressInputs(snapshot: IngressSnapshot): readonly OwnedInput[] {
  return [...snapshot.pending.flatMap(entry => ingressPayloadInputs(entry.payload)),
    ...snapshot.receipts.flatMap(receipt => receipt.returned ? ingressPayloadInputs(receipt.returned) : [])]
}

export function ingressPayloadInputs(payload: IngressPayload): readonly OwnedInput[] {
  if (payload.kind === 'input') return [payload.envelope.input]
  if (payload.kind === 'resolution-rejected') return payload.request.choice.kind === 'merge' ? [payload.request.choice.input] : []
  const event = payload.event
  switch (event.kind) {
    case 'resource-registered': return [{ kind: 'resource', id: event.descriptor.id }]
    case 'session-opened': case 'session-input': case 'task-registered': return [event.input]
    case 'prepared-action': case 'session-apply': case 'prepared-undo': case 'prepared-redo': return event.prepared.inputs.map(input => input.input)
    case 'task-reapply': return event.prepared?.inputs.map(input => input.input) ?? []
    case 'prepared-resolution': return [...(event.prepared.replacement?.inputs.map(input => input.input) ?? []), ...(event.prepared.request.choice.kind === 'merge' ? [event.prepared.request.choice.input] : [])]
    case 'task-completed': return event.result.kind !== 'action' ? [event.result.input] : event.result.action.inputs.map(input => input.input)
    case 'task-execution-observed': return event.outcome.kind !== 'succeeded' ? [] : event.outcome.result.kind !== 'action' ? [event.outcome.result.input] : event.outcome.result.action.inputs.map(input => input.input)
    default: return []
  }
}
