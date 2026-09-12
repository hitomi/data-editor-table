import { encodedValuesEqual, ownEncodedValue } from './document.js'
import type { IngressSnapshot, PendingIngress } from './ingress.js'
import type { IngressId, WorkspaceIdentity } from './model.js'
import type { KernelState } from './state.js'

export type IngressCheckpoint = Readonly<{ format: 1; workspace: WorkspaceIdentity; revision: number; snapshot: IngressSnapshot }>
const same = (a: unknown, b: unknown) => encodedValuesEqual(ownEncodedValue(a), ownEncodedValue(b))
const integer = (value: number, minimum: number) => Number.isSafeInteger(value) && value >= minimum

/** Structural validation for a trusted, integrity-checked full checkpoint.
 * This capsule does not prove storage outcomes or transfer an executor lease.
 * Predecessor errors intentionally retained as raw input remain recoverable. */
export function restoreIngressCheckpoint(raw: IngressCheckpoint, state: KernelState) {
  const checkpoint = ownEncodedValue(raw) as unknown as IngressCheckpoint
  if (checkpoint.format !== 1 || !same(checkpoint.workspace, state.workspace) || checkpoint.revision !== state.revision)
    throw new Error('Ingress checkpoint must match the exact semantic workspace and revision.')
  const { snapshot } = checkpoint
  if (!integer(snapshot.generation, 0)) throw new Error('Invalid ingress generation.')
  const ids = new Set<string>(), sequences = new Set<number>(), schedules = new Set<number>()
  const inputRefs = new Set(state.inputs.map(input => JSON.stringify([input.ref.id, input.ref.version])))
  const inputs = new Map<string, { id: IngressId; inputSequence: number }[]>()
  const add = (entry: IngressSnapshot['pending'][number] | IngressSnapshot['receipts'][number]) => {
    if (!entry.id || ids.has(entry.id) || !integer(entry.sequence, 1) || sequences.has(entry.sequence)
      || !integer(entry.scheduledAt, entry.sequence) || schedules.has(entry.scheduledAt) || entry.scheduledAt > snapshot.generation)
      throw new Error('Ingress entries require unique identities, original sequences and valid scheduling generations.')
    ids.add(entry.id); sequences.add(entry.sequence); schedules.add(entry.scheduledAt)
    const input = 'payload' in entry ? entry.payload.kind === 'input' ? entry.payload.envelope : null : entry.input
    if (input) {
      const { lease, inputSequence } = input
      if (!lease.sessionId || !lease.viewId || !integer(lease.generation, 1) || !integer(inputSequence, 1)) throw new Error('An ingress input requires its complete lease and sequence.')
      const key = JSON.stringify([lease.sessionId, lease.viewId, lease.generation])
      const chain = inputs.get(key) ?? []
      chain.push({ id: entry.id, inputSequence }); inputs.set(key, chain)
    }
  }
  for (const receipt of snapshot.receipts) {
    add(receipt)
    if (!['accepted', 'ignored', 'discarded', 'returned'].includes(receipt.disposition)) throw new Error('Invalid ingress receipt disposition.')
    if ((receipt.disposition === 'returned') !== (receipt.returned !== undefined)) throw new Error('Returned receipts must preserve their complete payload.')
    if (receipt.returned && (!['input', 'event', 'resolution-rejected'].includes(receipt.returned.kind)
      || (receipt.returned.kind === 'input' && receipt.returned.envelope.ingressId !== receipt.id))) throw new Error('Returned material belongs to another input request.')
    if (receipt.input?.ref) {
      if (receipt.disposition !== 'accepted' || !inputRefs.has(JSON.stringify([receipt.input.ref.id, receipt.input.ref.version])))
        throw new Error('An input receipt must name its exact accepted semantic input.')
    } else if (receipt.input && receipt.disposition === 'accepted') throw new Error('Accepted input receipt lacks its published reference.')
  }
  let active: IngressId | null = null
  const pending = snapshot.pending.map((entry): PendingIngress => {
    add(entry)
    if (!['input', 'event', 'resolution-rejected'].includes(entry.payload.kind)) throw new Error('Unknown ingress payload carrier.')
    if (entry.payload.kind === 'input' && entry.payload.envelope.ingressId !== entry.id) throw new Error('Input envelope belongs to another ingress identity.')
    if (entry.phase === 'committing' || entry.phase === 'uncertain') {
      const attempt = entry.attempt
      if (active || attempt.ingressId !== entry.id || attempt.sequence !== entry.sequence || !integer(attempt.generation, entry.scheduledAt)
        || attempt.generation > snapshot.generation || !integer(attempt.baseRevision, 0) || attempt.baseRevision > state.revision
        || state.revision - attempt.baseRevision > 1) throw new Error('Checkpoint cannot restore an ambiguous or unrelated active ingress attempt.')
      active = entry.id
      // A Promise cannot be resumed from bytes. Preserve the original attempt
      // until the outer storage coordinator proves its exact outcome.
      return entry.phase === 'uncertain' ? entry : Object.freeze({ ...entry, phase: 'uncertain',
        issue: Object.freeze({ code: 'ingress-recovery-required', message: 'Resolve the original commit attempt before processing this restored queue.' }) })
    }
    if (entry.phase !== 'queued' && entry.phase !== 'rejected' && entry.phase !== 'blocked') throw new Error('Unknown ingress checkpoint phase.')
    return entry
  })
  const heads = new Map<string, Readonly<{ id: IngressId; inputSequence: number }>>()
  for (const [key, chain] of inputs) {
    chain.sort((a, b) => a.inputSequence - b.inputSequence)
    if (chain.some((input, index) => input.inputSequence !== index + 1)) throw new Error('Checkpoint input chains must retain their complete receipt and predecessor history.')
    heads.set(key, Object.freeze(chain.at(-1)!))
  }
  const queue = pending.filter(entry => entry.phase === 'queued').sort((a, b) => a.scheduledAt - b.scheduledAt).map(entry => entry.id)
  const activeSchedule = active ? pending.find(entry => entry.id === active)!.scheduledAt : null
  if (activeSchedule !== null && pending.some(entry => entry.phase === 'queued' && entry.scheduledAt < activeSchedule))
    throw new Error('Queued work cannot precede the active commit attempt.')
  return { snapshot: Object.freeze({ generation: snapshot.generation, pending: Object.freeze(pending), receipts: snapshot.receipts }), heads, queue, active }
}
