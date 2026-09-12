import { ownEncodedValue } from './document.js'
import { assertCheckpointCommit, assertCheckpointConsumption, assertCheckpointReplacement, assertCheckpointResult, checkpointMatchesRoot, validateCheckpointWrite,
  type CheckpointCommit, type CheckpointRecoverySession, type CheckpointResult, type CheckpointToken, type CheckpointWrite } from './checkpoint-store.js'
import type { CheckpointTransport } from './checkpoint-transport.js'
import type { PreparedStorageCommit, RecoveryCommitResult, RecoveryRoot, WorkspaceIdentity } from './model.js'
import { assertRecoveryResult, recoveryRoot, sameRecoveryValue, validateRecoveryWrite, type RecoveryRecord } from './recovery-store.js'

type Head = Readonly<{ workspace: WorkspaceIdentity; epoch: string; root: RecoveryRoot | null; checkpoint: CheckpointToken | null }>
type StoredCheckpoint = Readonly<{ commit: CheckpointCommit; snapshot: CheckpointTransport }>
export type IndexedDbRecoverySession = CheckpointRecoverySession
const stores = ['heads', 'records', 'outcomes', 'resources', 'checkpoints', 'checkpoint-outcomes'] as const
const checkpointKey = (commit: CheckpointCommit) => JSON.stringify([commit.token.workspaceId, commit.token.leaseEpoch, commit.token.id])
const tokenKey = (commit: PreparedStorageCommit) => JSON.stringify([commit.workspace.id, commit.token.leaseEpoch, commit.token.sequence, commit.token.candidateHash])
const resourceKey = (workspace: WorkspaceIdentity, id: string, digest: string) => JSON.stringify([workspace.id, id, digest])
const negative = (commit: PreparedStorageCommit, message: string): RecoveryCommitResult => Object.freeze({ kind: 'not-committed', commit,
  issue: Object.freeze({ code: 'recovery-storage', message }) })

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed.'))
  })
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () => { /* onabort owns the final transaction result. */ }
  })
}
async function database(name: string): Promise<IDBDatabase> {
  const opening = indexedDB.open(name, 2)
  opening.onupgradeneeded = () => { for (const name of stores) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name) }
  return request(opening)
}

/** Browser storage adapter. An origin Web Lock spans the session lifetime;
 * every IndexedDB transaction also checks the durable epoch. No expiry or
 * timeout silently takes over a live owner. Closing the page releases the
 * browser lock; reopening acquires a new epoch before reading the root.
 *
 * Resources are immutable byte entries shared by successive root records.
 * Persist ArrayBuffers rather than browser-specific Blob/File serialization;
 * MIME and File metadata belong to the hashed manifest, not the byte carrier.
 * Root + semantic record + required bytes + exact outcome are one transaction.
 * Successful transaction completion, not a put request, is the commit receipt. */
export async function openIndexedDbRecovery(options: Readonly<{ databaseName: string; workspace: WorkspaceIdentity }>): Promise<IndexedDbRecoverySession> {
  const workspace = ownEncodedValue(options.workspace) as unknown as WorkspaceIdentity
  if (!options.databaseName || !workspace.id || !workspace.scope.sourceId || !workspace.scope.id || !workspace.scope.epoch || !workspace.schema || !workspace.codec)
    throw new Error('Recovery storage requires a database and complete workspace identity.')
  if (typeof indexedDB === 'undefined' || typeof navigator === 'undefined' || !navigator.locks) throw new Error('Durable recovery requires IndexedDB and exclusive browser locks.')
  let releaseLock!: () => void, acquired!: (value: IndexedDbRecoverySession) => void, failed!: (reason: unknown) => void
  const lifetime = new Promise<void>(resolve => { releaseLock = resolve })
  const ready = new Promise<IndexedDbRecoverySession>((resolve, reject) => { acquired = resolve; failed = reject })
  const lockName = `data-editor-table:recovery:${JSON.stringify([options.databaseName, workspace.id])}`
  const lockTask = navigator.locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { failed(new Error('This durable workspace already has an active owner.')); return }
    let db: IDBDatabase | null = null
    try {
      db = await database(options.databaseName)
      const activeDb = db, epoch = crypto.randomUUID(), listeners = new Set<(reason: string) => void>(), inflight = new Set<Promise<unknown>>()
      let active = true, releasing: Promise<void> | null = null
      const fence = (reason: string) => {
        if (!active) return
        active = false
        for (const listener of listeners) { try { listener(reason) } catch { /* Fencing other owners must still complete. */ } }
        listeners.clear()
      }
      const assertActive = () => { if (!active) throw new Error('The durable workspace lease has been released.') }
      const track = <T>(run: () => Promise<T>): Promise<T> => {
        try { assertActive() } catch (error) { return Promise.reject(error) }
        const promise = run(); inflight.add(promise)
        void promise.then(() => inflight.delete(promise), () => inflight.delete(promise))
        return promise
      }
      const transaction = async <T>(names: readonly string[], mode: IDBTransactionMode, run: (transaction: IDBTransaction) => Promise<T>): Promise<T> => {
        assertActive()
        const tx = activeDb.transaction([...names], mode, mode === 'readwrite' ? { durability: 'strict' } : {}), done = completed(tx)
        // Observe abort even when a request or semantic validation throws first.
        void done.catch(() => undefined)
        try { const result = await run(tx); await done; return result }
        catch (error) { try { tx.abort() } catch { /* The transaction may already have ended. */ } await done.catch(() => undefined); throw error }
      }
      const head = async (tx: IDBTransaction): Promise<Head> => {
        const value = await request(tx.objectStore('heads').get(workspace.id)) as Head | undefined
        if (!value || value.epoch !== epoch || !sameRecoveryValue(value.workspace, workspace)) {
          fence('Storage epoch no longer belongs to this workspace runtime.')
          throw new Error('Storage transaction was fenced by another workspace epoch.')
        }
        return value
      }
      await transaction(['heads'], 'readwrite', async tx => {
        const current = await request(tx.objectStore('heads').get(workspace.id)) as Head | undefined
        if (current && !sameRecoveryValue(current.workspace, workspace)) throw new Error('Workspace scope/schema/codec differs from the durable record.')
        await request(tx.objectStore('heads').put({ workspace, epoch, root: current?.root ?? null, checkpoint: current?.checkpoint ?? null } satisfies Head, workspace.id))
      })
      const release = (): Promise<void> => {
        if (releasing) return releasing
        fence('The durable storage session was released.')
        // Keep exclusion until every transaction/preparation that began under
        // this epoch has either committed or stopped. Never cancel by timeout.
        releasing = Promise.allSettled(inflight).then(() => { activeDb.close(); releaseLock() }).then(() => lockTask)
        return releasing
      }
      activeDb.onversionchange = () => { void release() }
      activeDb.onclose = () => { fence('The IndexedDB connection closed.'); releaseLock() }
      const session: IndexedDbRecoverySession = Object.freeze({
        lease: Object.freeze({ workspace, epoch }),
        onFence(listener) {
          if (!active) { listener('The durable storage session is already fenced.'); return () => {} }
          listeners.add(listener); return () => listeners.delete(listener)
        },
        release,
        checkpoints: Object.freeze({
          commit(raw: CheckpointWrite) {
            return track(async () => {
              const write = await validateCheckpointWrite(raw, workspace), { commit, checkpoint } = write
              if (commit.token.leaseEpoch !== epoch) throw new Error('Checkpoint belongs to another storage lease.')
              const contents: CheckpointTransport['contents'][number][] = []
              for (const content of checkpoint.contents) contents.push({ resourceId: content.resourceId, bytes: await Blob.prototype.arrayBuffer.call(content.blob) })
              const stored: StoredCheckpoint = { commit, snapshot: { format: 1, metadata: checkpoint.metadata, sha256: checkpoint.sha256, contents } }
              return transaction(['heads', 'checkpoints', 'checkpoint-outcomes'], 'readwrite', async tx => {
                const current = await head(tx), outcomes = tx.objectStore('checkpoint-outcomes'), key = checkpointKey(commit)
                const existing = await request(outcomes.get(key)) as CheckpointResult | undefined
                if (existing) { assertCheckpointResult(commit, existing); return existing }
                let result: CheckpointResult
                if (!sameRecoveryValue(commit.parent, current.checkpoint) || !checkpointMatchesRoot(write, current.root)) {
                  result = { kind: 'not-stored', commit, issue: { code: 'checkpoint-storage', message: 'The checkpoint head or semantic root changed.' } }
                } else {
                  if (current.checkpoint) {
                    const previousKey = JSON.stringify([current.checkpoint.workspaceId, current.checkpoint.leaseEpoch, current.checkpoint.id])
                    const previous = await request(tx.objectStore('checkpoints').get(previousKey)) as StoredCheckpoint | undefined
                    if (!previous) throw new Error('The replaced checkpoint head is missing.')
                    assertCheckpointReplacement(write, { commit: previous.commit, checkpoint: { metadata: previous.snapshot.metadata, sha256: previous.snapshot.sha256, contents: [] } })
                  }
                  await request(tx.objectStore('checkpoints').put(stored, key))
                  await request(tx.objectStore('heads').put({ ...current, checkpoint: commit.token } satisfies Head, workspace.id))
                  result = { kind: 'stored', commit, head: commit.token }
                }
                await request(outcomes.put(result, key))
                return result
              })
            })
          },
          lookup(raw: CheckpointCommit) {
            const commit = ownEncodedValue(raw) as unknown as CheckpointCommit
            return track(() => transaction(['heads', 'checkpoint-outcomes'], 'readwrite', async tx => {
              await head(tx); assertCheckpointCommit(commit, workspace)
              const outcomes = tx.objectStore('checkpoint-outcomes'), key = checkpointKey(commit)
              const existing = await request(outcomes.get(key)) as CheckpointResult | undefined
              if (existing) { assertCheckpointResult(commit, existing); return existing }
              const result: CheckpointResult = { kind: 'not-stored', commit, issue: { code: 'checkpoint-storage', message: 'This checkpoint token is permanently fenced from storing.' } }
              await request(outcomes.put(result, key)); return result
            }))
          },
          load() {
            return track(async () => {
              const stored = await transaction(['heads', 'checkpoints'], 'readonly', async tx => {
                const current = await head(tx)
                if (!current.checkpoint) return null
                const key = JSON.stringify([current.checkpoint.workspaceId, current.checkpoint.leaseEpoch, current.checkpoint.id])
                const record = await request(tx.objectStore('checkpoints').get(key)) as StoredCheckpoint | undefined
                if (!record || !sameRecoveryValue(record.commit.token, current.checkpoint)) throw new Error('Checkpoint head is missing its exact stored snapshot.')
                return record
              })
              if (!stored) return null
              const { snapshot, commit } = stored
              if (snapshot.format !== 1) throw new Error('Unsupported stored checkpoint transport.')
              const descriptors = new Map(snapshot.metadata.resources.manifest.entries.map(entry => [entry.descriptor.id, entry.descriptor]))
              const contents = snapshot.contents.map(content => {
                const descriptor = descriptors.get(content.resourceId)
                if (!descriptor || !(content.bytes instanceof ArrayBuffer)) throw new Error('Stored checkpoint bytes are missing or invalid.')
                return { resourceId: content.resourceId, blob: new Blob([content.bytes], { type: descriptor.mediaType }) }
              })
              const write: CheckpointWrite = { commit, checkpoint: { metadata: snapshot.metadata, sha256: snapshot.sha256, contents } }
              return validateCheckpointWrite(write, workspace)
            })
          },
        }),
        commit(raw) {
          return track(async () => {
            const { write } = await validateRecoveryWrite(raw, workspace), { record } = write, { commit } = record
            if (commit.token.leaseEpoch !== epoch) throw new Error('Candidate belongs to another storage lease.')
            // Prepare bytes before opening a transaction: Blob reads and
            // digests cannot keep an IndexedDB transaction alive.
            const contents = new Map<string, ArrayBuffer>()
            for (const content of write.contents) contents.set(content.resourceId, await Blob.prototype.arrayBuffer.call(content.blob))
            return transaction(stores, 'readwrite', async tx => {
              const current = await head(tx), outcomes = tx.objectStore('outcomes'), key = tokenKey(commit)
              const existing = await request(outcomes.get(key)) as RecoveryCommitResult | undefined
              if (existing) { assertRecoveryResult(commit, existing); return existing }
              let result: RecoveryCommitResult
              if (!sameRecoveryValue(commit.parent, current.root) || !sameRecoveryValue(record.checkpointParent, current.checkpoint)) result = negative(commit, 'The semantic or checkpoint parent changed; this candidate was not committed.')
              else {
                if (current.checkpoint) {
                  const key = JSON.stringify([current.checkpoint.workspaceId, current.checkpoint.leaseEpoch, current.checkpoint.id])
                  const stored = await request(tx.objectStore('checkpoints').get(key)) as StoredCheckpoint | undefined
                  if (!stored) throw new Error('The checkpoint being consumed is missing.')
                  assertCheckpointConsumption(record, { commit: stored.commit, checkpoint: { metadata: stored.snapshot.metadata, sha256: stored.snapshot.sha256, contents: [] } })
                }
                for (const entry of record.manifest.entries) {
                  await request(tx.objectStore('resources').put(contents.get(entry.descriptor.id)!, resourceKey(workspace, entry.descriptor.id, entry.sha256)))
                }
                await request(tx.objectStore('records').put(record, workspace.id))
                const root = recoveryRoot(commit)
                await request(tx.objectStore('heads').put({ ...current, root, checkpoint: null } satisfies Head, workspace.id))
                result = { kind: 'committed', commit, root }
              }
              await request(outcomes.put(result, key))
              return result
            })
          })
        },
        lookup(raw) {
          const commit = ownEncodedValue(raw) as unknown as PreparedStorageCommit
          return track(() => transaction(['heads', 'outcomes'], 'readwrite', async tx => {
            await head(tx)
            if (!sameRecoveryValue(commit.workspace, workspace) || commit.token.workspaceId !== workspace.id) throw new Error('Lookup belongs to another workspace.')
            const outcomes = tx.objectStore('outcomes'), key = tokenKey(commit), existing = await request(outcomes.get(key)) as RecoveryCommitResult | undefined
            if (existing) { assertRecoveryResult(commit, existing); return existing }
            const result = negative(commit, 'This token is permanently fenced from committing.')
            await request(outcomes.put(result, key))
            return result
          }))
        },
        load() {
          return track(() => transaction(['heads', 'records', 'resources'], 'readonly', async tx => {
            const current = await head(tx)
            if (!current.root) return null
            const record = await request(tx.objectStore('records').get(workspace.id)) as RecoveryRecord | undefined
            if (!record || !sameRecoveryValue(recoveryRoot(record.commit), current.root)) throw new Error('Durable root is missing its exact semantic record.')
            const contents: { resourceId: typeof record.manifest.entries[number]['descriptor']['id']; blob: Blob }[] = []
            for (const entry of record.manifest.entries) {
              const bytes = await request(tx.objectStore('resources').get(resourceKey(workspace, entry.descriptor.id, entry.sha256))) as ArrayBuffer | undefined
              if (!(bytes instanceof ArrayBuffer)) throw new Error('Durable root is missing referenced resource bytes.')
              contents.push({ resourceId: entry.descriptor.id, blob: new Blob([bytes], { type: entry.descriptor.mediaType }) })
            }
            return { record, contents }
          }))
        },
      })
      acquired(session)
      await lifetime
    } catch (error) { db?.close(); failed(error) }
  }).catch(failed)
  return ready
}
