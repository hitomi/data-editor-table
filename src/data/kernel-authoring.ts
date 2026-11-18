import { captureGridInput } from '../cell-types/input-codec.js'
import { applyDocumentPatches, encodedValuesEqual, isDocument, ownEncodedValue } from '../kernel/document.js'
import { inputRefKey } from '../kernel/journal.js'
import { kernelId, type Document, type EntityId, type InputRef, type Patch, type PreparedAction, type StoragePath } from '../kernel/model.js'
import { planDocumentWrite, prepareRowAction, type RowActionPlan, type RowCommand, type WritePlan } from '../kernel/prepare.js'
import type { GridKernelDataProjection } from './kernel-projection.js'
import { pathContains } from '../kernel/resources.js'
import { decodeRow, encodeRow } from '../kernel/schema.js'
import type { KernelState } from '../kernel/state.js'
import type { GridRowKey } from '../model/grid-model.js'
import { GridIssueError, gridExceptionIssue, gridValueIssue } from '../model/grid-result.js'
import type { GridCompiledDocumentModel, GridDocumentColumn } from './runtime-columns.js'

export type GridAuthoredCommand<Row> =
  | Readonly<{ kind: 'set-cell'; entityId: EntityId; columnKey: string; value: unknown }>
  | Readonly<{ kind: 'create'; entityId: EntityId; row: Row }>
  | Readonly<{ kind: 'delete'; entityId: EntityId }>
  | Readonly<{ kind: 'order'; desired: readonly EntityId[] }>
  /** An explicit user restoration, never a general display-rows setter. */
  | Readonly<{ kind: 'restore-row'; entityId: EntityId; row: Row }>

export type GridAuthoredAction<Row> = Omit<RowActionPlan, 'commands'> & Readonly<{
  revision: number
  commands: readonly Readonly<{
    id: RowActionPlan['commands'][number]['id']
    command: GridAuthoredCommand<Row>
    inputs: readonly InputRef[]
    dependencies: RowActionPlan['commands'][number]['dependencies']
  }>[]
}>

export type GridDataPreparation = Readonly<{
  prepared: PreparedAction | null
  /** The caller retains these inputs until an explicit no-change disposition.
   * They must not disappear just because other commands in the action wrote. */
  unconsumedInputs: RowActionPlan['inputs']
}>

/** Compile all entries against one captured revision. This function owns only
 * candidates: a failure cannot change the input state, history or other rows.
 * Existing behavior code parses values before this boundary; validation and
 * setters execute here once, and only concrete writes enter the journal. */
export function prepareGridDataAction<Row, RowKey extends GridRowKey>(
  state: KernelState,
  projection: GridKernelDataProjection<Row, RowKey>,
  model: GridCompiledDocumentModel<Row>,
  getRowKey: (row: Row) => RowKey,
  request: GridAuthoredAction<Row>,
  canDelete: ((row: Row) => boolean) | undefined,
): GridDataPreparation {
  if (state.revision !== request.revision) throw new GridIssueError({ code: 'stale-target', message: 'The authored action belongs to an older data revision.' })
  const inputs = ownEncodedValue(request.inputs) as unknown as RowActionPlan['inputs']
  const virtual = new Map<EntityId, Document>()
  const commands: RowActionPlan['commands'][number][] = []
  const keys = new Map<RowKey, number>()
  const keyOf = (document: Document) => {
    const key = getRowKey(decodeRow(model.codec, document))
    if (typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key)))
      throw new Error('Row keys must be strings or finite numbers.')
    return key
  }
  for (const row of projection.byId.values()) {
    if (row.data.existence === 'pending-delete') continue
    virtual.set(row.entityId, row.data.preview!)
    keys.set(row.rowKey, (keys.get(row.rowKey) ?? 0) + 1)
  }
  let order = projection.data.order.preview.filter(id => virtual.has(id))
  for (const entry of request.commands) {
    const authored = entry.command
    let command: RowCommand
    if (authored.kind === 'order') {
      const desired = [...authored.desired]
      if (desired.length !== virtual.size || new Set(desired).size !== desired.length || desired.some(id => !virtual.has(id)))
        throw new Error('An order action must include every staged entity exactly once.')
      if (desired.every((id, index) => order[index] === id)) continue
      order = desired
      command = { kind: 'order', desired }
    } else if (authored.kind === 'create') {
      if (state.entities.some(binding => binding.entityId === authored.entityId) || virtual.has(authored.entityId))
        throw new Error('A new row requires a fresh entity lifetime.')
      const document = encodeRow(model.codec, authored.row), key = keyOf(document)
      if (keys.has(key)) throw new Error('A created row cannot reuse a staged row key.')
      virtual.set(authored.entityId, document); keys.set(key, 1); order.push(authored.entityId)
      command = { kind: 'create', entityId: authored.entityId, document, proposedKey: key }
    } else {
      const before = virtual.get(authored.entityId)
      if (!before) throw new GridIssueError({ code: 'stale-target', message: 'The authored entity no longer exists in this action context.' })
      const key = keyOf(before)
      if (authored.kind === 'delete') {
        assertGridRowDeletable(model, before, canDelete)
        virtual.delete(authored.entityId)
        const remaining = keys.get(key)! - 1
        if (remaining) keys.set(key, remaining)
        else keys.delete(key)
        order = order.filter(id => id !== authored.entityId)
        command = { kind: 'delete', entityId: authored.entityId }
      } else if (authored.kind === 'restore-row') {
        const document = encodeRow(model.codec, authored.row)
        if (keyOf(document) !== key) throw new Error('Restoring row contents cannot change their identity.')
        if (encodedValuesEqual(before, document)) continue
        virtual.set(authored.entityId, document)
        command = { kind: 'replace', entityId: authored.entityId, document }
      } else {
        const binding = model.columns.find(entry => entry.column.key === authored.columnKey)
        if (!binding) throw new GridIssueError({ code: 'invalid-configuration', message: 'The target column has no compiled storage binding.' })
        let group: WritePlan
        try {
          group = compileCellWrite(model, binding, before, authored, kernelId<'write-group'>(`${entry.id}:write`))
        } catch (error) {
          throw new GridIssueError({ ...gridExceptionIssue(error), cell: { rowKey: key, columnKey: authored.columnKey } }, { cause: error })
        }
        const after = applyDocumentPatches(before, group.writes)
        if (keyOf(after) !== key) throw new Error('A cell setter cannot change its row key.')
        if (encodedValuesEqual(before, after)) continue
        virtual.set(authored.entityId, after)
        command = { kind: 'write', entityId: authored.entityId, groups: [group] }
      }
    }
    commands.push({ id: entry.id, command, inputs: entry.inputs, dependencies: entry.dependencies })
  }
  if (!commands.length) return Object.freeze({ prepared: null, unconsumedInputs: inputs })
  // No-op commands have no journal contribution. Other consumers of the same
  // bulk input retain it, and the caller owns a wholly no-op editor until it
  // explicitly accepts that outcome. Do not invent an empty history action.
  const used = new Set(commands.flatMap(command => command.inputs.map(inputRefKey)))
  const prepared = prepareRowAction(state, {
    action: request.action, cause: request.cause, commands,
    inputs: inputs.filter(input => used.has(inputRefKey(input.ref))),
  }, model.schema)
  return Object.freeze({ prepared, unconsumedInputs: Object.freeze(inputs.filter(input => !used.has(inputRefKey(input.ref)))) })
}

/** Local admission predicate. The delete's captured document dependency
 * protects replay; the authority source separately enforces server permissions. */
export function assertGridRowDeletable<Row>(model: GridCompiledDocumentModel<Row>, document: Document,
  canDelete: ((row: Row) => boolean) | undefined) {
  if (!canDelete?.(decodeRow(model.codec, document))) throw new GridIssueError({ code: 'permission-denied', message: 'This row is not eligible for deletion.' })
}

function compileCellWrite<Row>(
  model: GridCompiledDocumentModel<Row>,
  binding: GridDocumentColumn<Row>,
  before: Document,
  command: Extract<GridAuthoredCommand<Row>, { kind: 'set-cell' }>,
  id: WritePlan['id'],
): WritePlan {
  const column = binding.column
  const row = () => decodeRow(model.codec, before)
  if (!column.setValue || !column.isEditable(row())) throw new GridIssueError({ code: 'permission-denied', message: 'This cell is read-only.' })
  const ownValue = (value: unknown): unknown => {
    const captured = captureGridInput(value, binding.valueCodec)
    if (!binding.valueCodec) return captured.kind === 'encoded' ? captured.value : value
    // captureGridInput already checked independence, determinism and round trip.
    return binding.valueCodec.copy(value)
  }
  // Custom cell types can replace any standard type and read the complete row.
  // Keep the same isolated row for every access within this validation.
  const validationRow = row()
  let validatorReadRow = false
  const validated = column.behavior.value.validate(ownValue(command.value), {
    get row() { validatorReadRow = true; return validationRow },
    columnKey: column.key, typeOptions: column.typeOptions,
  })
  if (!validated.ok) throw new GridIssueError(gridValueIssue(validated.issue))
  const checked = column.validate?.(ownValue(validated.value), row()) ?? validated
  if (!checked.ok) throw new GridIssueError(gridValueIssue(checked.issue))
  const value = ownValue(checked.value)
  let group: WritePlan
  const write = binding.write
  switch (write.kind) {
    case 'planned':
      group = planDocumentWrite(command.entityId, before, id, value, write.plan)
      break
    case 'field':
      group = { id, comparison: 'paths', reads: [], writes: [{ kind: 'set', path: write.path, value: ownEncodedValue(value) }] }
      break
    case 'setter': {
      const after = encodeRow(model.codec, column.setValue(row(), value))
      group = { id, comparison: 'entity', reads: [], writes: authoredDocumentPatches(before, after) }
      break
    }
  }
  // A write base follows normalization by an earlier commit. A business read
  // also guards the value on which admission or the computed result depended.
  if (binding.rowAdmission || validatorReadRow || write.kind === 'setter') {
    group = { ...group, reads: [...group.reads, {
      resource: { kind: 'entity', entityId: command.entityId }, role: 'semantic-read', expected: { kind: 'value', value: before },
    }] }
  }
  for (const patch of group.writes) {
    if (!binding.fields.some(field => pathContains(field.path, patch.path)))
      throw new GridIssueError({ code: 'invalid-configuration', message: `Column "${column.key}" wrote outside its declared storage fields.` })
  }
  return ownEncodedValue(group) as unknown as WritePlan
}

/** Diff only the isolated result of this explicit setter invocation. This is
 * not an authority reconciliation or an attempt to infer past user intent. */
function authoredDocumentPatches(before: Document, after: Document): readonly Patch[] {
  const patches: Patch[] = []
  const visit = (a: Document, b: Document, prefix: readonly string[]) => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const path = [...prefix, key] as unknown as StoragePath
      if (!Object.hasOwn(b, key)) patches.push({ kind: 'remove', path })
      else if (!Object.hasOwn(a, key)) patches.push({ kind: 'set', path, value: b[key]! })
      else if (!encodedValuesEqual(a[key]!, b[key]!)) {
        if (isDocument(a[key]!) && isDocument(b[key]!)) visit(a[key] as Document, b[key] as Document, path)
        else patches.push({ kind: 'set', path, value: b[key]! })
      }
    }
  }
  visit(before, after, [])
  return Object.freeze(patches)
}
