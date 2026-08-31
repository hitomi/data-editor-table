import type { ChangeEvent, KeyboardEvent } from 'react'

import type {
  GridCellBehavior,
  GridDateBulkDraft,
  GridNumberBulkDraft,
  GridStringBulkDraft,
  GridValueResult,
} from './contracts.js'
import type {
  GridCellBulkEditorProps,
  GridCellEditorProps,
  GridCellTypeFactory,
  GridCellViewProps,
} from './react-view-contracts.js'
import { defineCellTypeFactory } from './registry.js'

export type GridStringColumnOptions = Readonly<{
  inputMode?: 'text' | 'email' | 'search' | 'tel' | 'url'
  placeholder?: string
}>

export type GridStringCellTypeOptions = Readonly<{
  locale?: string | readonly string[]
  sensitivity?: Intl.CollatorOptions['sensitivity']
}>

export function createStringCellType(
  options: GridStringCellTypeOptions = {},
): GridCellTypeFactory<
  string,
  string,
  GridStringBulkDraft,
  GridStringColumnOptions | undefined
> {
  const collator = new Intl.Collator(options.locale, {
    numeric: true,
    sensitivity: options.sensitivity ?? 'base',
  })
  return defineCellTypeFactory<
    string,
    string,
    GridStringBulkDraft,
    GridStringColumnOptions | undefined
  >(() => ({
    behavior: createStringBehavior(collator),
    view: {
      Cell: StandardTextCell,
      Editor: StringEditor,
      BulkEditor: StringBulkEditor,
      presentation: {
        content: 'padded',
        align: 'start',
        editActivation: ['double-click', 'enter', 'f2', 'printable'],
      },
    },
  }))
}

function createStringBehavior<Row>(
  collator: Intl.Collator,
): GridCellBehavior<
  Row,
  string,
  string,
  GridStringBulkDraft,
  GridStringColumnOptions | undefined
> {
  return {
    value: {
      validate: (value) => typeof value === 'string'
        ? success(value)
        : failure('invalid-string-value', 'The value must be text.'),
    },
    text: {
      display: (value) => value,
      search: (value) => value,
      original: (value) => value,
    },
    equals: Object.is,
    clipboard: {
      format: (value) => value,
      parse: (text) => success(text),
    },
    edit: {
      begin: (value) => value,
      commit: (draft) => success(draft),
    },
    clear: () => success(''),
    compare: (left, right) => collator.compare(left, right),
    filter: {
      defaultOperator: 'contains',
      operators: [
        textFilter('contains', 'Contains', true, (value, raw) => normalize(value).includes(normalize(raw))),
        textFilter('not-contains', 'Does not contain', true, (value, raw) => !normalize(value).includes(normalize(raw))),
        textFilter('equals', 'Equals', true, (value, raw) => collator.compare(value, raw) === 0),
        textFilter('not-equals', 'Does not equal', true, (value, raw) => collator.compare(value, raw) !== 0),
        textFilter('is-empty', 'Is empty', false, (value) => value.length === 0),
        textFilter('is-not-empty', 'Is not empty', false, (value) => value.length > 0),
      ],
    },
    bulk: {
      begin: ({ values }) => ({ operation: 'set', value: allEqual(values) ? values[0] ?? '' : '' }),
      apply: (current, draft) => applyStringBulkDraft(current, draft),
    },
  }
}

function textFilter(
  id: string,
  label: string,
  requiresValue: boolean,
  matches: (value: string, raw: string) => boolean,
) {
  return {
    id,
    label,
    requiresValue,
    input: { kind: 'text' as const },
    ...(requiresValue ? {
      validate: (raw: string) => raw.length > 0 ? null : 'Enter text to filter by.',
    } : {}),
    matches,
  }
}

function applyStringBulkDraft(current: string, draft: GridStringBulkDraft): GridValueResult<string> {
  if (draft.operation === 'set') return success(draft.value)
  if (draft.operation === 'affix') return success(`${draft.prefix}${current}${draft.suffix}`)
  if (!draft.find) return failure('empty-find', 'Enter text to find.')
  try {
    return success(draft.useRegex
      ? current.replace(new RegExp(draft.find, 'g'), draft.replacement)
      : current.split(draft.find).join(draft.replacement))
  } catch {
    return failure('invalid-regular-expression', 'Enter a valid regular expression.')
  }
}

export type GridNumberColumnOptions = Readonly<{
  minimum?: number
  maximum?: number
  placeholder?: string
  format?: Intl.NumberFormatOptions
}>

export type GridNumberCellTypeOptions<Empty extends number | null = number> = Readonly<{
  emptyValue?: Empty
  locale?: string | readonly string[]
  format?: Intl.NumberFormatOptions
}>

type GridNumberValue<Empty extends number | null> = Empty extends null ? number | null : number

export function createNumberCellType<Empty extends number | null = number>(
  options: GridNumberCellTypeOptions<Empty> = {},
): GridCellTypeFactory<
  GridNumberValue<Empty>,
  string,
  GridNumberBulkDraft,
  GridNumberColumnOptions | undefined
> {
  const emptyValue = options.emptyValue === undefined ? 0 : options.emptyValue
  if (emptyValue !== null && !Number.isFinite(emptyValue)) {
    throw new Error('Number emptyValue must be null or a finite number.')
  }
  const defaultFormatter = new Intl.NumberFormat(options.locale, options.format)
  return defineCellTypeFactory<
    number | null,
    string,
    GridNumberBulkDraft,
    GridNumberColumnOptions | undefined
  >(() => ({
    behavior: createNumberBehavior(emptyValue, defaultFormatter, options.locale, options.format),
    view: {
      Cell: StandardTextCell,
      Editor: NumberEditor,
      BulkEditor: NumberBulkEditor,
      presentation: {
        content: 'padded',
        align: 'end',
        editActivation: ['double-click', 'enter', 'f2', 'printable'],
      },
    },
  })) as GridCellTypeFactory<
    GridNumberValue<Empty>,
    string,
    GridNumberBulkDraft,
    GridNumberColumnOptions | undefined
  >
}

function createNumberBehavior<Row>(
  emptyValue: number | null,
  defaultFormatter: Intl.NumberFormat,
  locale: string | readonly string[] | undefined,
  defaultFormat: Intl.NumberFormatOptions | undefined,
): GridCellBehavior<
  Row,
  number | null,
  string,
  GridNumberBulkDraft,
  GridNumberColumnOptions | undefined
> {
  const parse = (raw: string) => parseNumber(raw, emptyValue)
  return {
    value: {
      validate: (value, context) => {
        if (value === null) {
          return emptyValue === null
            ? success(null)
            : failure('invalid-number-value', 'The value must be a finite number.')
        }
        return typeof value === 'number' && Number.isFinite(value)
          ? validateNumberRange(success(value), context.typeOptions)
          : failure('invalid-number-value', 'The value must be a finite number.')
      },
    },
    text: {
      display: (value, context) => value === null
        ? ''
        : context.typeOptions?.format
          ? new Intl.NumberFormat(locale, {
              ...defaultFormat,
              ...context.typeOptions.format,
            }).format(value)
          : defaultFormatter.format(value),
      search: (value) => value === null ? '' : String(value),
      original: (value) => value === null ? '' : String(value),
    },
    equals: Object.is,
    clipboard: {
      format: (value) => value === null ? '' : String(value),
      parse: (raw, context) => validateNumberRange(parse(raw), context.typeOptions),
    },
    edit: {
      begin: (value) => value === null ? '' : String(value),
      commit: (draft, context) => validateNumberRange(parse(draft), context.typeOptions),
    },
    clear: (context) => validateNumberRange(success(emptyValue), context.typeOptions),
    fill: (context) => validateNumberRange(
      numberSeriesValue(
        context.sourceValues,
        context.repeatedValue,
        context.sourceStartIndex,
        context.targetIndex,
      ),
      context.typeOptions,
    ),
    compare: (left, right) => left === right ? 0 : left === null ? -1 : right === null ? 1 : left - right,
    filter: {
      defaultOperator: 'equals',
      operators: [
        numberFilter('equals', 'Equals', true, parse, (value, operand) => value === operand),
        numberFilter('not-equals', 'Does not equal', true, parse, (value, operand) => value !== operand),
        numberFilter('greater-than', 'Is greater than', true, parse, (value, operand) => value !== null && operand !== null && value > operand),
        numberFilter('greater-than-or-equal', 'Is at least', true, parse, (value, operand) => value !== null && operand !== null && value >= operand),
        numberFilter('less-than', 'Is less than', true, parse, (value, operand) => value !== null && operand !== null && value < operand),
        numberFilter('less-than-or-equal', 'Is at most', true, parse, (value, operand) => value !== null && operand !== null && value <= operand),
        numberFilter('is-empty', 'Is empty', false, parse, (value) => value === null),
        numberFilter('is-not-empty', 'Is not empty', false, parse, (value) => value !== null),
      ],
    },
    bulk: {
      begin: ({ values }) => ({ value: allEqual(values) && values[0] !== null && values[0] !== undefined ? String(values[0]) : '' }),
      apply: (_current, draft, context) => validateNumberRange(parse(draft.value), context.typeOptions),
    },
  }
}

function numberFilter(
  id: string,
  label: string,
  requiresValue: boolean,
  parse: (raw: string) => GridValueResult<number | null>,
  matches: (value: number | null, operand: number | null) => boolean,
) {
  return {
    id,
    label,
    requiresValue,
    input: { kind: 'number' as const, inputMode: 'decimal' as const },
    ...(requiresValue ? {
      validate: (raw: string) => raw.trim().length > 0 && parse(raw).ok
        ? null
        : 'Enter a valid number.',
    } : {}),
    matches: (value: number | null, raw: string) => {
      if (!requiresValue) return matches(value, null)
      const parsed = parse(raw)
      return parsed.ok && matches(value, parsed.value)
    },
  }
}

function parseNumber(raw: string, emptyValue: number | null): GridValueResult<number | null> {
  const normalized = raw.trim()
  if (!normalized) return success(emptyValue)
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    return failure('invalid-number', 'Enter a valid number.')
  }
  const value = Number(normalized)
  return Number.isFinite(value)
    ? success(value)
    : failure('invalid-number', 'Enter a finite number.')
}

function validateNumberRange(
  parsed: GridValueResult<number | null>,
  options: GridNumberColumnOptions | undefined,
): GridValueResult<number | null> {
  if (!parsed.ok || parsed.value === null) return parsed
  if (options?.minimum !== undefined && parsed.value < options.minimum) {
    return failure('number-below-minimum', `Enter a number of at least ${options.minimum}.`)
  }
  if (options?.maximum !== undefined && parsed.value > options.maximum) {
    return failure('number-above-maximum', `Enter a number no greater than ${options.maximum}.`)
  }
  return parsed
}

function numberSeriesValue(
  values: readonly (number | null)[],
  repeatedValue: number | null,
  sourceStartIndex: number,
  targetIndex: number,
): GridValueResult<number | null> {
  if (values.length < 2 || values.some((value) => value === null)) return success(repeatedValue)
  const numeric = values as readonly number[]
  const first = numeric[0]
  const second = numeric[1]
  if (first === undefined || second === undefined) return success(repeatedValue)
  const step = second - first
  const arithmetic = numeric.slice(2).every((value, index) => {
    const previous = numeric[index + 1]
    if (previous === undefined) return false
    const difference = value - previous
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(step), Math.abs(difference)) * 8
    return Math.abs(difference - step) <= tolerance
  })
  return arithmetic ? success(first + (targetIndex - sourceStartIndex) * step) : success(repeatedValue)
}

export type GridIsoDateColumnOptions = Readonly<{
  placeholder?: string
  locale?: string | readonly string[]
  display?: Intl.DateTimeFormatOptions
}>

export type GridIsoDateCellTypeOptions<Empty extends '' | null> = Readonly<{
  storage: 'iso-date'
  emptyValue: Empty
  locale?: string | readonly string[]
  display?: Intl.DateTimeFormatOptions
}>

type GridIsoDateValue<Empty extends '' | null> = Empty extends null ? string | null : string

export function createDateCellType<Empty extends '' | null>(
  options: GridIsoDateCellTypeOptions<Empty>,
): GridCellTypeFactory<
  GridIsoDateValue<Empty>,
  string,
  GridDateBulkDraft,
  GridIsoDateColumnOptions | undefined
> {
  if (options.storage !== 'iso-date') {
    throw new Error('Date storage must be "iso-date".')
  }
  if (options.emptyValue !== '' && options.emptyValue !== null) {
    throw new Error('ISO date emptyValue must be an empty string or null.')
  }
  const defaultFormatter = options.display
    ? new Intl.DateTimeFormat(options.locale, { ...options.display, timeZone: 'UTC' })
    : null
  const parse = (raw: string) => parseIsoDate(raw, options.emptyValue)
  return defineCellTypeFactory<
    string | null,
    string,
    GridDateBulkDraft,
    GridIsoDateColumnOptions | undefined
  >(() => ({
    behavior: createDateBehavior(options.emptyValue, defaultFormatter),
    view: {
      Cell: StandardTextCell,
      Editor: DateEditor,
      BulkEditor: DateBulkEditor,
      presentation: {
        content: 'padded',
        align: 'start',
        editActivation: ['double-click', 'enter', 'f2', 'printable'],
      },
    },
  })) as GridCellTypeFactory<
    GridIsoDateValue<Empty>,
    string,
    GridDateBulkDraft,
    GridIsoDateColumnOptions | undefined
  >

  function createDateBehavior<Row>(
    emptyValue: '' | null,
    formatter: Intl.DateTimeFormat | null,
  ): GridCellBehavior<
    Row,
    string | null,
    string,
    GridDateBulkDraft,
    GridIsoDateColumnOptions | undefined
  > {
    const format = (value: string | null, context: { typeOptions: GridIsoDateColumnOptions | undefined }) => {
      if (!value) return ''
      const localFormatter = context.typeOptions?.locale !== undefined || context.typeOptions?.display !== undefined
        ? new Intl.DateTimeFormat(context.typeOptions.locale ?? options.locale, {
            ...options.display,
            ...context.typeOptions.display,
            timeZone: 'UTC',
          })
        : formatter
      return localFormatter ? localFormatter.format(isoDateToUtc(value)) : value
    }
    return {
      value: {
        validate: (value) => {
          if (value === null) {
            return emptyValue === null
              ? success(null)
              : failure('invalid-iso-date-value', 'The value must be an ISO date.')
          }
          if (typeof value !== 'string') {
            return failure('invalid-iso-date-value', 'The value must be an ISO date.')
          }
          if (value === '') {
            return emptyValue === ''
              ? success('')
              : failure('invalid-iso-date-value', 'The value must be an ISO date.')
          }
          return isValidIsoDate(value)
            ? success(value)
            : failure('invalid-iso-date-value', 'The value must use YYYY-MM-DD format.')
        },
      },
      text: {
        display: format,
        search: (value) => value ?? '',
        original: (value) => value ?? '',
      },
      equals: Object.is,
      clipboard: { format: (value) => value ?? '', parse },
      edit: { begin: (value) => value ?? '', commit: parse },
      clear: () => success(emptyValue),
      compare: (left, right) => left === right ? 0 : left === null ? -1 : right === null ? 1 : left.localeCompare(right),
      filter: {
        defaultOperator: 'on',
        operators: [
          dateFilter('on', 'Is on', true, parse, (value, operand) => value === operand),
          dateFilter('not-on', 'Is not on', true, parse, (value, operand) => value !== operand),
          dateFilter('before', 'Is before', true, parse, (value, operand) => Boolean(value && operand && value < operand)),
          dateFilter('after', 'Is after', true, parse, (value, operand) => Boolean(value && operand && value > operand)),
          dateFilter('is-empty', 'Is empty', false, parse, (value) => !value),
          dateFilter('is-not-empty', 'Is not empty', false, parse, (value) => Boolean(value)),
        ],
      },
      bulk: {
        begin: ({ values }) => ({ value: allEqual(values) ? values[0] ?? '' : '' }),
        apply: (_current, draft) => parse(draft.value),
      },
    }
  }
}

function dateFilter(
  id: string,
  label: string,
  requiresValue: boolean,
  parse: (raw: string) => GridValueResult<string | null>,
  matches: (value: string | null, operand: string | null) => boolean,
) {
  return {
    id,
    label,
    requiresValue,
    input: { kind: 'date' as const },
    ...(requiresValue ? {
      validate: (raw: string) => raw.trim().length > 0 && parse(raw).ok
        ? null
        : 'Enter a valid date in YYYY-MM-DD format.',
    } : {}),
    matches: (value: string | null, raw: string) => {
      if (!requiresValue) return matches(value, null)
      const parsed = parse(raw)
      return parsed.ok && matches(value, parsed.value)
    },
  }
}

export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return daysInMonth !== undefined && day <= daysInMonth
}

function parseIsoDate(raw: string, emptyValue: '' | null): GridValueResult<string | null> {
  const normalized = raw.trim()
  if (!normalized) return success(emptyValue)
  return isValidIsoDate(normalized)
    ? success(normalized)
    : failure('invalid-iso-date', 'Enter a valid date in YYYY-MM-DD format.')
}

function isoDateToUtc(value: string): Date {
  const [yearText, monthText, dayText] = value.split('-')
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText))
  return date
}

function StandardTextCell<Row, Value>({ displayText }: GridCellViewProps<Row, Value, unknown>) {
  return <span className="data-grid-cell-text">{displayText}</span>
}

function StringEditor<Row>({
  cancel,
  commit,
  commitAndMove,
  composing,
  draft,
  setComposing,
  setDraft,
  typeOptions,
}: GridCellEditorProps<Row, string, string, GridStringColumnOptions | undefined>) {
  return <input
    autoFocus
    className="data-grid-cell-editor"
    inputMode={typeOptions?.inputMode ?? 'text'}
    placeholder={typeOptions?.placeholder}
    value={draft}
    onChange={(event) => { setDraft(event.currentTarget.value) }}
    onCompositionEnd={(event) => { setComposing(false, event.currentTarget.value) }}
    onCompositionStart={() => { setComposing(true) }}
    onKeyDown={(event) => { handleEditorKey(event, composing, commit, commitAndMove, cancel) }}
  />
}

function NumberEditor<Row>({
  cancel,
  commit,
  commitAndMove,
  composing,
  draft,
  setComposing,
  setDraft,
  typeOptions,
}: GridCellEditorProps<Row, number | null, string, GridNumberColumnOptions | undefined>) {
  return <input
    autoFocus
    className="data-grid-cell-editor data-grid-number-editor"
    inputMode="decimal"
    placeholder={typeOptions?.placeholder}
    type="text"
    value={draft}
    onChange={(event) => { setDraft(event.currentTarget.value) }}
    onCompositionEnd={(event) => { setComposing(false, event.currentTarget.value) }}
    onCompositionStart={() => { setComposing(true) }}
    onKeyDown={(event) => { handleEditorKey(event, composing, commit, commitAndMove, cancel) }}
  />
}

function DateEditor<Row>({
  cancel,
  commit,
  commitAndMove,
  composing,
  draft,
  setComposing,
  setDraft,
  typeOptions,
}: GridCellEditorProps<Row, string | null, string, GridIsoDateColumnOptions | undefined>) {
  return <input
    autoFocus
    className="data-grid-cell-editor data-grid-date-editor"
    placeholder={typeOptions?.placeholder}
    type="date"
    value={draft}
    onChange={(event) => { setDraft(event.currentTarget.value) }}
    onCompositionEnd={(event) => { setComposing(false, event.currentTarget.value) }}
    onCompositionStart={() => { setComposing(true) }}
    onKeyDown={(event) => { handleEditorKey(event, composing, commit, commitAndMove, cancel) }}
  />
}

function handleEditorKey(
  event: KeyboardEvent<HTMLInputElement>,
  composing: boolean,
  commit: () => void,
  commitAndMove: (direction: 'next' | 'previous') => void,
  cancel: () => void,
): void {
  if (composing || event.nativeEvent.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    commit()
  } else if (event.key === 'Tab') {
    event.preventDefault()
    commitAndMove(event.shiftKey ? 'previous' : 'next')
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
}

function StringBulkEditor({
  apply,
  cancel,
  cellCount,
  draft,
  error,
  setDraft,
}: GridCellBulkEditorProps<GridStringBulkDraft>) {
  const changeOperation = (event: ChangeEvent<HTMLSelectElement>) => {
    const operation = event.currentTarget.value
    if (operation === 'affix') setDraft({ operation, prefix: '', suffix: '' })
    else if (operation === 'replace') setDraft({ operation, find: '', replacement: '', useRegex: false })
    else setDraft({ operation: 'set', value: '' })
  }
  return <form className="data-grid-bulk-editor" onSubmit={(event) => { event.preventDefault(); apply() }}>
    <label>Operation<select value={draft.operation} onChange={changeOperation}>
      <option value="set">Set value</option>
      <option value="affix">Add prefix or suffix</option>
      <option value="replace">Find and replace</option>
    </select></label>
    {draft.operation === 'set'
      ? <label>Value<input value={draft.value} onChange={(event) => { setDraft({ ...draft, value: event.currentTarget.value }) }} /></label>
      : draft.operation === 'affix'
        ? <><label>Prefix<input value={draft.prefix} onChange={(event) => { setDraft({ ...draft, prefix: event.currentTarget.value }) }} /></label><label>Suffix<input value={draft.suffix} onChange={(event) => { setDraft({ ...draft, suffix: event.currentTarget.value }) }} /></label></>
        : <><label>Find<input value={draft.find} onChange={(event) => { setDraft({ ...draft, find: event.currentTarget.value }) }} /></label><label>Replace with<input value={draft.replacement} onChange={(event) => { setDraft({ ...draft, replacement: event.currentTarget.value }) }} /></label><label><input checked={draft.useRegex} type="checkbox" onChange={(event) => { setDraft({ ...draft, useRegex: event.currentTarget.checked }) }} />Regular expression</label></>}
    <BulkActions cancel={cancel} cellCount={cellCount} error={error} />
  </form>
}

function NumberBulkEditor(props: GridCellBulkEditorProps<GridNumberBulkDraft>) {
  return <SingleValueBulkEditor {...props} inputMode="decimal" type="text" />
}

function DateBulkEditor(props: GridCellBulkEditorProps<GridDateBulkDraft>) {
  return <SingleValueBulkEditor {...props} type="date" />
}

function SingleValueBulkEditor<Draft extends Readonly<{ value: string }>>({
  apply,
  cancel,
  cellCount,
  draft,
  error,
  inputMode,
  setDraft,
  type,
}: GridCellBulkEditorProps<Draft> & Readonly<{
  inputMode?: 'decimal'
  type: 'date' | 'text'
}>) {
  return <form className="data-grid-bulk-editor" onSubmit={(event) => { event.preventDefault(); apply() }}>
    <label>Value<input inputMode={inputMode} type={type} value={draft.value} onChange={(event) => { setDraft({ ...draft, value: event.currentTarget.value }) }} /></label>
    <BulkActions cancel={cancel} cellCount={cellCount} error={error} />
  </form>
}

function BulkActions({
  cancel,
  cellCount,
  error,
}: Readonly<{
  cancel: () => void
  cellCount: number
  error: string | null
}>) {
  return <>
    {error ? <p role="alert">{error}</p> : null}
    <div className="data-grid-bulk-editor-actions">
      <button type="button" onClick={cancel}>Cancel</button>
      <button type="submit">Apply to {cellCount} cells</button>
    </div>
  </>
}

function success<Value>(value: Value): GridValueResult<Value> {
  return { ok: true, value }
}

function failure<Value>(code: string, message: string): GridValueResult<Value> {
  return { ok: false, issue: { code, message } }
}

function normalize(value: string): string {
  return value.toLocaleLowerCase()
}

function allEqual<Value>(values: readonly Value[]): boolean {
  return values.length > 0 && values.every((value) => Object.is(value, values[0]))
}
