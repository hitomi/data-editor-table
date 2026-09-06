import { describe, expect, it, vi } from 'vitest'
import { createStandardCellTypeRegistry, type StandardGridCellTypeSchema } from '../cell-types/standard-registry.js'
import { compileGridColumns } from '../data/runtime-columns.js'
import { beginGridBulkSession, prepareGridBulkValues } from './bulk-transitions.js'

const registry = createStandardCellTypeRegistry<number>()
const column = compileGridColumns<number, StandardGridCellTypeSchema>([{
  key: 'value', label: 'Value', type: 'number', bulkEditable: true,
  getValue: (row) => row, setValue: (_row, value) => value,
}], registry.behaviors)[0]!
const cells = [0, 1].map((value) => ({ cell: { rowKey: value, columnKey: 'value' }, row: value, value, column }))
const revisions = { sourceRevision: 1, draftRevision: 2, viewRevision: 3 }
function session() {
  const begun = beginGridBulkSession({ column, cells, revisions, revision: 1, maxMutations: 2 })
  if (!begun.ok) throw new Error(begun.issue.message)
  return begun.value
}

describe('bulk edit preparation', () => {
  it('checks the operation limit before invoking begin or resolving application targets', () => {
    const begin = vi.fn(column.behavior.bulk!.begin)
    const limited = { ...column, behavior: { ...column.behavior, bulk: { ...column.behavior.bulk!, begin } } }
    expect(beginGridBulkSession({ column: limited, cells, revisions, revision: 1, maxMutations: 1 }).ok).toBe(false)
    expect(begin).not.toHaveBeenCalled()
    const resolveCell = vi.fn((target) => cells[target.rowKey] ?? null)
    expect(prepareGridBulkValues({ session: session(), revisions, currentTargets: cells.map((cell) => cell.cell), maxMutations: 1, resolveCell }).ok).toBe(false)
    expect(resolveCell).not.toHaveBeenCalled()
  })

  it('retains the draft and rejects changed authority before running per-cell work', () => {
    const original = session()
    const resolveCell = vi.fn(() => cells[0]!)
    const result = prepareGridBulkValues({ session: original, revisions: { ...revisions, sourceRevision: 9 }, currentTargets: original.targetCells, maxMutations: 2, resolveCell })
    expect(result).toMatchObject({ ok: false, session: { revision: 2, draft: original.draft } })
    expect(resolveCell).not.toHaveBeenCalled()
    expect(original.error).toBeNull()
  })

  it('does not return a partial mutation plan when a later cell fails validation', () => {
    const original = session()
    const result = prepareGridBulkValues({
      session: original, revisions, currentTargets: original.targetCells, maxMutations: 2,
      resolveCell: (target) => {
        const resolved = cells[target.rowKey]!
        return { ...resolved, column: { ...column, behavior: { ...column.behavior, bulk: {
          ...column.behavior.bulk!, apply: () => target.rowKey === 0
            ? { ok: true, value: 5 }
            : { ok: false, issue: { code: 'invalid', message: 'Second cell rejected' } },
        } } } }
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'Second cell rejected', session: { draft: original.draft } })
    expect(result).not.toHaveProperty('mutations')
    expect(cells.map((cell) => cell.value)).toEqual([0, 1])
  })
})
