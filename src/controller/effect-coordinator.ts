import type { GridPoint, GridRowKey } from '../model/grid-model.js'

export type GridActiveEffect<RowKey extends GridRowKey> = Readonly<{
  abort: AbortController
  source?: number
  edit?: number
  persistence?: number
  cell?: GridPoint<RowKey>
  cellRevision?: number
  cellScope?: string
}>

export class GridEffectCoordinator<RowKey extends GridRowKey> {
  readonly #external = new Map<string, GridActiveEffect<RowKey>>()
  readonly #cells = new Map<string, GridActiveEffect<RowKey>>()
  readonly #cellScopes = new Map<string, string>()
  readonly #cellRevisions = new Map<string, number>()
  readonly #isCurrent: (effect: GridActiveEffect<RowKey>) => boolean

  constructor(isCurrent: (effect: GridActiveEffect<RowKey>) => boolean) {
    this.#isCurrent = isCurrent
  }

  cellRevision(cellKey: string) {
    return this.#cellRevisions.get(cellKey) ?? 0
  }

  startCell(
    ownerKey: string,
    cellScope: string,
    guard: Omit<GridActiveEffect<RowKey>, 'abort' | 'cellScope'>,
  ) {
    const previousOwner = this.#cellScopes.get(cellScope)
    if (previousOwner !== undefined) this.cancelCell(previousOwner)
    const effect = Object.freeze({
      ...guard,
      abort: new AbortController(),
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
      !effect.abort.signal.aborted &&
      this.#isCurrent(effect)
    )
  }

  finishCell(ownerKey: string, effect: GridActiveEffect<RowKey>) {
    if (this.#cells.get(ownerKey) !== effect) return false
    this.#cells.delete(ownerKey)
    if (this.#cellScopes.get(effect.cellScope!) === ownerKey) {
      this.#cellScopes.delete(effect.cellScope!)
    }
    return true
  }

  cancelCell(ownerKey: string) {
    const effect = this.#cells.get(ownerKey)
    if (!effect) return false
    effect.abort.abort()
    this.#cells.delete(ownerKey)
    if (this.#cellScopes.get(effect.cellScope!) === ownerKey) {
      this.#cellScopes.delete(effect.cellScope!)
    }
    return true
  }

  invalidateCell(cellKey: string) {
    this.#cellRevisions.set(cellKey, this.cellRevision(cellKey) + 1)
    const ownerKey = this.#cellScopes.get(cellKey)
    if (ownerKey !== undefined) this.cancelCell(ownerKey)
  }

  startExternal(
    id: string,
    guard: Omit<GridActiveEffect<RowKey>, 'abort'>,
    replace: boolean,
  ) {
    const previous = this.#external.get(id)
    if (previous && !replace) return null
    previous?.abort.abort()
    const effect = Object.freeze({ ...guard, abort: new AbortController() })
    this.#external.set(id, effect)
    return effect
  }

  isExternalCurrent(id: string, effect: GridActiveEffect<RowKey>) {
    return (
      this.#external.get(id) === effect &&
      !effect.abort.signal.aborted &&
      this.#isCurrent(effect)
    )
  }

  finishExternal(id: string, effect: GridActiveEffect<RowKey>) {
    if (this.#external.get(id) !== effect) return false
    this.#external.delete(id)
    return true
  }

  cancelExternal(id: string) {
    const effect = this.#external.get(id)
    if (!effect) return false
    effect.abort.abort()
    this.#external.delete(id)
    return true
  }

  abortSourceOwned() {
    for (const effect of this.#cells.values()) effect.abort.abort()
    this.#cells.clear()
    this.#cellScopes.clear()
    for (const [id, effect] of this.#external) {
      if (effect.source === undefined) continue
      effect.abort.abort()
      this.#external.delete(id)
    }
  }

  destroy() {
    for (const effect of this.#cells.values()) effect.abort.abort()
    for (const effect of this.#external.values()) effect.abort.abort()
    this.#cells.clear()
    this.#cellScopes.clear()
    this.#external.clear()
    this.#cellRevisions.clear()
  }
}
