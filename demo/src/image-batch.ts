import { ownEncodedValue, type EncodedValue } from 'data-editor-table'

const magic = new TextEncoder().encode('RDGIB001')
const maxFiles = 24, maxFileBytes = 8 * 1024 * 1024, maxBatchBytes = 48 * 1024 * 1024, maxHeaderBytes = 64 * 1024
const mediaType = 'application/x-data-editor-image-batch'
type Entry = { name: string; mediaType: string; size: number; lastModified: number }
type Header = { format: 'image-import-batch:1'; plan: EncodedValue; files: Entry[] }

/** Synchronous capture precedes any asynchronous conversion. One registered
 * resource owns all original file bytes, metadata and the frozen target plan.
 * Decoding reconstructs the original files; it never resolves current rows. */
export function captureImageBatch(files: readonly File[], plan: EncodedValue): File {
  if (!files.length || files.length > maxFiles) throw new Error(`Choose between 1 and ${maxFiles} images.`)
  const entries = files.map(file => ({ name: file.name, mediaType: file.type, size: file.size, lastModified: file.lastModified }))
  validateEntries(entries)
  const header: Header = { format: 'image-import-batch:1', plan: ownEncodedValue(plan), files: entries }
  const bytes = new TextEncoder().encode(JSON.stringify(header))
  if (bytes.length > maxHeaderBytes) throw new Error('The import target plan is too large.')
  const prefix = new Uint8Array(12); prefix.set(magic); new DataView(prefix.buffer).setUint32(8, bytes.length)
  return new File([prefix, bytes, ...files], 'image-import.batch', { type: mediaType, lastModified: 0 })
}
function validateEntries(entries: readonly Entry[]) {
  if (!entries.length || entries.length > maxFiles) throw new Error('Invalid image count.')
  let size = 0
  for (const entry of entries) {
    if (typeof entry.mediaType === 'string' && !entry.mediaType.startsWith('image/')) throw new Error('Only image files can be imported.')
    if (entry.size > maxFileBytes) throw new Error('Each image must be no larger than 8 MiB.')
    if (typeof entry.name !== 'string' || !entry.name || typeof entry.mediaType !== 'string' || !entry.mediaType.startsWith('image/')
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxFileBytes || !Number.isSafeInteger(entry.lastModified)) throw new Error('Invalid image metadata or file size.')
    size += entry.size
  }
  if (size > maxBatchBytes) throw new Error('The image batch exceeds 48 MiB.')
}
export async function decodeImageBatch(blob: Blob): Promise<Readonly<{ plan: EncodedValue; files: readonly File[] }>> {
  if (blob.type !== mediaType || blob.size < 12 || blob.size > 12 + maxHeaderBytes + maxBatchBytes) throw new Error('Invalid image batch resource.')
  const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  if (magic.some((byte, index) => prefix[index] !== byte)) throw new Error('Unknown image batch format.')
  const headerSize = new DataView(prefix.buffer).getUint32(8)
  if (!headerSize || headerSize > maxHeaderBytes || 12 + headerSize > blob.size) throw new Error('Invalid image batch header size.')
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await blob.slice(12, 12 + headerSize).arrayBuffer()))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid image batch header.')
  const header = raw as Header
  if (header.format !== 'image-import-batch:1' || !Array.isArray(header.files) || header.files.some(entry => !entry || typeof entry !== 'object')) throw new Error('Invalid image batch manifest.')
  validateEntries(header.files)
  const plan = ownEncodedValue(header.plan)
  let offset = 12 + headerSize
  if (offset + header.files.reduce((size, entry) => size + entry.size, 0) !== blob.size) throw new Error('Image batch content length differs from its manifest.')
  const files = header.files.map(entry => {
    const file = new File([blob.slice(offset, offset + entry.size)], entry.name, { type: entry.mediaType, lastModified: entry.lastModified })
    offset += entry.size
    return file
  })
  return Object.freeze({ plan, files: Object.freeze(files) })
}
