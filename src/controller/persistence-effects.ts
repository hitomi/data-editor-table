import type { GridCommitReceipt, GridCommitRequest } from '../data/data-source.js'
import type { GridRowKey } from '../model/grid-model.js'
import type { GridCommitProposal } from './persistence-machine.js'

export type GridPersistenceEffect<Row, RowKey extends GridRowKey> =
  | Readonly<{ type: 'commit'; proposal: GridCommitProposal<Row, RowKey> }>
  | Readonly<{ type: 'schedule'; token: number; delay: number; retry: boolean }>
  | Readonly<{ type: 'cancel-schedule' }>
  | Readonly<{ type: 'refresh'; token: number }>

export type GridPersistenceEvent<Row, RowKey extends GridRowKey> =
  | Readonly<{ type: 'commit/received'; proposal: GridCommitProposal<Row, RowKey>; receipt: GridCommitReceipt<Row, RowKey> }>
  | Readonly<{ type: 'commit/failed'; proposal: GridCommitProposal<Row, RowKey>; error: unknown }>
  | Readonly<{ type: 'schedule/due'; token: number; retry: boolean }>
  | Readonly<{ type: 'refresh/completed'; token: number }>
  | Readonly<{ type: 'refresh/failed'; token: number; error: unknown }>

type Ports<Row, RowKey extends GridRowKey> = Readonly<{
  commit: (request: GridCommitRequest<Row, RowKey>) => Promise<GridCommitReceipt<Row, RowKey>>
  refresh?: (context: Readonly<{ signal: AbortSignal }>) => Promise<void> | void
  send: (event: GridPersistenceEvent<Row, RowKey>) => void
}>

/** Owns cancellable resources only. All completion decisions belong to the machine. */
export class GridPersistenceEffectRunner<Row, RowKey extends GridRowKey> {
  readonly #ports: Ports<Row, RowKey>
  #timer: ReturnType<typeof setTimeout> | null = null
  #scheduleToken: number | null = null
  #refresh: AbortController | null = null
  #destroyed = false

  constructor(ports: Ports<Row, RowKey>) { this.#ports = ports }

  run(effect: GridPersistenceEffect<Row, RowKey>) {
    if (this.#destroyed) return
    switch (effect.type) {
      case 'commit': {
        const { proposal } = effect
        void Promise.resolve().then(() => {
          if (this.#destroyed) return
          return this.#ports.commit(proposal.request)
        }).then((receipt) => {
          if (!this.#destroyed) this.#ports.send({ type: 'commit/received', proposal, receipt: receipt! })
        }, (error: unknown) => {
          if (!this.#destroyed) this.#ports.send({ type: 'commit/failed', proposal, error })
        })
        return
      }
      case 'cancel-schedule': this.#cancelSchedule(); return
      case 'schedule': {
        this.#cancelSchedule()
        this.#scheduleToken = effect.token
        const due = () => {
          if (this.#destroyed || this.#scheduleToken !== effect.token) return
          this.#timer = null
          this.#scheduleToken = null
          this.#ports.send({ type: 'schedule/due', token: effect.token, retry: effect.retry })
        }
        if (effect.delay === 0) queueMicrotask(due)
        else this.#timer = setTimeout(due, effect.delay)
        return
      }
      case 'refresh': {
        this.#refresh?.abort()
        const active = new AbortController()
        this.#refresh = active
        void Promise.resolve().then(() => {
          if (!active.signal.aborted && !this.#destroyed)
            return this.#ports.refresh?.({ signal: active.signal })
        }).then(() => {
          if (active.signal.aborted || this.#destroyed) return
          this.#refresh = null
          this.#ports.send({ type: 'refresh/completed', token: effect.token })
        }, (error: unknown) => {
          if (active.signal.aborted || this.#destroyed) return
          this.#refresh = null
          this.#ports.send({ type: 'refresh/failed', token: effect.token, error })
        })
      }
    }
  }

  destroy() {
    this.#destroyed = true
    this.#cancelSchedule()
    this.#refresh?.abort()
    this.#refresh = null
  }

  #cancelSchedule() {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#scheduleToken = null
  }
}
