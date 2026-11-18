import { applyDocumentPatches, encodedValuesEqual } from '../kernel/document.js'
import type { EntityId, StoragePath } from '../kernel/model.js'
import type { GridRowKey, GridTargetDependency } from '../model/grid-model.js'
import { GridIssueError } from '../model/grid-result.js'
import type { GridKernelProjectedRow } from './kernel-projection.js'

/** Row keys address the current view. A deferred operation keeps the entity
 * chosen there and resolves it again in the current projection before use. */
export class GridOperationTargets<Row, Key extends GridRowKey> {
  constructor(private readonly byKey: ReadonlyMap<Key, GridKernelProjectedRow<Row, Key>>,
    private readonly byId: ReadonlyMap<EntityId, GridKernelProjectedRow<Row, Key>>,
    private readonly identityPath: StoragePath | undefined) {}

  readonly entityAt = (rowKey: Key) => this.byKey.get(rowKey)?.entityId

  locate(entityId: EntityId) {
    const row = this.byId.get(entityId)
    return row && this.entityAt(row.rowKey) === entityId ? row : undefined
  }

  live(entityId: EntityId) {
    const row = this.locate(entityId)
    return row?.data.existence === 'present' || row?.data.existence === 'local-create' ? row : undefined
  }

  capture(rowKey: Key, expected = this.entityAt(rowKey)): GridTargetDependency<Key> {
    const row = expected && this.live(expected)
    if (!row || row.rowKey !== rowKey || !row.data.preview)
      throw new GridIssueError({ code: 'stale-target', message: 'The original row was removed or replaced. Your input is retained.' })
    return Object.freeze({ entityId: row.entityId, rowKey, document: row.data.preview })
  }

  unchanged(target: GridTargetDependency<Key>) {
    const row = this.live(target.entityId)
    if (!row?.data.preview) return undefined
    const expected = this.identityPath && target.rowKey !== row.rowKey
      ? applyDocumentPatches(target.document, [{ kind: 'set', path: this.identityPath, value: row.rowKey }])
      : target.document
    return encodedValuesEqual(expected, row.data.preview) ? row : undefined
  }
}
