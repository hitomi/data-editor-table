import { type DurableTaskDefinition } from 'data-editor-table'
import { openDurableConversion } from './durable-conversion.js'

export function imageDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.onabort = () => reject(new Error('Image reading was interrupted.'))
    reader.readAsDataURL(blob)
  })
}
export function openImageTask(databaseName: string): Promise<DurableTaskDefinition> {
  return openDurableConversion(databaseName, {
    ref: { id: 'image-data-url', version: 'v1' },
    failure: { code: 'image-conversion', message: 'The image could not be converted.' },
    async convert(request, resource) {
      if (!resource || request.owner.kind !== 'session' || !resource.type.startsWith('image/')) throw new Error('Choose an image file.')
      return { kind: 'session-candidate', sessionId: request.owner.sessionId, input: { kind: 'encoded', value: await imageDataUrl(resource) } }
    },
  })
}
