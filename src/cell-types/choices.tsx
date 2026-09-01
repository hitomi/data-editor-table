import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'

import type {
  GridCellBehavior,
  GridChoiceOption,
  GridChoiceValue,
  GridMultiSelectBulkDraft,
  GridSingleSelectBulkDraft,
  GridValueResult,
} from './contracts.js'
import type {
  GridCellBulkEditorProps,
  GridCellEditorProps,
  GridCellTypeFactory,
  GridCellViewProps,
} from './react-view-contracts.js'
import { formatDefaultApplyToCells, resolveCellTypeMessages } from './messages.js'
import { defineCellTypeFactory } from './registry.js'
import { GridCellEditorPopover } from '../react/grid-layers.js'

type ChoiceCatalog<Value extends GridChoiceValue> = ReturnType<typeof createChoiceCatalog<Value>>

export type GridSingleSelectCellTypeOptions<Value extends GridChoiceValue> = Readonly<{
  /** Static options only. Async and row-dependent option sources are intentionally not supported. */
  options: readonly GridChoiceOption<Value>[]
  emptyValue?: null
  emptyLabel?: string
  messages?: Partial<GridSingleSelectCellTypeMessages>
}>

export type GridSingleSelectCellTypeMessages = Readonly<{
  valueRequired: string
  unknownValue: string
  unavailable: (label: string | null) => string
  pasteValueInvalid: string
  restartEdit: string
  equals: string
  notEquals: string
  isEmpty: string
  isNotEmpty: string
  filterValueRequired: string
  chooseValue: string
  chooseValuePlaceholder: string
  value: string
  keepExistingValues: string
  cancel: string
  applyToCells: (count: number) => string
}>

const DEFAULT_SINGLE_SELECT_MESSAGES: GridSingleSelectCellTypeMessages = Object.freeze({
  valueRequired: 'Choose a value.',
  unknownValue: 'Choose a value from the available options.',
  unavailable: (label) => `${label ?? 'This option'} is no longer available.`,
  pasteValueInvalid: 'Paste an option label or value from the available options.',
  restartEdit: 'Restart this edit and choose a value again.',
  equals: 'Equals',
  notEquals: 'Does not equal',
  isEmpty: 'Is empty',
  isNotEmpty: 'Is not empty',
  filterValueRequired: 'Choose a value to filter by.',
  chooseValue: 'Choose value',
  chooseValuePlaceholder: 'Choose a value',
  value: 'Value',
  keepExistingValues: 'Keep existing values',
  cancel: 'Cancel',
  applyToCells: formatDefaultApplyToCells,
})

export type GridSingleSelectEditDraft<Value extends GridChoiceValue> = Readonly<{
  value: Value | null
}>

const singleSelectEditOrigin = Symbol('single-select-edit-origin')

type GridSingleSelectInternalEditDraft<Value extends GridChoiceValue> =
  GridSingleSelectEditDraft<Value> & Readonly<{
    [singleSelectEditOrigin]: Readonly<{ value: Value | null }>
  }>

export function createSingleSelectCellType<Value extends GridChoiceValue>(
  options: GridSingleSelectCellTypeOptions<Value> & Readonly<{ emptyValue: null }>,
): GridCellTypeFactory<
  Value | null,
  GridSingleSelectEditDraft<Value>,
  GridSingleSelectBulkDraft<Value>
>
export function createSingleSelectCellType<Value extends GridChoiceValue>(
  options: Omit<GridSingleSelectCellTypeOptions<Value>, 'emptyValue'> & Readonly<{ emptyValue?: never }>,
): GridCellTypeFactory<
  Value,
  GridSingleSelectEditDraft<Value>,
  GridSingleSelectBulkDraft<Value>
>
export function createSingleSelectCellType<Value extends GridChoiceValue>(
  options: GridSingleSelectCellTypeOptions<Value>,
): GridCellTypeFactory<
  Value | null,
  GridSingleSelectEditDraft<Value>,
  GridSingleSelectBulkDraft<Value>
>
export function createSingleSelectCellType<Value extends GridChoiceValue>(
  options: GridSingleSelectCellTypeOptions<Value>,
): GridCellTypeFactory<
  Value | null,
  GridSingleSelectEditDraft<Value>,
  GridSingleSelectBulkDraft<Value>
> {
  const messages = resolveCellTypeMessages(DEFAULT_SINGLE_SELECT_MESSAGES, options.messages)
  const catalog = createChoiceCatalog(options.options)
  const nullable = options.emptyValue === null
  const emptyLabel = options.emptyLabel ?? 'None'
  return defineCellTypeFactory<
    Value | null,
    GridSingleSelectEditDraft<Value>,
    GridSingleSelectBulkDraft<Value>
  >(() => ({
    behavior: createSingleSelectBehavior(catalog, nullable, messages),
    view: {
      Cell: ChoiceTextCell,
      Editor: (props) => <SingleSelectEditor {...props} catalog={catalog} emptyLabel={emptyLabel} messages={messages} nullable={nullable} />,
      BulkEditor: (props) => <SingleSelectBulkEditor {...props} catalog={catalog} emptyLabel={emptyLabel} messages={messages} nullable={nullable} />,
      presentation: {
        content: 'padded',
        align: 'start',
        editActivation: ['active-cell-click', 'enter', 'f2', 'space'],
      },
    },
  }))
}

function createSingleSelectBehavior<Row, Value extends GridChoiceValue>(
  catalog: ChoiceCatalog<Value>,
  nullable: boolean,
  messages: GridSingleSelectCellTypeMessages,
): GridCellBehavior<
  Row,
  Value | null,
  GridSingleSelectEditDraft<Value>,
  GridSingleSelectBulkDraft<Value>
> {
  const validate = (value: unknown, allowDisabled = true): GridValueResult<Value | null> => {
    if (value === null) return nullable
      ? success(null)
      : failure('single-select-value-required', messages.valueRequired)
    const option = catalog.optionForUnknown(value)
    if (!option) return failure('unknown-single-select-value', messages.unknownValue)
    if (!allowDisabled && option.disabled) return failure('disabled-single-select-value', messages.unavailable(option.label))
    return success(option.value)
  }
  const parse = (raw: string) => {
    if (!raw.trim() && nullable) return success<Value | null>(null)
    const option = catalog.optionForAlias(raw)
    return option
      ? validate(option.value, false)
      : failure<Value | null>('unknown-single-select-value', messages.pasteValueInvalid)
  }
  return {
    value: { validate: (value) => validate(value) },
    text: {
      display: (value) => value === null ? '' : catalog.optionForValue(value)?.label ?? String(value),
      search: (value) => value === null ? '' : catalog.searchText(value),
      original: (value) => value === null ? '' : catalog.optionForValue(value)?.label ?? String(value),
    },
    equals: Object.is,
    clipboard: {
      format: (value) => value === null ? '' : catalog.optionForValue(value)?.label ?? String(value),
      parse,
    },
    edit: {
      exit: 'explicit',
      begin: (value) => ({
        value,
        [singleSelectEditOrigin]: Object.freeze({ value }),
      }),
      commit: (draft) => {
        const origin = (draft as Partial<GridSingleSelectInternalEditDraft<Value>>)[singleSelectEditOrigin]
        if (!origin) return failure('invalid-single-select-draft', messages.restartEdit)
        return validate(draft.value, Object.is(draft.value, origin.value))
      },
    },
    ...(nullable ? { clear: () => success<Value | null>(null) } : {}),
    fill: (context) => validate(
      sequenceValue(context.sourceValues, context.sourceStartIndex, context.targetIndex, context.repeatedValue),
      false,
    ),
    compare: (left, right) => compareOptionOrder(catalog, left, right),
    filter: {
      defaultOperator: 'equals',
      operators: [
        choiceFilter('equals', messages.equals, catalog, messages.filterValueRequired, (value, operand) => Object.is(value, operand)),
        choiceFilter('not-equals', messages.notEquals, catalog, messages.filterValueRequired, (value, operand) => !Object.is(value, operand)),
        ...(nullable ? [
          valuePresenceFilter('is-empty', messages.isEmpty, (value: Value | null) => value === null),
          valuePresenceFilter('is-not-empty', messages.isNotEmpty, (value: Value | null) => value !== null),
        ] : []),
      ],
    },
    bulk: {
      begin: ({ values }) => allEqual(values, Object.is)
        ? { operation: 'set', value: values[0] ?? null }
        : { operation: 'keep' },
      apply: (current, draft) => draft.operation === 'keep'
        ? success(current)
        : Object.is(current, draft.value)
          ? success(current)
          : validate(draft.value, false),
    },
  }
}

export type GridMultiSelectCellTypeOptions<Value extends GridChoiceValue> = Readonly<{
  /** Static options only. Async and row-dependent option sources are intentionally not supported. */
  options: readonly GridChoiceOption<Value>[]
  emptyLabel?: string
  messages?: Partial<GridMultiSelectCellTypeMessages>
}>

export type GridMultiSelectCellTypeMessages = Readonly<{
  invalidValue: string
  unknownValue: string
  duplicateValue: string
  unavailable: (label: string | null) => string
  unknownOption: (value: string) => string
  invalidCsvRow: string
  unclosedCsvQuote: string
  contains: string
  notContains: string
  isEmpty: string
  isNotEmpty: string
  filterValueRequired: string
  chooseValues: string
  cancel: string
  apply: string
  operation: string
  keepExistingTags: string
  replaceTags: string
  addTags: string
  removeTags: string
  tags: string
  applyToCells: (count: number) => string
}>

const DEFAULT_MULTI_SELECT_MESSAGES: GridMultiSelectCellTypeMessages = Object.freeze({
  invalidValue: 'The value must be a list of options.',
  unknownValue: 'Every value must be one of the available options.',
  duplicateValue: 'The same option cannot be selected more than once.',
  unavailable: (label) => `${label ?? 'This option'} is no longer available.`,
  unknownOption: (value) => `Unknown option: ${value}`,
  invalidCsvRow: 'Paste one CSV row of option labels or values.',
  unclosedCsvQuote: 'The pasted CSV has an unclosed quote.',
  contains: 'Contains',
  notContains: 'Does not contain',
  isEmpty: 'Is empty',
  isNotEmpty: 'Is not empty',
  filterValueRequired: 'Choose a tag to filter by.',
  chooseValues: 'Choose values',
  cancel: 'Cancel',
  apply: 'Apply',
  operation: 'Operation',
  keepExistingTags: 'Keep existing tags',
  replaceTags: 'Replace tags',
  addTags: 'Add tags',
  removeTags: 'Remove tags',
  tags: 'Tags',
  applyToCells: formatDefaultApplyToCells,
})

export function createMultiSelectCellType<Value extends GridChoiceValue>(
  options: GridMultiSelectCellTypeOptions<Value>,
): GridCellTypeFactory<readonly Value[], readonly Value[], GridMultiSelectBulkDraft<Value>> {
  const messages = resolveCellTypeMessages(DEFAULT_MULTI_SELECT_MESSAGES, options.messages)
  const catalog = createChoiceCatalog(options.options)
  const emptyLabel = options.emptyLabel ?? 'None'
  return defineCellTypeFactory<readonly Value[], readonly Value[], GridMultiSelectBulkDraft<Value>>(() => ({
    behavior: createMultiSelectBehavior(catalog, emptyLabel, messages),
    view: {
      Cell: (props) => <MultiSelectCell {...props} catalog={catalog} emptyLabel={emptyLabel} />,
      Editor: (props) => <MultiSelectEditor {...props} catalog={catalog} messages={messages} />,
      BulkEditor: (props) => <MultiSelectBulkEditor {...props} catalog={catalog} messages={messages} />,
      presentation: {
        content: 'padded',
        align: 'start',
        editActivation: ['active-cell-click', 'enter', 'f2', 'space'],
      },
    },
  }))
}

function createMultiSelectBehavior<Row, Value extends GridChoiceValue>(
  catalog: ChoiceCatalog<Value>,
  emptyLabel: string,
  messages: GridMultiSelectCellTypeMessages,
): GridCellBehavior<Row, readonly Value[], readonly Value[], GridMultiSelectBulkDraft<Value>> {
  const validate = (value: unknown, allowDisabled = true): GridValueResult<readonly Value[]> => {
    if (!Array.isArray(value)) return failure('invalid-multi-select-value', messages.invalidValue)
    const seen = new Set<number>()
    const indices: number[] = []
    for (const entry of value) {
      const index = catalog.indexOfUnknown(entry)
      if (index < 0) return failure('unknown-multi-select-value', messages.unknownValue)
      if (seen.has(index)) return failure('duplicate-multi-select-value', messages.duplicateValue)
      if (!allowDisabled && catalog.options[index]?.disabled) {
        return failure('disabled-multi-select-value', messages.unavailable(catalog.options[index]?.label ?? null))
      }
      seen.add(index)
      indices.push(index)
    }
    indices.sort((left, right) => left - right)
    return success(Object.freeze(indices.map((index) => catalog.options[index]!.value)))
  }
  const parse = (raw: string): GridValueResult<readonly Value[]> => {
    const parsed = parseCsvRow(raw, messages)
    if (!parsed.ok) return parsed
    if (parsed.value.length === 1 && parsed.value[0] === '') return success([])
    const values: Value[] = []
    for (const field of parsed.value) {
      const option = catalog.optionForAlias(field)
      if (!option) return failure('unknown-multi-select-value', messages.unknownOption(field))
      if (option.disabled) return failure('disabled-multi-select-value', messages.unavailable(option.label))
      values.push(option.value)
    }
    return validate(values, false)
  }
  const format = (value: readonly Value[]) => formatCsvRow(value.map((entry) => catalog.optionForValue(entry)?.label ?? String(entry)))
  const optionLabels = (value: readonly Value[]) => value.map((entry) => catalog.optionForValue(entry)?.label ?? String(entry)).join(', ')
  const display = (value: readonly Value[]) => value.length === 0 ? emptyLabel : optionLabels(value)
  return {
    value: { validate: (value) => validate(value) },
    text: {
      display,
      search: (value) => value.map((entry) => catalog.searchText(entry)).join(' '),
      original: display,
    },
    equals: (left, right) => equalSets(catalog, left, right),
    clipboard: { format, parse },
    edit: { exit: 'explicit', begin: (value) => [...value], commit: (draft) => validate(draft) },
    clear: () => success([]),
    fill: (context) => validate(
      sequenceValue(context.sourceValues, context.sourceStartIndex, context.targetIndex, context.repeatedValue),
      false,
    ),
    compare: (left, right) => optionLabels(left).localeCompare(optionLabels(right)),
    filter: {
      defaultOperator: 'contains',
      operators: [
        multiChoiceFilter('contains', messages.contains, catalog, messages.filterValueRequired, true),
        multiChoiceFilter('not-contains', messages.notContains, catalog, messages.filterValueRequired, false),
        valuePresenceFilter('is-empty', messages.isEmpty, (value: readonly Value[]) => value.length === 0),
        valuePresenceFilter('is-not-empty', messages.isNotEmpty, (value: readonly Value[]) => value.length > 0),
      ],
    },
    bulk: {
      begin: ({ values }) => allEqual(values, (left, right) => equalSets(catalog, left, right))
        ? { operation: 'replace', values: values[0] ?? [] }
        : { operation: 'keep', values: [] },
      apply: (current, draft) => {
        if (draft.operation === 'keep') return success(current)
        const selected = new Set(draft.values.map((value) => catalog.indexOfValue(value)))
        if (draft.operation !== 'remove') {
          for (const index of selected) {
            if (catalog.options[index]?.disabled && !current.some((value) => catalog.indexOfValue(value) === index)) {
              return failure('disabled-multi-select-value', messages.unavailable(catalog.options[index]?.label ?? null))
            }
          }
        }
        if (draft.operation === 'replace') return validate(draft.values)
        if (draft.operation === 'add') return validate([...current, ...draft.values.filter((value) => !current.some((entry) => Object.is(entry, value)))])
        return validate(current.filter((value) => !draft.values.some((entry) => Object.is(entry, value))))
      },
    },
  }
}

function ChoiceTextCell<Row, Value>({ displayText }: GridCellViewProps<Row, Value>) {
  return <span className="data-grid-cell-text">{displayText}</span>
}

function SingleSelectEditor<Row, Value extends GridChoiceValue>({
  cancel,
  catalog,
  commit,
  commitAndMove,
  draft,
  emptyLabel,
  messages,
  nullable,
  setDraft,
}: GridCellEditorProps<Row, Value | null, GridSingleSelectEditDraft<Value>> & Readonly<{
  catalog: ChoiceCatalog<Value>
  emptyLabel: string
  messages: GridSingleSelectCellTypeMessages
  nullable: boolean
}>) {
  const anchor = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<(HTMLDivElement | null)[]>([])
  const currentIndex = draft.value === null ? -1 : catalog.indexOfValue(draft.value)
  const entries = [
    ...(nullable ? [{ label: emptyLabel, value: null, disabled: false }] : []),
    ...catalog.options.map((option) => ({ label: option.label, value: option.value, disabled: Boolean(option.disabled) })),
  ] as const
  const entryIndex = currentIndex < 0 ? 0 : currentIndex + (nullable ? 1 : 0)
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, entryIndex))
  const select = (index: number) => {
    const entry = entries[index]
    if (!entry || entry.disabled) return
    setDraft({ ...draft, value: entry.value })
    commit()
  }
  const move = (key: string) => {
    const enabled = entries.map((_entry, index) => index).filter((index) => !entries[index]?.disabled)
    if (enabled.length === 0) return
    const current = enabled.indexOf(activeIndex)
    const next = key === 'Home' ? enabled[0]!
      : key === 'End' ? enabled.at(-1)!
        : key === 'ArrowDown' ? enabled[(Math.max(-1, current) + 1) % enabled.length]!
          : enabled[(current < 0 ? 0 : current - 1 + enabled.length) % enabled.length]!
    setActiveIndex(next)
    optionRefs.current[next]?.focus()
  }
  const selectedLabel = entries[entryIndex]?.label ?? emptyLabel
  return <>
    <button aria-haspopup="listbox" className="data-grid-cell-editor data-grid-choice-editor-button" ref={anchor} type="button">{selectedLabel}</button>
    <GridCellEditorPopover anchor={anchor} ariaLabel={messages.chooseValue} onCancel={cancel}>
      <div className="data-grid-choice-popover data-grid-single-choice-popover">
        <strong>{messages.chooseValue}</strong>
        <div
          aria-label={messages.chooseValue}
          className="data-grid-choice-options"
          role="listbox"
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault()
              commitAndMove(event.shiftKey ? 'previous' : 'next')
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              select(activeIndex)
              return
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            move(event.key)
          }}
        >
          {entries.map((entry, index) => <div
            aria-disabled={entry.disabled || undefined}
            aria-selected={index === entryIndex}
            className="data-grid-single-choice-option"
            key={`${entry.value === null ? 'null' : typeof entry.value}:${String(entry.value)}`}
            ref={(node) => { optionRefs.current[index] = node }}
            role="option"
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => select(index)}
            onFocus={() => setActiveIndex(index)}
          >{entry.label}</div>)}
        </div>
        <div className="data-grid-choice-popover__actions">
          <button className="business-grid__button" type="button" onClick={cancel}>{messages.cancel}</button>
        </div>
      </div>
    </GridCellEditorPopover>
  </>
}

function SingleSelectBulkEditor<Value extends GridChoiceValue>({
  apply,
  cancel,
  catalog,
  cellCount,
  draft,
  emptyLabel,
  error,
  messages,
  nullable,
  setDraft,
}: GridCellBulkEditorProps<GridSingleSelectBulkDraft<Value>> & Readonly<{
  catalog: ChoiceCatalog<Value>
  emptyLabel: string
  messages: GridSingleSelectCellTypeMessages
  nullable: boolean
}>) {
  return <form className="data-grid-bulk-editor" onSubmit={(event) => { event.preventDefault(); apply() }}>
    <label>{messages.value}<select value={draft.operation === 'keep' || draft.value === null ? '' : String(catalog.indexOfValue(draft.value))} onChange={(event) => {
      const index = Number(event.currentTarget.value)
      setDraft({ operation: 'set', value: event.currentTarget.value === '' ? null : catalog.options[index]?.value ?? null })
    }}>
      {draft.operation === 'keep'
        ? <option disabled value="">{messages.keepExistingValues}</option>
        : <option disabled={!nullable} value="">{nullable ? emptyLabel : messages.chooseValuePlaceholder}</option>}
      {catalog.options.map((option, index) => <option disabled={option.disabled} key={index} value={index}>{option.label}</option>)}
    </select></label>
    <BulkActions applyDisabled={draft.operation === 'keep'} cancel={cancel} cellCount={cellCount} error={error} messages={messages} />
  </form>
}

function MultiSelectCell<Row, Value extends GridChoiceValue>({ catalog, emptyLabel, value }: GridCellViewProps<Row, readonly Value[]> & Readonly<{
  catalog: ChoiceCatalog<Value>
  emptyLabel: string
}>) {
  const container = useRef<HTMLSpanElement>(null)
  const measurement = useRef<HTMLSpanElement>(null)
  const [visibleCount, setVisibleCount] = useState(value.length)
  useLayoutEffect(() => {
    const node = container.current
    const measure = measurement.current
    if (!node || !measure) return
    const update = () => {
      const tags = [...measure.querySelectorAll<HTMLElement>('[data-grid-tag-measure]')]
      const overflow = measure.querySelector<HTMLElement>('[data-grid-tag-overflow-measure]')
      const available = node.clientWidth
      const gap = 4
      const total = tags.reduce((width, tag, index) => width + tag.offsetWidth + (index === 0 ? 0 : gap), 0)
      if (total <= available) {
        setVisibleCount(value.length)
        return
      }
      let width = 0
      let count = 0
      for (let index = 0; index < tags.length; index += 1) {
        const nextWidth = width + (index === 0 ? 0 : gap) + tags[index]!.offsetWidth
        const overflowWidth = gap + (overflow?.offsetWidth ?? 0)
        if (nextWidth + overflowWidth > available) break
        width = nextWidth
        count += 1
      }
      setVisibleCount(count)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [value])
  const shown = value.slice(0, visibleCount)
  return <span ref={container} aria-label={value.map((entry) => catalog.optionForValue(entry)?.label ?? String(entry)).join(', ') || emptyLabel} className="data-grid-tag-list">
    {shown.length === 0 ? <span className="data-grid-tag-list__empty">{emptyLabel}</span> : shown.map((entry) => <span className="data-grid-tag" key={`${typeof entry}:${String(entry)}`}>{catalog.optionForValue(entry)?.label ?? String(entry)}</span>)}
    {value.length > shown.length ? <span className="data-grid-tag data-grid-tag--overflow">+{value.length - shown.length}</span> : null}
    <span aria-hidden="true" className="data-grid-tag-measurements" ref={measurement}>
      {value.map((entry) => <span className="data-grid-tag" data-grid-tag-measure key={`${typeof entry}:${String(entry)}`}>{catalog.optionForValue(entry)?.label ?? String(entry)}</span>)}
      <span className="data-grid-tag data-grid-tag--overflow" data-grid-tag-overflow-measure>+{value.length}</span>
    </span>
  </span>
}

function MultiSelectEditor<Row, Value extends GridChoiceValue>(props: GridCellEditorProps<Row, readonly Value[], readonly Value[]> & Readonly<{
  catalog: ChoiceCatalog<Value>
  messages: GridMultiSelectCellTypeMessages
}>) {
  const anchor = useRef<HTMLButtonElement>(null)
  const labelId = useId()
  const selected = new Set(props.draft.map((value) => props.catalog.indexOfValue(value)))
  const optionRefs = useRef<(HTMLInputElement | null)[]>([])
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, props.catalog.options.findIndex((option, index) => !option.disabled || selected.has(index))))
  useLayoutEffect(() => {
    const current = optionRefs.current[activeIndex]
    if (current && !current.disabled) return
    const next = optionRefs.current.findIndex((option) => option && !option.disabled)
    if (next < 0) return
    setActiveIndex(next)
    queueMicrotask(() => optionRefs.current[next]?.focus())
  }, [activeIndex, props.draft])
  const toggle = (index: number) => {
    const option = props.catalog.options[index]
    if (!option) return
    const current = selected.has(index)
    if (option.disabled && !current) return
    props.setDraft(current
      ? props.draft.filter((value) => props.catalog.indexOfValue(value) !== index)
      : props.catalog.canonical([...props.draft, option.value]))
  }
  return <>
    <button aria-haspopup="dialog" className="data-grid-cell-editor data-grid-choice-editor-button" ref={anchor} type="button">{props.messages.chooseValues}</button>
    <GridCellEditorPopover anchor={anchor} ariaLabel={props.messages.chooseValues} onCancel={props.cancel}>
      <div className="data-grid-choice-popover" aria-labelledby={labelId}>
        <strong id={labelId}>{props.messages.chooseValues}</strong>
        <div
          aria-labelledby={labelId}
          className="data-grid-choice-options"
          role="group"
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault()
              props.commitAndMove(event.shiftKey ? 'previous' : 'next')
              return
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return
            event.preventDefault()
            if (event.key === 'Enter') {
              toggle(activeIndex)
              return
            }
            const enabled = props.catalog.options.map((_option, index) => index).filter((index) => !optionRefs.current[index]?.disabled)
            if (enabled.length === 0) return
            const current = Math.max(0, enabled.indexOf(activeIndex))
            const next = event.key === 'Home' ? enabled[0]!
              : event.key === 'End' ? enabled.at(-1)!
                : event.key === 'ArrowDown' ? enabled[(current + 1) % enabled.length]!
                  : enabled[(current - 1 + enabled.length) % enabled.length]!
            setActiveIndex(next)
            optionRefs.current[next]?.focus()
          }}
        >
          {props.catalog.options.map((option, index) => {
            const checked = selected.has(index)
            return <label key={index}><input
              checked={checked}
              disabled={option.disabled && !checked}
              ref={(node) => { optionRefs.current[index] = node }}
              tabIndex={index === activeIndex ? 0 : -1}
              type="checkbox"
              onChange={() => toggle(index)}
              onFocus={() => setActiveIndex(index)}
            />{option.label}</label>
          })}
        </div>
        <div className="data-grid-choice-popover__actions">
          <button className="business-grid__button" type="button" onClick={props.cancel}>{props.messages.cancel}</button>
          <button className="business-grid__button business-grid__button--primary" type="button" onClick={props.commit}>{props.messages.apply}</button>
        </div>
      </div>
    </GridCellEditorPopover>
  </>
}

function MultiSelectBulkEditor<Value extends GridChoiceValue>(props: GridCellBulkEditorProps<GridMultiSelectBulkDraft<Value>> & Readonly<{
  catalog: ChoiceCatalog<Value>
  messages: GridMultiSelectCellTypeMessages
}>) {
  const selected = new Set(props.draft.values.map((value) => props.catalog.indexOfValue(value)))
  const changeOperation = (event: ChangeEvent<HTMLSelectElement>) => props.setDraft({ ...props.draft, operation: event.currentTarget.value as GridMultiSelectBulkDraft<Value>['operation'] })
  return <form className="data-grid-bulk-editor" onSubmit={(event) => { event.preventDefault(); props.apply() }}>
    <label>{props.messages.operation}<select value={props.draft.operation} onChange={changeOperation}>
      <option disabled value="keep">{props.messages.keepExistingTags}</option><option value="replace">{props.messages.replaceTags}</option><option value="add">{props.messages.addTags}</option><option value="remove">{props.messages.removeTags}</option>
    </select></label>
    <fieldset className="data-grid-bulk-choice-options"><legend>{props.messages.tags}</legend>{props.catalog.options.map((option, index) => {
      const checked = selected.has(index)
      const disabled = Boolean(option.disabled && props.draft.operation !== 'remove' && !checked)
      return <label key={index}><input checked={checked} disabled={disabled} type="checkbox" onChange={() => {
        props.setDraft({ ...props.draft, values: checked
          ? props.draft.values.filter((value) => props.catalog.indexOfValue(value) !== index)
          : props.catalog.canonical([...props.draft.values, option.value]) })
      }} />{option.label}</label>
    })}</fieldset>
    <BulkActions
      applyDisabled={props.draft.operation === 'keep' || (props.draft.operation !== 'replace' && props.draft.values.length === 0)}
      cancel={props.cancel}
      cellCount={props.cellCount}
      error={props.error}
      messages={props.messages}
    />
  </form>
}

function BulkActions({ applyDisabled = false, cancel, cellCount, error, messages }: Readonly<{
  applyDisabled?: boolean
  cancel: () => void
  cellCount: number
  error: string | null
  messages: Readonly<{ cancel: string; applyToCells: (count: number) => string }>
}>) {
  return <>{error ? <p role="alert">{error}</p> : null}<div className="data-grid-bulk-editor-actions"><button type="button" onClick={cancel}>{messages.cancel}</button><button disabled={applyDisabled} type="submit">{messages.applyToCells(cellCount)}</button></div></>
}

function createChoiceCatalog<Value extends GridChoiceValue>(source: readonly GridChoiceOption<Value>[]) {
  if (source.length === 0) throw new Error('Choice cell types require at least one option.')
  const options = Object.freeze(source.map((option) => Object.freeze({ ...option })))
  const aliases = new Map<string, number>()
  options.forEach((option, index) => {
    if (!option.label.trim()) throw new Error('Choice option labels cannot be empty.')
    if (typeof option.value === 'number' && (!Number.isFinite(option.value) || Object.is(option.value, -0))) {
      throw new Error(`Choice option numeric value "${String(option.value)}" must be finite and cannot be -0.`)
    }
    if (options.slice(0, index).some((candidate) => Object.is(candidate.value, option.value))) throw new Error(`Choice option value "${String(option.value)}" is registered more than once.`)
    for (const alias of [String(option.value), option.label]) {
      const normalized = normalizeAlias(alias)
      const existing = aliases.get(normalized)
      if (existing !== undefined && existing !== index) throw new Error(`Choice option alias "${alias}" is ambiguous.`)
      aliases.set(normalized, index)
    }
  })
  const indexOfValue = (value: Value) => options.findIndex((option) => Object.is(option.value, value))
  const tokenForValue = (value: Value) => `${typeof value}:${encodeURIComponent(String(value))}`
  const tokens = new Map(options.map((option, index) => [tokenForValue(option.value), index] as const))
  return {
    options,
    indexOfValue,
    indexOfUnknown: (value: unknown) => options.findIndex((option) => Object.is(option.value, value)),
    optionForValue: (value: Value) => options[indexOfValue(value)],
    optionForUnknown: (value: unknown) => options.find((option) => Object.is(option.value, value)),
    optionForAlias: (alias: string) => {
      const index = aliases.get(normalizeAlias(alias))
      return index === undefined ? undefined : options[index]
    },
    optionForToken: (token: string) => {
      const index = tokens.get(token)
      return index === undefined ? undefined : options[index]
    },
    tokenForValue,
    canonical: (values: readonly Value[]) => [...values].sort((left, right) => indexOfValue(left) - indexOfValue(right)),
    searchText: (value: Value) => {
      const option = options[indexOfValue(value)]
      return option ? `${option.label} ${String(option.value)}` : String(value)
    },
  }
}

function choiceFilter<Value extends GridChoiceValue>(
  id: string,
  label: string,
  catalog: ChoiceCatalog<Value>,
  valueRequiredMessage: string,
  matches: (value: Value | null, operand: Value) => boolean,
) {
  return {
    id, label, requiresValue: true,
    input: { kind: 'select' as const, options: catalog.options.map((option) => ({ value: catalog.tokenForValue(option.value), label: option.label })) },
    validate: (raw: string) => catalog.optionForToken(raw) ? null : valueRequiredMessage,
    matches: (value: Value | null, raw: string) => {
      const option = catalog.optionForToken(raw)
      return Boolean(option && matches(value, option.value))
    },
  }
}

function multiChoiceFilter<Value extends GridChoiceValue>(
  id: string,
  label: string,
  catalog: ChoiceCatalog<Value>,
  valueRequiredMessage: string,
  expected: boolean,
) {
  return {
    id, label, requiresValue: true,
    input: { kind: 'select' as const, options: catalog.options.map((option) => ({ value: catalog.tokenForValue(option.value), label: option.label })) },
    validate: (raw: string) => catalog.optionForToken(raw) ? null : valueRequiredMessage,
    matches: (value: readonly Value[], raw: string) => {
      const option = catalog.optionForToken(raw)
      return Boolean(option) && value.some((entry) => Object.is(entry, option!.value)) === expected
    },
  }
}

function valuePresenceFilter<Value>(id: string, label: string, matches: (value: Value) => boolean) {
  return { id, label, requiresValue: false, matches: (value: Value) => matches(value) }
}

function compareOptionOrder<Value extends GridChoiceValue>(catalog: ChoiceCatalog<Value>, left: Value | null, right: Value | null) {
  return left === right ? 0 : left === null ? -1 : right === null ? 1 : catalog.indexOfValue(left) - catalog.indexOfValue(right)
}

function equalSets<Value extends GridChoiceValue>(catalog: ChoiceCatalog<Value>, left: readonly Value[], right: readonly Value[]) {
  return left.length === right.length && left.every((value) => right.some((candidate) => Object.is(candidate, value)))
    && left.every((value) => catalog.indexOfValue(value) >= 0)
}

function sequenceValue<Value>(values: readonly Value[], sourceStartIndex: number, targetIndex: number, fallback: Value): Value {
  if (values.length === 0) return fallback
  const offset = ((targetIndex - sourceStartIndex) % values.length + values.length) % values.length
  return values[offset] ?? fallback
}

function formatCsvRow(fields: readonly string[]): string {
  return fields.map((field) => /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field).join(',')
}

function parseCsvRow(
  raw: string,
  messages: GridMultiSelectCellTypeMessages,
): GridValueResult<readonly string[]> {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (quoted) {
      if (character === '"' && raw[index + 1] === '"') { field += '"'; index += 1 }
      else if (character === '"') quoted = false
      else field += character
    } else if (character === ',' ) { fields.push(field); field = '' }
    else if (character === '"' && field.length === 0) quoted = true
    else if (character === '\r' || character === '\n') return failure('invalid-multi-select-csv', messages.invalidCsvRow)
    else field += character
  }
  if (quoted) return failure('invalid-multi-select-csv', messages.unclosedCsvQuote)
  fields.push(field)
  return success(fields)
}

function normalizeAlias(value: string) { return value.trim().toLocaleLowerCase() }
function allEqual<Value>(values: readonly Value[], equals: (left: Value, right: Value) => boolean) { return values.length > 0 && values.every((value) => equals(value, values[0]!)) }
function success<Value>(value: Value): GridValueResult<Value> { return { ok: true, value } }
function failure<Value>(code: string, message: string): GridValueResult<Value> { return { ok: false, issue: { code, message } } }
