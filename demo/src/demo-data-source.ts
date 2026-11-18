import { createRemoteGridDataSource, createFieldGridDocumentModel,
  type GridCellTypeSchema, type GridColumnForCellTypes, type GridDataSourceSnapshot, type GridPersistenceMode,
  type GridRowCapabilities, type GridRowKey,
} from 'data-editor-table'
import { kernelId, ownDocument, type PersistenceSource, type ServerAuthority, type Document } from 'data-editor-table/protocol'
import { openDemoSource } from './demo-source'

/** The database is this demo's actual authority. Rows, version and exact
 * operation outcomes commit together; this is not a frontend shim over HTTP. */
export function createDemoGridSource<Row extends { id: GridRowKey }, Schema extends GridCellTypeSchema>(options: {
  name: string; columns: readonly GridColumnForCellTypes<Row, Schema>[]; initialRows: readonly Row[];
  persistence: { mode: GridPersistenceMode; debounceMs?: number }; rows?: GridRowCapabilities<Row>; delay?: number
}) {
  const scope = { sourceId: `data-editor-original-ui:${options.name}`, id: kernelId<'scope'>('rows'), epoch: kernelId<'scope-epoch'>('1') }
  const listeners = new Set<() => void>()
  const store = {
    snapshot: { rows: options.initialRows, version: 0, status: 'ready', scope: { kind: 'complete' } } as GridDataSourceSnapshot<Row>,
    nextId: options.initialRows.length + 1, failNextSave: false, saveCount: 0,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const notify = () => { for (const listener of listeners) listener() }
  const opened = openDemoSource(scope, options.initialRows.map(ownDocument), document => {
    if (typeof document.id !== 'string' && typeof document.id !== 'number') throw new Error('A row needs a stable id.')
  }, Boolean(options.rows), document => options.rows?.canDelete?.(structuredClone(document) as Row) ?? false)
  const seen = new Set<string>()
  const receive = (authority: ServerAuthority) => {
    store.snapshot = { rows: Object.freeze(authority.rows.map(row => structuredClone(row.document) as Row)), version: Number(authority.version.kind === 'ordered' ? authority.version.position : 0),
      status: 'ready', scope: { kind: 'complete' } }
    dataSource.publish(authority); notify(); return authority
  }
  const source: PersistenceSource = {
    id: scope.sourceId,
    capabilities: { atomicScopeWrites: true, durableOperationLookup: true, operationIdFence: 'scope-epoch', authorityOrder: 'ordered',
      identity: 'incarnation', operationRetentionMs: 3_600_000, restoreDeleted: Boolean(options.rows) },
    readAtLeast: async (scope, frontier) => receive(await (await opened).readAtLeast(scope, frontier)),
    submit: async submission => {
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay))
      const authority = await opened
      if (store.failNextSave) { store.failNextSave = false; authority.failNextSave() }
      const result = await authority.submit(submission)
      if (result.kind === 'applied' && !seen.has(submission.operationId)) {
        seen.add(submission.operationId); store.saveCount++; notify()
      }
      return result
    },
    lookupOperation: async ref => (await opened).lookupOperation(ref),
  }
  const dataSource = createRemoteGridDataSource<Row, Row['id'], Schema>({ columns: options.columns, getRowKey: row => row.id,
    model: { ...createFieldGridDocumentModel(options.columns), identityPath: ['id'] }, scope, source, persistence: options.persistence,
    ...(options.rows ? { rows: options.rows } : {}),
  })
  const changeRow = async (key: Row['id'], change: (row: Row) => Row) => {
    const authority = await opened, snapshot = await authority.readAtLeast(scope, [])
    const row = snapshot.rows.find(row => row.identity.key === key)
    if (!row) throw new Error('The remote row no longer exists.')
    await authority.changeDocument(row.identity, document => ownDocument(change(structuredClone(document) as Row)) as Document)
    receive(await authority.readAtLeast(scope, []))
  }
  return { dataSource, store, changeRow }
}
