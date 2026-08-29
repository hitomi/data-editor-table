import type { GridRowKey as Key } from './types'

import type { DataGridEngine } from './grid-engine'

type Listener = () => void

export type DataGridEngineViewOptions<Row> = {
  compare?: (left: Row, right: Row) => number
  filter?: (row: Row) => boolean
}

export type DataGridEngineView<Row> = {
  configure: (options: DataGridEngineViewOptions<Row>) => void
  dispose: () => void
  getRowsSnapshot: () => readonly Row[]
  subscribe: (listener: Listener) => () => void
}

export function createDataGridEngineView<Row, RowKey extends Key>(
  engine: DataGridEngine<Row, RowKey>,
  initialOptions: DataGridEngineViewOptions<Row>,
): DataGridEngineView<Row> {
  let options = initialOptions
  let rowsSnapshot: readonly Row[] = []
  let keysSnapshot: readonly RowKey[] = []
  let engineRevision = engine.getRevision()
  const listeners = new Set<Listener>()
  let unsubscribeEngine: (() => void) | null = null

  const compareKeys = (
    leftKey: RowKey,
    rightKey: RowKey,
  ) => {
    const left = engine.getRowSnapshot(leftKey)
    const right = engine.getRowSnapshot(rightKey)
    if (!left || !right) return 0
    const compared = options.compare?.(left, right) ?? 0
    if (compared !== 0) return compared
    return (
      (engine.getKeyIndex(leftKey) ?? 0) -
      (engine.getKeyIndex(rightKey) ?? 0)
    )
  }

  const rebuild = () => {
    const nextKeys = engine
      .getKeysSnapshot()
      .filter((key) => {
        const row = engine.getRowSnapshot(key)
        return row !== undefined && (options.filter?.(row) ?? true)
      })
    if (options.compare) {
      nextKeys.sort(compareKeys)
    }
    keysSnapshot = nextKeys
    rowsSnapshot = nextKeys.map(
      (key) => engine.getRowSnapshot(key) as Row,
    )
    engineRevision = engine.getRevision()
  }

  const notify = () => {
    listeners.forEach((listener) => listener())
  }

  const handleEngineChange = ({
    changedKeys,
    orderChanged,
  }: {
    changedKeys: ReadonlySet<RowKey>
    orderChanged: boolean
  }) => {
    if (orderChanged) {
      rebuild()
      notify()
      return
    }

    if (!options.filter && !options.compare) {
      const replacements = new Map<number, Row>()
      changedKeys.forEach((key) => {
        const index = engine.getKeyIndex(key)
        const row = engine.getRowSnapshot(key)
        if (index !== undefined && row !== undefined) replacements.set(index, row)
      })
      engineRevision = engine.getRevision()
      if (replacements.size === 0) return
      rowsSnapshot = sparseArrayUpdate(rowsSnapshot, replacements)
      notify()
      return
    }

    const nextKeys = [...keysSnapshot]
    let changed = false
    changedKeys.forEach((key) => {
      const existingIndex = nextKeys.indexOf(key)
      const row = engine.getRowSnapshot(key)
      const shouldInclude =
        row !== undefined && (options.filter?.(row) ?? true)
      if (existingIndex >= 0) {
        nextKeys.splice(existingIndex, 1)
        changed = true
      }
      if (!shouldInclude) return
      let low = 0
      let high = nextKeys.length
      while (low < high) {
        const middle = (low + high) >>> 1
        const middleKey = nextKeys[middle]
        if (
          middleKey !== undefined &&
          compareKeys(middleKey, key) <= 0
        ) {
          low = middle + 1
        } else {
          high = middle
        }
      }
      nextKeys.splice(low, 0, key)
      changed = true
    })
    engineRevision = engine.getRevision()
    if (!changed) return
    keysSnapshot = nextKeys
    rowsSnapshot = nextKeys.map(
      (key) => engine.getRowSnapshot(key) as Row,
    )
    notify()
  }

  rebuild()

  return {
    configure(nextOptions) {
      if (
        options.compare === nextOptions.compare &&
        options.filter === nextOptions.filter
      ) {
        return
      }
      options = nextOptions
      rebuild()
      notify()
    },
    dispose() {
      unsubscribeEngine?.()
      unsubscribeEngine = null
      listeners.clear()
    },
    getRowsSnapshot: () => rowsSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (!unsubscribeEngine) {
        // The view may have been created during render before React installs
        // its external-store subscription. Rebuild at the subscription
        // boundary so updates in that gap cannot leave a stale snapshot.
        if (engineRevision !== engine.getRevision()) rebuild()
        unsubscribeEngine = engine.subscribeChanges(handleEngineChange)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unsubscribeEngine?.()
          unsubscribeEngine = null
        }
      }
    },
  }
}

function sparseArrayUpdate<Row>(base: readonly Row[], replacements: ReadonlyMap<number, Row>): readonly Row[] {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) {
        const replacement = replacements.get(Number(property))
        if (replacement !== undefined) return replacement
      }
      return Reflect.get(target, property, receiver)
    },
  })
}
