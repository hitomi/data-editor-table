import { Workspace } from '../../../src/kernel/workspace.js'
import { openIndexedDbRecovery, type IndexedDbRecoverySession } from '../../../src/kernel/indexeddb-recovery.js'
import { prepareCheckpointWrite } from '../../../src/kernel/checkpoint-store.js'
import { kernelId, type ScopeIdentity } from '../../../src/kernel/model.js'
import { prepareRowAction } from '../../../src/kernel/prepare.js'
import { defineKernelSchema } from '../../../src/kernel/schema.js'
import type { PersistenceSource } from '../../../src/kernel/source.js'
import type { DurableTaskDefinition } from '../../../src/kernel/durable-task.js'
import { decodeCheckpoint, encodeCheckpoint, type CheckpointTransport } from '../../../src/kernel/checkpoint-transport.js'

const schema = defineKernelSchema({ version: kernelId<'schema-version'>('schema'), codec: kernelId<'codec-version'>('codec'),
  fields: [{ id: kernelId<'field'>('value'), path: ['value'], readonly: false }], validate: () => [] })
const policy = { version: kernelId<'policy-version'>('policy'), create: true, order: true, defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [] }
let workspace: Workspace
let checkpointSession: IndexedDbRecoverySession
let rejectNextStorageWrite = false
let loseSemanticAcknowledgement = false
let holdSemanticWrite: Readonly<{ entered: () => void; released: Promise<void> }> | null = null
let loseCheckpointAcknowledgement = false, checkpointWrites = 0, checkpointLookups = 0
const fresh = () => crypto.randomUUID()
async function transport(path: string, body: unknown) {
  const response = await fetch(`/__kernel-source/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`Source returned ${response.status}`)
  return response.json()
}
export async function startDurableWorkspace(databaseName: string, restore: boolean, recovery: 'manual' | 'lookup' = 'manual', fromCheckpoint: boolean | 'store' = false, options: Readonly<{ refresh?: boolean }> = {}) {
  const scope: ScopeIdentity = { sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source: PersistenceSource = { id: databaseName, capabilities: { atomicScopeWrites: true, durableOperationLookup: true, operationIdFence: 'scope-epoch',
    authorityOrder: 'ordered', identity: 'incarnation', operationRetentionMs: 3600000, restoreDeleted: false },
    readAtLeast: (scope, frontier) => transport('read', { scope, frontier }), submit: submission => transport('submit', submission), lookupOperation: ref => transport('lookup', ref) }
  const identity = { id: kernelId<'workspace'>('workspace'), scope, schema: schema.version, codec: schema.codec }
  const session = await openIndexedDbRecovery({ databaseName, workspace: identity })
  checkpointSession = session
  const task: DurableTaskDefinition = { ref: { id: 'upload', version: 'v1' }, capabilities: { idempotentStart: true, durableOutcomeLookup: true, executionIdFence: 'workspace' },
    start: async (request, context) => {
      const resource = context.resource ? [...new Uint8Array(await context.resource.arrayBuffer())] : null
      const response = await fetch('/__kernel-task/start', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: context.signal, body: JSON.stringify({ request, resource }) })
      if (!response.ok) throw new Error(`Task returned ${response.status}`)
      return response.json()
    },
    lookup: async (request, context) => {
      const response = await fetch('/__kernel-task/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: context.signal, body: JSON.stringify({ request }) })
      if (!response.ok) throw new Error(`Task lookup returned ${response.status}`)
      return response.json()
    },
  }
  const runtimeOptions = { scope, schema, policy, source, session: { ...session, commit: async (write: Parameters<typeof session.commit>[0]) => {
    if (holdSemanticWrite) {
      const held = holdSemanticWrite; holdSemanticWrite = null
      held.entered(); await held.released
    }
    if (rejectNextStorageWrite) { rejectNextStorageWrite = false; return session.lookup(write.record.commit) }
    const result = await session.commit(write)
    if (loseSemanticAcknowledgement) { loseSemanticAcknowledgement = false; throw new Error('Semantic acknowledgement lost') }
    return result
  }, checkpoints: { ...session.checkpoints,
    commit: async (write: Parameters<typeof session.checkpoints.commit>[0]) => {
      checkpointWrites++
      const result = await session.checkpoints.commit(write)
      if (loseCheckpointAcknowledgement) { loseCheckpointAcknowledgement = false; throw new Error('Checkpoint acknowledgement lost') }
      return result
    },
    lookup: async (commit: Parameters<typeof session.checkpoints.lookup>[0]) => { checkpointLookups++; return session.checkpoints.lookup(commit) },
  } }, tasks: [task] }
  if (fromCheckpoint) {
    const checkpoint = fromCheckpoint === 'store' ? (await session.checkpoints.load())?.checkpoint
      : await decodeCheckpoint(await checkpointArchive(databaseName), schema)
    if (!checkpoint) throw new Error('Checkpoint head is empty')
    workspace = await Workspace.openCheckpoint({ ...runtimeOptions, recovery, checkpoint })
  } else workspace = await Workspace.openDurable({ ...runtimeOptions, restore, recovery })
  if (!restore && options.refresh !== false) {
    const result = await workspace.refresh()
    if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
  }
  return workspaceDiagnostics()
}
async function openWorkspaceEditor(value: string) {
  const entityId = workspace.getProjection().rows[0]!.entityId
  const opened = await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>(fresh()), inputId: kernelId<'input'>(fresh()),
    viewId: kernelId<'view'>(fresh()), target: { kind: 'cell', field: { entityId, fieldId: kernelId<'field'>('value') } }, input: { kind: 'encoded', value }, reads: [] })
  if (opened.kind !== 'accepted') throw new Error(JSON.stringify(opened))
}
export async function editAndSaveWorkspace(value: string) {
  await openWorkspaceEditor(value)
  return applyCurrentSessionAndSave()
}
async function applyCurrentSession() {
  const current = workspace.getState().session!
  if (!current.editor) await workspace.dispatch({ kind: 'session-attached', sessionId: current.id, viewId: kernelId<'view'>(fresh()) })
  const session = workspace.getState().session!
  if (session.rawInput.kind !== 'encoded') throw new Error('Expected encoded task result')
  const value = session.rawInput.value, entityId = workspace.getProjection().rows[0]!.entityId
  const inputs = [session.input, ...session.retainedInputs].map(ref => workspace.getState().inputs.find(input => input.ref.id === ref.id && input.ref.version === ref.version)!)
  const prepared = prepareRowAction(workspace.getState(), { action: { id: kernelId<'action'>(fresh()), applicationId: kernelId<'application'>(fresh()), label: 'Edit', saveAtomicity: 'row' }, cause: 'user',
    inputs, commands: [{ id: kernelId<'intent'>(fresh()), inputs: inputs.map(input => input.ref), dependencies: [], command: {
      kind: 'write', entityId, groups: [{ id: kernelId<'write-group'>(fresh()), comparison: 'paths', reads: [], writes: [{ kind: 'set', path: ['value'], value }] }],
    } }],
  }, schema)
  const applied = await workspace.dispatch({ kind: 'session-apply', lease: session.editor!, inputVersion: session.input.version, prepared })
  if (applied.kind !== 'accepted') throw new Error(JSON.stringify(applied))
}
export async function applyCurrentSessionAndSave() {
  await applyCurrentSession()
  const saved = await workspace.save()
  return { saved: saved.kind, ...workspaceDiagnostics() }
}
export async function startFileTask(target: 'cell' | 'filter' = 'cell') {
  const input = await workspace.registerResource(new File(['upload body'], 'input.txt', { type: 'text/plain', lastModified: 123 }))
  const opened = await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>(fresh()), inputId: kernelId<'input'>(fresh()), viewId: kernelId<'view'>(fresh()),
    target: target === 'filter' ? { kind: 'filter', columnId: 'filter', queryVersion: workspace.getState().view.version } : { kind: 'cell', field: { entityId: workspace.getProjection().rows[0]!.entityId, fieldId: kernelId<'field'>('value') } }, input: { kind: 'encoded', value: 'selected upload' }, reads: [] })
  if (opened.kind !== 'accepted') throw new Error(JSON.stringify(opened))
  const session = workspace.getState().session!
  const task = workspace.runDurableTask({ definition: { id: 'upload', version: 'v1' }, owner: { kind: 'session', sessionId: session.id, input: session.input }, input, reads: [] })
  const result = await task.result
  if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
  await workspace.waitForTask(task.taskId)
  return { taskId: task.taskId, ...workspaceDiagnostics() }
}
export async function recoverFileTask(taskId: string, mode: 'lookup' | 'retry' = 'lookup') {
  const result = await workspace.recoverTask(kernelId<'task'>(taskId), mode)
  return { result: result.kind, ...workspaceDiagnostics() }
}
export async function recoverDurableWorkspace() { const result = await workspace.recover(); return { result: result.kind, ...workspaceDiagnostics() } }
export async function refreshDurableWorkspace() { const result = await workspace.refresh(); return { result: result.kind, ...workspaceDiagnostics() } }
async function rejectWorkspaceFile() {
  await openWorkspaceEditor('original')
  rejectNextStorageWrite = true
  let rejected = false
  try { await workspace.registerResource(new File(['rejected file body'], '保留.txt', { type: 'text/plain', lastModified: 789 })) } catch { rejected = true }
  if (!rejected) throw new Error('Expected the storage negative proof to reject registration')
}
export async function retainRejectedWorkspaceFile() {
  await rejectWorkspaceFile()
  const result = await workspace.refresh()
  if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
  return workspaceIngressDiagnostics()
}
// Fixture-owned archive, separate from the semantic recovery store. The real
// checkpoint-close head/lease protocol is not implemented by this test helper.
async function checkpointArchive(name: string, write?: CheckpointTransport): Promise<CheckpointTransport> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(`${name}:checkpoint-archive`, 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore('checkpoint')
    opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error)
  })
  try {
    return await new Promise<CheckpointTransport>((resolve, reject) => {
      const transaction = db.transaction('checkpoint', write ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('checkpoint'), request = write ? store.put(write, 'latest') : store.get('latest')
      let value = write
      request.onsuccess = () => { if (!write) value = request.result as CheckpointTransport | undefined }
      transaction.oncomplete = () => value ? resolve(value) : reject(new Error('Checkpoint archive is empty'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Checkpoint archive transaction failed'))
      transaction.onerror = () => { /* onabort reports the final outcome. */ }
    })
  } finally { db.close() }
}
export async function archiveRejectedWorkspaceFile(databaseName: string) {
  await rejectWorkspaceFile()
  await checkpointArchive(databaseName, await encodeCheckpoint(await workspace.exportCheckpoint(), schema))
  return workspaceIngressDiagnostics()
}
export async function storeRejectedWorkspaceCheckpoint() {
  await rejectWorkspaceFile()
  const before = (await checkpointSession.load())!.record.commit
  const checkpoint = await workspace.exportCheckpoint()
  const write = await prepareCheckpointWrite(checkpoint, (await checkpointSession.checkpoints.load())?.commit.token ?? null, fresh(), schema)
  const result = await checkpointSession.checkpoints.commit(write)
  const competing = await prepareCheckpointWrite(checkpoint, write.commit.parent, fresh(), schema)
  const competitor = await checkpointSession.checkpoints.commit(competing)
  const late = await prepareCheckpointWrite(checkpoint, write.commit.token, fresh(), schema)
  const negative = await checkpointSession.checkpoints.lookup(late.commit)
  const arriving = await checkpointSession.checkpoints.commit(late)
  return { result, competitor: competitor.kind, negative: negative.kind, arriving: arriving.kind,
    before, after: (await checkpointSession.load())!.record.commit, ...workspaceIngressDiagnostics() }
}
export async function storedCheckpointToken() { return (await checkpointSession.checkpoints.load())?.commit.token ?? null }
export async function checkpointBeforeDelayedSemanticWrite() {
  await rejectWorkspaceFile()
  const checkpoint = await workspace.exportCheckpoint()
  const write = await prepareCheckpointWrite(checkpoint, null, fresh(), schema)
  const before = (await checkpointSession.load())!.record.commit
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
  holdSemanticWrite = { entered: enter, released }
  const updating = workspace.refresh()
  await entered
  const stored = await checkpointSession.checkpoints.commit(write)
  release()
  const update = await updating
  return { stored: stored.kind, update: update.kind, before, after: (await checkpointSession.load())!.record.commit, token: await storedCheckpointToken() }
}
export function workspaceIngressDiagnostics() {
  return { pending: workspace.getIngress().pending, receipts: workspace.getIngress().receipts, rawInput: workspace.getState().session?.rawInput }
}
export async function returnRejectedWorkspaceCommand() {
  const result = await workspace.dispatch({ kind: 'view-query-set', expectedVersion: -1, filters: [], sort: [] })
  if (result.kind !== 'rejected') throw new Error('Expected invalid view command to be retained')
  await workspace.refresh()
  const pending = workspace.getIngress().pending
  if (pending.length !== 1) throw new Error('Expected one retained command')
  const ingressId = pending[0]!.id
  await workspace.disposeIngress([ingressId], workspace.getIngress().generation, 'returned')
  return { ingressId, ...workspaceIngressDiagnostics() }
}
export async function retryRetainedWorkspaceFile(ingressId: string) {
  const entry = workspace.getIngress().pending.find(entry => entry.id === ingressId)
  if (!entry || entry.payload.kind !== 'event' || entry.payload.event.kind !== 'resource-registered') throw new Error('Expected retained registration')
  const result = await workspace.retryIngress(entry.id, workspace.getIngress().generation).completion
  if (result.kind !== 'completed' || result.transition.result.kind !== 'accepted') throw new Error(JSON.stringify(result))
  return readWorkspaceFile(entry.payload.event.descriptor.id)
}
export async function readWorkspaceFile(resourceId: string) {
  const file = workspace.getResource(kernelId<'resource'>(resourceId)) as File
  return { name: file.name, lastModified: file.lastModified, text: await file.text() }
}
export function workspaceDiagnostics() {
  return { row: workspace.getProjection().rows[0]?.preview, persistence: workspace.getState().persistence.kind, revision: workspace.getState().revision,
    schedule: workspace.getState().schedule, scheduledResult: workspace.getScheduledSaveResult(),
    inputDispositions: workspace.getState().inputs.map(input => input.disposition.kind), pending: workspace.getIngress().pending.length,
    tasks: workspace.getState().tasks.map(task => ({ id: task.id, kind: task.kind, outcome: task.execution?.outcome?.kind })), sessionInput: workspace.getState().session?.rawInput }
}
export function workspaceForReactFixture() { return workspace }
export function loseNextWorkspaceAcknowledgement() { loseSemanticAcknowledgement = true }
export async function reconcileWorkspaceInput() { return workspace.reconcileStorage() }

export async function closeDurableWorkspace() {
  const review = workspace.requestClose(), state = workspace.getState()
  const result = await workspace.close(review.ticket, 'clean-close')
  const late = result.kind === 'closed' ? await workspace.dispatch({ kind: 'view-query-set', expectedVersion: state.view.version, filters: [], sort: [] }) : null
  return { result, late, unchanged: state === workspace.getState(), pending: workspace.getIngress().pending.length }
}
export async function checkpointCloseWorkspace(loseReceipt = false) {
  if (loseReceipt) loseCheckpointAcknowledgement = true
  const state = workspace.getState(), result = await workspace.close(workspace.requestClose().ticket, 'checkpoint-close')
  return { result, checkpointWrites, checkpointLookups, unchanged: state === workspace.getState(), status: workspace.getCheckpointStatus(), ...workspaceIngressDiagnostics() }
}
export function loseNextCheckpointAcknowledgement() { loseCheckpointAcknowledgement = true }
export function checkpointWriteDiagnostics() { return { checkpointWrites, checkpointLookups } }
export function workspaceDiscardDiagnostics() {
  return { discards: workspace.getState().discards, history: workspace.getHistory(), capabilities: workspace.getCapabilities(), lifecycle: workspace.requestClose().lifecycle,
    ...workspaceDiagnostics(), ingress: workspaceIngressDiagnostics() }
}
export async function discardAndCloseWorkspace() {
  const result = await workspace.close(workspace.requestClose().ticket, 'discard')
  return { result, ...workspaceDiscardDiagnostics() }
}

export async function configureWorkspaceSchedule(mode: 'manual' | 'immediate' | 'debounced', debounceMs = 0) {
  const result = await workspace.setSaveSchedule({ mode, debounceMs })
  if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
  return workspaceDiagnostics()
}
export async function queueScheduledEdit(value: string) {
  await openWorkspaceEditor(value)
  await applyCurrentSession()
  return workspaceDiagnostics()
}

export async function scanDurableWorkspace() {
  const result = await workspace.recoverPendingWork()
  return { result, ...workspaceDiagnostics() }
}
export function workspaceRecoveryProgress() { return workspace.getRecoveryProgress() }

export async function applyRecoveredFilter() {
  const current = workspace.getState().session!
  if (!current.editor) await workspace.dispatch({ kind: 'session-attached', sessionId: current.id, viewId: kernelId<'view'>(fresh()) })
  const session = workspace.getState().session!
  if (session.target.kind !== 'filter' || session.rawInput.kind !== 'encoded') throw new Error('Expected recovered filter input')
  const result = await workspace.dispatch({ kind: 'session-query-apply', lease: session.editor!, inputVersion: session.input.version,
    queryVersion: session.target.queryVersion, predicate: { kind: 'compare', fieldId: kernelId<'field'>('value'), operator: 'equals', value: session.rawInput.value } })
  return { result, visible: workspace.getView().rows.length, ...workspaceDiagnostics() }
}

export async function exportAndValidateWorkspaceCheckpoint() {
  const checkpoint = await workspace.exportCheckpoint()
  const { validateWorkspaceCheckpoint } = await import('../../../src/kernel/checkpoint.js')
  const imported = await validateWorkspaceCheckpoint(structuredClone(checkpoint), workspace.schema)
  const files = []
  for (const entry of imported.metadata.resources.manifest.entries) {
    const blob = imported.resources.get(entry.descriptor.id)
    files.push({ descriptor: entry.descriptor, text: await blob.text() })
  }
  return { sha256: checkpoint.sha256, reservation: imported.metadata.reservation, tasks: imported.metadata.state.tasks.map(task => task.kind),
    files, ticket: imported.metadata.ticket, revision: imported.metadata.state.revision }
}
