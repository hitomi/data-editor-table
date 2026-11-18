import { ScopeVersionEvidence, versionKey as key } from './version-evidence.js'
import type { AuthorityFrontier, ExactReceipt, FrozenSubmission, ScopeIdentity, WorkspaceId } from './model.js'
import { authorityCovers, authorityCoversFrontier, joinAuthorityFrontier, sameScope } from './protocol.js'
import { ownServerAuthority, type PersistenceSource, type ServerAuthority } from './source.js'

export type AuthorityDelivery =
  | Readonly<{ kind: 'snapshot'; snapshot: ServerAuthority }>
  | Readonly<{ kind: 'required'; frontier: AuthorityFrontier; origin?: WorkspaceId }>
export class SourceReadUnavailable extends Error {}
export class SourceReadSuperseded extends Error {}

export type ValidateAuthorityRows = (rows: ServerAuthority['rows']) => void
type Subscriber = { notify(event: AuthorityDelivery): void; validate: ValidateAuthorityRows }
type View = { snapshot?: ServerAuthority; heads: Map<string, ServerAuthority> }

/** One admission order per physical scope and epoch. A live adapter holds the
 * materialized view. The process registry only pins protocol evidence. */
export class ScopeAuthority {
  readonly #evidence: ScopeVersionEvidence
  #view?: WeakRef<View>
  readonly #subscribers = new Map<Subscriber, View>()
  readonly #queue: { event: AuthorityDelivery; recipients: Subscriber[] }[] = []
  #merge: { frontier: AuthorityFrontier; promise: Promise<ServerAuthority> } | undefined
  #validating = false

  constructor(private readonly scope: ScopeIdentity, capabilities: PersistenceSource['capabilities'],
    private readonly evidenceChanged: () => void) {
    this.#evidence = new ScopeVersionEvidence(capabilities)
  }

  #viewState(): View {
    let view = this.#view?.deref()
    if (!view) { view = { heads: new Map() }; this.#view = new WeakRef(view) }
    return view
  }
  retainSnapshot() {
    const view = this.#viewState()
    return () => view.snapshot
  }
  get frontier() { return this.#evidence.frontier }

  captureRowValidators() { return [...new Set([...this.#subscribers.keys()].map(s => s.validate))] }

  #validateRows(rows: ServerAuthority['rows'], additional: readonly ValidateAuthorityRows[]) {
    for (const validate of new Set([...this.captureRowValidators(), ...additional])) validate(rows)
  }

  prepareReceipt(submission: FrozenSubmission, receipt: ExactReceipt, validators: readonly ValidateAuthorityRows[]) {
    if (this.#validating) throw new Error('Validation cannot reenter scope admission.')
    this.#validating = true
    try {
      const rows = receipt.results.flatMap(item => item.kind === 'created' || item.kind === 'updated'
        ? [{ identity: item.identity, document: item.canonical }] : [])
      this.#validateRows(rows, validators)
      const version = this.#evidence.expand(receipt.committedVersion)
      const base = this.#evidence.expand(submission.baseAuthority)
      const coversBase = authorityCovers(version, base)
      if (!coversBase && authorityCovers(base, version)) throw new Error('A receipt cannot precede its write base.')
      const admission = this.#evidence.prepare(receipt.committedVersion, receipt)
      if (!coversBase) return undefined
      return { receipt: Object.freeze({ ...receipt, committedVersion: admission.version }), commit: () => {
        const previous = this.frontier
        admission.commit()
        this.#project(previous, undefined, false, submission.workspaceId)
      } }
    } finally { this.#validating = false }
  }

  subscribe(subscriber: Subscriber) {
    const view = this.#viewState()
    this.#subscribers.set(subscriber, view)
    try {
      const snapshot = view.snapshot
      if (snapshot) {
        subscriber.validate(snapshot.rows)
        subscriber.notify({ kind: 'snapshot', snapshot })
      }
      const current = view.snapshot
      if (this.frontier.length && (!current || !authorityCoversFrontier(current.version, this.frontier)))
        subscriber.notify({ kind: 'required', frontier: this.frontier })
    } catch (error) {
      this.#subscribers.delete(subscriber)
      throw error
    }
    return () => { this.#subscribers.delete(subscriber) }
  }

  #deliver(event: AuthorityDelivery) {
    this.#queue.push({ event: Object.freeze(event), recipients: [...this.#subscribers.keys()] })
    if (this.#queue.length > 1) return
    try {
      for (const delivery of this.#queue) for (const subscriber of delivery.recipients) {
        if (this.#subscribers.has(subscriber)) {
          try { subscriber.notify(delivery.event) } catch { /* Observers are isolated after admission. */ }
        }
      }
    } finally { this.#queue.length = 0 }
  }

  #project(previous: AuthorityFrontier, snapshot?: ServerAuthority, superseded = false, origin?: WorkspaceId) {
    const { frontier } = this, view = this.#viewState()
    const id = snapshot && key(snapshot.version)
    const live = snapshot && frontier.some(head => key(head) === id)
    if (snapshot && live) view.heads.set(key(snapshot.version), snapshot)
    for (const stamp of view.heads.keys()) if (!frontier.some(v => key(v) === stamp)) view.heads.delete(stamp)
    const head = frontier.length === 1 ? frontier[0] : undefined
    const materialized = head && view.heads.get(key(head))
    if (materialized && head) {
      const strengthened = head.kind === 'causal' && materialized.version.kind === 'causal'
        && head.covers.length !== materialized.version.covers.length
      if (live || strengthened || materialized !== view.snapshot) {
        const current = strengthened ? Object.freeze({ ...materialized, version: head }) : materialized
        view.snapshot = current
        view.heads.set(key(head), current)
        this.#deliver({ kind: 'snapshot', snapshot: current })
      }
    } else {
      const changed = previous.length !== frontier.length || !frontier.every(next => previous.some(prior =>
        key(next) === key(prior) && (next.kind !== 'causal' || prior.kind === 'causal' && prior.covers.length === next.covers.length)))
      if (live || superseded || changed)
        this.#deliver({ kind: 'required', frontier, ...(origin ? { origin } : {}) })
    }
  }

  publish(raw: ServerAuthority, validate?: ValidateAuthorityRows, requested?: AuthorityFrontier): ServerAuthority {
    if (this.#validating) throw new Error('Snapshot validation cannot reenter scope admission.')
    this.#validating = true
    const previous = this.frontier
    let superseded: boolean, snapshot: ServerAuthority
    try {
      snapshot = ownServerAuthority(raw)
      if (!sameScope(snapshot.scope, this.scope))
        throw new Error('The snapshot belongs to another source scope or authority protocol.')
      this.#validateRows(snapshot.rows, validate ? [validate] : [])
      const admission = this.#evidence.prepare(snapshot.version, snapshot)
      if (requested && !authorityCoversFrontier(admission.version, requested))
        throw new Error('The returned read does not cover the requested frontier.')
      superseded = !!requested && !authorityCoversFrontier(admission.version, admission.frontier)
      snapshot = Object.freeze({ ...snapshot, version: admission.version })
      admission.commit()
    } finally { this.#validating = false }
    this.#project(previous, snapshot, superseded)
    this.evidenceChanged()
    if (superseded) throw new SourceReadSuperseded('The scope advanced during this read.')
    return snapshot
  }

  read(required: AuthorityFrontier, transport: PersistenceSource['readAtLeast'], validate?: ValidateAuthorityRows): Promise<ServerAuthority> {
    const requested = joinAuthorityFrontier(this.frontier, required.map(v => this.#evidence.expand(v)))
    const merging = this.frontier.length > 1
    const previous = this.#merge
    if (merging && previous && requested.every(v => previous.frontier.some(head => authorityCovers(head, v)))) return previous.promise
    const execute = async () => {
      let raw: ServerAuthority
      try { raw = await transport(this.scope, requested) }
      catch (cause) { throw new SourceReadUnavailable(cause instanceof Error ? cause.message : String(cause), { cause }) }
      return this.publish(raw, validate, requested)
    }
    if (!merging) return execute()
    // Register before invoking host code, which may synchronously publish another branch.
    const promise = Promise.resolve().then(execute)
    const merge = { frontier: requested, promise }
    this.#merge = merge
    const release = () => { if (this.#merge === merge) this.#merge = undefined }
    void promise.then(release, release)
    return promise
  }
}
