import { SourceReadUnavailable, SourceReadSuperseded } from '../kernel/scope-authority.js'
import { persistenceGateway, type GatewayMutationResult, type GatewayPermit } from '../kernel/gateway.js'
import { hashSubmission, type PersistenceSource } from '../kernel/source.js'
import { gridExceptionIssue, type GridIssue } from '../model/grid-result.js'
import type { GridAuthorityReader } from '../data/kernel-data-source.js'
import type { KernelEffect } from '../kernel/persistence.js'
import type { AuthorityVersion } from '../kernel/model.js'
import type { KernelState } from '../kernel/state.js'
import type { PreparedSubmission, SubmissionDraft } from '../kernel/submission.js'

export type GridKernelPersistenceEffect =
  | Readonly<{ type: 'acquire'; state: KernelState; ticket: string }>
  | Readonly<{ type: 'hash'; ticket: string; draft: SubmissionDraft }>
  | Readonly<{ type: 'kernel'; effect: Extract<KernelEffect, { kind: 'submit' | 'lookup' }> }>
  | Readonly<{ type: 'read'; state: KernelState; ticket: string }>
  | Readonly<{ type: 'release'; state: KernelState }>
  | Readonly<{ type: 'abandon'; ticket: string }>
  | Readonly<{ type: 'schedule'; token: number; delay: number }>
  | Readonly<{ type: 'cancel-schedule' }>
export type GridKernelPersistenceEvent =
  | Readonly<{ type: 'gateway/ready'; ticket: string; version: AuthorityVersion }>
  | Readonly<{ type: 'gateway/failed'; ticket: string; issue: GridIssue }>
  | Readonly<{ type: 'hash/ready'; ticket: string; prepared: PreparedSubmission }>
  | Readonly<{ type: 'hash/failed'; ticket: string; issue: GridIssue }>
  | Readonly<{ type: 'operation/result'; effect: Extract<KernelEffect, { kind: 'submit' | 'lookup' }>; result: GatewayMutationResult }>
  | Readonly<{ type: 'read/ready'; ticket: string; version: AuthorityVersion }>
  | Readonly<{ type: 'read/superseded'; ticket: string }>
  | Readonly<{ type: 'read/failed'; ticket: string; issue: GridIssue }>
  | Readonly<{ type: 'schedule/due'; token: number }>

/** Owns network resources and the shared-scope permit, never semantic data.
 * Uncertain jobs keep their permit; destroying a view cannot release a write. */
export class GridKernelPersistenceRunner {
  readonly gateway: ReturnType<typeof persistenceGateway>
  #permit: GatewayPermit | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #token: number | null = null
  #destroyed = false
  constructor(source: PersistenceSource, private readonly send: (event: GridKernelPersistenceEvent) => void,
    private readonly reader: Pick<GridAuthorityReader, 'readAtLeast'>) {
    this.gateway = persistenceGateway(source)
  }
  run(effect: GridKernelPersistenceEffect) {
    if (this.#destroyed) return
    const send = (event: GridKernelPersistenceEvent) => { if (!this.#destroyed) this.send(event) }
    switch (effect.type) {
      case 'acquire': {
        void (async () => {
          const permit = await this.gateway.acquire(effect.state.workspace.scope, effect.state.workspace.id, effect.ticket)
          if (this.#destroyed) { this.gateway.abandonUnused(permit); return }
          this.#permit = permit
          const version = await this.reader.readAtLeast(effect.state.authorityFrontier)
          send({ type: 'gateway/ready', ticket: effect.ticket, version })
        })().catch(error => send({ type: 'gateway/failed', ticket: effect.ticket, issue: readIssue(error) }))
        return
      }
      case 'hash':
        void hashSubmission(effect.draft.payload).then(payloadHash => send({ type: 'hash/ready', ticket: effect.ticket,
          prepared: { revision: effect.draft.revision, submission: { ...effect.draft.payload, payloadHash } },
        }), error => send({ type: 'hash/failed', ticket: effect.ticket, issue: gridExceptionIssue(error) }))
        return
      case 'abandon':
        if (this.#permit?.ticket === effect.ticket) { this.gateway.abandonUnused(this.#permit); this.#permit = null }
        return
      case 'release':
        if (this.#permit) { this.gateway.releaseSettled(this.#permit, effect.state); this.#permit = null }
        return
      case 'read':
        void this.reader.readAtLeast(effect.state.authorityFrontier)
          .then(version => send({ type: 'read/ready', ticket: effect.ticket, version }),
            error => send(error instanceof SourceReadSuperseded ? { type: 'read/superseded', ticket: effect.ticket }
              : { type: 'read/failed', ticket: effect.ticket, issue: readIssue(error) }))
        return
      case 'kernel': {
        const operation = effect.effect
        if (!this.#permit) throw new Error('A frozen operation requires its scope permit.')
        const receive = (result: GatewayMutationResult) => send({ type: 'operation/result', effect: operation, result })
        const promise = operation.kind === 'submit'
          ? this.gateway.submit(this.#permit, operation.submission, receive) : this.gateway.lookup(this.#permit, operation.submission, receive)
        void promise.then(receive, error => send({
          type: 'operation/result', effect: operation, result: { kind: 'unknown', issue: { code: 'source-unavailable', message: message(error) } },
        }))
        return
      }
      case 'cancel-schedule': this.#cancel(); return
      case 'schedule': {
        this.#cancel(); this.#token = effect.token
        const due = () => {
          if (this.#destroyed || this.#token !== effect.token) return
          this.#timer = null; this.#token = null; send({ type: 'schedule/due', token: effect.token })
        }
        if (effect.delay === 0) queueMicrotask(due)
        else this.#timer = setTimeout(due, effect.delay)
      }
    }
  }
  destroy() { this.#destroyed = true; this.#cancel() }
  #cancel() { if (this.#timer !== null) clearTimeout(this.#timer); this.#timer = null; this.#token = null }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function readIssue(error: unknown): GridIssue {
  return error instanceof SourceReadUnavailable
    ? { code: 'source-unavailable', message: error.message }
    : gridExceptionIssue(error)
}
