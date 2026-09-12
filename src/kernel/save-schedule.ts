import type { SaveSchedule } from './model.js'
import { projectKernel } from './projection.js'
import type { KernelSchema } from './schema.js'
import type { KernelState } from './state.js'

export type SaveScheduleOptions = Readonly<Pick<SaveSchedule, 'mode' | 'debounceMs'>>
export type SaveScheduleEvent = Readonly<{ kind: 'save-schedule-configured'; expectedToken: number; options: SaveScheduleOptions }>

export function assertSaveSchedule(schedule: SaveSchedule): void {
  if (!schedule || !['manual', 'immediate', 'debounced'].includes(schedule.mode)
    || !Number.isSafeInteger(schedule.debounceMs) || schedule.debounceMs < 0 || schedule.debounceMs > 2_147_483_647
    || (schedule.mode !== 'debounced' && schedule.debounceMs !== 0)
    || !Number.isSafeInteger(schedule.token) || schedule.token < 0 || typeof schedule.pending !== 'boolean'
    || (schedule.mode === 'manual' && schedule.pending)) throw new Error('Invalid persisted save schedule.')
}

export function nextSchedule(schedule: SaveSchedule, pending: boolean): SaveSchedule {
  if (!Number.isSafeInteger(schedule.token + 1)) throw new Error('Save schedule token exhausted.')
  return Object.freeze({ ...schedule, token: schedule.token + 1, pending })
}
export function hasSaveableChanges(state: KernelState, schema: KernelSchema): boolean {
  const projection = projectKernel(state, schema)
  return projection.changes.length > 0 || projection.orderChange !== null
}
export function configureSchedule(state: KernelState, event: SaveScheduleEvent, schema: KernelSchema): KernelState {
  const { mode, debounceMs } = event.options
  if (event.expectedToken !== state.schedule.token) throw new Error('Save mode changed since this configuration was reviewed.')
  assertSaveSchedule({ mode, debounceMs, token: state.schedule.token, pending: mode !== 'manual' })
  return Object.freeze({ ...state, schedule: nextSchedule({ ...state.schedule, mode, debounceMs }, mode !== 'manual' && (state.persistence.kind !== 'idle' || hasSaveableChanges(state, schema))) })
}

/** Journal append is the authoring boundary. Raw sessions, view changes,
 * receipt/read bookkeeping and task execution phases never restart debounce.
 * Keep a follow-up even if this row is currently reserved by an older save. */
export function scheduleAuthoredWork(before: KernelState, after: KernelState): KernelState {
  if (before.journal.intents.length === after.journal.intents.length && before.journal.actions.length === after.journal.actions.length) return after
  return Object.freeze({ ...after, schedule: nextSchedule(after.schedule, after.schedule.mode !== 'manual') })
}

/** A fresh authority/policy may unblock existing work. Only newly eligible
 * contributions rearm a consumed trigger; repeated equivalent reads do not
 * become a retry loop for a failed save. Unknown operations remain reserved. */
export function scheduleNewlyEligible(before: KernelState, after: KernelState, schema: KernelSchema): KernelState {
  if (after.schedule.mode === 'manual' || after.schedule.pending || before.persistence.kind !== 'idle') return after
  const eligible = (state: KernelState) => {
    const projection = projectKernel(state, schema)
    return [...projection.changes.flatMap(change => change.intentIds), ...(projection.orderChange?.intentIds ?? [])]
  }
  const previous = new Set(eligible(before))
  if (!eligible(after).some(id => !previous.has(id))) return after
  return Object.freeze({ ...after, schedule: nextSchedule(after.schedule, true) })
}

/** No timer is needed after neutralization, complete coverage or a conflict
 * blocking every row. Re-arm only on new authoring or newly eligible work. */
export function settleSchedule(state: KernelState, schema: KernelSchema): KernelState {
  if (!state.schedule.pending || state.persistence.kind !== 'idle' || hasSaveableChanges(state, schema)) return state
  return Object.freeze({ ...state, schedule: nextSchedule(state.schedule, false) })
}
