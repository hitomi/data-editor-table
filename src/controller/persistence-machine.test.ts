import { describe, expect, it } from 'vitest'
import { initialGridPersistenceOperation, transitionGridPersistenceOperation as transition, type GridCommitProposal } from './persistence-machine.js'

const proposal: GridCommitProposal<number, string> = Object.freeze({
  id: 'operation-1',
  request: Object.freeze({
    rows: [1], changes: { inserted: [], updated: [], deleted: [], order: null },
    acceptedRowKeys: [], deletedRowKeys: [], orderChanged: false, dirtyOriginals: [],
    draftRevision: 1, sourceVersion: 'opaque-base', operationId: 'operation-1',
  }),
})
const receipt = {
  operationId: proposal.id,
  applied: { rows: [1], version: 'opaque-receipt', status: 'ready' as const, scope: { kind: 'complete' as const } },
}
const idle = () => initialGridPersistenceOperation<number, string>()
const committing = () => transition(idle(), { type: 'start', proposal })

describe('persistence operation state machine', () => {
  it('ignores stale completions and preserves a committing proposal', () => {
    const state = committing()
    expect(transition(state, { type: 'acknowledged', operationId: 'other' })).toBe(state)
    expect(transition(state, { type: 'start', proposal: { ...proposal } })).toBe(state)
    expect(transition(state, { type: 'authority-reconciled' })).toBe(state)
  })

  it('only retries the exact proposal after an unknown outcome, even after refresh', () => {
    const state = transition(committing(), { type: 'failed', operationId: proposal.id, error: 'offline', definitive: false })
    expect(state.status).toBe('outcome-unknown')
    expect(transition(state, { type: 'authority-reconciled' })).toBe(state)
    expect(transition(state, { type: 'start', proposal: { ...proposal } })).toBe(state)
    const retry = transition(state, { type: 'start', proposal })
    expect(retry).toEqual({ status: 'committing', proposal })
    if (retry.status === 'committing') expect(retry.proposal.request).toBe(proposal.request)
  })

  it('retains the receipt and prohibits resending an applied but unreconciled write', () => {
    const state = transition(committing(), { type: 'unreconciled', operationId: proposal.id, receipt, error: 'invalid remap' })
    expect(state).toEqual({ status: 'applied-unreconciled', proposal, receipt, error: 'invalid remap' })
    expect(transition(state, { type: 'start', proposal })).toBe(state)
    expect(transition(state, { type: 'authority-reconciled' })).toBe(state)
    expect(transition(state, { type: 'acknowledged', operationId: proposal.id })).toEqual({ status: 'idle' })
  })

  it('distinguishes definitive rejection from an unknown result and allows a new proposal', () => {
    const state = transition(committing(), { type: 'failed', operationId: proposal.id, error: 'not applied', definitive: true })
    expect(state.status).toBe('rejected')
    const next = { ...proposal, id: 'operation-2', request: { ...proposal.request, operationId: 'operation-2' } }
    expect(transition(state, { type: 'start', proposal: next })).toEqual({ status: 'committing', proposal: next })
  })
})
