import { encodedValuesEqual, ownEncodedValue } from './document.js'
import type { FrozenSubmission, KernelIssue, OperationLookup } from './model.js'
import type { SubmissionRef } from './persistence.js'
import type { SourceMutationResult } from './source.js'

export type DefinitiveResult = Extract<OperationLookup, { kind: 'applied' | 'not-applied' }>
export type ScopeDispute = Readonly<{ kind: 'disputed'; id: string; ref: SubmissionRef; issue: KernelIssue; evidence: readonly SourceMutationResult[] }>
export type ScopeDisputeEvent = ScopeDispute | Readonly<{ kind: 'resolved'; id: string; ref: SubmissionRef; result: DefinitiveResult }>
type Listener = (event: ScopeDisputeEvent) => void

/** A resolution acknowledges a particular set of physical-source evidence.
 * A further incompatible response changes the dispute ID, even during review. */
export class ScopeDisputes<Job extends { submission: FrozenSubmission }> {
  readonly #open = new Map<Job, ScopeDispute>()
  readonly #listeners = new Set<Listener>()
  readonly #queue: { event: ScopeDisputeEvent; listeners: Listener[] }[] = []

  get first(): ScopeDispute | null { return this.#open.values().next().value ?? null }
  forJob(job: Job) { return this.#open.get(job) }
  find(id: string) {
    for (const [job, report] of this.#open) if (report.id === id) return { job, report }
    return undefined
  }

  waitUntilClear() {
    return new Promise<void>(resolve => {
      const release = this.subscribe(event => {
        if (event.kind === 'resolved' && !this.#open.size) { release(); resolve() }
      })
    })
  }

  subscribe(listener: Listener) {
    this.#listeners.add(listener)
    try { for (const report of this.#open.values()) listener(report) }
    catch (error) { this.#listeners.delete(listener); throw error }
    return () => { this.#listeners.delete(listener) }
  }

  #publish(event: ScopeDisputeEvent) {
    this.#queue.push({ event, listeners: [...this.#listeners] })
    if (this.#queue.length > 1) return
    try {
      for (const delivery of this.#queue) for (const listener of delivery.listeners) {
        if (this.#listeners.has(listener)) {
          try { listener(delivery.event) } catch { /* Isolate independent scope observers. */ }
        }
      }
    } finally { this.#queue.length = 0 }
  }

  raise(job: Job, message: string, facts: readonly SourceMutationResult[]) {
    const current = this.#open.get(job)
    const evidence = [...(current?.evidence ?? [])]
    for (const fact of facts) {
      if (!evidence.some(prior => encodedValuesEqual(prior, fact))) evidence.push(fact)
    }
    if (current && current.evidence.length === evidence.length) return current
    const { scope, operationId, payloadHash } = job.submission
    const event = ownEncodedValue({ kind: 'disputed', id: crypto.randomUUID(), ref: { scope, operationId, payloadHash },
      issue: { code: 'persistence-protocol', message }, evidence }) as unknown as ScopeDispute
    this.#open.set(job, event)
    this.#publish(event)
    return event
  }

  resolve(job: Job, id: string, result: DefinitiveResult) {
    const current = this.#open.get(job)
    if (!current || current.id !== id) throw new Error('This dispute is no longer current. Review the latest evidence.')
    this.#open.delete(job)
    this.#publish(Object.freeze({ kind: 'resolved', id, ref: current.ref, result }))
  }
}
