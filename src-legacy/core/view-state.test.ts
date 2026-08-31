import { describe, expect, it } from 'vitest'
import { resolveDataGridCollectionState } from './view-state'

describe('data grid collection state', () => {
  it.each([
    [{ loading: true, refreshing: false, error: null, sourceRowCount: 0, visibleRowCount: 0 }, 'initial-loading'],
    [{ loading: false, refreshing: true, error: null, sourceRowCount: 20, visibleRowCount: 20 }, 'refreshing-with-data'],
    [{ loading: false, refreshing: false, error: null, sourceRowCount: 0, visibleRowCount: 0 }, 'ready-empty'],
    [{ loading: false, refreshing: false, error: null, sourceRowCount: 20, visibleRowCount: 0 }, 'filtered-empty'],
    [{ loading: false, refreshing: false, error: '刷新失败', sourceRowCount: 20, visibleRowCount: 20 }, 'failed-with-data'],
    [{ loading: false, refreshing: false, error: '首次加载失败', sourceRowCount: 0, visibleRowCount: 0 }, 'failed-empty'],
    [{ loading: false, refreshing: false, error: '', sourceRowCount: 0, visibleRowCount: 0 }, 'failed-empty'],
  ] as const)('resolves %o as %s', (input, expected) => {
    expect(resolveDataGridCollectionState(input)).toBe(expected)
  })
})
