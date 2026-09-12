import type { EntityId, FieldId, FieldRef, ResourceValue } from './kernel/model.js'
import type { WorkspaceTextCodec } from './value-codecs.js'

/** TSV with spreadsheet quoting. A final record terminator is not another row;
 * a quoted empty final cell is explicit data. Invalid quoting is rejected. */
export function decodeMatrix(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [], row: string[] = []
  let value = '', mode: 'start' | 'plain' | 'quoted' | 'closed' = 'start', endedRecord = false
  const cell = () => { row.push(value); value = ''; mode = 'start' }
  const record = () => { cell(); rows.push(row.splice(0)); endedRecord = true }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (mode === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') { value += '"'; index++ }
        else mode = 'closed'
      } else value += char
      endedRecord = false
      continue
    }
    if (char === '\t') { cell(); endedRecord = false; continue }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      record(); continue
    }
    if (mode === 'closed') throw new Error('Unexpected text after a closing quote.')
    if (char === '"') {
      if (mode !== 'start') throw new Error('Quotes inside a cell must be escaped in a quoted cell.')
      mode = 'quoted'
    } else { mode = 'plain'; value += char }
    endedRecord = false
  }
  if (mode === 'quoted') throw new Error('Unclosed quoted cell.')
  if (!endedRecord) record()
  return Object.freeze(rows.map(row => Object.freeze(row)))
}

export function encodeMatrix(matrix: readonly (readonly string[])[]): string {
  if (!matrix.length || matrix.some(row => !row.length)) throw new Error('A clipboard matrix must have nonempty rows.')
  return matrix.map(row => row.map((value, index) => /[\t\r\n"]/.test(value) || row.length === 1 && index === 0 && value === ''
    ? `"${value.replaceAll('"', '""')}"` : value).join('\t')).join('\n')
}

export type MatrixLayout = Readonly<{
  rows: readonly EntityId[]
  columns: readonly Readonly<{ columnId: string; fieldId: FieldId }>[]
}>
export type MatrixCellInput = Readonly<{ field: FieldRef; text: string }>
export type MatrixValue = Readonly<{ field: FieldRef; value: ResourceValue }>

/** Parse the entire bound input before preparing any command. Failure carries
 * the exact field and original text, with no partial write set to apply. */
export function parseMatrixValues(text: string, layout: MatrixLayout, codecs: ReadonlyMap<FieldId, WorkspaceTextCodec>):
  Readonly<{ kind: 'valid'; values: readonly MatrixValue[] }> | Readonly<{ kind: 'invalid'; input: MatrixCellInput; message: string }> {
  const values: MatrixValue[] = []
  for (const input of bindMatrix(text, layout)) {
    const codec = codecs.get(input.field.fieldId)
    if (!codec) throw new Error('Every matrix field requires a registered codec.')
    const parsed = codec.parse(input.text)
    if (parsed.kind === 'invalid') return Object.freeze({ kind: 'invalid', input, message: parsed.message })
    values.push(Object.freeze({ field: input.field, value: parsed.value }))
  }
  return Object.freeze({ kind: 'valid', values: Object.freeze(values) })
}

/** Bind a complete matrix to captured identities. This function never consults
 * the current row order. Aliased display columns may share a target only when
 * their source text agrees; conflicting aliases cannot silently win. */
export function bindMatrix(text: string, layout: MatrixLayout): readonly MatrixCellInput[] {
  if (!layout.rows.length || !layout.columns.length || layout.rows.some(id => !id) || new Set(layout.rows).size !== layout.rows.length
    || layout.columns.some(column => !column.columnId || !column.fieldId) || new Set(layout.columns.map(column => column.columnId)).size !== layout.columns.length)
    throw new Error('A matrix requires unique nonempty row and display column identities.')
  const matrix = decodeMatrix(text)
  if (matrix.length !== layout.rows.length || matrix.some(row => row.length !== layout.columns.length)) throw new Error('The complete matrix must match the captured target dimensions.')
  const result: MatrixCellInput[] = []
  for (let row = 0; row < matrix.length; row++) {
    const fields = new Map<FieldId, string>()
    for (let column = 0; column < layout.columns.length; column++) {
      const fieldId = layout.columns[column]!.fieldId, value = matrix[row]![column]!
      if (fields.has(fieldId) && fields.get(fieldId) !== value) throw new Error('Display columns disagree about the same target field.')
      fields.set(fieldId, value)
    }
    for (const [fieldId, value] of fields) result.push(Object.freeze({ field: Object.freeze({ entityId: layout.rows[row]!, fieldId }), text: value }))
  }
  return Object.freeze(result)
}

/** The layout travels with raw text in the retained input, including before a
 * storage acknowledgement and after reload. It is never reconstructed from UI. */
export type MatrixInput = Readonly<{ format: 'workspace-matrix:1'; text: string; layout: MatrixLayout }>
export function readMatrixInput(input: import('./kernel/model.js').OwnedInput | null | undefined): MatrixInput | null {
  if (input?.kind !== 'encoded' || !input.value || typeof input.value !== 'object' || Array.isArray(input.value)) return null
  const candidate = input.value as unknown as MatrixInput
  if (candidate.format !== 'workspace-matrix:1' || typeof candidate.text !== 'string' || !candidate.layout
    || !Array.isArray(candidate.layout.rows) || !candidate.layout.rows.length || candidate.layout.rows.some(id => typeof id !== 'string' || !id)
    || new Set(candidate.layout.rows).size !== candidate.layout.rows.length || !Array.isArray(candidate.layout.columns) || !candidate.layout.columns.length
    || candidate.layout.columns.some(column => !column || typeof column.columnId !== 'string' || !column.columnId || typeof column.fieldId !== 'string' || !column.fieldId)
    || new Set(candidate.layout.columns.map(column => column.columnId)).size !== candidate.layout.columns.length) return null
  return candidate
}
