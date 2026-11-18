import { applyDocumentPatches, ownDocument, ownEncodedValue } from './document.js'
import { declaredResolution, rowOperationForIntent } from './intent.js'
import { inputRefKey } from './journal.js'
import { kernelId, type Document, type EntityId, type InputRecord, type IntentId, type RecoveryEntry, type RecoveryId } from './model.js'
import { authorityCovers } from './protocol.js'
import type { KernelState } from './state.js'

/** Complete recovery material is independent of the current display row. It
 * never authorizes a write: recreate/merge still need an explicit decision and
 * fresh schema, identity, permission and observation checks. */
export function recoverIntentDocument(state: KernelState, entityId: EntityId, targets: readonly IntentId[]): Document {
  const ids = new Set(targets)
  const records = state.journal.intents.filter(record => ids.has(record.id))
  if (!ids.size || ids.size !== targets.length || records.length !== targets.length) throw new Error('Recovery requires exact known intent identities.')
  const operations = records.map(record => rowOperationForIntent(state, record))
  if (operations.some(operation => !operation || operation.entityId !== entityId)) throw new Error('A recovery document belongs to one explicit entity lifetime.')
  const first = records[0]!
  const captured = state.journal.actions.find(action => action.applicationId === first.applicationId)?.recoveryDocuments.find(row => row.entityId === entityId)
  let document: Document | null = captured?.document ?? null
  let version = captured ? state.observations.find(observation => observation.id === captured.observation)?.version : undefined
  if (captured && !version) throw new Error('Recovery material is missing its authority observation evidence.')
  for (const fact of state.commits) {
    const item = fact.submission.items.find(item => item.kind !== 'order' && item.entityId === entityId)
    const result = item ? fact.receipt.results.find(result => result.itemId === item.id) : undefined
    if (!result || (result.kind !== 'created' && result.kind !== 'updated')) continue
    if (version && authorityCovers(version, fact.receipt.committedVersion)) continue
    if (version && !authorityCovers(fact.receipt.committedVersion, version)) throw new Error('Recovery cannot choose between incomparable document evidence.')
    document = result.canonical; version = fact.receipt.committedVersion
  }
  for (const operation of operations) {
    if (!operation) throw new Error('Missing recovery operation.')
    if (operation.kind === 'create' || operation.kind === 'replace') document = operation.document
    else if (operation.kind === 'write') {
      if (!document) throw new Error('A partial write cannot reconstruct an unknown complete document.')
      for (const group of operation.groups) document = applyDocumentPatches(document, group.writes)
    } else if (!document) document = operation.recoveryDocument
  }
  if (!document) throw new Error('No complete recovery material is available.')
  return ownDocument(document)
}

/** Undoing a decision restores owned input for explicit editing/reapplication.
 * These fresh input identities never reopen old commit or discard evidence. */
export function prepareDecisionRecovery(state: KernelState, resolution: IntentId, createdBy: IntentId, id: RecoveryId) {
  const record = state.journal.intents.find(intent => intent.id === resolution)
  const decision = record && declaredResolution(record)
  if (!decision || state.recoveries.some(entry => entry.id === id)) throw new Error('Recovery requires a known decision and a fresh recovery identity.')
  const records = decision.targets.map(target => {
    const intent = state.journal.intents.find(intent => intent.id === target)
    if (!intent) throw new Error('A resolution must retain every original intent as recovery evidence.')
    return intent
  })
  const refs = new Set(records.flatMap(record => record.inputs.map(inputRefKey)))
  const materials = state.inputs.filter(input => refs.has(inputRefKey(input.ref))).map(input => input.input)
  if (materials.length !== refs.size) throw new Error('A resolution must retain its complete original input material.')
  if (!materials.length) materials.push({ kind: 'encoded', value: ownEncodedValue(records.map(record => record.operation)) })
  const inputs: InputRecord[] = materials.map((input, index) => ({ ref: { id: kernelId<'input'>(`${createdBy}:input:${index}`), version: 0 }, input,
    disposition: { kind: 'recovery', recoveryId: id },
  }))
  if (inputs.some(input => state.inputs.some(existing => inputRefKey(existing.ref) === inputRefKey(input.ref)))) throw new Error('Recovered inputs require fresh identities.')
  const entry: RecoveryEntry = { id, resolution, createdBy, intentIds: decision.targets, inputs: inputs.map(input => input.ref), state: 'available' }
  return { inputs, entry }
}
