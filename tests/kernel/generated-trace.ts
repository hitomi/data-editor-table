/** Test-only scheduler utilities. No production state or comparison helpers. */
export function seededRandom(seed: number): (bound: number) => number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be a uint32')
  let state = seed
  return bound => {
    if (!Number.isSafeInteger(bound) || bound <= 0) throw new Error('Bound must be positive')
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return Math.floor(state / 0x100000000 * bound)
  }
}

export type TraceFailure = Readonly<{ property: string; diagnostics: unknown }>
export type TraceOutcome = Readonly<{ kind: 'pass' | 'invalid' }> | Readonly<{ kind: 'fail'; failure: TraceFailure }>

/** Deletion and optional value simplification to a fixed point, preserving the
 * same property. Values require a decreasing natural-number rank. Invalid
 * schedules never count as failures. Minimality is local to one-event deletion
 * and the supplied candidates, not globally shortest values/permutations.
 * Infrastructure exceptions propagate instead of becoming counterexamples. */
export async function minimizeTrace<Event>(events: readonly Event[], replay: (events: readonly Event[]) => Promise<TraceOutcome>,
  values?: Readonly<{ candidates: (event: Event) => readonly Event[]; rank: (event: Event) => number }>) {
  const original = await replay(events)
  if (original.kind !== 'fail') throw new Error('A reproducible semantic failure is required')
  const property = original.failure.property
  let trace = [...events], failure = original.failure, attempts = 1
  let simplified: boolean
  do {
    simplified = false
    for (let size = Math.max(1, Math.floor(trace.length / 2)); size >= 1; size = Math.floor(size / 2)) {
      let changed = true
      while (changed) {
        changed = false
        for (let index = 0; index < trace.length; index++) {
          const candidate = [...trace.slice(0, index), ...trace.slice(index + size)]
          const result = await replay(candidate); attempts++
          if (result.kind === 'fail' && result.failure.property === property) {
            trace = candidate; failure = result.failure; changed = true; break
          }
        }
      }
    }
    if (values) {
      for (let index = 0; index < trace.length; index++) {
        const event = trace[index]!, rank = values.rank(event)
        if (!Number.isSafeInteger(rank) || rank < 0) throw new Error('Value rank must be a nonnegative safe integer')
        for (const replacement of values.candidates(event)) {
          const nextRank = values.rank(replacement)
          if (!Number.isSafeInteger(nextRank) || nextRank < 0 || nextRank >= rank) throw new Error('Value candidates must strictly decrease rank')
          const candidate = trace.map((value, position) => position === index ? replacement : value)
          const result = await replay(candidate); attempts++
          if (result.kind === 'fail' && result.failure.property === property) {
            trace = candidate; failure = result.failure; simplified = true; break
          }
        }
        if (simplified) break
      }
    }
    // A simpler value can make a previously required event removable.
  } while (simplified)
  return { trace, failure, attempts, minimality: values ? 'single-event-deletion-and-value-candidates' as const : 'single-event-deletion' as const }
}
