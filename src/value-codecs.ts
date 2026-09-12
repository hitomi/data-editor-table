import type { ResourceValue } from './kernel/model.js'

/** Authoring text and validation are separate from localized display. Formatting
 * unsupported stored values throws so an editor cannot silently normalize them. */
export type WorkspaceTextCodec = Readonly<{
  inputKind?: 'text' | 'number' | 'date' | 'boolean'
  format(value: ResourceValue): string
  display?(value: ResourceValue): string
  choices?: Readonly<{ placeholder: string; multiple?: boolean; options: readonly Readonly<{ text: string; label: string; disabled?: boolean }>[] }>
  parse(text: string): Readonly<{ kind: 'valid'; value: ResourceValue }> | Readonly<{ kind: 'invalid'; message: string }>
}>

export type WorkspaceChoice = Readonly<{ value: string | number; label: string; disabled?: boolean }>

/** Multi-choice authoring is an ordered array of typed scalar tokens. Empty
 * means an empty array, not null or a removed field. */
export function createMultiChoiceCodec(options: Readonly<{ options: readonly WorkspaceChoice[]; invalid: string; placeholder: string }>): WorkspaceTextCodec {
  const single = createSingleChoiceCodec(options), invalid = options.invalid, placeholder = options.placeholder
  const format = (value: ResourceValue) => {
    if (value.kind !== 'value' || !Array.isArray(value.value)) throw new Error('Multi-choice values require an array.')
    const tokens = value.value.map(value => single.format({ kind: 'value', value }))
    if (new Set(tokens).size !== tokens.length) throw new Error('Multi-choice values must be unique.')
    return JSON.stringify(tokens)
  }
  return Object.freeze({ format,
    display(value: ResourceValue) {
      format(value)
      return value.kind === 'value' && Array.isArray(value.value) && value.value.length
        ? value.value.map(value => single.display!({ kind: 'value', value })).join(', ') : placeholder
    },
    choices: Object.freeze({ ...single.choices!, multiple: true }),
    parse(text: string) {
      try {
        const tokens: unknown = JSON.parse(text)
        if (!Array.isArray(tokens) || tokens.some(token => typeof token !== 'string') || new Set(tokens).size !== tokens.length) throw new Error('Invalid selection.')
        const values = tokens.map(token => {
          const parsed = single.parse(token)
          if (parsed.kind !== 'valid' || parsed.value.kind !== 'value') throw new Error('Unknown choice.')
          return parsed.value.value
        })
        return { kind: 'valid' as const, value: { kind: 'value' as const, value: Object.freeze(values) } }
      } catch { return { kind: 'invalid' as const, message: invalid } }
    },
  })
}

/** Typed values have distinct authoring tokens. Labels are display only and
 * never determine identity. The catalog is copied once, outside session state. */
export function createSingleChoiceCodec(options: Readonly<{
  options: readonly WorkspaceChoice[]; invalid: string; placeholder: string; empty?: EmptyValuePolicy
}>): WorkspaceTextCodec {
  const { invalid, placeholder, empty = 'reject' } = options
  if (!invalid || !placeholder || !['reject', 'missing', 'null'].includes(empty)) throw new Error('Invalid choice configuration.')
  const catalog = new Map<string, WorkspaceChoice>()
  for (const option of options.options) {
    if (!option.label || typeof option.value !== 'string' && (typeof option.value !== 'number' || !Number.isFinite(option.value) || Object.is(option.value, -0))) throw new Error('Choices require labels and finite string/number values.')
    const key = JSON.stringify(option.value)
    if (catalog.has(key)) throw new Error('Choice values must be unique.')
    catalog.set(key, Object.freeze({ ...option }))
  }
  const format = (value: ResourceValue): string => {
    if (value.kind === 'missing' && empty === 'missing' || value.kind === 'value' && value.value === null && empty === 'null') return ''
    const key = value.kind === 'value' ? JSON.stringify(value.value) : undefined
    if (key === undefined || !catalog.has(key)) throw new Error('The stored choice is not in this catalog.')
    return key
  }
  return Object.freeze({ format,
    display(value: ResourceValue) { const key = format(value); return key === '' ? placeholder : catalog.get(key)!.label },
    choices: Object.freeze({ placeholder, options: Object.freeze([...catalog].map(([text, option]) => Object.freeze({ text, label: option.label, disabled: option.disabled === true }))) }),
    parse(text: string) {
      if (text === '' && empty !== 'reject') return { kind: 'valid' as const, value: empty === 'missing' ? { kind: 'missing' as const } : { kind: 'value' as const, value: null } }
      const option = catalog.get(text)
      return option ? { kind: 'valid' as const, value: { kind: 'value' as const, value: option.value } } : { kind: 'invalid' as const, message: invalid }
    },
  })
}

export function createBooleanChoiceCodec(options: Options & Readonly<{ trueLabel: string; falseLabel: string; placeholder: string }>): WorkspaceTextCodec {
  const { trueLabel, falseLabel, placeholder } = options
  if (!trueLabel || !falseLabel || trueLabel === falseLabel || !placeholder) throw new Error('Boolean choices require distinct labels and a placeholder.')
  const codec = createBooleanCodec(options)
  return Object.freeze({ ...codec,
    display(value: ResourceValue) { const text = codec.format(value); return text === '' ? placeholder : text === 'true' ? trueLabel : falseLabel },
    choices: Object.freeze({ placeholder, options: Object.freeze([Object.freeze({ text: 'true', label: trueLabel }), Object.freeze({ text: 'false', label: falseLabel })]) }),
  })
}
export type EmptyValuePolicy = 'reject' | 'missing' | 'null'
type Scalar = string | number | boolean
type Options = Readonly<{ invalid: string; empty?: EmptyValuePolicy }>

function scalarCodec(options: Options, accepts: (value: unknown) => value is Scalar, parse: (text: string) => Scalar | undefined,
  format: (value: Scalar) => string = String): WorkspaceTextCodec {
  const { invalid, empty = 'reject' } = options
  if (!invalid || !['reject', 'missing', 'null'].includes(empty)) throw new Error('A codec requires an error message and a valid empty policy.')
  return Object.freeze({
    format(value: ResourceValue) {
      if (value.kind === 'missing' && empty === 'missing' || value.kind === 'value' && value.value === null && empty === 'null') return ''
      if (value.kind !== 'value' || !accepts(value.value)) throw new Error('The stored value cannot be represented by this codec.')
      return format(value.value)
    },
    parse(text: string) {
      if (text === '' && empty !== 'reject') return { kind: 'valid' as const, value: empty === 'missing' ? { kind: 'missing' as const } : { kind: 'value' as const, value: null } }
      const value = parse(text)
      return value === undefined || !accepts(value) ? { kind: 'invalid' as const, message: invalid } : { kind: 'valid' as const, value: { kind: 'value' as const, value } }
    },
  })
}

/** Empty strings remain strings. No trimming or coercion occurs. */
export function createStringCodec(options: Readonly<{ invalid: string; allowEmpty?: boolean }>): WorkspaceTextCodec {
  const { invalid, allowEmpty = true } = options
  return Object.freeze({ ...scalarCodec({ invalid }, (value): value is string => typeof value === 'string' && (allowEmpty || value.length > 0), text => text), inputKind: 'text' as const })
}

/** Locale-independent decimal authoring, including exponents. Empty input never
 * means zero; whitespace, hex, Infinity and unsafe integers are rejected. */
export function createNumberCodec(options: Options & Readonly<{ minimum?: number; maximum?: number; integer?: boolean }>): WorkspaceTextCodec {
  const { minimum, maximum, integer = false } = options
  if (minimum !== undefined && !Number.isFinite(minimum) || maximum !== undefined && !Number.isFinite(maximum)
    || minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error('Invalid numeric bounds.')
  const accepts = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value)) && (!integer || Number.isInteger(value))
    && (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum)
  return Object.freeze({ ...scalarCodec(options, accepts, text => {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined
    const value = Number(text)
    // A nonzero decimal must not silently underflow into an exact zero.
    return value === 0 && /[1-9]/.test(text.split(/[eE]/)[0]!) ? undefined : value
  },
    value => Object.is(value, -0) ? '-0' : String(value)), inputKind: 'number' as const })
}

export function createBooleanCodec(options: Options): WorkspaceTextCodec {
  return Object.freeze({ ...scalarCodec(options, (value): value is boolean => typeof value === 'boolean',
    text => text.toLowerCase() === 'true' ? true : text.toLowerCase() === 'false' ? false : undefined), inputKind: 'boolean' as const })
}

/** Gregorian YYYY-MM-DD, years 0001–9999. No Date parsing or timezone conversion. */
export function createIsoDateCodec(options: Options & Readonly<{ allowEmpty?: boolean }>): WorkspaceTextCodec {
  if (options.allowEmpty && options.empty && options.empty !== 'reject') throw new Error('An empty date string cannot also represent null or a missing field.')
  const accepts = (value: unknown): value is string => {
    if (options.allowEmpty && value === '') return true
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10))
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return year > 0 && month > 0 && month <= 12 && day > 0 && day <= days[month - 1]!
  }
  return Object.freeze({ ...scalarCodec(options, accepts, text => text), inputKind: 'date' as const })
}
