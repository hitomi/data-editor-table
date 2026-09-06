import type { GridPoint, GridRowKey } from '../model/grid-model.js'

export type GridActiveEffect<RowKey extends GridRowKey> = Readonly<{
  source?: number
  edit?: number
  persistence?: number
  cell?: GridPoint<RowKey>
  cellRevision?: number
  cellScope?: string
}>

export type GridEffectOwnershipState<RowKey extends GridRowKey> = Readonly<{
  external: ReadonlyMap<string, GridActiveEffect<RowKey>>
  cells: ReadonlyMap<string, GridActiveEffect<RowKey>>
  cellScopes: ReadonlyMap<string, string>
  cellRevisions: ReadonlyMap<string, number>
}>

export function initialGridEffectOwnershipState<RowKey extends GridRowKey>(): GridEffectOwnershipState<RowKey> {
  return Object.freeze({ external: new Map(), cells: new Map(), cellScopes: new Map(), cellRevisions: new Map() })
}

export class GridEffectCoordinator<RowKey extends GridRowKey> {
  #external = new Map<string, GridActiveEffect<RowKey>>()
  #cells = new Map<string, GridActiveEffect<RowKey>>()
  #cellScopes = new Map<string, string>()
  #cellRevisions = new Map<string, number>()
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
    this.#external = state.external as Map<string, GridActiveEffect<RowKey>>
    this.#cells = state.cells as Map<string, GridActiveEffect<RowKey>>
    this.#cellScopes = state.cellScopes as Map<string, string>
    this.#cellRevisions = state.cellRevisions as Map<string, number>
    this.#owned = false
  }

  captureState(): GridEffectOwnershipState<RowKey> {
    return Object.freeze({
      external: this.#external, cells: this.#cells,
      cellScopes: this.#cellScopes, cellRevisions: this.#cellRevisions,
    })
  }

  #write() {
    if (this.#owned) return
    this.#external = new Map(this.#external)
    this.#cells = new Map(this.#cells)
    this.#cellScopes = new Map(this.#cellScopes)
    this.#cellRevisions = new Map(this.#cellRevisions)
    this.#owned = true
  }

  cellRevision(cellKey: string) {
    return this.#cellRevisions.get(cellKey) ?? 0
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

  invalidateCell(cellKey: string) {
    this.#write()
    this.#cellRevisions.set(cellKey, this.cellRevision(cellKey) + 1)
    const ownerKey = this.#cellScopes.get(cellKey)
    if (ownerKey !== undefined) this.cancelCell(ownerKey)
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

  abortSourceOwned() {
    this.#write()
    for (const effect of this.#cells.values()) this.#cancel(effect)
    this.#cells.clear()
    this.#cellScopes.clear()
    for (const [id, effect] of this.#external) {
      if (effect.source === undefined) continue
      this.#cancel(effect)
      this.#external.delete(id)
    }
  }

}
