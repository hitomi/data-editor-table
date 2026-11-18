import { expect, it } from 'vitest'
import { persistenceGateway } from './gateway.js'
import { kernelId } from './model.js'
import type { PersistenceSource, ServerAuthority } from './source.js'

it('releases read documents while retaining shared version and content evidence', async () => {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('rows'), epoch: kernelId<'scope-epoch'>('1') }
  const identity = { key: 1, incarnation: 'first' }
  const authority = (position: string, name: string): ServerAuthority => ({
    scope, observation: kernelId<'observation'>(crypto.randomUUID()),
    version: { kind: 'ordered', position, token: position }, order: [identity],
    rows: [{ identity, document: { name } }],
  })
  let remote = authority('2', 'current')
  const source: PersistenceSource = {
    id: scope.sourceId,
    capabilities: { atomicScopeWrites: true, authorityOrder: 'ordered', durableOperationLookup: true,
      identity: 'incarnation', operationIdFence: 'scope-epoch', operationRetentionMs: 1000, restoreDeleted: false },
    readAtLeast: async () => remote,
    submit: async () => { throw Error('unexpected write') },
    lookupOperation: async () => { throw Error('unexpected lookup') },
  }
  const readDocument = async () => {
    const snapshot = await persistenceGateway(source).readAtLeast(scope, [])
    return new WeakRef(snapshot.rows[0]!.document)
  }
  const weak = await readDocument()
  // A WeakRef target is kept alive until the end of its current JS job.
  await new Promise(resolve => setTimeout(resolve, 0))
  const gc = (globalThis as typeof globalThis & { gc(): void }).gc
  gc()
  expect(weak.deref()).toBeUndefined()

  const reopened = persistenceGateway({ ...source })
  expect(reopened.frontier(scope)).toEqual([remote.version])
  remote = authority('1', 'older')
  await expect(reopened.readAtLeast(scope, [])).rejects.toThrow(/frontier/)
  remote = authority('2', 'contradiction')
  await expect(reopened.readAtLeast(scope, [])).rejects.toThrow(/inconsistent/)
  remote = authority('2', 'current')
  await expect(reopened.readAtLeast(scope, [])).resolves.toEqual(remote)
})
