import { describe, expect, it, vi } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import type { GridDataSource } from '../data/data-source.js'
import type { GridControllerSnapshot, GridRuntimeCellEffect, GridValueResult } from '../model/grid-model.js'
import { createGridController } from './grid-controller.js'
import type { GridController, GridDispatchResult, GridEffectResult, GridTransactionContext } from './controller-contracts.js'

type Row = Readonly<{ id: string; name: string; quantity: number }>
type Snapshot = GridControllerSnapshot<Row, string>
const registry = createStandardCellTypeRegistry<Row>()
const cell = { rowKey: 'a', columnKey: 'name' }

function source(): GridDataSource<Row, string, StandardGridCellTypeSchema> {
  const initial = {
    rows: [{ id: 'a', name: 'Visible', quantity: 1 }],
    status: 'ready' as const,
    version: 'v1',
    scope: { kind: 'complete' as const },
  }
  return {
    columns: [{
      key: 'name', label: 'Name', type: 'string', filterable: true,
      getValue: (row) => row.name,
      setValue: (row, name) => ({ ...row, name }),
    }, {
      key: 'quantity', label: 'Quantity', type: 'number',
      getValue: (row) => row.quantity,
      setValue: (row, quantity) => ({ ...row, quantity }),
    }],
    getRowKey: (row) => row.id,
    getSnapshot: () => initial,
    subscribe: () => () => undefined,
    persistence: {
      mode: 'manual-save',
      commit: async (request) => ({
        operationId: request.operationId,
        applied: { ...initial, rows: request.rows, version: 'v2' },
      }),
    },
  }
}

function controller(dataSource = source()) {
  return createGridController({ dataSource, cellBehaviors: registry.behaviors })
}

function effectController(run: GridRuntimeCellEffect<Row>['run']) {
  return createGridController({
    dataSource: source(),
    cellBehaviors: {
      resolve: (type, options) => {
        const behavior = registry.behaviors.resolve(type, options)
        return behavior ? {
          ...behavior,
          effects: { resolve: (id) => id === 'resolve' ? { id, concurrency: 'replace-cell' as const, run } : undefined },
        } : undefined
      },
    },
  })
}

describe('GridController atomic command workflows', () => {
  it.each(['manual-save', 'auto-save', 'immediate'] as const)('saves the latest draft with %s scheduling', async (mode) => {
    vi.useFakeTimers()
    const dataSource = source()
    const commit = vi.fn(dataSource.persistence.commit)
    const grid = controller({ ...dataSource, persistence: { mode, commit } })
    try {
      grid.dispatch({ type: 'cell/set-value', cell, value: 'First' })
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Latest' })
      expect(commit).not.toHaveBeenCalled()
      if (mode === 'manual-save') {
        await vi.advanceTimersByTimeAsync(1000)
        expect(commit).not.toHaveBeenCalled()
        expect(grid.dispatch({ type: 'persistence/save' }).accepted).toBe(true)
      } else if (mode === 'auto-save') {
        await vi.advanceTimersByTimeAsync(799)
        expect(commit).not.toHaveBeenCalled()
      }
      await vi.runAllTimersAsync()
      expect(commit).toHaveBeenCalledTimes(1)
      expect(commit.mock.calls[0]?.[0].rows[0]?.name).toBe('Latest')
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
      expect(grid.getSnapshot().persistence.status).toBe('idle')
    } finally {
      grid.destroy()
      vi.useRealTimers()
    }
  })

  it('cancels a scheduled auto-save when switching to manual mode', async () => {
    vi.useFakeTimers()
    const dataSource = source()
    const commit = vi.fn(dataSource.persistence.commit)
    const grid = controller({ ...dataSource, persistence: { mode: 'auto-save', commit } })
    try {
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Pending' })
      grid.dispatch({ type: 'persistence/set-mode', mode: 'manual-save' })
      await vi.runAllTimersAsync()
      expect(commit).not.toHaveBeenCalled()
      expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(1)
      grid.dispatch({ type: 'persistence/set-mode', mode: 'immediate' })
      await vi.runAllTimersAsync()
      expect(commit).toHaveBeenCalledTimes(1)
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    } finally {
      grid.destroy()
      vi.useRealTimers()
    }
  })

  it('queues authority published by a setter until the local command has committed', () => {
    const dataSource = source()
    let published = dataSource.getSnapshot()
    let notify = () => {}
    let emitted = false
    let callbackRead: Snapshot | undefined
    const grid = controller({
      ...dataSource,
      getSnapshot: () => published,
      subscribe: (listener) => { notify = listener; return () => {} },
      columns: [{
        key: 'name', label: 'Name', type: 'string', getValue: (row) => row.name,
        setValue: (row, name) => {
          if (!emitted) {
            emitted = true
            published = { ...published, version: 'v2', rows: [{ id: 'a', name: 'Visible', quantity: 2 }] }
            notify()
            callbackRead = grid.getSnapshot()
          }
          return { ...row, name }
        },
      }, dataSource.columns[1]!],
    })
    const base = grid.getSnapshot()
    const observed: Snapshot[] = []
    grid.subscribe(() => observed.push(grid.getSnapshot()))
    const result = grid.dispatch({ type: 'cell/set-value', cell, value: 'Local' })
    expect(callbackRead).toBe(base)
    expect(result).toMatchObject({ accepted: true, revision: base.revision + 1 })
    expect(observed).toHaveLength(2)
    expect(observed[0]).toMatchObject({ source: { version: 'v1' }, draft: { rows: [{ name: 'Local', quantity: 1 }] } })
    expect(observed[1]).toMatchObject({ source: { version: 'v2' }, draft: { rows: [{ name: 'Local', quantity: 2 }] } })
    expect(grid.getSnapshot().revision).toBe(base.revision + 2)
    grid.destroy()
  })

  it('does not abort an existing effect when cancellation belongs to a failed candidate', async () => {
    let signal: AbortSignal | undefined
    let resolve: ((value: GridEffectResult<string, string>) => void) | undefined
    const grid = createGridController<Row, string, StandardGridCellTypeSchema, string>({
      dataSource: source(), cellBehaviors: registry.behaviors,
      effects: { run: (effect, context) => {
        if (effect === 'long') {
          signal = context.signal
          return new Promise<GridEffectResult<string, string>>((done) => { resolve = done })
        }
        return [
          { type: 'controller/cancel-effect', id: 'long' },
          { get type(): 'feedback/clear' { throw new Error('Discard cancellation') } },
        ]
      } },
    })
    grid.dispatch({ type: 'controller/run-effect', request: { id: 'long', effect: 'long', owner: { kind: 'controller' } } })
    await Promise.resolve()
    grid.dispatch({ type: 'controller/run-effect', request: { id: 'batch', effect: 'batch', owner: { kind: 'controller' } } })
    await vi.waitFor(() => expect(grid.getSnapshot().feedback.items[0]?.message).toBe('Discard cancellation'))
    expect(signal?.aborted).toBe(false)
    resolve!({ type: 'cell/set-value', cell, value: 'Still active' })
    await vi.waitFor(() => expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Still active'))
    expect(grid.dispatch({ type: 'controller/run-effect', request: { id: 'batch', effect: 'batch', owner: { kind: 'controller' } } }).accepted).toBe(true)
    grid.destroy()
  })

  it('rolls back persistence control state and its outbox when a later preparation step throws', async () => {
    const dataSource = source()
    const commit = vi.fn(dataSource.persistence.commit)
    const grid = createGridController<Row, string, StandardGridCellTypeSchema, string>({
      dataSource: { ...dataSource, persistence: { ...dataSource.persistence, commit } },
      cellBehaviors: registry.behaviors,
      effects: { run: () => [
        { type: 'persistence/save' },
        { get type(): 'feedback/clear' { throw new Error('Invalid effect command') } },
      ] },
    })
    grid.dispatch({ type: 'cell/set-value', cell, value: 'Preserved' })
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'run', owner: { kind: 'controller' } } })
    await vi.waitFor(() => expect(grid.getSnapshot().feedback.items[0]?.message).toContain('Invalid effect command'))
    expect(grid.getSnapshot().persistence.status).toBe('idle')
    expect(commit).not.toHaveBeenCalled()
    expect(grid.dispatch({ type: 'persistence/save' }).payload).toHaveProperty('operationId')
    await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
    expect(commit).toHaveBeenCalledTimes(1)
    grid.destroy()
  })

  it('applies a cell effect, closes its editor and schedules saving in one notification', async () => {
    const grid = effectController(async () => ({ ok: true, value: 'Resolved' }))
    grid.dispatch({ type: 'edit/start', cell })
    const listener = vi.fn()
    grid.subscribe(listener)
    expect(grid.dispatch({ type: 'cell/run-effect', cell, effect: 'resolve', input: null }).accepted).toBe(true)
    await vi.waitFor(() => expect(grid.getSnapshot().edit).toBeNull())
    expect(listener).toHaveBeenCalledTimes(1)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Resolved')
    expect(grid.getSnapshot().draft.undoStack).toHaveLength(1)
    expect(grid.getSnapshot().persistence.pendingDraftRevision).toBe(grid.getSnapshot().draft.revision)
    grid.destroy()
  })

  it('ignores a replaced cell effect even if its Promise resolves later', async () => {
    const complete: Array<(result: GridValueResult<unknown>) => void> = []
    const grid = effectController(() => new Promise((resolve) => complete.push(resolve)))
    grid.dispatch({ type: 'cell/run-effect', cell, effect: 'resolve', input: null })
    await Promise.resolve()
    grid.dispatch({ type: 'cell/run-effect', cell, effect: 'resolve', input: null })
    await Promise.resolve()
    complete[1]!({ ok: true, value: 'Newest' })
    await vi.waitFor(() => expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Newest'))
    const base = grid.getSnapshot()
    complete[0]!({ ok: true, value: 'Stale' })
    await Promise.resolve()
    await Promise.resolve()
    expect(grid.getSnapshot()).toBe(base)
    grid.destroy()
  })

  it('executes external completion commands in order and stops at a rejected command', async () => {
    const grid = createGridController<Row, string, StandardGridCellTypeSchema, string>({
      dataSource: source(), cellBehaviors: registry.behaviors,
      effects: { run: async () => [
        { type: 'cell/set-value', cell, value: 'Accepted first' },
        { type: 'cell/set-value', cell: { ...cell, rowKey: 'missing' }, value: 'Rejected' },
        { type: 'cell/set-value', cell, value: 'Must not run' },
      ] },
    })
    const listener = vi.fn()
    grid.subscribe(listener)
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'run', owner: { kind: 'controller' } } })
    await vi.waitFor(() => expect(grid.getSnapshot().feedback.items).toHaveLength(1))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Accepted first')
    expect(grid.getSnapshot().draft.undoStack).toHaveLength(1)
    grid.destroy()
  })

  it('publishes commit acknowledgment, draft replay and persistence settlement in one event', async () => {
    const grid = controller()
    grid.dispatch({ type: 'cell/set-value', cell, value: 'Saved' })
    grid.dispatch({ type: 'persistence/save' })
    const base = grid.getSnapshot()
    const observed: Snapshot[] = []
    grid.subscribe(() => observed.push(grid.getSnapshot()))
    await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      revision: base.revision + 1,
      source: { version: 'v2', rows: [{ name: 'Saved' }] },
      draft: { dirtyCells: [], baselineVersion: 'v2' },
      persistence: { inFlightOperationId: null, pendingDraftRevision: null },
    })
    grid.destroy()
  })

  it('does not invoke a queued remote write after a subscriber destroys the controller', async () => {
    const dataSource = source()
    const commit = vi.fn(dataSource.persistence.commit)
    const grid = controller({ ...dataSource, persistence: { ...dataSource.persistence, commit } })
    grid.dispatch({ type: 'cell/set-value', cell, value: 'Never sent' })
    grid.subscribe(() => {
      if (grid.getSnapshot().persistence.status === 'saving') grid.destroy()
    })
    grid.dispatch({ type: 'persistence/save' })
    await Promise.resolve()
    expect(commit).not.toHaveBeenCalled()
  })

  it('publishes edited data, filtered view, session closure and save scheduling together', () => {
    const grid = controller()
    grid.dispatch({ type: 'view/set-global-filter', value: 'Visible' })
    grid.dispatch({ type: 'edit/start', cell })
    grid.dispatch({ type: 'edit/change', value: 'Hidden' })
    const base = grid.getSnapshot()
    const observations: Snapshot[] = []
    grid.subscribe(() => observations.push(grid.getSnapshot()))

    const result = grid.dispatch({ type: 'edit/commit-and-move', direction: 'next' })
    expect(result).toMatchObject({ accepted: true, revision: base.revision + 1, payload: { committed: true, moved: false } })
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      edit: null,
      draft: { rows: [{ id: 'a', name: 'Hidden' }], undoStack: [{ label: 'Edit cell' }] },
      view: { visibleRowKeys: [] },
      interaction: { activeCell: null },
      persistence: { pendingDraftRevision: grid.getSnapshot().draft.revision },
    })
    grid.destroy()
  })

  it('publishes one invalid-editor result without modifying rows or history', () => {
    const grid = controller()
    grid.dispatch({ type: 'edit/start', cell: { ...cell, columnKey: 'quantity' } })
    grid.dispatch({ type: 'edit/change', value: 'invalid' })
    const base = grid.getSnapshot()
    const observed: Snapshot[] = []
    grid.subscribe(() => observed.push(grid.getSnapshot()))

    expect(grid.dispatch({ type: 'edit/commit' })).toMatchObject({ accepted: false, revision: base.revision + 1 })
    expect(observed).toHaveLength(1)
    expect(grid.getSnapshot().draft).toBe(base.draft)
    expect(grid.getSnapshot().edit).toMatchObject({ draftValue: 'invalid', status: 'invalid' })
    grid.destroy()
  })

  it('keeps public snapshots committed while callbacks derive a candidate view', () => {
    const dataSource = source()
    let grid: GridController<Row, string, StandardGridCellTypeSchema> | undefined
    let reading = false
    const observed: Snapshot[] = []
    grid = controller({
      ...dataSource,
      columns: [{
        key: 'name', label: 'Name', type: 'string', filterable: true,
        setValue: (row, name) => ({ ...row, name }),
        getValue: (row) => {
          if (grid && reading) observed.push(grid.getSnapshot())
          return row.name
        },
      }, dataSource.columns[1]!],
    })
    grid.dispatch({ type: 'view/set-global-filter', value: 'Visible' })
    grid.dispatch({ type: 'edit/start', cell })
    grid.dispatch({ type: 'edit/change', value: 'Hidden' })
    const base = grid.getSnapshot()
    reading = true
    expect(grid.dispatch({ type: 'edit/commit' }).accepted).toBe(true)
    reading = false
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every((snapshot) => snapshot === base)).toBe(true)
    expect(grid.getSnapshot().view.visibleRowKeys).toEqual([])
    grid.destroy()
  })

  it('rejects callback and subscriber reentry without replacing the outer command result', () => {
    const dataSource = source()
    let grid: GridController<Row, string, StandardGridCellTypeSchema> | undefined
    const attempts: GridDispatchResult[] = []
    grid = controller({
      ...dataSource,
      columns: [{
        key: 'name', label: 'Name', type: 'string', getValue: (row) => row.name,
        setValue: (row, name) => {
          attempts.push(grid!.dispatch({ type: 'cell/set-value', cell, value: 'Nested setter' }))
          return { ...row, name }
        },
      }],
    })
    grid.subscribe(() => {
      attempts.push(grid!.dispatch({ type: 'cell/set-value', cell, value: 'Nested subscriber' }))
    })
    const result = grid.dispatch({ type: 'cell/set-value', cell, value: 'Outer' })
    expect(result.accepted).toBe(true)
    expect(attempts).toHaveLength(2)
    expect(attempts.every((attempt) => !attempt.accepted && attempt.reason?.includes('another input'))).toBe(true)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Outer')
    expect(grid.getSnapshot().draft.undoStack).toHaveLength(1)
    grid.destroy()
  })

  it('leaves the snapshot unchanged for rejected setters and for empty transactions', () => {
    const dataSource = source()
    const grid = controller({
      ...dataSource,
      columns: [{
        key: 'name', label: 'Name', type: 'string', getValue: (row) => row.name,
        setValue: () => { throw new Error('Setter unavailable') },
      }],
    })
    const initial = grid.getSnapshot()
    const listener = vi.fn()
    grid.subscribe(listener)
    expect(grid.dispatch({ type: 'cell/set-value', cell, value: 'New' }).accepted).toBe(false)
    expect(grid.applyTransaction(() => {}).accepted).toBe(true)
    expect(grid.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()
    grid.destroy()
  })

  it('does not rebuild the draft row index when only the viewport changes', () => {
    const dataSource = source()
    const getRowKey = vi.fn(dataSource.getRowKey)
    const grid = controller({ ...dataSource, getRowKey })
    getRowKey.mockClear()
    grid.dispatch({ type: 'viewport/resized', width: 600, height: 400 })
    grid.dispatch({ type: 'viewport/scrolled', scrollLeft: 0, scrollTop: 0 })
    expect(getRowKey).not.toHaveBeenCalled()
    grid.destroy()
  })

  it('runs a builder once, stages changes privately and closes its context after commit', () => {
    const dataSource = source()
    const nameColumn = dataSource.columns.find((column) => column.type === 'string')!
    const grid = controller(dataSource)
    const base = grid.getSnapshot()
    const listener = vi.fn()
    grid.subscribe(listener)
    let captured: GridTransactionContext<Row, string, StandardGridCellTypeSchema> | undefined
    const build = vi.fn((transaction: GridTransactionContext<Row, string, StandardGridCellTypeSchema>) => {
      captured = transaction
      expect(transaction.base).toBe(base)
      transaction.set(nameColumn, 'a', 'Changed')
      expect(grid.getSnapshot()).toBe(base)
      expect(grid.applyTransaction(() => {}).accepted).toBe(false)
    })
    expect(grid.applyTransaction(build).accepted).toBe(true)
    expect(build).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Changed')
    expect(() => captured!.set(nameColumn, 'a', 'Late')).toThrow()
    expect(grid.getSnapshot().draft.undoStack).toHaveLength(1)
    grid.destroy()
  })

  it('discards staged writes when a builder throws or returns a Promise', async () => {
    const dataSource = source()
    const nameColumn = dataSource.columns.find((column) => column.type === 'string')!
    const grid = controller(dataSource)
    const base = grid.getSnapshot()
    expect(grid.applyTransaction((transaction) => {
      transaction.set(nameColumn, 'a', 'Discarded')
      throw new Error('Stop')
    })).toMatchObject({ accepted: false, issues: [{ code: 'builder-exception' }] })
    expect(grid.applyTransaction(async (transaction) => {
      transaction.set(nameColumn, 'a', 'Also discarded')
      await Promise.resolve()
      transaction.set(nameColumn, 'a', 'Too late')
    })).toMatchObject({ accepted: false, issues: [{ code: 'async-builder' }] })
    expect(grid.applyTransaction((transaction) => {
      transaction.set(nameColumn, 'a', 'Discarded on preparation failure')
    }, { get label(): string { throw new Error('Invalid label') } })).toMatchObject({
      accepted: false,
      issues: [{ code: 'transaction-exception', message: 'The grid transaction failed: Invalid label' }],
    })
    await Promise.resolve()
    expect(grid.getSnapshot()).toBe(base)
    grid.destroy()
  })

  it('checks transaction cost before calling a row factory', () => {
    const create = vi.fn(() => ({ id: 'b', name: 'New', quantity: 0 }))
    const grid = createGridController({
      dataSource: { ...source(), rows: { create } },
      cellBehaviors: registry.behaviors,
      maxMutations: 1,
    })
    const base = grid.getSnapshot()
    const result = grid.applyTransaction((transaction) => {
      transaction.createRow()
      transaction.createRow()
    })
    expect(result).toMatchObject({ accepted: false, issues: [{ code: 'mutation-limit' }] })
    expect(create).toHaveBeenCalledTimes(1)
    expect(grid.getSnapshot()).toBe(base)
    grid.destroy()
  })

  it.each([false, true])('closes the initial read/subscribe gap (synchronous publication: %s)', (emit) => {
    const dataSource = source()
    let published = dataSource.getSnapshot()
    const unsubscribe = vi.fn()
    const grid = controller({
      ...dataSource,
      getSnapshot: () => published,
      subscribe: (listener) => {
        published = { ...published, version: 'v2', rows: [{ id: 'a', name: 'Latest', quantity: 2 }] }
        if (emit) listener()
        return unsubscribe
      },
    })
    expect(grid.getSnapshot().source.version).toBe('v2')
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Latest')
    expect(grid.getSnapshot().revision).toBe(1)
    grid.destroy()
    grid.destroy()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
