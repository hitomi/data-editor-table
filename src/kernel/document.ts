import type { Document, EncodedValue, Patch, ResourceValue, StoragePath } from './model.js'

export const missingResource: ResourceValue = Object.freeze({ kind: 'missing' })

/** Own an encoded value. Accessors, hidden/symbol properties, holes and cycles
 * cannot be represented losslessly by the storage protocol, so reject them.
 */
export function ownEncodedValue(input: unknown): EncodedValue {
  const ancestors = new Set<object>()
  const own = (value: unknown): EncodedValue => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value
    if (typeof value !== 'object' || value === null) throw new Error('Value requires a lossless document codec.')
    if (ancestors.has(value)) throw new Error('Cyclic values require a document codec.')
    const array = Array.isArray(value)
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('Custom objects require a document codec.')
    ancestors.add(value)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new Error('Symbol properties require a document codec.')
      if (array) {
        const source = value as unknown[]
        if (Object.keys(descriptors).length !== source.length + 1) throw new Error('Sparse arrays and extra array properties are not encoded values.')
        const result: EncodedValue[] = []
        for (let index = 0; index < source.length; index++) {
          const entry = descriptors[String(index)]
          if (!entry || !('value' in entry) || !entry.enumerable) throw new Error('Array entries must be enumerable values.')
          result.push(own(entry.value))
        }
        return Object.freeze(result)
      }
      const result: Record<string, EncodedValue> = Object.create(null)
      for (const key of Object.keys(descriptors).sort()) {
        const entry = descriptors[key]!
        if (!('value' in entry) || !entry.enumerable) throw new Error('Accessors and hidden properties require a document codec.')
        result[key] = own(entry.value)
      }
      return Object.freeze(result)
    } finally { ancestors.delete(value) }
  }
  return own(input)
}

export function ownDocument(input: unknown): Document {
  const value = ownEncodedValue(input)
  if (!isDocument(value)) throw new Error('A row document must be an object.')
  return value
}

export function isDocument(value: EncodedValue): value is Document {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function encodedValuesEqual(left: EncodedValue, right: EncodedValue): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => encodedValuesEqual(value, right[index]!))
  }
  const a = left as Document, b = right as Document
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && encodedValuesEqual(a[key]!, b[key]!))
}

export function resourceValuesEqual(left: ResourceValue, right: ResourceValue) {
  return left.kind === 'missing' ? right.kind === 'missing'
    : right.kind === 'value' && encodedValuesEqual(left.value, right.value)
}

export function readDocument(document: Document, path: StoragePath): ResourceValue {
  let value: EncodedValue = document
  for (const key of path) {
    if (!isDocument(value) || !Object.hasOwn(value, key)) return missingResource
    value = value[key]!
  }
  return Object.freeze({ kind: 'value', value })
}

export function pathsOverlap(left: StoragePath, right: StoragePath) {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return false
  return true
}

/** Applies only explicit object-path writes. Never invent missing parents or
 * edit array indices: either would hide additional structural writes.
 */
export function applyDocumentPatches(document: Document, patches: readonly Patch[]): Document {
  let current = document
  for (const patch of patches) {
    if (patch.path.length === 0) throw new Error('Use an explicit row replacement for a root write.')
    const setAt = (parent: Document, depth: number): Document => {
      const key = patch.path[depth]!
      const copy: Record<string, EncodedValue> = Object.assign(Object.create(null), parent)
      if (depth === patch.path.length - 1) {
        if (patch.kind === 'remove') delete copy[key]
        else copy[key] = ownEncodedValue(patch.value)
      } else {
        const child = Object.hasOwn(parent, key) ? parent[key]! : undefined
        if (child === undefined || !isDocument(child)) throw new Error('A write parent is missing or is not an object.')
        copy[key] = setAt(child, depth + 1)
      }
      return Object.freeze(copy)
    }
    current = setAt(current, 0)
  }
  return current
}

/** A canonical serialization, not a cryptographic digest. Hashing belongs to
 * the gateway/runtime and hashes this exact representation.
 */
export function canonicalEncodedValue(value: EncodedValue): string {
  const encode = (owned: EncodedValue): string => {
    if (owned === null || typeof owned !== 'object') return JSON.stringify(owned)
    if (Array.isArray(owned)) return `[${owned.map(encode).join(',')}]`
    const object = owned as Document
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${encode(object[key]!)}`).join(',')}}`
  }
  return encode(ownEncodedValue(value))
}
