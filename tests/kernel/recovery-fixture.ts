import type { PreparedStorageCommit, RecoveryCommitResult, WorkspaceIdentity } from '../../src/kernel/model.js'
import type { RecoveryWrite } from '../../src/kernel/recovery-store.js'
import type { CheckpointCommit, CheckpointRecoverySession, CheckpointResult, CheckpointWrite } from '../../src/kernel/checkpoint-store.js'

// Independent transactional storage oracle. No production reducer, digest,
// resource, root or receipt validator is imported here.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
const failure = (commit: PreparedStorageCommit, message: string): RecoveryCommitResult => ({ kind: 'not-committed', commit, issue: { code: 'storage-fixture', message } })

export class RecoveryFixture {
  #epoch = 0
  #active = ''
  #listeners = new Set<(reason: string) => void>()
  #root: RecoveryWrite | null = null
  #outcomes = new Map<string, RecoveryCommitResult>()
  #checkpoint: CheckpointWrite | null = null
  #checkpointOutcomes = new Map<string, CheckpointResult>()
  readonly checkpointWrites: CheckpointWrite[] = []
  readonly checkpointQueries: CheckpointCommit[] = []
  beforeCheckpointCommit: ((write: CheckpointWrite) => Promise<void>) | null = null
  loseCheckpointResponse = false
  rejectNextCheckpoint = false
  readonly writes: RecoveryWrite[] = []
  readonly queries: PreparedStorageCommit[] = []
  beforeCommit: ((write: RecoveryWrite) => Promise<void>) | null = null
  loseResponse = false
  rejectNext = false
  corruptResponse: ((result: RecoveryCommitResult) => RecoveryCommitResult) | null = null

  constructor(readonly workspace: WorkspaceIdentity) {}
  get root() { return this.#root ? structuredClone(this.#root) : null }
  get checkpoint() { return this.#checkpoint ? structuredClone(this.#checkpoint) : null }

  acquire(): CheckpointRecoverySession {
    for (const listener of this.#listeners) listener('Another fixture lease was acquired')
    this.#listeners.clear()
    const epoch = `lease:${++this.#epoch}`
    this.#active = epoch
    const assertLease = () => { if (epoch !== this.#active) throw new Error('Lease is fenced') }
    return {
      lease: { workspace: this.workspace, epoch },
      onFence: listener => { this.#listeners.add(listener); return () => this.#listeners.delete(listener) },
      load: async () => { assertLease(); return this.root },
      release: async () => {
        if (epoch !== this.#active) return
        this.#active = ''
        for (const listener of this.#listeners) listener('Fixture lease released')
        this.#listeners.clear()
      },
      checkpoints: {
        load: async () => { assertLease(); return this.checkpoint },
        lookup: async raw => {
          assertLease()
          const commit = structuredClone(raw), key = canonical([commit.token.workspaceId, commit.token.leaseEpoch, commit.token.id])
          if (!same(commit.workspace, this.workspace) || commit.token.workspaceId !== this.workspace.id) throw new Error('Wrong checkpoint lookup workspace')
          this.checkpointQueries.push(commit)
          const existing = this.#checkpointOutcomes.get(key)
          if (existing && !same(existing.commit, commit)) throw new Error('Checkpoint identity reused for another request')
          const result: CheckpointResult = existing ?? { kind: 'not-stored', commit, issue: { code: 'checkpoint-fixture', message: 'Checkpoint token permanently fenced' } }
          this.#checkpointOutcomes.set(key, result)
          return structuredClone(result)
        },
        commit: async raw => {
          const write = structuredClone(raw), { commit, checkpoint } = write
          this.checkpointWrites.push(write)
          if (this.beforeCheckpointCommit) await this.beforeCheckpointCommit(write)
          assertLease()
          if (commit.token.leaseEpoch !== epoch || !same(commit.workspace, this.workspace)) throw new Error('Wrong checkpoint lease or workspace')
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(checkpoint.metadata)))
          const hash = `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
          if (hash !== checkpoint.sha256 || hash !== commit.token.sha256 || checkpoint.metadata.ticket.leaseEpoch !== epoch) throw new Error('Invalid checkpoint hash or epoch')
          for (const entry of checkpoint.metadata.resources.manifest.entries) {
            const content = checkpoint.contents.find(content => content.resourceId === entry.descriptor.id)
            if (!content || content.blob.size !== entry.descriptor.size) throw new Error('Missing checkpoint bytes')
            const digest = await crypto.subtle.digest('SHA-256', await content.blob.arrayBuffer())
            if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== entry.sha256) throw new Error('Corrupt checkpoint bytes')
          }
          assertLease()
          const key = canonical([commit.token.workspaceId, commit.token.leaseEpoch, commit.token.id])
          let result = this.#checkpointOutcomes.get(key)
          if (result && !same(result.commit, commit)) throw new Error('Checkpoint identity reused for another request')
          if (!result) {
            const root = this.#root ? { token: this.#root.record.commit.token, revision: this.#root.record.commit.semanticRevision } : null
            const storage = checkpoint.metadata.storage
            const current = storage.kind === 'durable' && (same(storage.root, root) || Boolean(storage.pending && same({ token: storage.pending.commit.token, revision: storage.pending.commit.semanticRevision }, root)))
            if (this.rejectNextCheckpoint || !current || !same(commit.parent, this.#checkpoint?.commit.token ?? null)) {
              this.rejectNextCheckpoint = false
              result = { kind: 'not-stored', commit, issue: { code: 'checkpoint-fixture', message: 'Checkpoint CAS failed' } }
            } else {
              if (this.#checkpoint) {
                const before = this.#checkpoint.checkpoint.metadata.ingress.snapshot, after = checkpoint.metadata.ingress.snapshot
                if (after.generation < before.generation || before.pending.some(entry => !after.pending.some(next => next.id === entry.id && same(next.payload, entry.payload)) && !after.receipts.some(receipt => receipt.id === entry.id))
                  || before.receipts.some(receipt => !after.receipts.some(next => same(next, receipt)))) throw new Error('Replacement drops checkpoint ownership')
              }
              this.#checkpoint = write
              result = { kind: 'stored', commit, head: commit.token }
            }
            this.#checkpointOutcomes.set(key, result)
          }
          if (this.loseCheckpointResponse) { this.loseCheckpointResponse = false; throw new Error('Checkpoint acknowledgement lost') }
          return structuredClone(result)
        },
      },
      lookup: async commit => {
        assertLease(); this.queries.push(structuredClone(commit))
        if (!same(commit.workspace, this.workspace)) throw new Error('Wrong lookup workspace')
        const key = canonical(commit.token), found = this.#outcomes.get(key)
        // Atomically record an immutable negative proof. A request that was
        // delayed before its transaction may no longer commit after lookup.
        const result = found ?? failure(commit, 'Token is permanently not committed')
        this.#outcomes.set(key, result)
        return structuredClone(this.corruptResponse?.(result) ?? result)
      },
      commit: async raw => {
        const write = structuredClone(raw), { commit } = write.record
        this.writes.push(write)
        if (this.beforeCommit) await this.beforeCommit(write)
        assertLease()
        if (commit.token.leaseEpoch !== epoch || !same(commit.workspace, this.workspace)) throw new Error('Wrong commit epoch or workspace')
        const key = canonical(commit.token)
        let result = this.#outcomes.get(key)
        if (!result) {
          const token = { ...commit.token }; delete (token as Partial<typeof token>).candidateHash
          const payload = { ...write.record, commit: { ...commit, token } }
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload)))
          const hash = `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
          if (hash !== commit.token.candidateHash) throw new Error('Invalid candidate hash')
          for (const entry of write.record.manifest.entries) {
            const content = write.contents.find(content => content.resourceId === entry.descriptor.id)
            if (!content || content.blob.size !== entry.descriptor.size) throw new Error('Missing resource content')
            const bytes = await crypto.subtle.digest('SHA-256', await content.blob.arrayBuffer())
            const hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
            if (hash !== entry.sha256) throw new Error('Invalid resource digest')
          }
          // All awaits precede the transaction. This final section is the
          // oracle's atomic lease check + root CAS + bytes/record/outcome write.
          assertLease()
          result = this.#outcomes.get(key)
          if (!result) {
            const parent = this.#root ? { token: this.#root.record.commit.token, revision: this.#root.record.commit.semanticRevision } : null
            if (this.rejectNext || !same(parent, commit.parent) || !same(write.record.checkpointParent, this.#checkpoint?.commit.token ?? null)) {
              this.rejectNext = false; result = failure(commit, 'Storage transaction was not committed')
            } else {
              if (this.#checkpoint) {
                const before = this.#checkpoint.checkpoint.metadata.ingress.snapshot, after = write.record.ingress?.snapshot
                if (!after || before.pending.some(entry => !after.pending.some(next => next.id === entry.id && same(next.payload, entry.payload)) && !after.receipts.some(receipt => receipt.id === entry.id))
                  || before.receipts.some(receipt => !after.receipts.some(next => same(next, receipt)))) throw new Error('Checkpoint ownership missing from semantic commit')
              }
              this.#root = write
              this.#checkpoint = null
              result = { kind: 'committed', commit, root: { token: commit.token, revision: commit.semanticRevision } }
            }
            this.#outcomes.set(key, result)
          }
        }
        if (this.loseResponse) { this.loseResponse = false; throw new Error('Storage acknowledgement lost') }
        return structuredClone(this.corruptResponse?.(result) ?? result)
      },
    }
  }
}
