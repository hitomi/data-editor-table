import { Workspace, kernelId, defineKernelSchema, prepareRowAction, type PersistenceSource, type WorkspaceOptions } from 'data-editor-table/engine'

export const schema = defineKernelSchema({ version: kernelId<'schema-version'>('products-v1'), codec: kernelId<'codec-version'>('json-v1'),
  fields: [{ id: kernelId<'field'>('name'), path: ['name'], readonly: false }], validate: () => [] })
export function createEditor(source: PersistenceSource) {
  const options: WorkspaceOptions = { source, scope: { sourceId: source.id, id: kernelId<'scope'>('products'), epoch: kernelId<'scope-epoch'>('v1') }, schema,
    policy: { version: kernelId<'policy-version'>('v1'), create: true, order: true, defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [] } }
  return new Workspace(options)
}
export const prepare = prepareRowAction
// @ts-expect-error Entity identity cannot substitute for a field identity.
const invalidField: typeof schema.fields[number]['id'] = kernelId<'entity'>('row')
void invalidField
// @ts-expect-error Backends must guarantee exact operation lookup.
const unsupported: PersistenceSource['capabilities']['durableOperationLookup'] = false
void unsupported
