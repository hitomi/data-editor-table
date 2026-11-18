import type { IngressSnapshot } from './ingress.js'
import type { IngressId } from './model.js'

export type IngressDispositionEvent = Readonly<{ kind: 'ingress-disposed'; revision: number; generation: number;
  ids: readonly IngressId[]; disposition: 'discarded' | 'returned' }>

export function assertDispositionShape(event: IngressDispositionEvent) {
  if (!Number.isSafeInteger(event.generation) || event.generation < 0 || !Number.isSafeInteger(event.revision) || event.revision < 0
    || !event.ids.length || new Set(event.ids).size !== event.ids.length || event.ids.some(id => !id)
    || (event.disposition !== 'discarded' && event.disposition !== 'returned')) throw new Error('Disposition requires a complete reviewed request.')
}

/** The candidate adds only its own ingress allocation. Later user input is
 * never implicitly included in the reviewed disposition set. */
export function assertReviewedDisposition(snapshot: IngressSnapshot, event: IngressDispositionEvent, allocated = false) {
  assertDispositionShape(event)
  if (snapshot.generation !== event.generation + (allocated ? 1 : 0)) throw new Error('The retained requests changed; review them again.')
  const ids = new Set(event.ids)
  for (const id of ids) {
    const entry = snapshot.pending.find(entry => entry.id === id)
    if (!entry || (entry.phase !== 'rejected' && entry.phase !== 'blocked')) throw new Error('Only definitively rejected or blocked requests can be disposed.')
  }
  for (const entry of snapshot.pending) if (entry.payload.kind === 'input' && entry.payload.envelope.predecessor.kind === 'ingress'
    && ids.has(entry.payload.envelope.predecessor.id) && !ids.has(entry.id)) throw new Error('Review the complete dependent input chain together.')
}
