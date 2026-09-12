import { describe, expect, it } from 'vitest'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { Workspace } from './workspace.js'
import { kernelId } from './model.js'
import { decodeCheckpoint, encodeCheckpoint } from './checkpoint-transport.js'
import { validateWorkspaceCheckpoint } from './checkpoint.js'

async function setup() {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const workspace = new Workspace({ scope, source: new SourceFixture(scope, {}), schema: permissiveSchema, policy: permissivePolicy })
  const input = await workspace.registerResource(new File(['original bytes'], '原文.txt', { type: 'text/plain', lastModified: 19 }))
  return { workspace, input, checkpoint: await workspace.exportCheckpoint() }
}

describe('checkpoint structured-clone byte transport', () => {
  it('roundtrips file bytes and metadata through ArrayBuffers independently of Blob serialization', async () => {
    const { workspace, input, checkpoint } = await setup()
    const transport = structuredClone(await encodeCheckpoint(checkpoint, workspace.schema))
    expect(transport.contents[0]!.bytes).toBeInstanceOf(ArrayBuffer)
    const decoded = await decodeCheckpoint(transport, workspace.schema)
    const { resources } = await validateWorkspaceCheckpoint(decoded, workspace.schema), file = resources.get(input.id) as File
    expect(decoded.metadata).toEqual(checkpoint.metadata); expect(decoded.sha256).toBe(checkpoint.sha256)
    expect(await file.text()).toBe('original bytes'); expect(file.name).toBe('原文.txt'); expect(file.type).toBe('text/plain'); expect(file.lastModified).toBe(19)
  })

  it('owns the transport metadata and every byte buffer before asynchronous validation', async () => {
    const { workspace, checkpoint } = await setup(), transport = structuredClone(await encodeCheckpoint(checkpoint, workspace.schema))
    const decoding = decodeCheckpoint(transport, workspace.schema)
    new Uint8Array(transport.contents[0]!.bytes).fill(0)
    const mutated = transport.metadata.state as { revision: number }; mutated.revision += 1
    const decoded = await decoding
    expect(decoded.metadata).toEqual(checkpoint.metadata)
    expect(await decoded.contents[0]!.blob.text()).toBe('original bytes')
  })

  it('rejects corrupt, missing, duplicate and unsupported carriers before activation', async () => {
    const { workspace, checkpoint } = await setup(), transport = await encodeCheckpoint(checkpoint, workspace.schema)
    const corrupted = structuredClone(transport)
    const bytes = new Uint8Array(corrupted.contents[0]!.bytes)
    bytes[0] = bytes[0]! ^ 1
    await expect(decodeCheckpoint(corrupted, workspace.schema)).rejects.toThrow('digest')
    await expect(decodeCheckpoint({ ...transport, contents: [] }, workspace.schema)).rejects.toThrow()
    await expect(decodeCheckpoint({ ...transport, contents: [...transport.contents, ...transport.contents] }, workspace.schema)).rejects.toThrow()
    await expect(decodeCheckpoint({ ...transport, format: 2 as never }, workspace.schema)).rejects.toThrow('Unsupported')
  })
})
