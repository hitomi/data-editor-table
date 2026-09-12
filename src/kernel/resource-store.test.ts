import { describe, expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { kernelId, type ResourceId } from './model.js'
import { ResourceStore, type ResourceBundle } from './resource-store.js'
import { referencedResources } from './resource-ownership.js'

function register(fixture: KernelFixture, store: ResourceStore, name: string, blob: Blob): ResourceId {
  const id = kernelId<'resource'>(name), descriptor = store.register(id, blob)
  expect(fixture.dispatch({ kind: 'resource-registered', descriptor }).result.kind).toBe('accepted')
  return id
}

describe('owned file resources and content manifests', () => {
  it('owns File bytes and standard metadata independently of source buffers or custom instance properties', async () => {
    const store = new ResourceStore(), id = kernelId<'resource'>('file'), bytes = new Uint8Array([0, 1, 255])
    const file = new File([bytes], '数据.bin', { type: 'application/octet-stream', lastModified: 123 })
    const descriptor = store.register(id, file)
    bytes.fill(7)
    Object.defineProperty(file, 'name', { value: 'mutated-name' })
    Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('Mutated source method') } })
    const copy = store.get(id) as File
    expect(copy).not.toBe(file)
    expect(descriptor).toEqual({ id, kind: 'file', name: '数据.bin', lastModified: 123, size: 3, mediaType: 'application/octet-stream' })
    expect(copy.name).toBe('数据.bin'); expect(copy.lastModified).toBe(123)
    expect([...new Uint8Array(await copy.arrayBuffer())]).toEqual([0, 1, 255])
    Object.defineProperty(copy, 'arrayBuffer', { value: () => { throw new Error('Mutated returned object') } })
    expect([...new Uint8Array(await store.get(id).arrayBuffer())]).toEqual([0, 1, 255])
  })

  it('rejects unknown input resources and keeps cancelled historical input pinned', () => {
    const fixture = new KernelFixture({}), store = new ResourceStore(), sessionId = kernelId<'session'>('filter')
    const event = { kind: 'session-opened' as const, revision: fixture.state.revision, sessionId, inputId: kernelId<'input'>('input'), viewId: kernelId<'view'>('view'),
      target: { kind: 'filter' as const, columnId: 'file', queryVersion: 0 }, input: { kind: 'resource' as const, id: kernelId<'resource'>('missing') }, reads: [] }
    const before = fixture.state
    expect(fixture.dispatch(event).result.kind).toBe('rejected'); expect(fixture.state).toBe(before)
    const id = register(fixture, store, 'registered', new Blob(['abc']))
    expect(fixture.dispatch({ ...event, revision: fixture.state.revision, input: { kind: 'resource', id } }).result.kind).toBe('accepted')
    const session = fixture.state.session!
    fixture.dispatch({ kind: 'session-cancelled', sessionId, lease: session.editor, inputVersion: session.input.version })
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('cancelled-session')
    expect(referencedResources(fixture.state).has(id)).toBe(true)
    expect(fixture.dispatch({ kind: 'resource-released', resourceId: id }).result.kind).toBe('rejected')
    expect(() => store.assertState(fixture.state)).not.toThrow()
  })

  it('exports all available staged bytes and round-trips File metadata through Blob-only content', async () => {
    const fixture = new KernelFixture({}), store = new ResourceStore()
    const file = register(fixture, store, 'file', new File(['hello'], 'hello.txt', { type: 'text/plain', lastModified: 12 }))
    const blob = register(fixture, store, 'blob', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }))
    const bundle = await store.export(fixture.state)
    expect(bundle.manifest.revision).toBe(fixture.state.revision)
    expect(bundle.manifest.entries.map(entry => entry.descriptor.id)).toEqual([file, blob])
    expect(bundle.manifest.entries[0]?.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(bundle.contents[0]?.blob).not.toBeInstanceOf(File)
    const restored = await ResourceStore.restore(fixture.state, structuredClone(bundle))
    const recovered = restored.get(file) as File
    expect(recovered.name).toBe('hello.txt'); expect(recovered.lastModified).toBe(12); expect(recovered.type).toBe('text/plain')
    expect(await recovered.text()).toBe('hello')
    expect([...new Uint8Array(await restored.get(blob).arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('rejects missing, duplicate, truncated, changed and wrong-context bundle content without a partial restore', async () => {
    const fixture = new KernelFixture({}), store = new ResourceStore()
    register(fixture, store, 'file', new File(['hello'], 'hello.txt', { type: 'text/plain', lastModified: 12 }))
    const bundle = await store.export(fixture.state), first = bundle.contents[0]!, metadata = bundle.manifest.entries[0]!
    const invalid: ResourceBundle[] = [
      { ...bundle, contents: [] },
      { ...bundle, contents: [first, first] },
      { ...bundle, contents: [{ ...first, blob: new Blob(['hell'], { type: 'text/plain' }) }] },
      { ...bundle, contents: [{ ...first, blob: new Blob(['HELLO'], { type: 'text/plain' }) }] },
      { ...bundle, manifest: { ...bundle.manifest, revision: bundle.manifest.revision + 1 } },
      { ...bundle, manifest: { ...bundle.manifest, workspace: { ...bundle.manifest.workspace, id: kernelId<'workspace'>('other') } } },
      { ...bundle, manifest: { ...bundle.manifest, entries: [metadata, metadata] } },
      { ...bundle, manifest: { ...bundle.manifest, entries: [{ ...metadata, sha256: '0'.repeat(64) }] } },
      { ...bundle, manifest: { ...bundle.manifest, entries: [{ ...metadata, descriptor: { ...metadata.descriptor, mediaType: 'different' } }] } },
    ]
    for (const candidate of invalid) await expect(ResourceStore.restore(fixture.state, candidate)).rejects.toThrow()
    expect(await store.get(first.resourceId).text()).toBe('hello')
  })

  it('keeps an in-progress export fixed to its captured state even after explicit release of unreferenced staging', async () => {
    const fixture = new KernelFixture({}), store = new ResourceStore(), id = register(fixture, store, 'staged', new Blob(['staged bytes']))
    const captured = fixture.state, exporting = store.export(captured)
    expect(fixture.dispatch({ kind: 'resource-released', resourceId: id }).result.kind).toBe('accepted')
    store.release(id)
    expect(() => store.get(id)).toThrow('unavailable')
    const bundle = await exporting
    expect(bundle.manifest.revision).toBe(captured.revision)
    expect(await bundle.contents[0]!.blob.text()).toBe('staged bytes')
    expect(await (await ResourceStore.restore(captured, bundle)).get(id).text()).toBe('staged bytes')
    await expect(ResourceStore.restore(fixture.state, bundle)).rejects.toThrow('checkpoint context')
    const latest = await store.export(fixture.state), recovered = await ResourceStore.restore(fixture.state, latest)
    expect(latest.contents).toEqual([])
    expect(() => recovered.register(id, new Blob(['new']))).toThrow('reused')
    expect(fixture.dispatch({ kind: 'resource-registered', descriptor: captured.resources[0]!.descriptor }).result.kind).toBe('rejected')
  })

  it('rejects physical content mismatches instead of exporting a metadata-only recovery promise', async () => {
    const fixture = new KernelFixture({}), store = new ResourceStore()
    const id = register(fixture, store, 'bytes', new Blob(['abc']))
    const altered = { ...fixture.state, resources: fixture.state.resources.map(record => ({ ...record, descriptor: { ...record.descriptor, size: 9 } })) }
    await expect(store.export(altered)).rejects.toThrow('physical content')
    store.release(id)
    await expect(store.export(fixture.state)).rejects.toThrow('physical content')
  })
})
