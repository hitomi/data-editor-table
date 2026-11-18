import type { GridCellBehaviorPort, GridColumn, GridCompiledColumn, GridValueResult } from '../model/grid-model.js'
import type {
  GridCellTypeSchema,
  GridColumnForCellTypes,
} from '../cell-types/contracts.js'
import { gridFieldAssignment } from '../cell-types/column-helper.js'
import { ownEncodedValue } from '../kernel/document.js'
import { decodeRow, defineKernelSchema, type KernelSchema, type SchemaField } from '../kernel/schema.js'
import { isPlainGridRowCodec, type GridDocumentColumnBinding, type GridDocumentModel } from './grid-document.js'
import { collectRowValidationIssues } from './row-invariants.js'

export type GridDocumentColumn<Row> = Readonly<{
  column: GridCompiledColumn<Row>
  write:
    | Readonly<{ kind: 'field'; path: readonly [string] }>
    | Readonly<{ kind: 'planned'; plan: NonNullable<GridDocumentColumnBinding['planEdit']> }>
    | Readonly<{ kind: 'setter' }>
  rowAdmission: boolean
  fields: readonly SchemaField[]
  valueCodec: GridDocumentColumnBinding['valueCodec'] | undefined
}>

export type GridCompiledDocumentModel<Row> = Readonly<{
  identityPath: GridDocumentModel<Row>['identityPath']
  codec: GridDocumentModel<Row>['codec']
  schema: KernelSchema
  columns: readonly GridDocumentColumn<Row>[]
}>

/** Compile beside the existing display columns. This adds storage identity
 * without changing their renderers, behavior registry or layout contracts. */
export function compileGridDocumentModel<Row, Schema extends GridCellTypeSchema>(
  model: GridDocumentModel<Row>,
  columns: readonly GridCompiledColumn<Row>[],
  definitions: readonly GridColumnForCellTypes<Row, Schema>[],
): GridCompiledDocumentModel<Row> {
  const codec = Object.freeze({
    version: model.codec.version,
    copy: model.codec.copy.bind(model.codec),
    equals: model.codec.equals.bind(model.codec),
    encode: model.codec.encode.bind(model.codec),
    decode: model.codec.decode.bind(model.codec),
  })
  const validate = model.validate
  const schema = defineKernelSchema({
    version: model.version,
    codec: codec.version,
    fields: model.fields,
    validate(document, context) {
      // Each callback sees an independent row; none can mutate kernel facts
      // or the row supplied to another validator.
      const issues = columns.flatMap(column => collectRowValidationIssues(
        [decodeRow(codec, document)], [column], () => context.entityId,
      ).map(issue => ({ code: 'invalid-cell-value', message: issue.message, entityId: context.entityId })))
      return Object.freeze([...issues, ...(validate?.(decodeRow(codec, document), context.mutation) ?? [])])
    },
  })
  const definitionsByKey = new Map(definitions.map(column => [column.key, column]))
  const byKey = new Map(columns.map(column => [column.key, column]))
  const fields = new Map(schema.fields.map(field => [field.id, field]))
  const bound = new Set<string>()
  const compiled = model.columns.map(binding => {
    const column = byKey.get(binding.columnKey)
    if (!column || bound.has(binding.columnKey)) throw new Error('Storage bindings require unique, configured column keys.')
    bound.add(binding.columnKey)
    const ids = ownEncodedValue(binding.fieldIds) as unknown as GridDocumentColumnBinding['fieldIds']
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !fields.has(id)))
      throw new Error(`Column "${column.key}" must name its complete, unique storage fields.`)
    const definition = definitionsByKey.get(column.key)!
    const path = isPlainGridRowCodec(model.codec) && gridFieldAssignment(definition.setValue)
    const write: GridDocumentColumn<Row>['write'] = binding.planEdit
      ? { kind: 'planned', plan: binding.planEdit }
      : path ? { kind: 'field', path } : { kind: 'setter' }
    return Object.freeze({ column, write: Object.freeze(write), rowAdmission: Boolean(definition.isEditable || definition.validateWithRow),
      fields: Object.freeze(ids.map(id => fields.get(id)!)),
      valueCodec: binding.valueCodec === undefined ? undefined : Object.freeze({
        version: binding.valueCodec.version,
        copy: binding.valueCodec.copy.bind(binding.valueCodec),
        equals: binding.valueCodec.equals.bind(binding.valueCodec),
        encode: binding.valueCodec.encode.bind(binding.valueCodec),
        decode: binding.valueCodec.decode.bind(binding.valueCodec),
      }),
    })
  })
  for (const column of columns) if (column.setValue && !bound.has(column.key))
    throw new Error(`Editable column "${column.key}" requires an explicit storage binding.`)
  return Object.freeze({ codec, schema, identityPath: model.identityPath ? Object.freeze([...model.identityPath]) as GridDocumentModel<Row>['identityPath'] : undefined, columns: Object.freeze(compiled) })
}

export function compileGridColumns<Row, Schema extends GridCellTypeSchema>(
  columns: readonly GridColumnForCellTypes<Row, Schema>[],
  behaviors: GridCellBehaviorPort<Row>,
): readonly GridCompiledColumn<Row>[] {
  const issues: string[] = []
  const keys = new Set<string>()
  const compiled: GridCompiledColumn<Row>[] = []

  for (const definition of columns) {
    const column = eraseGridColumn(
      definition as unknown as GridColumn<Row, unknown, string, unknown>,
    )
    if (column.key.trim().length === 0) issues.push('Column keys cannot be empty or whitespace.')
    if (keys.has(column.key)) issues.push(`Column key "${column.key}" is registered more than once.`)
    keys.add(column.key)
    const behavior = behaviors.resolve(column.type, column.typeOptions)
    if (!behavior) {
      issues.push(`Column "${column.key}" uses unregistered cell type "${column.type}".`)
      continue
    }
    if (column.sortable && !behavior.compare) issues.push(`Column "${column.key}" is sortable, but cell type "${column.type}" has no compare capability.`)
    if (column.filterable && !behavior.filter) issues.push(`Column "${column.key}" is filterable, but cell type "${column.type}" has no filter capability.`)
    if (column.bulkEditable && !behavior.bulk) issues.push(`Column "${column.key}" enables bulk editing, but cell type "${column.type}" has no bulk capability.`)
    validateColumnLayout(column.key, column.layout, issues)

    compiled.push(Object.freeze({
      key: column.key,
      label: column.label,
      type: column.type,
      typeOptions: column.typeOptions,
      layout: Object.freeze({ ...column.layout }),
      getValue: column.getValue,
      setValue: column.setValue ? (row: Row, value: unknown) => column.setValue!(row, value) : null,
      isEditable: (row: Row) => {
        if (column.setValue === undefined) return false
        try {
          return column.isEditable?.(row) ?? true
        } catch {
          return false
        }
      },
      validate: column.validate,
      sortable: column.sortable ?? false,
      filterable: column.filterable ?? false,
      bulkEditable: column.bulkEditable ?? false,
      behavior,
    }))
  }

  if (issues.length > 0) throw new Error(`Invalid Grid configuration:\n- ${issues.join('\n- ')}`)
  return Object.freeze(compiled)
}

function eraseGridColumn<
  Row,
  Value,
  Type extends string,
  ColumnOptions,
>(column: GridColumn<Row, Value, Type, ColumnOptions>) {
  const setValue = column.setValue
  const { validate, validateWithRow } = column
  const validateColumn = (value: unknown, row: Row): GridValueResult<unknown> => {
    const checked = validate ? validate(value as Value) : { ok: true as const, value: value as Value }
    return checked.ok && validateWithRow ? validateWithRow(checked.value, row) : checked
  }
  return {
    ...column,
    getValue: (row: Row): unknown => column.getValue(row),
    setValue: setValue
      ? (row: Row, value: unknown) => setValue(row, value as Value)
      : undefined,
    validate: validate || validateWithRow ? validateColumn : null,
  }
}

function validateColumnLayout(
  columnKey: string,
  layout: GridColumn<unknown>['layout'],
  issues: string[],
) {
  if (!layout) return
  for (const [name, value] of Object.entries(layout)) {
    const valid =
      value === undefined ||
      (Number.isFinite(value) && (name === 'flex' ? value >= 0 : value > 0))
    if (!valid) {
      issues.push(
        `Column "${columnKey}" layout.${name} must be ${
          name === 'flex' ? 'finite and non-negative' : 'finite and positive'
        }.`,
      )
    }
  }
  if (
    layout.min !== undefined &&
    layout.max !== undefined &&
    layout.min > layout.max
  ) {
    issues.push(`Column "${columnKey}" layout.min cannot exceed layout.max.`)
  }
}
