import type { GridCellTypeSchema, GridColumnForCellTypes } from '../cell-types/contracts.js'
import type { AuthorityFrontier, AuthorityVersion, ScopeIdentity } from '../kernel/model.js'
import type { PersistenceSource, ServerAuthority } from '../kernel/source.js'
import type { GridPersistenceMode, GridRowKey } from '../model/grid-model.js'
import type { GridRowCapabilities } from './data-source.js'
import type { GridDocumentModel } from './grid-document.js'

import type { AuthorityDelivery } from '../kernel/scope-authority.js'
export type { AuthorityDelivery as GridAuthorityDelivery } from '../kernel/scope-authority.js'

export type GridAuthorityReader = Readonly<{
  /** Resolves with the admitted version after delivery. Rows arrive only by subscription. */
  readAtLeast(required: AuthorityFrontier): Promise<AuthorityVersion>
  /** Synchronously replays the usable snapshot and any outstanding frontier, then follows the scope. */
  subscribe(listener: (event: AuthorityDelivery) => void): () => void
}>

/** The controller's only authority source. Opaque row-cache versions and
 * success callbacks cannot substitute for ordered server evidence. */
export type GridKernelDataSource<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema> = GridAuthorityReader & Readonly<{
  columns: readonly GridColumnForCellTypes<Row, Schema>[]
  getRowKey(row: Row): RowKey
  model: GridDocumentModel<Row>
  scope: ScopeIdentity
  source: PersistenceSource
  getSnapshot(): ServerAuthority | undefined
  cloneRow: (row: Row) => Row
  persistence: Readonly<{ mode: GridPersistenceMode; debounceMs?: number }>
  rows?: GridRowCapabilities<Row>
}>

export function assertGridKernelSource(source: PersistenceSource, scope: ScopeIdentity): void {
  const capability = source.capabilities
  if (!source.id || source.id !== scope.sourceId || !scope.id || !scope.epoch)
    throw new Error('A kernel source requires its actual source, scope and epoch identities.')
  if (capability.atomicScopeWrites !== true || capability.durableOperationLookup !== true
    || capability.operationIdFence !== 'scope-epoch'
    || (capability.authorityOrder !== 'ordered' && capability.authorityOrder !== 'causal')
    || (capability.identity !== 'incarnation' && capability.identity !== 'no-key-reuse-in-epoch')
    || !Number.isSafeInteger(capability.operationRetentionMs) || capability.operationRetentionMs <= 0
    || typeof capability.restoreDeleted !== 'boolean')
    throw new Error('The source must explicitly guarantee atomic writes, operation lookup, version evidence and identity lifetimes.')
  if (typeof source.readAtLeast !== 'function' || typeof source.submit !== 'function' || typeof source.lookupOperation !== 'function')
    throw new Error('The source must implement authority reads, exact submission and operation lookup.')
}
