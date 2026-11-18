import type { Document, EntityId } from './model.js'
import type { KernelProjection, RowProjection } from './projection.js'

export type PrefixRead = Readonly<{ projection: KernelProjection; documents: ReadonlyMap<EntityId, Document>;
  order: readonly EntityId[]; rows: ReadonlyMap<EntityId, RowProjection> }>
export type PrefixComputation = Generator<number, KernelProjection, PrefixRead>
type Frame = { through: number; computation: PrefixComputation; value?: PrefixRead; failure?: { error: unknown } }

function index(projection: KernelProjection): PrefixRead {
  const documents = new Map(projection.rows.flatMap(row => row.preview && row.existence !== 'pending-delete' ? [[row.entityId, row.preview] as const] : []))
  return { projection, documents, order: projection.order.preview.filter(id => documents.has(id)),
    rows: new Map(projection.rows.map(row => [row.entityId, row] as const)) }
}

/** Suspended prefixes keep their local calculation, rather than restarting it
 * or nesting JavaScript calls. Each completed prefix and its indexes are local
 * to this evaluation. A child failure is thrown at the parent's read site. */
export function evaluatePrefixes(compute: (through: number) => PrefixComputation, initial = Infinity): KernelProjection {
  const reads = new Map<number, PrefixRead>()
  const frames: Frame[] = [{ through: initial, computation: compute(initial) }]
  while (frames.length) {
    const frame = frames.at(-1)!
    let step: IteratorResult<number, KernelProjection>
    try {
      const failure = frame.failure, value = frame.value
      delete frame.failure; delete frame.value
      step = failure ? frame.computation.throw(failure.error) : value ? frame.computation.next(value) : frame.computation.next()
    } catch (error) {
      frames.pop()
      if (!frames.length) throw error
      frames.at(-1)!.failure = { error }
      continue
    }
    if (step.done) {
      frames.pop()
      if (!frames.length) return step.value
      const read = index(step.value)
      reads.set(frame.through, read)
      frames.at(-1)!.value = read
      continue
    }
    const through = step.value
    if (!Number.isSafeInteger(through) || through < 0 || through >= frame.through)
      throw new Error('A causal prefix must read a strictly earlier nonnegative sequence.')
    const cached = reads.get(through)
    if (cached) frame.value = cached
    else frames.push({ through, computation: compute(through) })
  }
  throw new Error('Prefix evaluation ended without a complete projection.')
}
