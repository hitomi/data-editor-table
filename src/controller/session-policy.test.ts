import { describe, expect, it } from 'vitest'
import type { GridBulkSession, GridEditSession } from '../model/grid-model.js'
import { decideGridSessionExit, gridDraftSessionIssue, type GridDraftCommandOwner } from './session-policy.js'

const cell = { rowKey: 'row', columnKey: 'value' }
const edit: GridEditSession<string> = {
  revision: 4, startedRevision: 1, sourceRevision: 1, cell,
  originalValue: 0, draftValue: 'input', status: 'editing', composing: false, error: null,
}
const bulk: GridBulkSession<string> = {
  revision: 3, sourceRevision: 1, draftRevision: 1, viewRevision: 1,
  selectionSignature: '', columnKey: 'value', targetCells: [cell], draft: 'input', error: null,
}
const empty = { edit: null, bulk: null, filterSession: null }

describe('session ownership and exit policy', () => {
  it('only asks the workflow to commit an implicit editor', () => {
    expect(decideGridSessionExit(empty, 'sorting', false)).toEqual({ kind: 'allow' })
    expect(decideGridSessionExit({ ...empty, edit }, 'sorting', false)).toEqual({ kind: 'commit-edit' })
    expect(decideGridSessionExit({ ...empty, edit }, 'sorting', true)).toMatchObject({ kind: 'blocked' })
    expect(decideGridSessionExit({ ...empty, bulk }, 'sorting', false)).toMatchObject({ kind: 'blocked' })
    expect(edit.draftValue).toBe('input')
  })

  it.each<Readonly<{ owner: GridDraftCommandOwner<string>; allowed: boolean }>>([
    { owner: { kind: 'external' }, allowed: false },
    { owner: { kind: 'edit-commit', cell, editRevision: 4 }, allowed: true },
    { owner: { kind: 'edit-commit', cell, editRevision: 3 }, allowed: false },
    { owner: { kind: 'cell-effect', cell, editRevision: 4 }, allowed: true },
    { owner: { kind: 'cell-effect', cell, editRevision: null }, allowed: false },
    { owner: { kind: 'cell-effect', cell: { ...cell, rowKey: 'other' }, editRevision: 4 }, allowed: false },
    { owner: { kind: 'bulk-apply', bulkRevision: 3 }, allowed: false },
  ])('checks the exact edit owner: $owner.kind, allowed=$allowed', ({ owner, allowed }) => {
    expect(gridDraftSessionIssue({ ...empty, edit }, 4, owner, 'writing') === null).toBe(allowed)
  })

  it('rejects orphaned session owners but permits session-independent cell effects', () => {
    expect(gridDraftSessionIssue(empty, 4, { kind: 'edit-commit', cell, editRevision: 4 }, 'writing')).toContain('no longer current')
    expect(gridDraftSessionIssue(empty, 4, { kind: 'cell-effect', cell, editRevision: 4 }, 'writing')).toContain('no longer belongs')
    expect(gridDraftSessionIssue(empty, 4, { kind: 'cell-effect', cell, editRevision: null }, 'writing')).toBeNull()
  })

  it('requires the current bulk revision and prevents another surface from writing', () => {
    expect(gridDraftSessionIssue({ ...empty, bulk }, 4, { kind: 'bulk-apply', bulkRevision: 3 }, 'writing')).toBeNull()
    expect(gridDraftSessionIssue({ ...empty, bulk }, 4, { kind: 'bulk-apply', bulkRevision: 2 }, 'writing')).toContain('bulk edit')
    const filterSession = { revision: 1, columnKey: 'value', conditions: [], combine: 'all' as const, error: null }
    expect(gridDraftSessionIssue({ ...empty, filterSession }, 4, { kind: 'external' }, 'writing')).toContain('filter edit')
  })
})
