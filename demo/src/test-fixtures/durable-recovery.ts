import { DurableCommitBarrier } from '../../../src/kernel/durable-commit.js'
import { IngressQueue, type IngressHandle } from '../../../src/kernel/ingress.js'
import { openIndexedDbRecovery, type IndexedDbRecoverySession } from '../../../src/kernel/indexeddb-recovery.js'
import { kernelId } from '../../../src/kernel/model.js'
import { ResourceStore } from '../../../src/kernel/resource-store.js'
import { prepareRecoveryWrite } from '../../../src/kernel/recovery-store.js'
import { defineKernelSchema } from '../../../src/kernel/schema.js'
import { createKernelState } from '../../../src/kernel/state.js'
import { reduceKernel } from '../../../src/kernel/transition.js'

const schema = defineKernelSchema({ version: kernelId<'schema-version'>('schema'), codec: kernelId<'codec-version'>('codec'), fields: [], validate: () => [] })
const initialState = createKernelState({ id: kernelId<'workspace'>('browser-durable'), scope: { sourceId: 'browser-source', id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') },
  schema: schema.version, codec: schema.codec }, { version: kernelId<'policy-version'>('policy'), create: true, order: true, defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [] })
let storage: IndexedDbRecoverySession, barrier: DurableCommitBarrier, ingress: IngressQueue, loseAcknowledgement = false
const id = () => kernelId<'ingress'>(crypto.randomUUID())
async function accepted(handle: IngressHandle) {
  const result = await handle.completion
  if (result.kind === 'unresolved') throw new Error(result.issue.message)
  if (result.transition.result.kind !== 'accepted') throw new Error(JSON.stringify(result.transition.result))
}

export async function startDurableFixture(databaseName: string, recover: boolean) {
  storage = await openIndexedDbRecovery({ databaseName, workspace: initialState.workspace })
  const session = { ...storage, async commit(write: Parameters<typeof storage.commit>[0]) {
    const result = await storage.commit(write)
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Injected lost storage receipt') }
    return result
  } }
  if (recover) barrier = await DurableCommitBarrier.restore({ initialState, schema, session })
  else barrier = new DurableCommitBarrier({ state: initialState, schema, resources: new ResourceStore(), session })
  ingress = new IngressQueue(() => barrier.getState(), event => barrier.commit(event))
  if (!recover) {
    const descriptor = barrier.resources.register(kernelId<'resource'>('file'), new File(['preserved bytes'], '恢复.txt', { type: 'text/plain', lastModified: 123 }))
    await accepted(ingress.event(id(), { kind: 'resource-registered', descriptor }))
    await accepted(ingress.event(id(), { kind: 'session-opened', revision: barrier.getState().revision, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('input'),
      viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'resource', id: descriptor.id }, reads: [] }))
  } else {
    // A restored DOM editor is never reused. Detach/reattach are themselves
    // durable transitions; original input and file history remain owned.
    const session = barrier.getState().session
    if (session?.editor) {
      await accepted(ingress.event(id(), { kind: 'session-detached', lease: session.editor, inputVersion: session.input.version }))
      await accepted(ingress.event(id(), { kind: 'session-attached', sessionId: session.id, viewId: kernelId<'view'>(crypto.randomUUID()) }))
    }
  }
  return durableDiagnostics()
}

export async function typeDurableInput(values: readonly string[], loseReceipt = false) {
  loseAcknowledgement = loseReceipt
  const lease = barrier.getState().session!.editor!
  const handles = values.map(value => ingress.input(ingress.envelope(id(), lease, { kind: 'encoded', value }, 'idle')))
  // A lost receipt deliberately stops the queue; later handles remain pending.
  if (loseReceipt) await handles[0]!.completion
  else await Promise.all(handles.map(handle => handle.completion))
  return durableDiagnostics()
}
export async function reconcileDurableInput() {
  const pending = ingress.getSnapshot().pending.find(entry => entry.phase === 'uncertain')
  if (!pending || pending.phase !== 'uncertain') throw new Error('No uncertain ingress')
  ingress.resolveUncertain(pending.attempt, await barrier.reconcile())
  return durableDiagnostics()
}
export async function releaseDurableFixture() { await storage.release(); return durableDiagnostics() }
export async function checkpointHeadIsEmpty() { return await storage.checkpoints.load() === null }
export async function seedPreviousRecoverySchema(databaseName: string) {
  const resources = new ResourceStore()
  const descriptor = resources.register(kernelId<'resource'>('file'), new File(['legacy bytes'], '旧文件.txt', { type: 'text/plain', lastModified: 29 }))
  const event = { kind: 'resource-registered' as const, descriptor }, lease = { workspace: initialState.workspace, epoch: 'previous-schema-lease' }
  const write = await prepareRecoveryWrite(lease, 1, null, event, reduceKernel(initialState, event, schema), resources)
  const bytes = await write.contents[0]!.blob.arrayBuffer(), entry = write.record.manifest.entries[0]!
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(databaseName, 1)
    opening.onupgradeneeded = () => { for (const name of ['heads', 'records', 'outcomes', 'resources']) opening.result.createObjectStore(name) }
    opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['heads', 'records', 'resources'], 'readwrite')
      transaction.objectStore('heads').put({ workspace: initialState.workspace, epoch: lease.epoch, root: { token: write.record.commit.token, revision: 1 } }, initialState.workspace.id)
      transaction.objectStore('records').put(write.record, initialState.workspace.id)
      transaction.objectStore('resources').put(bytes, JSON.stringify([initialState.workspace.id, descriptor.id, entry.sha256]))
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
    })
  } finally { db.close() }
}
export async function stageDurableFile() {
  barrier.resources.register(kernelId<'resource'>('staged'), new File(['staged bytes'], '暂存.txt', { type: 'text/plain', lastModified: 456 }))
  const retired = kernelId<'resource'>('retired-staged')
  barrier.resources.register(retired, new Blob(['retired'])); barrier.resources.release(retired)
  await accepted(ingress.event(id(), { kind: 'read-started', ticket: crypto.randomUUID() }))
  return stagedDurableDiagnostics()
}
export async function stagedDurableDiagnostics() {
  const file = barrier.resources.get(kernelId<'resource'>('staged')) as File
  let reuseRejected = false
  try { barrier.resources.register(kernelId<'resource'>('retired-staged'), new Blob()) } catch { reuseRejected = true }
  return { file: { name: file.name, lastModified: file.lastModified, text: await file.text() }, reuseRejected,
    semanticallyRegistered: barrier.getState().resources.some(record => record.descriptor.id === 'staged') }
}
export async function verifyDurableNegativeFence() {
  const event = { kind: 'read-started' as const, ticket: 'must-not-publish' }
  const write = await prepareRecoveryWrite(storage.lease, 1000, barrier.getRoot(), event, reduceKernel(barrier.getState(), event, schema), barrier.resources)
  const before = await storage.load()
  const proof = await storage.lookup(write.record.commit)
  const late = await storage.commit(write)
  const after = await storage.load()
  return { proof: proof.kind, late: late.kind, before: before?.record.commit, after: after?.record.commit, phase: barrier.getStatus().kind }
}
export async function durableDiagnostics() {
  const file = barrier.resources.get(kernelId<'resource'>('file')) as File
  return { revision: barrier.getState().revision, rawInput: barrier.getState().session?.rawInput, file: { name: file.name, lastModified: file.lastModified, text: await file.text() },
    phase: barrier.getStatus().kind, inputCount: barrier.getState().inputs.length, pending: ingress.getSnapshot().pending.length,
    leaseEpoch: storage.lease.epoch, root: barrier.getRoot() }
}
