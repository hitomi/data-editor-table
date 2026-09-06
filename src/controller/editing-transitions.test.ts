import { describe, expect, it, vi } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import { beginGridEditSession, invalidateGridEditSession, prepareGridEditValue } from './editing-transitions.js'
import { beginGridFilterSession, changeGridFilterSession, prepareGridFilterApply } from './filter-transitions.js'

const registry = createStandardCellTypeRegistry<number>()
const column = compileGridColumns<number, StandardGridCellTypeSchema>([{
  key: 'value', label: 'Value', type: 'number', filterable: true,
  getValue: (row) => row, setValue: (_row, value) => value,
}], registry.behaviors)[0]!
const cell = { rowKey: 'row', columnKey: 'value' }
const resolved = { row: 0, value: 0, column }
function session() {
  const result = beginGridEditSession(resolved, cell, 1, 2)
  if (!result.ok) throw new Error(result.issue.message)
  return result.value
}

describe('editing domain transitions', () => {
  it('begins a primitive row session and prepares a value without closing it', () => {
    const edit = { ...session(), draftValue: '2' }
    expect(edit).toMatchObject({ originalValue: 0, sourceRevision: 1, revision: 2 })
    expect(prepareGridEditValue(edit, resolved, 1)).toEqual({ ok: true, value: 2 })
    expect(edit.status).toBe('editing')
    expect(edit.draftValue).toBe('2')
  })

  it('rejects changed authority before calling the edit commit callback', () => {
    const commit = vi.fn(column.behavior.edit!.commit)
    const changed = { ...resolved, value: 3, column: { ...column, behavior: { ...column.behavior, edit: { ...column.behavior.edit!, commit } } } }
    expect(prepareGridEditValue(session(), changed, 2)).toMatchObject({ ok: false, issue: { code: 'edit-source-changed' } })
    expect(commit).not.toHaveBeenCalled()
  })

  it('converts callback exceptions and retains the original input in invalid feedback state', () => {
    const edit = { ...session(), draftValue: 'recover me' }
    const target = { ...resolved, column: { ...column, behavior: { ...column.behavior, edit: {
      ...column.behavior.edit!, commit: () => { throw new Error('Cannot parse') },
    } } } }
    expect(prepareGridEditValue(edit, target, 1)).toMatchObject({ ok: false, issue: { message: 'Cannot parse' } })
    const invalid = invalidateGridEditSession(edit, 'Cannot parse', 3)
    expect(invalid).toMatchObject({ status: 'invalid', draftValue: 'recover me', originalValue: 0, revision: 3 })
    expect(edit.status).toBe('editing')
  })
})

describe('filter draft transitions', () => {
  it('edits staged conditions without mutating the original session or active query', () => {
    const query = [{ columnKey: 'value', operator: column.behavior.filter!.defaultOperator, value: '1', combine: 'all' as const }]
    const begun = beginGridFilterSession(column, query, 1)
    if (!begun.ok) throw new Error(begun.issue.message)
    const changed = changeGridFilterSession(begun.value, { type: 'change', index: 0, value: undefined, operator: undefined, combine: 'any' })
    expect(changed).toMatchObject({ ok: true, value: { combine: 'any', conditions: [{ value: '1' }] } })
    expect(begun.value.combine).toBe('all')
    expect(query[0]?.combine).toBe('all')
    expect(changeGridFilterSession(begun.value, { type: 'remove', index: 8 }).ok).toBe(false)
  })

  it('preserves filter input when its validator throws', () => {
    const begun = beginGridFilterSession(column, [], 1)
    if (!begun.ok) throw new Error(begun.issue.message)
    const badColumn = { ...column, behavior: { ...column.behavior, filter: {
      ...column.behavior.filter!, operators: column.behavior.filter!.operators.map((operator) => ({
        ...operator, validate: () => { throw new Error('Invalid condition') },
      })),
    } } }
    const result = prepareGridFilterApply(begun.value, badColumn, [])
    expect(result).toMatchObject({ ok: false, reason: 'Invalid condition', session: { revision: 2, conditions: begun.value.conditions } })
    expect(begun.value.error).toBeNull()
  })
})
