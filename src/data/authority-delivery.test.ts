import { describe, expect, it, vi } from 'vitest'
import { createGridColumnHelper, createDataGridBinding, type StandardGridCellTypeSchema } from '../index.js'
import { kernelId, type AuthorityVersion } from '../kernel/model.js'
import type { PersistenceSource, ServerAuthority } from '../kernel/source.js'
import { createFieldGridDocumentModel, createRemoteGridDataSource } from './remote-data-source.js'

type Row = { id: number; name: string }
const columns = [createGridColumnHelper<Row>().field('name', { type: 'string', label: 'Name' })]
const ordered = (n: number): AuthorityVersion => ({ kind: 'ordered', position: String(n), token: String(n) })
const causal = (stamp: string, covers: string[] = []): AuthorityVersion => ({
  kind: 'causal', stamp: kernelId<'causal-stamp'>(stamp), covers: covers.map(id => kernelId<'causal-stamp'>(id)), token: stamp,
})

function fixture(version: AuthorityVersion) {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('rows'), epoch: kernelId<'scope-epoch'>('1') }
  const identity = { key: 1, incarnation: 'first' }
  const authority = (v: AuthorityVersion, name = v.token): ServerAuthority => ({
    scope, observation: kernelId<'observation'>(crypto.randomUUID()), version: v,
    rows: [{ identity, document: { id: 1, name } }], order: [identity],
  })
  const initial = authority(version)
  const read = vi.fn<PersistenceSource['readAtLeast']>(async () => initial)
  const adapter = (seed: ServerAuthority) => createRemoteGridDataSource<Row, number, StandardGridCellTypeSchema>({
    scope, columns, getRowKey: row => row.id, initialAuthority: seed,
    model: createFieldGridDocumentModel(columns), persistence: { mode: 'manual-save' },
    source: { id: scope.sourceId, capabilities: {
      atomicScopeWrites: true, durableOperationLookup: true, operationIdFence: 'scope-epoch',
      authorityOrder: version.kind, identity: 'incarnation', operationRetentionMs: 3600000, restoreDeleted: false,
    }, readAtLeast: read, submit: async () => { throw Error('Unexpected submit') },
    lookupOperation: async () => { throw Error('Unexpected lookup') } },
  })
  const dataSource = adapter(initial)
  return { dataSource, adapter, read, authority, open: (source = dataSource) => createDataGridBinding({ dataSource: source }).controller }
}

describe('authority delivery and reopening', () => {
  it('rejects a reused observation before a push or read can change the shared snapshot', async () => {
    const f = fixture(ordered(1)), grid = f.open()
    await grid.refresh()
    const old = f.dataSource.getSnapshot()!
    f.dataSource.publish(f.authority(ordered(2)))
    const valid = f.authority(ordered(3))
    const wrong = { ...valid, observation: old.observation }
    expect(() => f.dataSource.publish(wrong)).toThrow(/observation/)
    f.read.mockResolvedValueOnce(wrong)
    expect(await grid.refresh()).toMatchObject({ status: 'failed', issue: { code: 'adapter-error' } })
    expect(f.dataSource.getSnapshot()?.version.token).toBe('2')
    expect(grid.getSnapshot().source.version).toBe('2')
    f.read.mockResolvedValueOnce(valid)
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    grid.destroy()
  })

  it('rejects an undecodable read and push without poisoning the next read or reopening', async () => {
    const f = fixture(ordered(1)), grid = f.open()
    await grid.refresh()
    const valid = f.authority(ordered(2))
    const invalid = { ...valid, rows: valid.rows.map(row => ({ ...row, document: { id: 999, name: 'invalid' } })) }
    f.read.mockResolvedValueOnce(invalid)
    expect(await grid.refresh()).toMatchObject({ status: 'failed', issue: { code: 'adapter-error' } })
    expect(() => f.dataSource.publish(invalid)).toThrow(/key/)
    expect(f.dataSource.getSnapshot()?.version.token).toBe('1')
    grid.destroy()
    f.read.mockRejectedValueOnce(new Error('offline'))
    const reopened = f.open()
    await vi.waitFor(() => expect(reopened.getSnapshot().source.status).toBe('error'))
    expect(reopened.getSnapshot().source.rows).toEqual([{ id: 1, name: '1' }])
    f.read.mockResolvedValueOnce(valid)
    expect(await reopened.refresh()).toEqual({ status: 'refreshed' })
    expect(reopened.getSnapshot().source.version).toBe('2')
    reopened.destroy()
  })

  it('delivers an accepted read to all open grids before an older push arrives', async () => {
    const f = fixture(ordered(1)), left = f.open(), right = f.open()
    await Promise.all([left.refresh(), right.refresh()])
    const updates: string[] = []
    const release = f.dataSource.subscribe(() => updates.push(f.dataSource.getSnapshot()!.version.token))
    f.read.mockResolvedValueOnce(f.authority(ordered(3)))
    expect(await left.refresh()).toEqual({ status: 'refreshed' })
    expect(right.getSnapshot().source.rows).toEqual([{ id: 1, name: '3' }])
    f.dataSource.publish(f.authority(ordered(2)))
    expect(updates).toEqual(['1', '3'])
    expect(right.getSnapshot().source.version).toBe('3')
    release()
    left.destroy()
    right.destroy()
  })

  it('retries a failed merge on feed replay without reopening or manually refreshing', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await grid.refresh()
    const branch = f.authority(causal('B'))
    f.read.mockRejectedValueOnce(new Error('offline'))
    f.dataSource.publish(branch)
    await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('error'))
    f.read.mockResolvedValueOnce(f.authority(causal('M', ['A', 'B'])))
    f.dataSource.publish(branch)
    await vi.waitFor(() => expect(grid.getSnapshot().source.version).toBe('M'))
    expect(grid.getSnapshot().source.status).toBe('ready')
    grid.destroy()
  })

  it('widens an in-flight merge for a new branch and releases covered branches after the merge', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await grid.refresh()
    let finish!: (snapshot: ServerAuthority) => void
    f.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    f.dataSource.publish(f.authority(causal('B')))
    const merged = f.authority(causal('M', ['A', 'B', 'C']))
    f.read.mockResolvedValue(merged)
    f.dataSource.publish(f.authority(causal('C')))
    await vi.waitFor(() => expect(f.read.mock.lastCall?.[1].map(v => v.token).sort()).toEqual(['A', 'B', 'C']))
    await vi.waitFor(() => expect(grid.getSnapshot().source.version).toBe('M'))
    const final = f.authority(causal('Z', ['M', 'AB']))
    f.read.mockResolvedValue(final)
    finish(f.authority(causal('AB', ['A', 'B'])))
    // AB satisfied its original request but is concurrent with the installed M.
    await vi.waitFor(() => expect(grid.getSnapshot().source.version).toBe('Z'))
    expect(f.read.mock.lastCall?.[1].map(v => v.token).sort()).toEqual(['AB', 'M'])
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    expect(f.read.mock.lastCall?.[1].map(v => v.token)).toEqual(['Z'])
    grid.destroy()
  })

  it('delivers nested publications in order and releases each subscription independently', () => {
    const f = fixture(ordered(1))
    const releaseA = f.dataSource.subscribe(event => {
      if (event.kind === 'snapshot' && event.snapshot.version.token === '2') f.dataSource.publish(f.authority(ordered(3)))
    })
    const versions: string[] = []
    const releaseB = f.dataSource.subscribe(event => { if (event.kind === 'snapshot') versions.push(event.snapshot.version.token) })
    f.dataSource.publish(f.authority(ordered(2)))
    expect(versions).toEqual(['1', '2', '3'])
    releaseA()
    releaseB()
    f.dataSource.publish(f.authority(ordered(4)))
    expect(versions).toEqual(['1', '2', '3'])
  })

  it('installs a causal covering read without a manual refresh and keeps it for an offline reopening', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await vi.waitFor(() => expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', error: null }))
    const merged = f.authority(causal('M', ['A', 'B']))
    f.read.mockResolvedValue(merged)
    f.dataSource.publish(f.authority(causal('B')))
    await vi.waitFor(() => expect(grid.getSnapshot().source.version).toBe('M'))
    expect(f.read.mock.lastCall?.[1].map(v => v.token).sort()).toEqual(['A', 'B'])
    expect(f.dataSource.getSnapshot()?.version).toEqual(merged.version)
    expect(grid.destroy().status).toBe('closed')
    f.read.mockRejectedValue(new Error('offline'))
    const reopened = f.open()
    await vi.waitFor(() => expect(reopened.getSnapshot().source.status).toBe('error'))
    expect(reopened.getSnapshot().draft.rows).toEqual([{ id: 1, name: 'M' }])
    reopened.destroy()
  })

  it('shows a failed merge read and retries against both branches after reopening', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await vi.waitFor(() => expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', error: null }))
    f.read.mockRejectedValue(new Error('merge unavailable'))
    f.dataSource.publish(f.authority(causal('B')))
    await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('error'))
    expect(grid.getSnapshot().draft.rows[0]?.name).toBe('A')
    grid.destroy()
    f.read.mockResolvedValue(f.authority(causal('M', ['B', 'A'])))
    const reopened = f.open()
    await vi.waitFor(() => expect(reopened.getSnapshot().source.version).toBe('M'))
    expect(f.read.mock.lastCall?.[1].map(v => v.token).sort()).toEqual(['A', 'B'])
    reopened.destroy()
  })

  it('shares a covering read even when the server supplies stronger evidence for an existing stamp', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await grid.refresh()
    const updates: string[] = []
    const release = f.dataSource.subscribe(event => updates.push(event.kind === 'required' ? event.frontier.map(v => v.token).join('+') : event.snapshot.version.token))
    const covering = f.authority(causal('A', ['B']))
    f.read.mockResolvedValue(covering)
    f.dataSource.publish(f.authority(causal('B')))
    await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('ready'))
    expect(updates).toEqual(['A', 'A+B', 'A'])
    expect(f.dataSource.getSnapshot()?.version).toEqual(covering.version)
    release()
    grid.destroy()
  })

  it('retains all attested predecessors when different observations describe the same stamp', async () => {
    const f = fixture(causal('M', ['A'])), grid = f.open()
    await grid.refresh()
    f.dataSource.publish(f.authority(causal('M', ['B'])))
    const accepted = f.dataSource.getSnapshot()!.version
    expect(accepted).toEqual(causal('M', ['A', 'B']))
    const calls = f.read.mock.calls.length
    f.dataSource.publish(f.authority(causal('A')))
    f.dataSource.publish(f.authority(causal('B')))
    expect(f.read).toHaveBeenCalledTimes(calls)
    expect(grid.getSnapshot().source.version).toBe('M')
    grid.destroy()
  })

  it('retains the newest ordered feed version across close and a failed read', async () => {
    const f = fixture(ordered(1)), grid = f.open()
    await vi.waitFor(() => expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', error: null }))
    f.dataSource.publish(f.authority(ordered(3)))
    f.dataSource.publish(f.authority(ordered(2)))
    expect(grid.getSnapshot().source.version).toBe('3')
    expect(f.dataSource.getSnapshot()?.version).toEqual(ordered(3))
    expect(grid.destroy().status).toBe('closed')
    f.read.mockRejectedValue(new Error('offline'))
    const reopened = f.open()
    await vi.waitFor(() => expect(reopened.getSnapshot().source.status).toBe('error'))
    expect(reopened.getSnapshot().source.rows[0]?.name).toBe('3')
    reopened.destroy()
  })

  it('keeps a newer covering publication when an in-flight merge read finishes later', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('ready'))
    let finish!: (authority: ServerAuthority) => void
    const pending = new Promise<ServerAuthority>(resolve => { finish = resolve })
    f.read.mockReturnValueOnce(pending)
    const branch = f.authority(causal('B'))
    f.dataSource.publish(branch)
    f.dataSource.publish(branch)
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
    expect(grid.getSnapshot().source.status).toBe('refreshing')
    const newest = f.authority(causal('Z', ['A', 'B', 'M']))
    f.dataSource.publish(newest)
    finish(f.authority(causal('M', ['A', 'B'])))
    f.read.mockResolvedValue(newest)
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    expect(grid.getSnapshot().source.rows[0]?.name).toBe('Z')
    expect(f.dataSource.getSnapshot()?.version).toEqual(newest.version)
    grid.destroy()
  })

  it('recovers from a read that contradicts a version first seen in the feed', async () => {
    const f = fixture(ordered(1)), grid = f.open()
    await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('ready'))
    const newest = f.authority(ordered(2))
    f.dataSource.publish(newest)
    f.read.mockResolvedValueOnce(f.authority(ordered(2), 'different'))
    expect(await grid.refresh()).toMatchObject({ status: 'failed', issue: { code: 'adapter-error' } })
    expect(f.dataSource.getSnapshot()?.rows).toEqual(newest.rows)
    f.read.mockResolvedValueOnce(newest)
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    grid.destroy()
  })

  it('rejects contradictory content at the same version without replacing the reopen cache', () => {
    const f = fixture(ordered(1)), before = f.dataSource.getSnapshot()
    expect(() => f.dataSource.publish(f.authority(ordered(1), 'different'))).toThrow()
    expect(f.dataSource.getSnapshot()).toBe(before)
  })
})

describe('one admission stream per physical scope', () => {
  it('delivers a newer result from a superseded refresh to its caller and its peers', async () => {
    const f = fixture(ordered(1)), a = f.open(), b = f.open()
    await Promise.all([a.refresh(), b.refresh()])
    let finish!: (snapshot: ServerAuthority) => void
    f.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const first = a.refresh()
    f.read.mockResolvedValueOnce(f.authority(ordered(2)))
    expect(await a.refresh()).toEqual({ status: 'refreshed' })
    expect(await first).toEqual({ status: 'superseded' })
    finish(f.authority(ordered(3)))
    await vi.waitFor(() => {
      for (const grid of [a, b]) expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', version: '3' })
    })
    a.destroy()
    b.destroy()
  })

  it('rejects retired identities before admission and allows corrected content at the same version', async () => {
    const f = fixture(ordered(1)), grid = f.open()
    await grid.refresh()
    f.dataSource.publish({ ...f.authority(ordered(2)), rows: [], order: [] })
    const retired = f.authority(ordered(3))
    f.read.mockResolvedValueOnce(retired)
    expect(await grid.refresh()).toMatchObject({ status: 'failed' })
    expect(() => f.dataSource.publish(retired)).toThrow(/retired/i)
    grid.destroy()
    f.read.mockRejectedValueOnce(new Error('offline'))
    const reopened = f.open()
    await vi.waitFor(() => expect(reopened.getSnapshot().source.status).toBe('error'))
    expect(reopened.getSnapshot().source).toMatchObject({ version: '2', rows: [] })
    const identity = { key: 1, incarnation: 'replacement' }
    f.read.mockResolvedValueOnce({ ...retired, rows: [{ ...retired.rows[0]!, identity }], order: [identity] })
    expect(await reopened.refresh()).toEqual({ status: 'refreshed' })
    expect(reopened.getSnapshot().source.version).toBe('3')
    reopened.destroy()
  })

  it('checks separate wrappers against the same version evidence for seeds, pushes and reads', async () => {
    const f = fixture(ordered(1)), a = f.open()
    const good = f.authority(ordered(3), 'correct'), bad = f.authority(ordered(3), 'different')
    f.read.mockResolvedValue(good)
    expect(await a.refresh()).toEqual({ status: 'refreshed' })
    expect(() => f.adapter(bad)).toThrow(/inconsistent/)
    const second = f.adapter(f.authority(ordered(1)))
    expect(second.getSnapshot()?.version).toEqual(good.version)
    const b = f.open(second)
    expect(() => second.publish(bad)).toThrow(/inconsistent/)
    f.read.mockResolvedValueOnce(bad)
    expect(await b.refresh()).toMatchObject({ status: 'failed' })
    expect(await b.refresh()).toEqual({ status: 'refreshed' })
    second.publish(f.authority(ordered(4)))
    expect(a.getSnapshot().source.version).toBe('4')
    a.destroy()
    b.destroy()
  })

  it.each(['A', 'B'])('retries the unresolved frontier on replay of %s after all tables reopened offline', async replay => {
    const f = fixture(causal('A')), first = f.open()
    await first.refresh()
    f.read.mockRejectedValue(new Error('offline'))
    f.dataSource.publish(f.authority(causal('B')))
    await vi.waitFor(() => expect(first.getSnapshot().source.status).toBe('error'))
    first.destroy()
    const a = f.open(), b = f.open()
    await vi.waitFor(() => {
      for (const grid of [a, b]) expect(grid.getSnapshot().source.status).toBe('error')
    })
    const before = f.read.mock.calls.length
    f.read.mockResolvedValue(f.authority(causal('M', ['A', 'B'])))
    f.dataSource.publish(f.authority(causal(replay)))
    await vi.waitFor(() => {
      for (const grid of [a, b]) expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', version: 'M' })
    })
    expect(f.read).toHaveBeenCalledTimes(before + 1)
    expect(f.read.mock.lastCall?.[1].map(v => v.token).sort()).toEqual(['A', 'B'])
    a.destroy()
    b.destroy()
  })

  it('recognizes transitive causal coverage after intermediate heads have been compacted', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await grid.refresh()
    f.dataSource.publish(f.authority(causal('B', ['A'])))
    f.dataSource.publish(f.authority(causal('C', ['B'])))
    f.read.mockRejectedValue(new Error('offline'))
    const before = f.read.mock.calls.length
    f.dataSource.publish(f.authority(causal('A')))
    expect(f.read).toHaveBeenCalledTimes(before)
    expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', version: 'C' })
    grid.destroy()
  })

  it('uses late evidence about a historical stamp to resolve the current frontier', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await grid.refresh()
    f.dataSource.publish(f.authority(causal('C', ['A'])))
    f.read.mockRejectedValue(new Error('offline'))
    f.dataSource.publish(f.authority(causal('B')))
    await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('error'))
    const before = f.read.mock.calls.length
    expect(() => f.dataSource.publish(f.authority(causal('A', ['C'])))).toThrow(/cycle/)
    f.dataSource.publish(f.authority(causal('A', ['B'])))
    expect(f.read).toHaveBeenCalledTimes(before)
    expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', version: 'C', rows: [{ name: 'C' }] })
    expect(f.dataSource.getSnapshot()?.version).toEqual(causal('C', ['A', 'B']))
    grid.destroy()
  })
})

describe('causal observations across forks', () => {
  it('admits a read satisfying its original request and merges it with an intervening push for every table', async () => {
    const f = fixture(causal('A')), left = f.open(), right = f.open()
    await Promise.all([left.refresh(), right.refresh()])
    let finish!: (snapshot: ServerAuthority) => void
    f.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const old = left.refresh()
    f.dataSource.publish(f.authority(causal('B', ['A'])))
    f.read.mockResolvedValue(f.authority(causal('M', ['C', 'B'])))
    finish(f.authority(causal('C', ['A'])))
    expect(await old).toEqual({ status: 'superseded' })
    await vi.waitFor(() => {
      for (const grid of [left, right]) expect(grid.getSnapshot().source).toMatchObject({ version: 'M', status: 'ready' })
    })
    expect(f.read.mock.lastCall?.[1].map(v => v.token).sort()).toEqual(['B', 'C'])
    left.destroy()
    right.destroy()
  })

  it('inherits a deletion on a concurrent branch and accepts a corrected merge at the same stamp', async () => {
    const f = fixture(causal('O')), grid = f.open()
    await grid.refresh()
    f.dataSource.publish(f.authority(causal('A', ['O'])))
    const merge = f.authority(causal('M', ['A', 'B']))
    f.read.mockResolvedValue(merge)
    f.dataSource.publish({ ...f.authority(causal('B', ['O'])), rows: [], order: [] })
    await vi.waitFor(() => expect(grid.getSnapshot().source.status).toBe('error'))
    expect(f.dataSource.getSnapshot()?.version.token).toBe('A')
    expect(() => f.dataSource.publish(merge)).toThrow(/retired/i)
    const identity = { key: 1, incarnation: 'replacement' }
    f.read.mockResolvedValue({ ...merge, rows: [{ ...merge.rows[0]!, identity }], order: [identity] })
    expect(await grid.refresh()).toEqual({ status: 'refreshed' })
    expect(f.dataSource.getSnapshot()?.order).toEqual([identity])
    grid.destroy()
  })

  it('allows an incarnation present on one branch and absent on an unrelated branch', async () => {
    const f = fixture(causal('A')), grid = f.open()
    await grid.refresh()
    f.read.mockResolvedValue(f.authority(causal('M', ['A', 'B'])))
    f.dataSource.publish({ ...f.authority(causal('B')), rows: [], order: [] })
    await vi.waitFor(() => expect(grid.getSnapshot().source).toMatchObject({ status: 'ready', version: 'M' }))
    expect(grid.getSnapshot().source.rows).toEqual([{ id: 1, name: 'M' }])
    grid.destroy()
  })

  it('validates an intermediate observation against known descendants before recording it', () => {
    const f = fixture(causal('O'))
    f.dataSource.publish(f.authority(causal('M', ['O', 'B'])))
    const b = f.authority(causal('B', ['O']))
    expect(() => f.dataSource.publish({ ...b, rows: [], order: [] })).toThrow(/retired/i)
    expect(() => f.dataSource.publish(b)).not.toThrow()
    expect(f.dataSource.getSnapshot()?.version.token).toBe('M')
  })
})
