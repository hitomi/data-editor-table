import type { ServerAuthority } from '../kernel/source.js'
import type { GridRowKey } from '../model/grid-model.js'
import { encodedValuesEqual, ownDocument } from '../kernel/document.js'
import type { CodecVersion, FieldId, KernelIssue, Patch, ResourceValue, SchemaVersion, StoragePath } from '../kernel/model.js'
import { decodeRow, type DocumentCodec, type SchemaField } from '../kernel/schema.js'
import type { GridInputCodec } from '../cell-types/input-codec.js'

/** Paths address the encoded document, never a display column key. Aliased
 * columns name the same field IDs from the model's single field declaration. */
export type GridDocumentColumnBinding = Readonly<{
  columnKey: string
  fieldIds: readonly FieldId[]
  /** Needed only for parsed custom values outside the encoded-value domain. */
  valueCodec?: GridInputCodec<unknown>
  /** Optional explicit planner. The old setter is not called when supplied.
   * Reads made by this planner are captured. Legacy row-aware validators still
   * require a conservative complete-row dependency. */
  planEdit?: (
    context: Readonly<{ read(path: StoragePath): ResourceValue }>,
    value: unknown,
  ) => readonly Patch[]
}>

export type GridDocumentModel<Row> = Readonly<{
  version: SchemaVersion
  /** Encoded key location, when key-only receipt normalization preserves task context. */
  identityPath?: StoragePath
  codec: DocumentCodec<Row>
  fields: readonly SchemaField[]
  columns: readonly GridDocumentColumnBinding[]
  /** Pure complete-row validation, with a fixed meaning for this version. */
  validate?: (row: Row, mutation: 'create' | 'update') => readonly KernelIssue[]
}>

export function validateAuthorityRows<Row>(rows: ServerAuthority['rows'], codec: DocumentCodec<Row>, getRowKey: (row: Row) => GridRowKey) {
  for (const entry of rows) {
    if (getRowKey(decodeRow(codec, entry.document)) !== entry.identity.key)
      throw new Error('The server identity and decoded business row key disagree.')
  }
}

const plainCodecs = new WeakSet<object>()
export function isPlainGridRowCodec(codec: object) {
  return plainCodecs.has(codec)
}

/** Default for complete plain encoded objects. Validate before cloning so
 * Date, undefined, sparse arrays and custom instances are never silently lost.
 * Unlike the kernel's immutable Document codec, copies here are mutable,
 * independent business rows so existing in-place setters continue to work. */
export function plainGridRowCodec<Row extends object>(version: CodecVersion): DocumentCodec<Row> {
  const codec: DocumentCodec<Row> = Object.freeze({
    version,
    copy: (row: Row) => structuredClone(ownDocument(row)) as Row,
    equals: (left: Row, right: Row) => encodedValuesEqual(ownDocument(left), ownDocument(right)),
    encode: ownDocument,
    decode: (document) => structuredClone(ownDocument(document)) as Row,
  })
  plainCodecs.add(codec)
  return codec
}
