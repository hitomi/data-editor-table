import { validateWorkspaceCheckpoint, type CheckpointMetadata, type WorkspaceCheckpoint } from './checkpoint.js'
import { ownEncodedValue } from './document.js'
import type { ResourceId } from './model.js'
import type { KernelSchema } from './schema.js'

/** Structured-clone transport for stores that cannot reliably serialize File
 * or Blob. File metadata belongs to the hashed manifest, never the byte carrier.
 * This is an encoding, not a storage receipt or a checkpoint-close proof. */
export type CheckpointTransport = Readonly<{
  format: 1
  metadata: CheckpointMetadata
  sha256: string
  contents: readonly Readonly<{ resourceId: ResourceId; bytes: ArrayBuffer }>[]
}>
const blobBytes = Blob.prototype.arrayBuffer
const bufferCopy = ArrayBuffer.prototype.slice

export async function encodeCheckpoint(checkpoint: WorkspaceCheckpoint, schema: KernelSchema): Promise<CheckpointTransport> {
  const sha256 = checkpoint.sha256
  const { metadata, resources } = await validateWorkspaceCheckpoint(checkpoint, schema)
  const contents: CheckpointTransport['contents'][number][] = []
  for (const entry of metadata.resources.manifest.entries) contents.push(Object.freeze({ resourceId: entry.descriptor.id,
    bytes: await blobBytes.call(resources.get(entry.descriptor.id)),
  }))
  return Object.freeze({ format: 1, metadata, sha256, contents: Object.freeze(contents) })
}

export async function decodeCheckpoint(raw: CheckpointTransport, schema: KernelSchema): Promise<WorkspaceCheckpoint> {
  if (raw.format !== 1) throw new Error('Unsupported checkpoint transport format.')
  const metadata = ownEncodedValue(raw.metadata) as unknown as CheckpointMetadata, sha256 = raw.sha256
  const descriptors = new Map(metadata.resources.manifest.entries.map(entry => [entry.descriptor.id, entry.descriptor]))
  // Copy every caller-owned buffer before the first digest await. Transfers or
  // mutations made by the caller afterward cannot change the decoded snapshot.
  const contents = Object.freeze(raw.contents.map(entry => {
    const descriptor = descriptors.get(entry.resourceId)
    if (!descriptor) throw new Error('Checkpoint transport has an unexpected resource.')
    return Object.freeze({ resourceId: entry.resourceId, blob: new Blob([bufferCopy.call(entry.bytes, 0)], { type: descriptor.mediaType }) })
  }))
  const checkpoint = Object.freeze({ metadata, sha256, contents })
  await validateWorkspaceCheckpoint(checkpoint, schema)
  return checkpoint
}
