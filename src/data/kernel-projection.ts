import { GridOperationTargets } from './operation-targets.js'
import { encodedValuesEqual } from '../kernel/document.js'
import { projectHistory, type HistoryProjection } from '../kernel/history.js'
import type { Document, EntityId } from '../kernel/model.js'
import { projectKernel, type KernelProjection, type RowProjection } from '../kernel/projection.js'
import { decodeRow } from '../kernel/schema.js'
import type { KernelState } from '../kernel/state.js'
import type { GridRowKey } from '../model/grid-model.js'
import type { GridCompiledDocumentModel } from './runtime-columns.js'

export type GridKernelProjectedRow<Row, RowKey extends GridRowKey> = Readonly<{
  entityId: EntityId
  rowKey: RowKey
  row: Row
  authority: Row | null
  data: RowProjection
}>

/** These rows and history capabilities are output only. The command compiler
 * consumes immutable kernel documents, never this decoded display cache. */
export type GridKernelDataProjection<Row, RowKey extends GridRowKey> = Readonly<{
  revision: number
  targets: GridOperationTargets<Row, RowKey>
  rows: readonly Row[]
  baselineRows: readonly Row[]
  byId: ReadonlyMap<EntityId, GridKernelProjectedRow<Row, RowKey>>
  byKey: ReadonlyMap<RowKey, GridKernelProjectedRow<Row, RowKey>>
  data: KernelProjection
  history: HistoryProjection
  persistence: KernelState['persistence']
}>

export function createGridKernelProjector<Row, RowKey extends GridRowKey>(
  model: GridCompiledDocumentModel<Row>,
  getRowKey: (row: Row) => RowKey,
): (state: KernelState) => GridKernelDataProjection<Row, RowKey> {
  let previousRows: readonly Row[] = Object.freeze([])
  const snapshots = new WeakMap<KernelState, GridKernelDataProjection<Row, RowKey>>()
  type CachedRow = Readonly<{ document: Document; row: Row; rowKey: RowKey }>
  let documents = new Map<EntityId, Readonly<{ preview: CachedRow | null; authority: CachedRow | null }>>()
  const decode = (document: Document | null, prior: CachedRow | null | undefined): CachedRow | null => {
    if (!document) return null
    if (prior && encodedValuesEqual(document, prior.document)) return prior
    const row = decodeRow(model.codec, document)
    if (typeof row === 'object' && row !== null) Object.freeze(row)
    return Object.freeze({ document, row, rowKey: getRowKey(model.codec.copy(row)) })
  }
  return (state) => {
    const cached = snapshots.get(state)
    if (cached) return cached
    const data = projectKernel(state, model.schema)
    const next = new Map<EntityId, Readonly<{ preview: CachedRow | null; authority: CachedRow | null }>>()
    const byId = new Map<EntityId, GridKernelProjectedRow<Row, RowKey>>()
    const byKey = new Map<RowKey, GridKernelProjectedRow<Row, RowKey>>()
    for (const entry of data.rows) {
      const previous = documents.get(entry.entityId)
      const preview = decode(entry.preview, previous?.preview), authority = decode(entry.authority, previous?.authority)
      next.set(entry.entityId, { preview, authority })
      // A removed row's intent/recovery remains in data.rows even when there is
      // no display document. Never infer deletion acceptance from this list.
      if (!preview) continue
      const entity = Object.freeze({
        entityId: entry.entityId, rowKey: preview.rowKey, row: preview.row,
        authority: authority?.row ?? null, data: entry,
      })
      byId.set(entry.entityId, entity)
      // A local creation collision shows the retained input. Both lifetimes
      // remain addressable by entity ID for recovery and authority checks.
      const prior = byKey.get(entity.rowKey)
      if (!prior || entry.issues.length && !prior.data.issues.length) byKey.set(entity.rowKey, entity)
    }
    const shown = new Set<RowKey>(), rows: Row[] = []
    for (const id of [...data.order.preview, ...data.rows.filter(row => row.issues.length).map(row => row.entityId)]) {
      const candidate = byId.get(id), entry = candidate && byKey.get(candidate.rowKey)
      if (!entry || shown.has(entry.rowKey) || entry.data.existence === 'pending-delete' && !entry.data.issues.length) continue
      shown.add(entry.rowKey); rows.push(entry.row)
    }
    if (rows.length !== previousRows.length || rows.some((row, index) => row !== previousRows[index])) previousRows = Object.freeze(rows)
    // A pending delete has no visible preview, but its baseline remains
    // available until authority actually removes the row.
    const baselineRows = data.order.authority.map(id => next.get(id)!.authority!.row)
    const result = Object.freeze({ revision: state.revision, targets: new GridOperationTargets(byKey, byId, model.identityPath), rows: previousRows, baselineRows: Object.freeze(baselineRows), byId, byKey,
      data, history: projectHistory(state), persistence: state.persistence,
    })
    documents = next; snapshots.set(state, result)
    return result
  }
}
