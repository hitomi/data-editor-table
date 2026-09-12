import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { ResourceStore, type ResourceCheckpoint } from './resource-store.js'
import { kernelId } from './model.js'
import { IngressQueue } from './ingress.js'

const id = (value: string) => kernelId<'resource'>(value)

describe('complete physical resource checkpoints', () => {
  it('captures staged File bytes before awaits without promoting them to semantic registrations', async () => {
    const fixture = new KernelFixture({}), state = fixture.state, store = new ResourceStore()
    const staged = store.register(id('staged'), new File(['original'], '原文.txt', { type: 'text/plain', lastModified: 123 }))
    expect((await store.export(state)).manifest.entries).toEqual([])
    const exporting = store.exportCheckpoint(state)
    store.release(staged.id)
    store.register(id('later'), new Blob(['later input']))
    const checkpoint = await exporting
    expect(checkpoint.bundle.manifest.entries.map(entry => entry.descriptor)).toEqual([staged])
    const restored = await ResourceStore.restoreCheckpoint(state, checkpoint)
    const file = restored.get(staged.id) as File
    expect(await file.text()).toBe('original'); expect(file.name).toBe('原文.txt'); expect(file.lastModified).toBe(123)
    expect(() => restored.get(id('later'))).toThrow('unavailable')
    expect(fixture.state).toBe(state); expect(state.resources).toEqual([])
    expect(() => restored.register(staged.id, new Blob(['replacement']))).toThrow('cannot be reused')
  })

  it('retains lifetime tombstones even for unpublished resources whose bytes were explicitly released', async () => {
    const fixture = new KernelFixture({}), store = new ResourceStore()
    store.register(id('retired'), new Blob(['retired'])); store.release(id('retired'))
    const checkpoint = await store.exportCheckpoint(fixture.state)
    expect(checkpoint.retired).toEqual(['retired']); expect(checkpoint.bundle.contents).toEqual([])
    const restored = await ResourceStore.restoreCheckpoint(fixture.state, checkpoint)
    expect(() => restored.get(id('retired'))).toThrow('unavailable')
    expect(() => restored.register(id('retired'), new Blob(['different']))).toThrow('cannot be reused')
  })

  it('handles semantic release before physical cleanup while preserving the original metadata', async () => {
    const fixture = new KernelFixture({}), store = new ResourceStore()
    const descriptor = store.register(id('released'), new Blob(['pending cleanup']))
    fixture.dispatch({ kind: 'resource-registered', descriptor })
    expect(fixture.dispatch({ kind: 'resource-released', resourceId: descriptor.id }).result.kind).toBe('accepted')
    const checkpoint = await store.exportCheckpoint(fixture.state)
    const restored = await ResourceStore.restoreCheckpoint(fixture.state, checkpoint)
    expect(await restored.get(descriptor.id).text()).toBe('pending cleanup')
    expect(fixture.state.resources[0]?.status).toBe('released')
    restored.release(descriptor.id)
    expect(() => restored.register(descriptor.id, new Blob(['new']))).toThrow('cannot be reused')
  })

  it('restores a rejected File registration together with ingress and retries its original identity once', async () => {
    const fixture = new KernelFixture({}), store = new ResourceStore()
    const descriptor = store.register(id('file'), new File(['retained input'], 'recovery.txt', { lastModified: 17 }))
    const ingress = new IngressQueue(() => fixture.state, () => ({ state: fixture.state, result: { kind: 'rejected', issue: { code: 'storage-rejected', message: 'Not committed' } }, effects: [] }))
    const registration = ingress.event(kernelId<'ingress'>('registration'), { kind: 'resource-registered', descriptor })
    await registration.completion
    const semantic = fixture.state, queueCheckpoint = ingress.exportCheckpoint(), resourceCheckpoint = await store.exportCheckpoint(semantic)
    const restoredStore = await ResourceStore.restoreCheckpoint(semantic, resourceCheckpoint)
    let commits = 0
    const restoredIngress = IngressQueue.restore(queueCheckpoint, () => fixture.state, event => {
      commits++
      const transition = fixture.dispatch(event)
      restoredStore.assertState(transition.state)
      return transition
    })
    expect(commits).toBe(0); expect(fixture.state.resources).toEqual([])
    restoredIngress.resume()
    expect((await restoredIngress.retry(registration.id, restoredIngress.getSnapshot().generation).completion).kind).toBe('completed')
    expect(commits).toBe(1); expect(fixture.state.resources).toEqual([{ descriptor, status: 'available' }])
    expect(await restoredStore.get(descriptor.id).text()).toBe('retained input')
    expect((restoredStore.get(descriptor.id) as File).name).toBe('recovery.txt')
    expect(fixture.dispatch({ kind: 'session-opened', revision: fixture.state.revision, sessionId: kernelId<'session'>('session'), inputId: kernelId<'input'>('input'),
      viewId: kernelId<'view'>('view'), target: { kind: 'filter', columnId: 'filter', queryVersion: 0 }, input: { kind: 'resource', id: descriptor.id }, reads: [] }).result.kind).toBe('accepted')
    restoredStore.assertState(fixture.state)
    expect(fixture.state.inputs[0]?.input).toEqual({ kind: 'resource', id: descriptor.id })
  })

  it('rejects missing/corrupt bytes and inconsistent lifetime inventories without modifying the original store', async () => {
    const fixture = new KernelFixture({}), store = new ResourceStore()
    const descriptor = store.register(id('available'), new Blob(['good']))
    fixture.dispatch({ kind: 'resource-registered', descriptor })
    const checkpoint = await store.exportCheckpoint(fixture.state)
    const invalid: ResourceCheckpoint[] = [
      { ...checkpoint, bundle: { ...checkpoint.bundle, contents: [] } },
      { ...checkpoint, bundle: { ...checkpoint.bundle, contents: [{ resourceId: descriptor.id, blob: new Blob(['evil']) }] } },
      { ...checkpoint, retired: [descriptor.id] },
      { ...checkpoint, retired: [id('duplicate'), id('duplicate')] },
      { ...checkpoint, bundle: { ...checkpoint.bundle, manifest: { ...checkpoint.bundle.manifest, entries: [] }, contents: [] } },
    ]
    for (const value of invalid) await expect(ResourceStore.restoreCheckpoint(fixture.state, value)).rejects.toThrow()
    expect(await store.get(descriptor.id).text()).toBe('good')
  })
})
