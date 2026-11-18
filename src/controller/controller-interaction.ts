import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridEditStatus, GridHitTarget, GridPointerModifiers, GridRowKey } from '../model/grid-model.js'
import { GridConfigurationError } from '../model/grid-result.js'
import type { GridCommandResult, GridCommandTarget, GridController, GridIntent, GridMutationValue } from './controller-contracts.js'

export type GridKeyboardCommand =
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'edit'
  | 'commit-edit'
  | 'cancel'
  | 'clear'
  | 'select-all'
  | 'select-row'
  | 'select-column'
  | 'undo'
  | 'redo'

export type GridInteractionInput<RowKey extends GridRowKey> =
  | { type: 'viewport/resized'; width: number; height: number }
  | { type: 'viewport/scrolled'; scrollLeft: number; scrollTop: number }
  | { type: 'viewport/configure'; rowHeight: number; headerHeight: number; rowIndicatorWidth: number }
  | {
      type: 'pointer/start'
      pointerId: number
      target: GridHitTarget<RowKey>
      modifiers: GridPointerModifiers
    }
  | { type: 'pointer/move'; pointerId: number; target: GridHitTarget<RowKey> }
  | { type: 'pointer/end'; pointerId: number; target?: GridHitTarget<RowKey> }
  | { type: 'pointer/cancel'; pointerId: number }
  | { type: 'keyboard/command'; command: GridKeyboardCommand; extend?: boolean }
  | { type: 'edit/set-composing'; composing: boolean; finalValue?: unknown }
  | { type: 'edit/set-status'; status: GridEditStatus; error?: string | null }

export type GridInteractionValue<Input extends GridInteractionInput<GridRowKey>> =
  Input extends { type: 'keyboard/command' } ? GridMutationValue | Readonly<{ changedCells: number; skippedCells: number }> | void
  : Input extends { type: 'pointer/end' } ? GridMutationValue | void
  : void

/** A callback credential names its recipient. Commands that resolve their
 * recipient from the current selection require a fresh user gesture. */
export function gridCommandAddressesTarget<Key extends GridRowKey>(
  command: GridIntent<Key, unknown> | GridInteractionInput<Key>, target: GridCommandTarget<Key>,
  editing: Readonly<{ cell: Readonly<{ rowKey: Key; columnKey: string }> }> | null,
) {
  if (target.kind !== 'row') {
    if (target.kind === 'filter') return command.type.startsWith('filter/') && command.type !== 'filter/open'
    if (target.kind === 'bulk') return command.type.startsWith('bulk/') && command.type !== 'bulk/start'
    if (command.type === 'controller/run-effect') return command.request.owner.kind === 'edit'
    if (command.type === 'cell/run-effect') return command.cell.rowKey === editing?.cell.rowKey && command.cell.columnKey === editing.cell.columnKey
    if (command.type === 'keyboard/command') return command.command === 'commit-edit' || command.command === 'cancel'
    return command.type.startsWith('edit/') && command.type !== 'edit/start'
  }
  if (command.type === 'interaction/activate' && command.range &&
    (command.range.anchor.rowKey !== target.rowKey || command.range.focus.rowKey !== target.rowKey)) return false
  if (command.type === 'controller/run-effect') return command.request.owner.kind === 'cell' && command.request.owner.cell.rowKey === target.rowKey
  if ('cell' in command) return command.cell?.rowKey === target.rowKey
  if (command.type === 'conflict/resolve') return command.rowKey === target.rowKey
  if (command.type === 'rows/revert') return command.rowKeys?.length === 1 && command.rowKeys[0] === target.rowKey
  if (command.type === 'interaction/open-action') return command.target.rowKey === target.rowKey
  if (command.type === 'pointer/start' || command.type === 'pointer/move' || command.type === 'pointer/end') {
    const hit = command.target
    return !!hit && 'rowKey' in hit && hit.rowKey === target.rowKey
  }
  return false
}

/** A view adapter sends DOM-derived facts through the existing Controller Runtime. */
export type GridInteractionPort<RowKey extends GridRowKey> = Readonly<{
  send<Input extends GridInteractionInput<RowKey>>(input: Input, target?: GridCommandTarget<RowKey>): GridCommandResult<GridInteractionValue<Input>>
}>

const ports = new WeakMap<object, GridInteractionPort<GridRowKey>>()

/** Internal registration; neither owns state nor extends the public Controller. */
export function registerGridInteractionPort<RowKey extends GridRowKey>(controller: object, port: GridInteractionPort<RowKey>): void {
  ports.set(controller, port as GridInteractionPort<GridRowKey>)
}

/** Engine-only entry for hosts implementing a custom viewport or input adapter. */
export function getGridInteractionPort<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect>(
  controller: GridController<Row, RowKey, Schema, Effect>,
): GridInteractionPort<RowKey> {
  const port = ports.get(controller)
  if (!port) throw new GridConfigurationError('This Controller has no registered interaction port.')
  return port as GridInteractionPort<RowKey>
}

const interactionTypes = {
  'viewport/resized': true,
  'viewport/scrolled': true,
  'viewport/configure': true,
  'pointer/start': true,
  'pointer/move': true,
  'pointer/end': true,
  'pointer/cancel': true,
  'keyboard/command': true,
  'edit/set-composing': true,
  'edit/set-status': true,
} satisfies Record<GridInteractionInput<GridRowKey>['type'], true>

function hasType(input: unknown, names: object): boolean {
  return typeof input === 'object' && input !== null && 'type' in input
    && typeof input.type === 'string' && Object.hasOwn(names, input.type)
}
export function isGridInteractionInput(input: unknown): input is GridInteractionInput<GridRowKey> {
  return hasType(input, interactionTypes)
}

const businessTypes = {
  'effect/inspect-result': true,
  'effect/apply-host-result': true,
  'order/resolve': true,
  'interaction/activate': true,
  'interaction/set-ranges': true,
  'interaction/open-action': true,
  'interaction/close-action': true,
  'interaction/clear': true,
  'edit/start': true,
  'edit/change': true,
  'edit/commit': true,
  'edit/cancel': true,
  'edit/commit-and-move': true,
  'cell/set-value': true,
  'cell/run-effect': true,
  'cell/cancel-effect': true,
  'cell/run-action': true,
  'selection/copy': true,
  'selection/paste': true,
  'selection/clear-values': true,
  'selection/fill': true,
  'cell/revert': true,
  'selection/revert': true,
  'rows/revert': true,
  'conflict/resolve': true,
  'bulk/start': true,
  'bulk/change': true,
  'bulk/apply': true,
  'bulk/cancel': true,
  'filter/open': true,
  'filter/change': true,
  'filter/add-condition': true,
  'filter/remove-condition': true,
  'filter/apply': true,
  'filter/clear': true,
  'filter/cancel': true,
  'history/undo': true,
  'history/redo': true,
  'history/compensate-insertion': true,
  'effect/reapply-cell-result': true,
  'effect/discard-result': true,
  'rows/add': true,
  'rows/duplicate': true,
  'rows/delete': true,
  'view/set-global-filter': true,
  'view/set-column-filters': true,
  'view/set-sort': true,
  'persistence/set-mode': true,
  'feedback/push': true,
  'feedback/dismiss': true,
  'feedback/clear': true,
  'controller/run-effect': true,
  'controller/cancel-effect': true,
} satisfies Record<GridIntent<GridRowKey, unknown>['type'], true>

export function isGridBusinessIntent(input: unknown): input is GridIntent<GridRowKey, unknown> {
  return hasType(input, businessTypes)
}
