import { encodedValuesEqual, ownEncodedValue } from '../kernel/document.js'
import type { EncodedValue, OwnedInput } from '../kernel/model.js'

/** Independent of the business-row codec: editor drafts can contain values
 * which are not valid cell values yet. Do not parse or normalize them here. */
export type GridInputCodec<Input> = Readonly<{
  version: string
  copy(input: Input): Input
  equals(left: Input, right: Input): boolean
  encode(input: Input): unknown
  decode(value: EncodedValue): Input
}>

export function captureGridInput<Input>(input: Input, codec?: GridInputCodec<Input>): OwnedInput {
  if (!codec) return Object.freeze({ kind: 'encoded', value: ownEncodedValue(input) })
  if (!codec.version.trim()) throw new Error('An input codec requires a fixed version.')
  const copy = (value: Input): Input => {
    const result = codec.copy(value)
    if (typeof value === 'object' && value !== null && result === value)
      throw new Error('An input codec must copy its input independently.')
    return result
  }
  const owned = copy(input), before = copy(owned)
  const data = ownEncodedValue(codec.encode(owned))
  if (!codec.equals(owned, before)) throw new Error('The input codec mutated its input.')
  if (!encodedValuesEqual(data, ownEncodedValue(codec.encode(copy(before)))))
    throw new Error('The input codec is not deterministic.')
  const decoded = codec.decode(data)
  if (!codec.equals(before, decoded) || !encodedValuesEqual(data, ownEncodedValue(codec.encode(copy(decoded)))))
    throw new Error('The input codec must preserve the complete unparsed draft.')
  return Object.freeze({ kind: 'encoded', value: ownEncodedValue({ codec: codec.version, data }) })
}

/** Take ownership without parsing or requiring an already valid cell value. */
export function copyGridInput<Input>(input: Input, codec?: GridInputCodec<Input>): Input {
  const result = codec ? codec.copy(input) : structuredClone(input)
  if (typeof input === 'object' && input !== null && result === input)
    throw new Error('An input codec must return an independent copy.')
  return result
}
