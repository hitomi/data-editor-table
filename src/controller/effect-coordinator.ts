import type { GridRowKey, GridTargetDependency } from '../model/grid-model.js'

export type GridActiveEffect<RowKey extends GridRowKey> = Readonly<{
  generation?: string
  targets: readonly (GridTargetDependency<RowKey> & Readonly<{ columnKey: string; access: 'read' | 'write' }>)[]
  sessionId?: string
  source?: number
  edit?: number
  persistence?: number
  cellScope?: string
}>

export type GridEffectOwnershipState<RowKey extends GridRowKey> = Readonly<{
  pending: ReadonlySet<GridActiveEffect<RowKey>>
  external: ReadonlyMap<string, GridActiveEffect<RowKey>>
  cells: ReadonlyMap<string, GridActiveEffect<RowKey>>
  cellScopes: ReadonlyMap<string, string>
}>

export function initialGridEffectOwnershipState<RowKey extends GridRowKey>(): GridEffectOwnershipState<RowKey> {
  return Object.freeze({ pending: new Set<GridActiveEffect<RowKey>>(), external: new Map(), cells: new Map(), cellScopes: new Map() })
}

export class GridEffectCoordinator<RowKey extends GridRowKey> {
  #pending = new Set<GridActiveEffect<RowKey>>()
  #external = new Map<string, GridActiveEffect<RowKey>>()
  #cells = new Map<string, GridActiveEffect<RowKey>>()
  #cellScopes = new Map<string, string>()
  readonly #isCurrent: (effect: GridActiveEffect<RowKey>) => boolean

  readonly #cancel: (effect: GridActiveEffect<RowKey>) => void
  #owned = true

  constructor(
    isCurrent: (effect: GridActiveEffect<RowKey>) => boolean,
    cancel: (effect: GridActiveEffect<RowKey>) => void,
  ) {
    this.#cancel = cancel
    this.#isCurrent = isCurrent
  }

  restoreState(state: GridEffectOwnershipState<RowKey>) {
    // Maps are shared read-only until the first mutation in this input.
    this.#pending = state.pending as Set<GridActiveEffect<RowKey>>
    this.#external = state.external as Map<string, GridActiveEffect<RowKey>>
    this.#cells = state.cells as Map<string, GridActiveEffect<RowKey>>
    this.#cellScopes = state.cellScopes as Map<string, string>
    this.#owned = false
  }

  captureState(): GridEffectOwnershipState<RowKey> {
    // A rollback checkpoint can be captured midway through a command.
    // Its maps must survive subsequent writes in the same input.
    this.#owned = false
    return Object.freeze({
      pending: this.#pending, external: this.#external, cells: this.#cells,
      cellScopes: this.#cellScopes,
    })
  }

  #write() {
    if (this.#owned) return
    this.#pending = new Set(this.#pending)
    this.#external = new Map(this.#external)
    this.#cells = new Map(this.#cells)
    this.#cellScopes = new Map(this.#cellScopes)
    this.#owned = true
  }

  startCell(
    ownerKey: string,
    cellScope: string,
    guard: Omit<GridActiveEffect<RowKey>, 'cellScope'>,
  ) {
    this.#write()
    const previousOwner = this.#cellScopes.get(cellScope)
    if (previousOwner !== undefined) this.cancelCell(previousOwner)
    const effect = Object.freeze({
      ...guard,
      cellScope,
    })
    this.#pending.add(effect)
    this.#cells.set(ownerKey, effect)
    this.#cellScopes.set(cellScope, ownerKey)
    return effect
  }

  isCellCurrent(ownerKey: string, effect: GridActiveEffect<RowKey>) {
    return (
      this.#cells.get(ownerKey) === effect &&
      this.#cellScopes.get(effect.cellScope!) === ownerKey &&
      this.#isCurrent(effect)
    )
  }

  finishCell(ownerKey: string, effect: GridActiveEffect<RowKey>) {
    this.#write()
    this.#pending.delete(effect)
    if (this.#cells.get(ownerKey) !== effect) return false
    this.#cells.delete(ownerKey)
    if (this.#cellScopes.get(effect.cellScope!) === ownerKey) {
      this.#cellScopes.delete(effect.cellScope!)
    }
    return true
  }

  cancelCell(ownerKey: string) {
    this.#write()
    const effect = this.#cells.get(ownerKey)
    if (!effect) return false
    this.#cancel(effect)
    this.#cells.delete(ownerKey)
    if (this.#cellScopes.get(effect.cellScope!) === ownerKey) {
      this.#cellScopes.delete(effect.cellScope!)
    }
    return true
  }

  startExternal(
    id: string,
    guard: GridActiveEffect<RowKey>,
    replace: boolean,
  ) {
    const previous = this.#external.get(id)
    if (previous && !replace) return null
    this.#write()
    if (previous) this.#cancel(previous)
    const effect = Object.freeze({ ...guard })
    this.#pending.add(effect)
    this.#external.set(id, effect)
    return effect
  }

  isExternalCurrent(id: string, effect: GridActiveEffect<RowKey>) {
    return (
      this.#external.get(id) === effect &&
      this.#isCurrent(effect)
    )
  }

  finishExternal(id: string, effect: GridActiveEffect<RowKey>) {
    this.#write()
    this.#pending.delete(effect)
    if (this.#external.get(id) !== effect) return false
    this.#external.delete(id)
    return true
  }

  cancelExternal(id: string) {
    this.#write()
    const effect = this.#external.get(id)
    if (!effect) return false
    this.#cancel(effect)
    this.#external.delete(id)
    return true
  }

  /** Revoke on the first published loss of ownership, including a change
   * before the task runner's first microtask. A later value match cannot revive it. */
  revokeStale() {
    for (const [id, active] of this.#cells)
      if (!this.#isCurrent(active)) this.cancelCell(id)
    for (const [id, active] of this.#external)
      if (!this.#isCurrent(active)) this.cancelExternal(id)
  }
}
