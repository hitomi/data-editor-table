import { describe, expect, it, vi } from 'vitest'
import { deferred, testGridSource } from '../../tests/unit/authority.js'
import type { GridInputCodec } from '../cell-types/input-codec.js'
import { createGridColumnHelper } from '../cell-types/column-helper.js'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import type { FrozenSubmission } from '../kernel/model.js'
import type { SourceMutationResult } from '../kernel/source.js'
import type { GridRuntimeCellEffect, GridValueResult } from '../model/grid-model.js'
import type { GridEffectResult } from './controller-contracts.js'
import { createGridController } from './grid-controller.js'

type Row = { id: string; name: string }
const initial = ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase() }))
const [a, b, c] = initial as [Row, Row, Row]
const cell = (rowKey: string) => ({ rowKey, columnKey: 'name' })
const column = createGridColumnHelper<Row>().field('name', { type: 'string', label: 'Name', bulkEditable: true, sortable: true })

function fixture(valueCodec?: GridInputCodec<unknown>) {
  const { dataSource, server } = testGridSource(initial, [column])
  const registry = createStandardCellTypeRegistry<Row>()
  const task = deferred<GridValueResult<unknown>>()
  const hostTask = deferred<GridEffectResult>()
  const run = vi.fn<GridRuntimeCellEffect<Row>['run']>(() => task.promise)
  const runHost = vi.fn(() => hostTask.promise)
  const grid = createGridController<Row, string, StandardGridCellTypeSchema, string>({
    dataSource: { ...dataSource, ...(valueCodec ? { model: { ...dataSource.model,
      columns: dataSource.model.columns.map(binding => ({ ...binding, valueCodec })),
    } } : {}), rows: { canDelete: () => true, create: () => ({ id: 'temp', name: 'New' }) } },
    cellBehaviors: { resolve(type, options) {
      const behavior = registry.behaviors.resolve(type, options)
      return behavior && { ...behavior, effects: { resolve: id => ({ id, concurrency: 'replace-cell', run }) } }
    } },
    effects: { run: runHost },
  })
  const select = () => grid.dispatch({ type: 'interaction/activate', cell: cell('a'), range: { anchor: cell('a'), focus: cell('b') } })
  const change = async (rows: Row[], entry: 'read' | 'push', replace?: string) => {
    const snapshot = server.snapshot(rows, 2)
    const records = snapshot.rows.map(row => row.identity.key === replace
      ? { ...row, identity: { ...row.identity, incarnation: 'replacement' } } : row)
    const next = { ...snapshot, rows: records, order: records.map(row => row.identity) }
    server.install(next)
    if (entry === 'read') await grid.refresh()
    else dataSource.publish(next)
  }
  return { grid, server, task, hostTask, run, runHost, select, change }
}

describe('operation target ownership at controller entry points', () => {
  it('rejects a delayed row callback that addresses a different row or the current selection', async () => {
    const { grid, server } = fixture()
    await grid.refresh()
    const entityId = grid.getSnapshot().draft.entityAt('a')!
    const target = { kind: 'row' as const, rowKey: 'a', entityId }
    grid.dispatch({ type: 'interaction/activate', cell: cell('b') })
    expect(grid.dispatch({ type: 'rows/delete' }, target)).toMatchObject({ accepted: false, issue: { code: 'stale-target' } })
    expect(grid.dispatch({ type: 'cell/set-value', cell: cell('b'), value: 'wrong row' }, target).accepted).toBe(false)
    expect(grid.dispatch({ type: 'cell/set-value', cell: cell('a'), value: 'original row' }, target).accepted).toBe(true)
    expect((await grid.save()).status).toBe('confirmed')
    expect(server.current().rows.map(row => row.document.name)).toEqual(['original row', 'B', 'C'])
    expect(grid.destroy().status).toBe('closed')
  })

  it.each(['read', 'push'] as const)('deletes exactly the selected entities after a %s inserts another row between them', async entry => {
    const { grid, server, select, change } = fixture()
    select()
    await change([a, c, b], entry)
    expect(grid.getSnapshot().interaction.ranges).toHaveLength(2)
    expect(grid.dispatch({ type: 'rows/delete' }).accepted).toBe(true)
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    expect(server.current().rows.map(row => row.identity.key)).toEqual(['c'])
    grid.destroy()
  })

  it('uses the same selected members after an explicit sort and an authority reorder', async () => {
    const { grid, server, change } = fixture()
    await change([a, c, b], 'push')
    grid.dispatch({ type: 'interaction/activate', cell: cell('a'), range: { anchor: cell('a'), focus: cell('c') } })
    expect(grid.dispatch({ type: 'view/set-sort', sort: [{ columnKey: 'name', direction: 'ascending' }] }).accepted).toBe(true)
    expect(grid.getSnapshot().interaction.ranges).toHaveLength(2)
    expect(grid.dispatch({ type: 'rows/delete' }).accepted).toBe(true)
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    expect(server.current().rows.map(row => row.identity.key)).toEqual(['b'])
    grid.destroy()
  })

  it.each(['rows/delete', 'selection/clear-values'] as const)('%s cannot touch a replacement in a selection without a menu', async type => {
    const { grid, select, change, server } = fixture()
    select()
    await change(initial, 'push', 'b')
    expect(grid.getSnapshot().interaction.ranges).toEqual([])
    grid.dispatch({ type })
    expect(await grid.save()).toMatchObject({ status: 'no-changes' })
    expect(server.source.submit).not.toHaveBeenCalled()
    grid.destroy()
  })

  it.each([true, false])('bulk apply keeps its original members after reorder (replacement = %s)', async replace => {
    const { grid, select, change } = fixture()
    select()
    expect(grid.dispatch({ type: 'bulk/start' }).accepted).toBe(true)
    const draft = { operation: 'set', value: 'changed' }
    grid.dispatch({ type: 'bulk/change', value: draft })
    await change([a, c, b], 'push', replace ? 'b' : undefined)
    expect(grid.dispatch({ type: 'bulk/apply' }).accepted).toBe(!replace)
    expect(grid.getSnapshot().draft.rows.map(row => row.name)).toEqual(replace ? ['A', 'C', 'B'] : ['changed', 'C', 'changed'])
    if (replace) expect(grid.getSnapshot().bulk?.draft).toEqual(draft)
    grid.dispatch({ type: 'bulk/cancel' })
    await grid.save()
    grid.destroy()
  })

  it('preserves the old editor input and refuses its commit, cell task and host task after replacement', async () => {
    const { grid, run, runHost, change } = fixture()
    const target = cell('a')
    grid.dispatch({ type: 'edit/start', cell: target })
    grid.dispatch({ type: 'edit/change', value: 'recover me' })
    await change(initial, 'push', 'a')
    expect(grid.dispatch({ type: 'edit/commit' })).toMatchObject({ accepted: false, issue: { code: 'stale-target' } })
    expect(grid.dispatch({ type: 'cell/run-effect', cell: target, effect: 'task', input: null })).toMatchObject({ accepted: false, issue: { code: 'stale-target' } })
    expect(grid.dispatch({ type: 'controller/run-effect', request: { effect: 'host', owner: { kind: 'edit' } } })).toMatchObject({ accepted: false, issue: { code: 'stale-target' } })
    expect(run).not.toHaveBeenCalled()
    expect(runHost).not.toHaveBeenCalled()
    expect(grid.getSnapshot().edit?.draftValue).toBe('recover me')
    grid.dispatch({ type: 'edit/cancel' })
    grid.destroy()
  })

  it('requires the same edit source for commit, a cell task and a host task', async () => {
    const { grid, run, runHost, change } = fixture()
    const target = cell('a')
    grid.dispatch({ type: 'edit/start', cell: target })
    await change([{ ...a, name: 'Server value' }, b, c], 'push')
    grid.dispatch({ type: 'edit/change', value: 'user input' })
    expect(grid.dispatch({ type: 'edit/commit' })).toMatchObject({ accepted: false, issue: { code: 'conflict' } })
    expect(grid.dispatch({ type: 'cell/run-effect', cell: target, effect: 'task', input: null })).toMatchObject({ accepted: false, issue: { code: 'conflict' } })
    expect(grid.dispatch({ type: 'controller/run-effect', request: { effect: 'host', owner: { kind: 'edit' } } })).toMatchObject({ accepted: false, issue: { code: 'conflict' } })
    expect(run).not.toHaveBeenCalled()
    expect(runHost).not.toHaveBeenCalled()
    expect(grid.getSnapshot().edit?.draftValue).toBe('user input')
    grid.dispatch({ type: 'edit/cancel' })
    grid.destroy()
  })

  it.each([true, false])('requires an explicit target to apply or retry a retained cell task after replacement (success = %s)', async success => {
    const { grid, task, run, change } = fixture()
    const target = cell('a')
    grid.dispatch({ type: 'cell/run-effect', cell: target, effect: 'task', input: 'original input' })
    await Promise.resolve()
    await change(initial, 'read', 'a')
    task.resolve(success ? { ok: true, value: 'output' } : { ok: false, issue: { code: 'error', message: 'Try again' } })
    await vi.waitFor(() => expect(grid.getSnapshot().pendingEffects).toHaveLength(1))
    const effectId = grid.getSnapshot().pendingEffects[0]!.id
    expect(grid.dispatch({ type: 'effect/reapply-cell-result', effectId })).toMatchObject({ accepted: false, issue: { code: 'stale-target' } })
    expect(run).toHaveBeenCalledTimes(1)
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('A')
    expect(grid.dispatch({ type: 'effect/reapply-cell-result', effectId, target: cell('c') }).accepted).toBe(true)
    if (success) expect(grid.getSnapshot().draft.rows[2]?.name).toBe('output')
    else {
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      expect(run.mock.calls[1]?.[1].row.id).toBe('c')
      grid.dispatch({ type: 'effect/discard-result', effectId: grid.getSnapshot().pendingEffects[0]!.id })
    }
    await grid.save()
    grid.destroy()
  })

  it('revokes an edit-owned host task when the row is replaced before its first microtask', async () => {
    const { grid, change, runHost } = fixture()
    grid.dispatch({ type: 'edit/start', cell: cell('a') })
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'host', owner: { kind: 'edit' } } })
    await change(initial, 'push', 'a')
    await vi.waitFor(() => expect(grid.getSnapshot().pendingEffects).toHaveLength(1))
    expect(runHost).not.toHaveBeenCalled()
    grid.dispatch({ type: 'effect/discard-result', effectId: grid.getSnapshot().pendingEffects[0]!.id })
    grid.dispatch({ type: 'edit/cancel' })
    grid.destroy()
  })

  it.each(['edit', 'bulk', 'cell task', 'host cell', 'host batch'] as const)('keeps the original entity across an assigned key for %s', async entry => {
    const { grid, server, task, hostTask } = fixture()
    expect(grid.dispatch({ type: 'rows/add' }).accepted).toBe(true)
    const sent = deferred<FrozenSubmission>(), response = deferred<SourceMutationResult>()
    server.source.submit.mockImplementationOnce(request => { sent.resolve(request); return response.promise })
    const save = grid.save()
    const request = await sent.promise
    const target = cell('temp')
    const entityId = grid.getSnapshot().draft.entityAt('temp')
    grid.dispatch({ type: 'interaction/activate', cell: target })
    if (entry === 'bulk') {
      expect(grid.dispatch({ type: 'bulk/start' }).accepted).toBe(true)
      grid.dispatch({ type: 'bulk/change', value: { operation: 'set', value: 'owned' } })
    } else if (entry === 'edit') {
      grid.dispatch({ type: 'edit/start', cell: target })
      grid.dispatch({ type: 'edit/change', value: 'owned' })
    } else if (entry === 'host cell' || entry === 'host batch') {
      grid.dispatch({ type: 'controller/run-effect', request: { effect: 'derive',
        owner: entry === 'host cell' ? { kind: 'cell', cell: target } : { kind: 'cells', write: [target], read: [cell('b')] },
      } })
    } else grid.dispatch({ type: 'cell/run-effect', cell: target, effect: 'task', input: 'original' })
    response.resolve(server.apply(request, { create: row => ({ ...row, id: 'assigned' }) }))
    expect(await save).toMatchObject({ status: 'confirmed' })
    expect(grid.getSnapshot().draft.entityAt('assigned')).toBe(entityId)
    expect(grid.getSnapshot().interaction.activeCell).toEqual(cell('assigned'))
    if (entry === 'bulk') expect(grid.dispatch({ type: 'bulk/apply' }).accepted).toBe(true)
    else if (entry === 'edit') expect(grid.dispatch({ type: 'edit/commit' }).accepted).toBe(true)
    else if (entry === 'host cell') hostTask.resolve({ kind: 'value', value: 'owned' })
    else if (entry === 'host batch') hostTask.resolve({ kind: 'values', values: ['owned'] })
    else task.resolve({ ok: true, value: 'owned' })
    await vi.waitFor(() => expect(grid.getSnapshot().draft.rows.find(row => row.id === 'assigned')?.name).toBe('owned'))
    expect(grid.getSnapshot().pendingEffects).toHaveLength(0)
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    grid.destroy()
  })

  it.each(['cell', 'controller'] as const)('never interprets a %s host result as a selection command', async kind => {
    const { grid, hostTask, select, server } = fixture()
    select()
    const owner = kind === 'cell' ? { kind, cell: cell('a') } : { kind }
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'confirm', owner } })
    await Promise.resolve()
    grid.dispatch({ type: 'interaction/activate', cell: cell('c') })
    // @ts-expect-error JavaScript adapters may return an old command instead of a value.
    hostTask.resolve({ type: 'rows/delete' })
    await vi.waitFor(() => expect(grid.getSnapshot().activeEffectCount).toBe(0))
    const effectId = grid.getSnapshot().pendingEffects[0]!.id
    expect(grid.dispatch({ type: 'effect/inspect-result', effectId })).toMatchObject({ accepted: true, value: { state: 'failed' } })
    expect(grid.dispatch({ type: 'effect/apply-host-result', effectId }).accepted).toBe(false)
    expect(await grid.save()).toMatchObject({ status: 'no-changes' })
    expect(server.current().rows).toHaveLength(3)
    grid.dispatch({ type: 'effect/discard-result', effectId })
    grid.destroy()
  })

  it.each(['row', 'edit'] as const)('accepts a matching %s callback credential for a host cell task', async kind => {
    const { grid, hostTask } = fixture()
    const target = cell('a')
    const owner = kind === 'row' ? { kind: 'cell' as const, cell: target } : { kind: 'edit' as const }
    if (kind === 'edit') grid.dispatch({ type: 'edit/start', cell: target })
    const credential = kind === 'row' ? { kind, rowKey: 'a', entityId: grid.getSnapshot().draft.entityAt('a')! }
      : { kind, id: grid.getSnapshot().edit!.id }
    expect(grid.dispatch({ type: 'controller/run-effect', request: { effect: 'foreign', owner: { kind: 'cell', cell: cell('b') } } }, credential).accepted).toBe(false)
    expect(grid.dispatch({ type: 'controller/run-effect', request: { effect: 'matching', owner } }, credential).accepted).toBe(true)
    hostTask.resolve({ kind: 'value', value: 'matching value' })
    await vi.waitFor(() => expect(grid.getSnapshot().draft.rows[0]?.name).toBe('matching value'))
    expect(grid.getSnapshot().edit).toBeNull()
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    grid.destroy()
  })

  it('a task authorized for A cannot supply addresses for A and a replacement B', async () => {
    const { grid, hostTask, change } = fixture()
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'derive', owner: { kind: 'cell', cell: cell('a') } } })
    await Promise.resolve()
    await change(initial, 'push', 'b')
    // @ts-expect-error A JavaScript host cannot extend the original write scope by returning commands.
    hostTask.resolve([a, b].map(row => ({ type: 'cell/set-value', cell: cell(row.id), value: 'wrong' })))
    await vi.waitFor(() => expect(grid.getSnapshot().activeEffectCount).toBe(0))
    const effectId = grid.getSnapshot().pendingEffects[0]!.id
    expect(grid.dispatch({ type: 'effect/apply-host-result', effectId }).accepted).toBe(false)
    expect(grid.getSnapshot().draft.rows).toEqual(initial)
    grid.dispatch({ type: 'effect/discard-result', effectId })
    grid.destroy()
  })

  it('rechecks the complete authorized batch when a blocking editor has closed', async () => {
    const { grid, hostTask } = fixture()
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'derive', owner: {
      kind: 'cells', write: [cell('a'), cell('b')], read: [cell('c')],
    } } })
    grid.dispatch({ type: 'edit/start', cell: cell('c') })
    hostTask.resolve({ kind: 'values', values: ['one', 'two'] })
    await vi.waitFor(() => expect(grid.getSnapshot().pendingEffects).toHaveLength(1))
    const effectId = grid.getSnapshot().pendingEffects[0]!.id
    expect(grid.dispatch({ type: 'effect/apply-host-result', effectId })).toMatchObject({ accepted: false, issue: { code: 'session-open' } })
    grid.dispatch({ type: 'edit/cancel' })
    expect(grid.dispatch({ type: 'effect/apply-host-result', effectId }).accepted).toBe(true)
    expect(grid.getSnapshot().draft.rows.map(row => row.name)).toEqual(['one', 'two', 'C'])
    expect(grid.getSnapshot().pendingEffects).toEqual([])
    expect(grid.getSnapshot().draft.undoStack).toHaveLength(1)
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    grid.destroy()
  })

  it.each(['read', 'write'] as const)('retains the entire batch when a %s target is replaced', async access => {
    const { grid, hostTask, change, server } = fixture()
    const key = access === 'read' ? 'c' : 'b'
    const originalId = grid.getSnapshot().draft.entityAt(key)
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'derive', owner: {
      kind: 'cells', write: [cell('a'), cell('b')], read: [cell('c')],
    } } })
    await Promise.resolve()
    await change(initial, 'push', key)
    hostTask.resolve({ kind: 'values', values: ['first', 'second'] })
    await vi.waitFor(() => expect(grid.getSnapshot().activeEffectCount).toBe(0))
    const effectId = grid.getSnapshot().pendingEffects[0]!.id
    expect(grid.dispatch({ type: 'effect/inspect-result', effectId })).toMatchObject({
      accepted: true, value: { state: 'completed', result: { kind: 'values', values: ['first', 'second'] },
        targets: expect.arrayContaining([{ access, cell: cell(key), entityId: originalId }]) },
    })
    expect(grid.dispatch({ type: 'effect/apply-host-result', effectId })).toMatchObject({ accepted: false, issue: { code: 'stale-target' } })
    expect(await grid.save()).toMatchObject({ status: 'no-changes' })
    expect(server.source.submit).not.toHaveBeenCalled()
    grid.dispatch({ type: 'effect/discard-result', effectId })
    grid.destroy()
  })

  it('applies one value per declared destination after a reorder and selection change', async () => {
    const { grid, hostTask, change } = fixture()
    const captured = deferred<string[]>()
    grid.updateEffects({ run: (_, { cells }) => {
      captured.resolve(cells.map(input => [input.access, input.cell.rowKey, input.row.name, input.value].join('/')))
      return hostTask.promise
    } })
    const write = [cell('b'), cell('a')]
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'derive', owner: { kind: 'cells', write, read: [cell('c')] } } })
    write.reverse()
    expect(await captured.promise).toEqual(['write/b/B/B', 'write/a/A/A', 'read/c/C/C'])
    await change([c, a, b], 'read')
    grid.dispatch({ type: 'interaction/activate', cell: cell('c') })
    hostTask.resolve({ kind: 'values', values: ['new B', 'new A'] })
    await vi.waitFor(() => expect(grid.getSnapshot().activeEffectCount).toBe(0))
    expect(grid.getSnapshot().draft.rows).toEqual([c, { ...a, name: 'new A' }, { ...b, name: 'new B' }])
    expect(grid.getSnapshot().draft.undoStack).toHaveLength(1)
    expect(await grid.save()).toMatchObject({ status: 'confirmed' })
    grid.destroy()
  })

  it('owns retained host values through the declared column codec on completion and inspection', async () => {
    class Label {
      constructor(public text: string) {}
    }
    const raw = (value: unknown) => value instanceof Label ? value.text : String(value)
    const { grid, hostTask, change } = fixture({ version: 'label/1', copy: value => new Label(raw(value)),
      equals: (a, b) => raw(a) === raw(b), encode: raw, decode: value => new Label(String(value)) })
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'render', owner: { kind: 'cell', cell: cell('a') } } })
    await Promise.resolve()
    await change(initial, 'push', 'a')
    const label = new Label('original')
    hostTask.resolve({ kind: 'value', value: label })
    await vi.waitFor(() => expect(grid.getSnapshot().pendingEffects).toHaveLength(1))
    label.text = 'changed by host'
    const effectId = grid.getSnapshot().pendingEffects[0]!.id
    function inspect() {
      const response = grid.dispatch({ type: 'effect/inspect-result', effectId })
      if (!response.accepted || response.value.kind !== 'external' || response.value.state !== 'completed'
        || response.value.result?.kind !== 'value' || !(response.value.result.value instanceof Label)) throw new Error('Expected an owned Label')
      return response.value.result.value
    }
    const first = inspect()
    expect(first.text).toBe('original')
    first.text = 'changed by reviewer'
    expect(inspect().text).toBe('original')
    grid.dispatch({ type: 'effect/discard-result', effectId })
    grid.destroy()
  })

  it('supplies explicitly authorized inputs to a read-only task and denies a returned write', async () => {
    const { grid } = fixture()
    const visited: string[] = []
    grid.updateEffects({ run: (_, { cells }) => {
      visited.push(...cells.map(input => input.row.id))
      return { kind: 'values', values: ['overwrite'] }
    } })
    expect(grid.dispatch({ type: 'controller/run-effect', request: { effect: 'inspect',
      owner: { kind: 'cells', read: [cell('b')], write: [] } } }).accepted).toBe(true)
    await vi.waitFor(() => expect(grid.getSnapshot().pendingEffects).toHaveLength(1))
    expect(visited).toEqual(['b'])
    expect(grid.getSnapshot().draft.rows).toEqual(initial)
    const effectId = grid.getSnapshot().pendingEffects[0]!.id
    expect(grid.dispatch({ type: 'effect/inspect-result', effectId })).toMatchObject({ accepted: true, value: {
      state: 'failed', targets: [{ cell: cell('b'), access: 'read' }], issue: { message: expect.stringContaining('no authorized write targets') },
    } })
    grid.dispatch({ type: 'effect/discard-result', effectId })
    grid.destroy()
  })

  it('runs a nonwriting host task without exposing the grid snapshot', async () => {
    const { grid } = fixture()
    const run = vi.fn((_effect: string, context: { cells: readonly unknown[] }) => {
      expect(context.cells).toEqual([])
      expect(context).not.toHaveProperty('getSnapshot')
    })
    grid.updateEffects({ run })
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'notify', owner: { kind: 'controller' } } })
    await vi.waitFor(() => expect(grid.getSnapshot().activeEffectCount).toBe(0))
    expect(run).toHaveBeenCalledOnce()
    expect(grid.getSnapshot().pendingEffects).toEqual([])
    grid.destroy()
  })

  it('retains a host result started by the original editor and refuses to apply its value to a replacement', async () => {
    const { grid, hostTask, change } = fixture()
    const target = cell('a')
    grid.dispatch({ type: 'edit/start', cell: target })
    grid.dispatch({ type: 'controller/run-effect', request: { effect: 'host', owner: { kind: 'edit' } } })
    await Promise.resolve()
    await change(initial, 'push', 'a')
    hostTask.resolve({ kind: 'value', value: 'wrong recipient' })
    await vi.waitFor(() => expect(grid.getSnapshot().pendingEffects).toHaveLength(1))
    grid.dispatch({ type: 'edit/cancel' })
    const effectId = grid.getSnapshot().pendingEffects[0]!.id
    expect(grid.dispatch({ type: 'effect/apply-host-result', effectId })).toMatchObject({ accepted: false, issue: { code: 'stale-target' } })
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('A')
    grid.dispatch({ type: 'effect/discard-result', effectId })
    grid.destroy()
  })
})
