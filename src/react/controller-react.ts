import { useCallback, useRef, useSyncExternalStore } from 'react'

import type { GridController, GridCommandResult } from '../controller/grid-controller.js'
import type { GridCellTypeSchema } from '../cell-types/contracts.js'
import type { GridControllerSnapshot, GridRowKey } from '../model/grid-model.js'

export type GridRejectedActionPresenter = (reason: string) => string

/**
 * Presents a classified issue without inferring its code from message text.
 * Domain and adapter messages remain owned by the source which produced them.
 */
export function reportGridRejectedAction<
  Row,
  RowKey extends GridRowKey,
  Schema extends GridCellTypeSchema,
  Effect,
>(
  controller: GridController<Row, RowKey, Schema, Effect>,
  result: GridCommandResult,
  present: GridRejectedActionPresenter,
) {
  if (result.accepted) return
  controller.dispatch({
    type: 'feedback/push',
    item: {
      id: 'grid:last-rejected-action',
      kind: 'error',
      message: present(result.issue.message),
      persistent: false,
    },
  })
}

type SelectorCache<Row, RowKey extends GridRowKey, Selected> = {
  controller: unknown
  snapshot: GridControllerSnapshot<Row, RowKey>
  selector: (snapshot: GridControllerSnapshot<Row, RowKey>) => Selected
  isEqual: (left: Selected, right: Selected) => boolean
  selected: Selected
}

/**
 * React's only subscription boundary for controller-owned semantic state.
 * Derived selections are cached so equality can preserve their identity until
 * the slice consumed by a component actually changes.
 */
export function useGridSelector<Row, RowKey extends GridRowKey, Schema extends GridCellTypeSchema, Effect, Selected>(
  controller: GridController<Row, RowKey, Schema, Effect>,
  selector: (snapshot: GridControllerSnapshot<Row, RowKey>) => Selected,
  isEqual: (left: Selected, right: Selected) => boolean = Object.is,
): Selected {
  const selectorRef = useRef(selector)
  const equalityRef = useRef(isEqual)
  selectorRef.current = selector
  equalityRef.current = isEqual

  const cacheRef = useRef<SelectorCache<Row, RowKey, Selected> | null>(null)
  const getSnapshot = useCallback(() => {
    const snapshot = controller.getSnapshot()
    const currentSelector = selectorRef.current
    const currentEquality = equalityRef.current
    const cached = cacheRef.current
    if (cached
      && cached.controller === controller
      && cached.snapshot === snapshot
      && cached.selector === currentSelector
      && cached.isEqual === currentEquality) return cached.selected

    const next = currentSelector(snapshot)
    const selected = cached
      && cached.controller === controller
      && currentEquality(cached.selected, next)
      ? cached.selected
      : next
    cacheRef.current = {
      controller,
      snapshot,
      selector: currentSelector,
      isEqual: currentEquality,
      selected,
    }
    return selected
  }, [controller])
  const subscribe = useCallback((listener: () => void) => controller.subscribe(() => {
    const cached = cacheRef.current
    const hasPrevious = cached?.controller === controller
    const previous = hasPrevious ? cached.selected : undefined
    const next = getSnapshot()
    if (!hasPrevious || !Object.is(previous, next)) listener()
  }), [controller, getSnapshot])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
