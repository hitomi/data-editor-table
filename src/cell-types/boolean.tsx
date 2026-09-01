import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type {
  GridBooleanBulkDraft,
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

export type GridBooleanCellTypeOptions = Readonly<{
  trueLabel?: string
  falseLabel?: string
  /** Omit this property when Delete/Clear should skip boolean cells. */
  clearValue?: boolean
  messages?: Partial<GridBooleanCellTypeMessages>
}>

export type GridBooleanCellTypeMessages = Readonly<{
  invalidValue: string
  equals: string
  notEquals: string
  choiceRequired: string
  filterChoiceRequired: string
  pasteValueInvalid: string
  value: string
  chooseValue: string
  cancel: string
  applyToCells: (count: number) => string
}>

const DEFAULT_BOOLEAN_MESSAGES: GridBooleanCellTypeMessages = Object.freeze({
  invalidValue: 'The value must be true or false.',
  equals: 'Equals',
  notEquals: 'Does not equal',
  choiceRequired: 'Choose true or false before applying.',
  filterChoiceRequired: 'Choose true or false.',
  pasteValueInvalid: 'Paste TRUE or FALSE.',
  value: 'Value',
  chooseValue: 'Choose true or false',
  cancel: 'Cancel',
  applyToCells: formatDefaultApplyToCells,
})

export function createBooleanCellType(
  options: GridBooleanCellTypeOptions = {},
): GridCellTypeFactory<boolean, boolean, GridBooleanBulkDraft> {
  const messages = resolveCellTypeMessages(DEFAULT_BOOLEAN_MESSAGES, options.messages)
  const trueLabel = options.trueLabel ?? 'True'
  const falseLabel = options.falseLabel ?? 'False'
  const clearValue = options.clearValue
  assertBooleanLabels(trueLabel, falseLabel)
  return defineCellTypeFactory<boolean, boolean, GridBooleanBulkDraft>(() => ({
    behavior: {
      value: {
        validate: (value) => typeof value === 'boolean'
          ? success(value)
          : failure('invalid-boolean-value', messages.invalidValue),
      },
      text: {
        display: (value) => value ? trueLabel : falseLabel,
        search: (value) => value ? `${trueLabel} TRUE` : `${falseLabel} FALSE`,
        original: (value) => value ? trueLabel : falseLabel,
      },
      equals: Object.is,
      clipboard: {
        format: (value) => value ? 'TRUE' : 'FALSE',
        parse: (raw) => parseBoolean(raw, trueLabel, falseLabel, messages),
      },
      edit: { begin: (value) => !value, commit: success },
      ...(typeof clearValue === 'boolean' ? { clear: () => success(clearValue) } : {}),
      compare: (left, right) => Number(left) - Number(right),
      filter: {
        defaultOperator: 'equals',
        operators: [
          booleanFilter('equals', messages.equals, trueLabel, falseLabel, messages.filterChoiceRequired, (value, operand) => value === operand),
          booleanFilter('not-equals', messages.notEquals, trueLabel, falseLabel, messages.filterChoiceRequired, (value, operand) => value !== operand),
        ],
      },
      bulk: {
        begin: ({ values }) => ({ value: allEqual(values) ? values[0] ?? 'mixed' : 'mixed' }),
        apply: (_current, draft) => draft.value === 'mixed'
          ? failure('boolean-bulk-choice-required', messages.choiceRequired)
          : success(draft.value),
      },
    },
    view: {
      Cell: (props) => <BooleanCell {...props} falseLabel={falseLabel} trueLabel={trueLabel} />,
      Editor: BooleanEditor,
      BulkEditor: (props) => <BooleanBulkEditor {...props} falseLabel={falseLabel} messages={messages} trueLabel={trueLabel} />,
      presentation: {
        content: 'padded',
        align: 'center',
        editActivation: ['enter', 'f2', 'space'],
      },
    },
  }))
}

function BooleanCell<Row>({
  commitValue,
  editable,
  falseLabel,
  trueLabel,
  value,
}: GridCellViewProps<Row, boolean> & Readonly<{
  falseLabel: string
  trueLabel: string
}>) {
  const cancelPendingPointer = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelPendingPointer.current?.(), [])
  const armToggle = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!editable || event.button !== 0) return
    cancelPendingPointer.current?.()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const cleanup = () => {
      document.removeEventListener('pointerup', complete, true)
      document.removeEventListener('pointercancel', cancel, true)
      if (cancelPendingPointer.current === cleanup) cancelPendingPointer.current = null
    }
    const cancel = (cancelEvent: globalThis.PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return
      cleanup()
    }
    const complete = (upEvent: globalThis.PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      cleanup()
      if (Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY) > 4) return
      queueMicrotask(() => commitValue(!value))
    }
    cancelPendingPointer.current = cleanup
    document.addEventListener('pointerup', complete, true)
    document.addEventListener('pointercancel', cancel, true)
  }
  return <span
    aria-label={value ? trueLabel : falseLabel}
    aria-checked={value}
    aria-disabled={!editable || undefined}
    className="data-grid-boolean-cell"
    data-checked={value || undefined}
    data-disabled={!editable || undefined}
    role="checkbox"
    onPointerDown={armToggle}
  />
}

function BooleanEditor<Row>({
  claimInitialActivation,
  commit,
}: GridCellEditorProps<Row, boolean, boolean>) {
  useLayoutEffect(() => {
    if (claimInitialActivation()) commit()
  }, [claimInitialActivation, commit])
  return <span aria-hidden="true" />
}

function BooleanBulkEditor({
  apply,
  cancel,
  cellCount,
  draft,
  error,
  falseLabel,
  messages,
  setDraft,
  trueLabel,
}: GridCellBulkEditorProps<GridBooleanBulkDraft> & Readonly<{
  falseLabel: string
  messages: GridBooleanCellTypeMessages
  trueLabel: string
}>) {
  return <form className="data-grid-bulk-editor" onSubmit={(event) => { event.preventDefault(); apply() }}>
    <label>{messages.value}<select
      value={draft.value === 'mixed' ? '' : String(draft.value)}
      onChange={(event) => setDraft({
        value: event.currentTarget.value === '' ? 'mixed' : event.currentTarget.value === 'true',
      })}
    >
      <option disabled value="">{messages.chooseValue}</option>
      <option value="true">{trueLabel}</option>
      <option value="false">{falseLabel}</option>
    </select></label>
    {error ? <p role="alert">{error}</p> : null}
    <div className="data-grid-bulk-editor-actions">
      <button type="button" onClick={cancel}>{messages.cancel}</button>
      <button disabled={draft.value === 'mixed'} type="submit">{messages.applyToCells(cellCount)}</button>
    </div>
  </form>
}

function booleanFilter(
  id: string,
  label: string,
  trueLabel: string,
  falseLabel: string,
  invalidValueMessage: string,
  matches: (value: boolean, operand: boolean) => boolean,
) {
  return {
    id,
    label,
    requiresValue: true,
    input: {
      kind: 'select' as const,
      options: [
        { value: 'true', label: trueLabel },
        { value: 'false', label: falseLabel },
      ],
    },
    validate: (raw: string) => raw === 'true' || raw === 'false'
      ? null
      : invalidValueMessage,
    matches: (value: boolean, raw: string) => matches(value, raw === 'true'),
  }
}

function parseBoolean(
  raw: string,
  trueLabel: string,
  falseLabel: string,
  messages: GridBooleanCellTypeMessages,
): GridValueResult<boolean> {
  const normalized = normalize(raw)
  if (normalized === 'true') return success(true)
  if (normalized === 'false') return success(false)
  if (normalized === normalize(trueLabel)) return success(true)
  if (normalized === normalize(falseLabel)) return success(false)
  return failure('invalid-boolean', messages.pasteValueInvalid)
}

function assertBooleanLabels(trueLabel: string, falseLabel: string) {
  const trueAlias = normalize(trueLabel)
  const falseAlias = normalize(falseLabel)
  if (!trueAlias || !falseAlias) throw new Error('Boolean labels cannot be empty.')
  if (trueAlias === falseAlias || trueAlias === 'false' || falseAlias === 'true') {
    throw new Error('Boolean labels must have unambiguous TRUE/FALSE clipboard values.')
  }
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase()
}

function allEqual(values: readonly boolean[]) {
  return values.length > 0 && values.every((value) => Object.is(value, values[0]))
}

function success<Value>(value: Value): GridValueResult<Value> {
  return { ok: true, value }
}

function failure<Value>(code: string, message: string): GridValueResult<Value> {
  return { ok: false, issue: { code, message } }
}
