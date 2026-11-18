import { encodedValuesEqual, ownEncodedValue } from './document.js'
import type { ResourceDescriptor, ResourceId, WorkspaceIdentity } from './model.js'
import { assertRegisteredResources, ownResourceDescriptor } from './resource-ownership.js'
import type { KernelState } from './state.js'

export type ResourceManifestEntry = Readonly<{ descriptor: ResourceDescriptor; sha256: string }>
export type ResourceManifest = Readonly<{ format: 1; workspace: WorkspaceIdentity; revision: number; entries: readonly ResourceManifestEntry[] }>
/** Blob payloads are structured-cloneable content, not a manifest-only promise
 * that a browser File or an in-memory URL can be recovered after restart. */
export type ResourceBundle = Readonly<{ manifest: ResourceManifest; contents: readonly Readonly<{ resourceId: ResourceId; blob: Blob }>[] }>
/** Complete physical inventory, including registrations not yet published to
 * the semantic root. This is one component of a Workspace checkpoint. */
export type ResourceCheckpoint = Readonly<{ format: 1; bundle: ResourceBundle; retired: readonly ResourceId[] }>
type Stored = Readonly<{ descriptor: ResourceDescriptor; blob: Blob }>
const equal = (a: unknown, b: unknown) => encodedValuesEqual(ownEncodedValue(a), ownEncodedValue(b))
const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!
const blobType = Object.getOwnPropertyDescriptor(Blob.prototype, 'type')!.get!
const blobSlice = Blob.prototype.slice
const blobBytes = Blob.prototype.arrayBuffer

/** Use built-in Blob accessors so custom instance properties cannot mutate
 * the owned resource metadata or replace the method used during export. */
function capture(id: ResourceId, value: Blob): Stored {
  const size: number = blobSize.call(value), mediaType: string = blobType.call(value)
  let descriptor: ResourceDescriptor = { id, kind: 'blob', size, mediaType }
  if (typeof File !== 'undefined') {
    try {
      const name: string = Object.getOwnPropertyDescriptor(File.prototype, 'name')!.get!.call(value)
      const lastModified: number = Object.getOwnPropertyDescriptor(File.prototype, 'lastModified')!.get!.call(value)
      descriptor = { id, kind: 'file', size, mediaType, name, lastModified }
    } catch { /* A plain Blob has no File brand or file metadata. */ }
  }
  return Object.freeze({ descriptor: ownResourceDescriptor(descriptor), blob: blobSlice.call(value, 0, size, mediaType) })
}

function copy(stored: Stored): Blob {
  const { descriptor, blob } = stored
  return descriptor.kind === 'file'
    ? new File([blob], descriptor.name, { type: descriptor.mediaType, lastModified: descriptor.lastModified })
    : blobSlice.call(blob, 0, descriptor.size, descriptor.mediaType)
}

async function digest(blob: Blob): Promise<string> {
  const bytes = await blobBytes.call(blob), hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Physical bytes live outside the pure kernel. Resource IDs are immutable
 * lifetime identities; semantic ownership and release are kernel transitions. */
export class ResourceStore {
  #entries = new Map<ResourceId, Stored>()
  #seen = new Set<ResourceId>()

  register(id: ResourceId, value: Blob): ResourceDescriptor {
    if (this.#seen.has(id)) throw new Error('A physical resource identity cannot be reused.')
    const stored = capture(id, value)
    this.#entries.set(id, stored); this.#seen.add(id)
    return stored.descriptor
  }

  get(id: ResourceId): Blob {
    const stored = this.#entries.get(id)
    if (!stored) throw new Error('Resource bytes are unavailable.')
    return copy(stored)
  }

  /** The owner must publish an accepted release transition first. A bundle
   * already exporting retains its own immutable Blob references. */
  release(id: ResourceId): void { this.#entries.delete(id) }

  assertState(state: KernelState): void {
    assertRegisteredResources(state)
    for (const record of state.resources) if (record.status === 'available') {
      const stored = this.#entries.get(record.descriptor.id)
      if (!stored || !equal(stored.descriptor, record.descriptor)) throw new Error('Resource metadata has no matching owned physical content.')
    }
  }

  async export(state: KernelState): Promise<ResourceBundle> {
    this.assertState(state)
    // Capture all available bytes synchronously, including registered resources
    // awaiting input handoff. No mutable store lookup follows an await.
    const captured = state.resources.flatMap(record => record.status === 'available' ? [this.#entries.get(record.descriptor.id)!] : [])
    return ResourceStore.#export(state.workspace, state.revision, captured)
  }

  async exportCheckpoint(state: KernelState): Promise<ResourceCheckpoint> {
    return this.#checkpoint(state, false)
  }

  /** Durable roots retain staged registrations too. A published release is
   * sufficient to omit its bytes even before runtime cleanup has run. */
  async exportRecovery(state: KernelState): Promise<ResourceCheckpoint> {
    return this.#checkpoint(state, true)
  }

  async #checkpoint(state: KernelState, omitReleased: boolean): Promise<ResourceCheckpoint> {
    this.assertState(state)
    const released = new Set(omitReleased ? state.resources.filter(record => record.status === 'released').map(record => record.descriptor.id) : [])
    const captured = [...this.#entries.values()].filter(entry => !released.has(entry.descriptor.id))
    const present = new Set(captured.map(entry => entry.descriptor.id))
    const retired = Object.freeze([...new Set([...this.#seen, ...state.resources.map(record => record.descriptor.id)])].filter(id => !present.has(id)))
    const bundle = await ResourceStore.#export(state.workspace, state.revision, captured)
    return Object.freeze({ format: 1, bundle, retired })
  }

  static async #export(workspace: WorkspaceIdentity, revision: number, captured: readonly Stored[]): Promise<ResourceBundle> {
    workspace = ownEncodedValue(workspace) as unknown as WorkspaceIdentity
    const entries: ResourceManifestEntry[] = []
    // Hash sequentially to avoid materializing all file ArrayBuffers together.
    for (const stored of captured) entries.push(Object.freeze({ descriptor: stored.descriptor, sha256: await digest(stored.blob) }))
    const manifest = ownEncodedValue({ format: 1, workspace, revision, entries }) as unknown as ResourceManifest
    return Object.freeze({ manifest, contents: Object.freeze(captured.map(stored => Object.freeze({ resourceId: stored.descriptor.id,
      blob: blobSlice.call(stored.blob, 0, stored.descriptor.size, stored.descriptor.mediaType),
    }))) })
  }

  /** Restore into an isolated store only after every entry's metadata, size,
   * content digest and workspace/revision binding has been verified. */
  static restore(state: KernelState, raw: ResourceBundle): Promise<ResourceStore> {
    return ResourceStore.#restore(state, raw, state.resources.filter(record => record.status === 'available').map(record => record.descriptor), [])
  }

  static async restoreCheckpoint(state: KernelState, raw: ResourceCheckpoint): Promise<ResourceStore> {
    const metadata = ownEncodedValue({ format: raw.format, manifest: raw.bundle.manifest, retired: raw.retired }) as unknown as {
      format: number; manifest: ResourceManifest; retired: readonly ResourceId[]
    }
    const descriptors = metadata.manifest.entries.map(entry => ownResourceDescriptor(entry.descriptor))
    const physical = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]))
    if (metadata.format !== 1 || new Set(metadata.retired).size !== metadata.retired.length
      || metadata.retired.some(id => typeof id !== 'string' || !id || physical.has(id))) throw new Error('Invalid physical resource lifetime inventory.')
    const retired = new Set(metadata.retired)
    for (const record of state.resources) {
      const present = physical.get(record.descriptor.id)
      if (present ? !equal(present, record.descriptor) : record.status === 'available' || !retired.has(record.descriptor.id))
        throw new Error('Physical checkpoint does not preserve the semantic resource identity and lifetime.')
    }
    return ResourceStore.#restore(state, { manifest: metadata.manifest, contents: raw.bundle.contents }, descriptors, metadata.retired)
  }

  static async #restore(state: KernelState, raw: ResourceBundle, available: readonly ResourceDescriptor[], retired: readonly ResourceId[]): Promise<ResourceStore> {
    const manifest = ownEncodedValue(raw.manifest) as unknown as ResourceManifest
    if (manifest.format !== 1 || manifest.revision !== state.revision || !equal(manifest.workspace, state.workspace)) throw new Error('Resource bundle belongs to another checkpoint context.')
    assertRegisteredResources(state)
    const metadata = new Map(manifest.entries.map(entry => [entry.descriptor.id, entry] as const))
    const contents = new Map(raw.contents.map(entry => [entry.resourceId, entry.blob] as const))
    if (metadata.size !== manifest.entries.length || contents.size !== raw.contents.length || metadata.size !== available.length || contents.size !== available.length)
      throw new Error('Resource manifest and content must cover all available resources exactly once.')
    // Snapshot caller-owned containers and Blob metadata before awaiting hashes.
    const captured = available.map(descriptor => {
      const id = descriptor.id, entry = metadata.get(id), blob = contents.get(id)
      if (!entry || !blob || !equal(descriptor, ownResourceDescriptor(entry.descriptor)) || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('Resource descriptor or content digest is missing or inconsistent.')
      const content = capture(id, blob)
      if (content.descriptor.size !== entry.descriptor.size || content.descriptor.mediaType !== entry.descriptor.mediaType) throw new Error('Resource bytes do not match the manifest metadata.')
      // File metadata belongs to the manifest; byte transports may structured
      // clone a File as a Blob. Reconstruct the File only when it is read.
      const stored: Stored = Object.freeze({ descriptor: entry.descriptor, blob: content.blob })
      return { stored, sha256: entry.sha256 }
    })
    for (const entry of captured) if (await digest(entry.stored.blob) !== entry.sha256) throw new Error('Resource content digest does not match its checkpoint manifest.')
    const store = new ResourceStore()
    for (const entry of captured) { store.#entries.set(entry.stored.descriptor.id, entry.stored); store.#seen.add(entry.stored.descriptor.id) }
    for (const record of state.resources) store.#seen.add(record.descriptor.id)
    for (const id of retired) store.#seen.add(id)
    store.assertState(state)
    return store
  }
}
