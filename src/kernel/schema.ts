import { encodedValuesEqual, ownDocument, ownEncodedValue, pathsOverlap } from './document.js'
import type { CodecVersion, Document, EntityId, FieldId, KernelIssue, SchemaVersion, StoragePath, WorkspaceIdentity } from './model.js'

export type SchemaField = Readonly<{ id: FieldId; path: StoragePath; readonly: boolean }>
/** This definition is owned once by Workspace, outside its serializable state.
 * validate must be deterministic and pure for this version. It never prepares
 * edits or performs I/O. Changing its meaning requires a new schema version.
 */
export type KernelSchema = Readonly<{
  version: SchemaVersion
  codec: CodecVersion
  fields: readonly SchemaField[]
  validate(document: Document, context: Readonly<{ entityId: EntityId; mutation: 'create' | 'update' }>): readonly KernelIssue[]
}>

export function defineKernelSchema(schema: KernelSchema): KernelSchema {
  const metadata = ownEncodedValue({ version: schema.version, codec: schema.codec, fields: schema.fields }) as unknown as Omit<KernelSchema, 'validate'>
  if (!metadata.version || !metadata.codec || typeof schema.validate !== 'function') throw new Error('A schema requires fixed versions and a pure validator.')
  const ids = new Set<string>()
  for (let index = 0; index < metadata.fields.length; index++) {
    const field = metadata.fields[index]!
    if (!field.id || ids.has(field.id) || typeof field.readonly !== 'boolean' || !field.path.length || field.path.some(segment => typeof segment !== 'string'))
      throw new Error('Fields require unique identities, explicit mutability and storage paths.')
    if (metadata.fields.slice(0, index).some(previous => pathsOverlap(previous.path, field.path)))
      throw new Error('Overlapping field bindings must share one storage field identity.')
    ids.add(field.id)
  }
  return Object.freeze({ ...metadata, validate: schema.validate })
}

export function assertKernelSchema(workspace: WorkspaceIdentity, schema: KernelSchema) {
  if (workspace.schema !== schema.version || workspace.codec !== schema.codec) throw new Error('Schema and codec must match the fixed workspace versions.')
}

/** copy and equals must preserve the complete business row, including custom
 * values. They are part of the explicit codec contract, not inferred from JSON.
 * copy must return an independent value; a malicious aliasing copy cannot be
 * made safe for arbitrary host classes by the kernel.
 */
export type DocumentCodec<Row> = Readonly<{
  version: CodecVersion
  copy(row: Row): Row
  equals(left: Row, right: Row): boolean
  encode(row: Row): unknown
  decode(document: Document): Row
}>

function copyRow<Row>(codec: DocumentCodec<Row>, row: Row): Row {
  const copy = codec.copy(row)
  if (typeof row === 'object' && row !== null && copy === row) throw new Error('A codec copy must own the business row independently.')
  return copy
}

export function encodeRow<Row>(codec: DocumentCodec<Row>, row: Row): Document {
  if (!codec.version) throw new Error('A document codec requires a stable version.')
  const owned = copyRow(codec, row), before = copyRow(codec, owned)
  const document = ownDocument(codec.encode(owned))
  if (!codec.equals(owned, before)) throw new Error('The codec mutated its input row.')
  if (!encodedValuesEqual(document, ownDocument(codec.encode(copyRow(codec, before))))) throw new Error('The codec encoding is not deterministic.')
  const decoded = codec.decode(document)
  if (!codec.equals(before, decoded) || !encodedValuesEqual(document, ownDocument(codec.encode(copyRow(codec, decoded)))))
    throw new Error('The codec cannot round-trip this row losslessly.')
  return document
}

export function decodeRow<Row>(codec: DocumentCodec<Row>, document: Document): Row {
  const owned = ownDocument(document), row = codec.decode(owned)
  if (!encodedValuesEqual(owned, encodeRow(codec, row))) throw new Error('Decoding would discard or change stored fields.')
  return copyRow(codec, row)
}

export function documentCodec(version: CodecVersion): DocumentCodec<Document> {
  return Object.freeze({ version, copy: ownDocument, equals: encodedValuesEqual, encode: ownDocument, decode: ownDocument })
}
