import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { DurableCommitBarrier } from './durable-commit.js'
import { kernelId } from './model.js'
import { ResourceStore } from './resource-store.js'
import { validateRecoveryWrite } from './recovery-store.js'

function setup() {
  const fixture = new KernelFixture(), resources = new ResourceStore(), storage = new RecoveryFixture(fixture.state.workspace)
  const barrier = new DurableCommitBarrier({ state: fixture.state, schema: fixture.schema, resources, session: storage.acquire() })
  const restore = () => DurableCommitBarrier.restore({ initialState: fixture.state, schema: fixture.schema, session: storage.acquire() })
  return { fixture, resources, storage, barrier, restore }
}
const resourceId = kernelId<'resource'>('staged-file')

describe('durable physical resource inventory', () => {
  it('preserves a rejected registration through later commits and two runtime restores without promoting it to semantic state', async () => {
    const { resources, storage, barrier, restore } = setup()
    const descriptor = resources.register(resourceId, new File(['retained'], '原文.txt', { type: 'text/plain', lastModified: 42 }))
    storage.rejectNext = true
    expect((await barrier.commit({ kind: 'resource-registered', descriptor })).result.kind).toBe('rejected')
    expect((await barrier.commit({ kind: 'read-started', ticket: 'later' })).result.kind).toBe('accepted')
    const first = await restore()
    expect(first.getState().resources).toEqual([])
    expect(await first.resources.get(resourceId).text()).toBe('retained')
    await first.commit({ kind: 'read-started', ticket: 'another' })
    const second = await restore(), file = second.resources.get(resourceId) as File
    expect(file.name).toBe('原文.txt'); expect(file.lastModified).toBe(42)
    expect(await file.text()).toBe('retained')
    expect((await second.commit({ kind: 'resource-registered', descriptor })).result.kind).toBe('accepted')
    expect(second.getState().resources).toHaveLength(1)
  })

  it('omits released bytes before runtime cleanup and preserves the retired identity through another root', async () => {
    const { resources, storage, barrier, restore } = setup()
    const descriptor = resources.register(resourceId, new Blob(['released']))
    await barrier.commit({ kind: 'resource-registered', descriptor })
    expect((await barrier.commit({ kind: 'resource-released', resourceId })).result.kind).toBe('accepted')
    expect(await resources.get(resourceId).text()).toBe('released')
    expect(storage.root!.record.manifest.entries).toEqual([])
    expect(storage.root!.record.retiredResources).toEqual([resourceId])
    resources.release(resourceId)
    const restored = await restore()
    expect(() => restored.resources.get(resourceId)).toThrow('unavailable')
    expect(() => restored.resources.register(resourceId, new Blob(['replacement']))).toThrow('cannot be reused')
    await restored.commit({ kind: 'read-started', ticket: 'next' })
    expect((await restore()).getRestoredRecord()!.retiredResources).toEqual([resourceId])
  })

  it('retains lifetime identities retired before semantic registration', async () => {
    const { resources, barrier, restore } = setup()
    resources.register(resourceId, new Blob(['temporary'])); resources.release(resourceId)
    await barrier.commit({ kind: 'read-started', ticket: 'persist' })
    const restored = await restore()
    expect(restored.getState().resources).toEqual([])
    expect(() => restored.resources.register(resourceId, new Blob())).toThrow('cannot be reused')
  })

  it('binds staged bytes and retired identities to the candidate digest', async () => {
    const { fixture, resources, storage, barrier } = setup()
    resources.register(resourceId, new Blob(['content']))
    const retired = kernelId<'resource'>('retired')
    resources.register(retired, new Blob()); resources.release(retired)
    await barrier.commit({ kind: 'read-started', ticket: 'persist' })
    const root = storage.root!
    await expect(validateRecoveryWrite({ ...root, contents: [] }, fixture.state.workspace)).rejects.toThrow()
    await expect(validateRecoveryWrite({ ...root, contents: [{ resourceId, blob: new Blob(['corrupt']) }] }, fixture.state.workspace)).rejects.toThrow('digest')
    await expect(validateRecoveryWrite({ ...root, record: { ...root.record, retiredResources: [] } }, fixture.state.workspace)).rejects.toThrow('digest')
  })

  it('rejects older formats without changing the stored root', async () => {
    const { fixture, storage, barrier } = setup()
    await barrier.commit({ kind: 'read-started', ticket: 'persist' })
    const root = storage.root!
    for (const format of [1, 2, 3, 4, 5, 6, 7, 8]) await expect(validateRecoveryWrite({ ...root, record: { ...root.record, format: format as never } }, fixture.state.workspace)).rejects.toThrow('invalid workspace')
    expect(storage.root).toEqual(root)
  })
})
