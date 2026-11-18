import { describe, expect, it, vi } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import type { GridKernelDataSource as GridDataSource } from '../data/kernel-data-source.js'
import { testGridSource } from '../../tests/unit/authority.js'
import { getGridInteractionPort } from './controller-interaction.js'
import { createGridColumnHelper } from '../cell-types/column-helper.js'
import type { GridControllerSnapshot, GridRuntimeCellEffect, GridValueResult } from '../model/grid-model.js'
import { createGridController } from './grid-controller.js'
import type { GridController, GridCommandResult, GridEffectResult, GridTransactionContext } from './controller-contracts.js'

type Row = Readonly<{ id: string; name: string; quantity: number }>
type Snapshot = GridControllerSnapshot<Row, string>
const registry = createStandardCellTypeRegistry<Row>()
const cell = { rowKey: 'a', columnKey: 'name' }

const column = createGridColumnHelper<Row>()
function fixture() {
  return testGridSource<Row>([{ id: 'a', name: 'Visible', quantity: 1 }], [
    column.field('name', { label: 'Name', type: 'string', filterable: true }),
    column.field('quantity', { label: 'Quantity', type: 'number' }),
  ])
}
function source() { return fixture().dataSource }
function controller(dataSource: GridDataSource<Row, string, StandardGridCellTypeSchema> = source()) {
  // Tests specializing a subset of the columns also specialize their storage bindings.
  const present = new Set(dataSource.columns.map(column => column.key))
  return createGridController({ dataSource: { ...dataSource, model: { ...dataSource.model,
    columns: dataSource.model.columns.filter(binding => present.has(binding.columnKey)) } }, cellBehaviors: registry.behaviors })
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
    const { dataSource, server } = fixture()
    const commit = server.source.submit
    const grid = controller({ ...dataSource, persistence: { mode, debounceMs: 800 } })
    try {
      grid.dispatch({ type: 'cell/set-value', cell, value: 'First' })
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Latest' })
      expect(commit).not.toHaveBeenCalled()
      if (mode === 'manual-save') {
        await vi.advanceTimersByTimeAsync(1000)
        expect(commit).not.toHaveBeenCalled()
        expect(await grid.save()).toMatchObject({ status: 'confirmed' })
      } else if (mode === 'auto-save') {
        await vi.advanceTimersByTimeAsync(799)
        expect(commit).not.toHaveBeenCalled()
      }
      await vi.runAllTimersAsync()
      await vi.waitFor(() => expect(grid.getSnapshot().draft.dirtyCells).toEqual([]))
      expect(commit).toHaveBeenCalledTimes(1)
      expect(commit.mock.calls[0]?.[0].items).toMatchObject([{ kind: 'update', after: { name: 'Latest' } }])
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
      expect(grid.getSnapshot().persistence.status).toBe('idle')
    } finally {
      grid.destroy()
      vi.useRealTimers()
    }
  })

  it('cancels a scheduled auto-save when switching to manual mode', async () => {
    vi.useFakeTimers()
    const { dataSource, server } = fixture()
    const commit = server.source.submit
    const grid = controller({ ...dataSource, persistence: { mode: 'auto-save', debounceMs: 800 } })
    try {
      grid.dispatch({ type: 'cell/set-value', cell, value: 'Pending' })
      grid.dispatch({ type: 'persistence/set-mode', mode: 'manual-save' })
      await vi.runAllTimersAsync()
      expect(commit).not.toHaveBeenCalled()
      expect(grid.getSnapshot().draft.dirtyCells).toHaveLength(1)
      grid.dispatch({ type: 'persistence/set-mode', mode: 'immediate' })
      await vi.runAllTimersAsync()
      await vi.waitFor(() => expect(grid.getSnapshot().draft.dirtyCells).toEqual([]))
      expect(commit).toHaveBeenCalledTimes(1)
      expect(grid.getSnapshot().draft.dirtyCells).toEqual([])
    } finally {
      grid.destroy()
      vi.useRealTimers()
    }
  })

  it('queues authority published by a setter until the local command has committed', () => {
    const { dataSource, server } = fixture()
    let emitted = false
    let callbackRead: Snapshot | undefined
    const grid = controller({
      ...dataSource,
      columns: [{
        key: 'name', label: 'Name', type: 'string', getValue: (row) => row.name,
        setValue: (row, name) => {
          if (!emitted) {
            emitted = true
            dataSource.publish(server.snapshot([{ id: 'a', name: 'Visible', quantity: 2 }], 2))
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

  it('denies a host result that tries to cancel a different task', async () => {
    let signal: AbortSignal | undefined
    let resolve: ((value: GridEffectResult) => void) | undefined
    const grid = createGridController<Row, string, StandardGridCellTypeSchema, string>({
      dataSource: source(), cellBehaviors: registry.behaviors,
      // @ts-expect-error An untyped host returning commands is also rejected at runtime.
      effects: { run: (effect, context) => {
        if (effect === 'long') {
          signal = context.signal
          return new Promise<GridEffectResult>((done) => { resolve = done })
        }
        return [
          { type: 'controller/cancel-effect', id: 'long' },
          { get type(): 'feedback/clear' { throw new Error('Discard cancellation') } },
        ]
      } },
    })
    grid.dispatch({ type: 'controller/run-effect', request: { id: 'long', effect: 'long', owner: { kind: 'cell', cell } } })
    await Promise.resolve()
    grid.dispatch({ type: 'controller/run-effect', request: { id: 'batch', effect: 'batch', owner: { kind: 'controller' } } })
    await vi.waitFor(() => expect(grid.getSnapshot().feedback.items[0]?.message).toContain('no authorized write targets'))
    expect(signal?.aborted).toBe(false)
    resolve!({ kind: 'value', value: 'Still active' })
    await vi.waitFor(() => expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Still active'))
    expect(grid.dispatch({ type: 'controller/run-effect', request: { id: 'batch', effect: 'batch', owner: { kind: 'controller' } } }).accepted).toBe(true)
    grid.destroy()
  })

  it('denies persistence control commands from a controller-owned host result', async () => {
    const { dataSource, server } = fixture()
    const commit = server.source.submit
    const grid = createGridController<Row, string, StandardGridCellTypeSchema, string>({
      dataSource: { ...dataSource, persistence: dataSource.persistence },
      cellBehaviors: registry.behaviors,
      // @ts-expect-error Task results cannot change persistence mode.
      effects: { run: () => [
        { type: 'persistence/set-mode', mode: 'immediate' },
        { get type(): 'feedback/clear' { throw new Error('Invalid effect command') } },
      ] },
    })
    grid.dispatch({ type: 'cell/set-value', cell, value: 'Preserved' })
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'run', owner: { kind: 'controller' } } })
    await vi.waitFor(() => expect(grid.getSnapshot().feedback.items[0]?.message).toContain('no authorized write targets'))
    expect(grid.getSnapshot().persistence.status).toBe('idle')
    expect(commit).not.toHaveBeenCalled()
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    await vi.waitFor(() => expect(grid.getSnapshot().persistence.status).toBe('idle'))
    expect(commit).toHaveBeenCalledTimes(1)
    grid.destroy()
  })

  it('applies a cell effect, closes its editor and schedules saving in one notification', async () => {
    const grid = effectController(async () => ({ ok: true, value: 'Resolved' }))
    grid.dispatch({ type: 'edit/start', cell })
    await grid.refresh()
    const observations: Snapshot[] = []
    grid.subscribe(() => observations.push(grid.getSnapshot()))
    expect(grid.dispatch({ type: 'cell/run-effect', cell, effect: 'resolve', input: null }).accepted).toBe(true)
    await vi.waitFor(() => expect(grid.getSnapshot().edit).toBeNull())
    expect(observations.filter(snapshot => snapshot.draft.rows[0]?.name === 'Resolved')).toHaveLength(1)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Resolved')
    expect(grid.getSnapshot().draft.undoStack).toHaveLength(1)
    expect(grid.getSnapshot().draft.savePlan.canSave).toBe(true)
    grid.destroy()
  })

  it('retains the replaced result without applying it over the latest cell effect', async () => {
    const complete: Array<(result: GridValueResult<unknown>) => void> = []
    const grid = effectController(() => new Promise((resolve) => complete.push(resolve)))
    grid.dispatch({ type: 'cell/run-effect', cell, effect: 'resolve', input: null })
    await Promise.resolve()
    grid.dispatch({ type: 'cell/run-effect', cell, effect: 'resolve', input: null })
    await Promise.resolve()
    complete[1]!({ ok: true, value: 'Newest' })
    await vi.waitFor(() => expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Newest'))
    complete[0]!({ ok: true, value: 'Stale' })
    await vi.waitFor(() => expect(grid.getSnapshot().pendingEffects).toHaveLength(1))
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Newest')
    grid.destroy()
  })

  it('rejects all proposed host values when one cell fails validation', async () => {
    const grid = createGridController<Row, string, StandardGridCellTypeSchema, string>({
      dataSource: source(), cellBehaviors: registry.behaviors,
      effects: { run: async () => ({ kind: 'values', values: ['Accepted first', { invalid: true }] }) },
    })
    const observations: Snapshot[] = []
    grid.subscribe(() => observations.push(grid.getSnapshot()))
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'run', owner: { kind: 'cells', write: [cell, { ...cell, columnKey: 'quantity' }] } } })
    await vi.waitFor(() => expect(grid.getSnapshot().feedback.items).toHaveLength(1))
    expect(observations.every(snapshot => snapshot.draft.rows[0]?.name === 'Visible')).toBe(true)
    expect(grid.getSnapshot().pendingEffects).toHaveLength(1)
    expect(grid.getSnapshot().draft.undoStack).toHaveLength(0)
    grid.destroy()
  })

  it('publishes commit acknowledgment, draft replay and persistence settlement in one event', async () => {
    const grid = controller()
    grid.dispatch({ type: 'cell/set-value', cell, value: 'Saved' })
    const saving = grid.save()
    const observed: Snapshot[] = []
    grid.subscribe(() => observed.push(grid.getSnapshot()))
    expect(await saving).toMatchObject({ status: 'confirmed' })
    const settled = observed.filter(snapshot => snapshot.persistence.status === 'idle')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({
      source: { version: 'v2', rows: [{ name: 'Saved' }] },
      draft: { dirtyCells: [], baselineVersion: 'v2' },
      persistence: { inFlightOperationId: null, pendingDraftRevision: null },
    })
    grid.destroy()
  })

  it('blocks disposal during a save and finishes the accepted write exactly once', async () => {
    const { dataSource, server } = fixture()
    const grid = controller(dataSource)
    grid.dispatch({ type: 'cell/set-value', cell, value: 'Save me' })
    const closures: string[] = []
    grid.subscribe(() => {
      if (grid.getSnapshot().persistence.status === 'saving') closures.push(grid.destroy().status)
    })
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    expect(closures.length).toBeGreaterThan(0)
    expect(closures.every(status => status === 'blocked')).toBe(true)
    expect(server.source.submit).toHaveBeenCalledTimes(1)
    expect(grid.destroy().status).toBe('closed')
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
    expect(result).toMatchObject({ accepted: true, revision: base.revision + 1, value: { committed: true, moved: false } })
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      edit: null,
      draft: { rows: [{ id: 'a', name: 'Hidden' }], undoStack: [{ label: 'Edit cell' }] },
      view: { visibleRowKeys: [] },
      interaction: { activeCell: null },
      persistence: { status: 'idle' },
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
    const attempts: GridCommandResult[] = []
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
    expect(attempts.every((attempt) => !attempt.accepted && attempt.issue.code === 'busy')).toBe(true)
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
    getGridInteractionPort(grid).send({ type: 'viewport/resized', width: 600, height: 400 })
    getGridInteractionPort(grid).send({ type: 'viewport/scrolled', scrollLeft: 0, scrollTop: 0 })
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
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    const base = grid.getSnapshot()
    expect(grid.applyTransaction((transaction) => {
      transaction.set(nameColumn, 'a', 'Discarded')
      throw new Error('Stop')
    })).toMatchObject({ accepted: false, issues: [{ domainCode: 'builder-exception' }] })
    expect(grid.applyTransaction(async (transaction) => {
      transaction.set(nameColumn, 'a', 'Also discarded')
      await Promise.resolve()
      transaction.set(nameColumn, 'a', 'Too late')
    })).toMatchObject({ accepted: false, issues: [{ domainCode: 'async-builder' }] })
    expect(grid.applyTransaction((transaction) => {
      transaction.set(nameColumn, 'a', 'Discarded on preparation failure')
    }, { get label(): string { throw new Error('Invalid label') } })).toMatchObject({
      accepted: false,
      issues: [{ code: 'adapter-error', message: 'Invalid label' }],
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
    expect(result).toMatchObject({ accepted: false, issues: [{ code: 'limit-exceeded', domainCode: 'mutation-limit' }] })
    expect(create).toHaveBeenCalledTimes(1)
    expect(grid.getSnapshot()).toBe(base)
    grid.destroy()
  })

  it.each(['before', 'after'])('installs a snapshot published %s registering the subscription', timing => {
    const { dataSource, server } = fixture()
    const unsubscribe = vi.fn()
    const grid = controller({
      ...dataSource,
      subscribe(listener) {
        const latest = server.snapshot([{ id: 'a', name: 'Latest', quantity: 2 }], 2)
        if (timing === 'before') dataSource.publish(latest)
        const release = dataSource.subscribe(listener)
        if (timing === 'after') dataSource.publish(latest)
        return () => { release(); unsubscribe() }
      },
    })
    expect(grid.getSnapshot().source.version).toBe('v2')
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('Latest')
    expect(grid.getSnapshot().source.rows[0]?.name).toBe('Latest')
    grid.destroy()
    grid.destroy()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
