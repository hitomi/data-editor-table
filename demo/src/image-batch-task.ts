import { type DurableTaskDefinition } from 'data-editor-table'
import { decodeImageBatch } from './image-batch.js'
import { openDurableConversion } from './durable-conversion.js'
import { imageDataUrl } from './image-task.js'

/** Produces review data only. Original target identities and file order travel
 * with the result; conversion never consults current grid selection or rows. */
export function openImageBatchTask(databaseName: string): Promise<DurableTaskDefinition> {
  return openDurableConversion(databaseName, {
    ref: { id: 'image-batch-data-url', version: 'v1' },
    failure: { code: 'image-batch-conversion', message: 'The image batch could not be converted. Original files are retained.' },
    async convert(request, resource) {
      if (!resource || request.owner.kind !== 'workspace') throw new Error('An image batch requires its Workspace owner.')
      const batch = await decodeImageBatch(resource)
      const images = []
      // Read sequentially to bound concurrent FileReader buffers for 48 MiB batches.
      for (const file of batch.files) images.push({ fileName: file.name,
        name: file.name.replace(/\.[^.]+$/, '') || file.name, image: await imageDataUrl(file) })
      return { kind: 'action-candidate', input: { kind: 'encoded', value: { format: 'image-import-result:1', plan: batch.plan, images } } }
    },
  })
}
