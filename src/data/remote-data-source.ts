import type { GridCellTypeSchema, GridColumnForCellTypes } from '../cell-types/contracts.js'
import type { StandardGridCellTypeSchema } from '../cell-types/standard-contracts.js'
import type { GridColumn, GridRowKey, GridPersistenceMode } from '../model/grid-model.js'
import { kernelId, type ScopeIdentity } from '../kernel/model.js'
import type { DefinitiveResult, ScopeDispute, ScopeDisputeEvent } from '../kernel/scope-disputes.js'
import type { PersistenceSource, ServerAuthority } from '../kernel/source.js'
import { assertGridKernelSource, type GridKernelDataSource } from './kernel-data-source.js'
import { createGridAuthoritySync } from './grid-authority-sync.js'
import { plainGridRowCodec, type GridDocumentModel } from './grid-document.js'
import type { GridRowCapabilities } from './data-source.js'

export type CreateRemoteGridDataSourceOptions<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema> = Readonly<{
  columns: readonly GridColumnForCellTypes<Row, Schema>[]
  getRowKey(row: Row): RowKey
  scope: ScopeIdentity
  source: PersistenceSource
  model: GridDocumentModel<Row>
  initialAuthority?: ServerAuthority
  subscribe?: (listener: (authority: ServerAuthority) => void) => () => void
  rows?: GridRowCapabilities<Row>
  persistence: Readonly<{ mode: GridPersistenceMode; debounceMs?: number }>
}>
export type RemoteGridDataSource<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema> = GridKernelDataSource<Row, RowKey, Schema> & Readonly<{
  publish(authority: ServerAuthority): void
  getDispute(id?: string): ScopeDispute | null
  subscribeDisputes(listener: (event: ScopeDisputeEvent) => void): () => void
  resolveDispute(id: string, result: DefinitiveResult): void
}>

/** Bind a real authority protocol to the existing product. This adapter never
 * manufactures a version/receipt from HTTP success or proposed display rows. */
export function createRemoteGridDataSource<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema = StandardGridCellTypeSchema>(
  options: CreateRemoteGridDataSourceOptions<Row, RowKey, NoInfer<Schema>>,
): RemoteGridDataSource<Row, RowKey, Schema> {
  assertGridKernelSource(options.source, options.scope)
  return Object.freeze({
    ...createGridAuthoritySync(options), columns: options.columns, getRowKey: options.getRowKey, model: options.model,
    scope: options.scope, source: options.source, persistence: options.persistence,
    ...(options.rows ? { rows: options.rows } : {}), cloneRow: options.model.codec.copy.bind(options.model.codec),
  })
}

/** Field helpers carry explicit storage paths. Custom getters/setters must
 * supply their own model; a column label/key is never guessed to be a path. */
export function createFieldGridDocumentModel<Row extends object>(
  columns: readonly (Pick<GridColumn<Row>, 'key' | 'storagePath' | 'getValue'> & Pick<GridColumn<Row, never>, 'setValue'>)[], version = '1',
): GridDocumentModel<Row> {
  const fields = new Map<string, { id: ReturnType<typeof kernelId<'field'>>; path: readonly [string, ...string[]]; readonly: boolean }>()
  const bindings = columns.flatMap(column => {
    if (!column.storagePath) {
      if (column.setValue) throw new Error(`Column "${column.key}" requires an explicit document model.`)
      return []
    }
    const path = Object.freeze([...column.storagePath]) as readonly [string, ...string[]]
    const key = JSON.stringify(path), existing = fields.get(key)
    const field = existing ?? { id: kernelId<'field'>(key), path, readonly: !column.setValue }
    if (column.setValue) field.readonly = false
    fields.set(key, field)
    return [{ columnKey: column.key, fieldIds: [field.id] }]
  })
  return Object.freeze({ version: kernelId<'schema-version'>(version), codec: plainGridRowCodec<Row>(kernelId<'codec-version'>(version)),
    fields: Object.freeze([...fields.values()].map(field => Object.freeze(field))), columns: Object.freeze(bindings),
  })
}

export function createGridIdempotencyHeaders(operationId: string, headerName = 'Idempotency-Key'): Readonly<Record<string, string>> {
  if (!operationId || !headerName) throw new Error('An idempotency header requires an operation and header name.')
  return Object.freeze({ [headerName]: operationId })
}
