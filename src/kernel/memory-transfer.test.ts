import { describe, expect, it } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { SourceFixture, deferred } from '../../tests/kernel/source-fixture.js'
import { kernelId, type TaskResult } from './model.js'
import { Workspace } from './workspace.js'

let serial = 0
async function setup() {
  const scope = { sourceId: `memory-transfer:${++serial}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, { a: { x: 0, hidden: 7 } })
  const options = { scope, source, schema: permissiveSchema, policy: permissivePolicy }
  const workspace = new Workspace(options)
  await workspace.refresh()
  await workspace.dispatch({ kind: 'session-opened', revision: workspace.getState().revision, sessionId: kernelId<'session'>('filter'),
    inputId: kernelId<'input'>('input'), viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 },
    input: { kind: 'encoded', value: 'original' }, reads: [] })
  return { options, workspace, source }
}

describe('exclusive in-process memory transfer', () => {
  it('transfers raw input and File ownership, detaches the old editor and revokes the previous writer', async () => {
    const { options, workspace, source } = await setup(), lease = workspace.getState().session!.editor!
    await workspace.typeInput(lease, { kind: 'encoded', value: 'unsent raw' }).completion
    const resource = await workspace.registerResource(new File(['body'], 'owned.txt', { lastModified: 17 }))
    const before = workspace.getState()
    const successor = await Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })
    expect(workspace.requestClose().lifecycle).toBe('closed')
    expect(workspace.getState()).toBe(before)
    expect(successor.getState().workspace).toEqual(before.workspace)
    expect(successor.getState().session).toMatchObject({ rawInput: { value: 'unsent raw' }, editor: null })
    expect(successor.getState().inputs).toEqual(before.inputs)
    const file = successor.getResource(resource.id) as File
    expect(await file.text()).toBe('body'); expect(file.name).toBe('owned.txt'); expect(file.lastModified).toBe(17)
    await workspace.typeInput(lease, { kind: 'encoded', value: 'late' }).completion
    expect(workspace.getState()).toBe(before)
    expect(source.writes).toBe(0)
    await expect(Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })).rejects.toThrow('open memory')
  })

  it('preserves authored changes for one save by the successor', async () => {
    const { options, workspace, source } = await setup(), fixture = new KernelFixture()
    fixture.state = workspace.getState()
    await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 9 })]) })
    const successor = await Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })
    expect((await successor.save()).kind).toBe('committed')
    expect(source.writes).toBe(1)
    expect(successor.getProjection().rows[0]!.preview).toEqual({ x: 9, hidden: 7 })
    expect((await workspace.save()).kind).toBe('blocked')
    expect(source.writes).toBe(1)
  })

  it('rejects concurrent input and explicit retain without revoking the live owner', async () => {
    for (const retain of [false, true]) {
      const { options, workspace } = await setup(), ticket = workspace.requestClose().ticket
      const transferring = Workspace.transferMemory({ ...options, from: workspace, ticket })
      const rejected = expect(transferring).rejects.toThrow('stale')
      if (retain) await workspace.close(ticket, 'retain')
      else await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'encoded', value: 'newer' }).completion
      await rejected
      expect(workspace.requestClose().lifecycle).toBe('open')
      expect(workspace.getState().session?.rawInput).toEqual({ kind: 'encoded', value: retain ? 'original' : 'newer' })
    }
  })

  it('preserves rejected raw ingress under its original identity without automatic retry', async () => {
    const { options, workspace } = await setup(), lease = workspace.getState().session!.editor!
    const rejected = workspace.enqueueInput({ ingressId: kernelId<'ingress'>('rejected'), lease: { ...lease, viewId: kernelId<'view'>('obsolete-view') },
      inputSequence: 1, predecessor: { kind: 'published', inputVersion: workspace.getState().session!.input.version }, composition: 'idle',
      input: { kind: 'encoded', value: 'rejected original' } })
    await rejected.completion
    const before = workspace.getIngress()
    expect(before.pending).toHaveLength(1)
    const successor = await Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })
    expect(successor.getIngress()).toEqual(before)
    expect(successor.getIngress().pending[0]!.id).toBe(rejected.id)
    expect(successor.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'original' })
  })

  it('retains an unknown source operation until exact recovery without creating another write', async () => {
    const { options, workspace, source } = await setup(), fixture = new KernelFixture()
    fixture.state = workspace.getState()
    await workspace.dispatch({ kind: 'prepared-action', prepared: fixture.prepare([fixture.write(workspace.getProjection().rows[0]!.entityId, { x: 4 })]) })
    source.submitHook = async (_request, execute) => { execute(); throw new Error('Response lost') }
    expect((await workspace.save()).kind).toBe('unresolved')
    const before = workspace.getState()
    await expect(Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })).rejects.toThrow('source reservations')
    expect(workspace.getState()).toBe(before)
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect((await workspace.recover()).kind).toBe('committed')
    const successor = await Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })
    expect(successor.getProjection().rows[0]!.preview).toEqual({ x: 4, hidden: 7 })
    expect(source.writes).toBe(1); expect(source.requests).toHaveLength(1)
  })

  it('waits for a memory callback, then transfers its result without re-executing it', async () => {
    const { options, workspace } = await setup(), session = workspace.getState().session!
    const entered = deferred<void>(), finish = deferred<TaskResult>()
    let calls = 0
    const task = workspace.runTask({ owner: { kind: 'session', sessionId: session.id, input: session.input }, input: { kind: 'encoded', value: 'work' }, reads: [] },
      async () => { calls++; entered.resolve(); return finish.promise })
    await entered.promise
    await expect(Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })).rejects.toThrow('running work')
    finish.resolve({ kind: 'session-candidate', sessionId: session.id, input: { kind: 'encoded', value: 'finished' } })
    await workspace.waitForTask(task.taskId)
    const successor = await Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })
    expect(successor.getState().session?.rawInput).toEqual({ kind: 'encoded', value: 'finished' })
    expect(successor.getState().tasks).toEqual(workspace.getState().tasks)
    expect(calls).toBe(1)
  })

  it('leaves missing resource input with its original owner when full capture fails', async () => {
    const { options, workspace } = await setup()
    await workspace.typeInput(workspace.getState().session!.editor!, { kind: 'resource', id: kernelId<'resource'>('missing') }).completion
    const before = workspace.getIngress()
    await expect(Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })).rejects.toThrow('unavailable checkpoint bytes')
    expect(workspace.requestClose().lifecycle).toBe('open')
    expect(workspace.getIngress()).toEqual(before)
  })

  it('never exposes two successors from concurrent transfers', async () => {
    const { options, workspace } = await setup(), ticket = workspace.requestClose().ticket
    const results = await Promise.allSettled([Workspace.transferMemory({ ...options, from: workspace, ticket }), Workspace.transferMemory({ ...options, from: workspace, ticket })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(workspace.requestClose().lifecycle).toBe('closed')
  })

  it('retains the live owner while a refresh is running and rejects source substitution', async () => {
    const { options, workspace, source } = await setup(), entered = deferred<void>(), release = deferred<void>()
    source.readHook = async () => { entered.resolve(); await release.promise; return source.snapshot() }
    const refreshing = workspace.refresh(); await entered.promise
    await expect(Workspace.transferMemory({ ...options, from: workspace, ticket: workspace.requestClose().ticket })).rejects.toThrow('running work')
    expect(workspace.requestClose().lifecycle).toBe('open')
    release.resolve(); await refreshing
    await expect(Workspace.transferMemory({ ...options, source: new SourceFixture(options.scope, {}), from: workspace, ticket: workspace.requestClose().ticket })).rejects.toThrow()
    expect(workspace.requestClose().lifecycle).toBe('open')
  })
})
